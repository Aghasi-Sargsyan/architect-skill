import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan } from './plan.mjs';
import {
  normalizeRisk,
  isValidRisk,
  isHighRisk,
  hasStructuralVerificationMarker,
  isExecutableCodeFile,
  validateFrozenEntries,
  validatePlan,
} from './plan-validate.mjs';

test('C-01: parsePlan normalizes CRLF line endings without losing tasks or leaving carriage returns', () => {
  const crlfPlan = [
    '# PLAN',
    '',
    '## 3. Frozen',
    '- `EXECUTOR.md`',
    '- `tests/ref.test.mjs`',
    '',
    '## 5. Tasks',
    '- [ ] T-001: First task with CRLF',
    '  - Risk: high.',
    '  - Change: `src/one.mjs`',
    '  - Test cases: `tests/ref.test.mjs`',
    '  - Verify: `npm test`',
    '',
    '- [x] T-002: Done task with CRLF',
    '  - Risk: low',
    '  - Depends on: T-001',
    '  - Change: `src/two.mjs`',
  ].join('\r\n') + '\r\n';

  const parsed = parsePlan(crlfPlan);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].id, 'T-001');
  assert.equal(parsed.tasks[0].title, 'First task with CRLF');
  assert.deepEqual(parsed.tasks[0].change, ['src/one.mjs']);
  assert.deepEqual(parsed.tasks[0].verifyCommands, ['npm test']);
  assert.deepEqual(parsed.tasks[0].referenceTests, ['tests/ref.test.mjs']);
  assert.equal(parsed.tasks[1].id, 'T-002');
  assert.equal(parsed.tasks[1].done, true);
  assert.deepEqual(parsed.frozen, ['EXECUTOR.md', 'tests/ref.test.mjs']);
  assert.deepEqual(parsed.parseErrors, []);
  assert.deepEqual(parsed.frozenErrors, []);
});

test('C-01: malformed task headers never glue fields onto previous task and report exact 1-based line numbers', () => {
  const md = [
    '# PLAN',                                       // 1
    '',                                             // 2
    '## Frozen',                                    // 3
    '- `EXECUTOR.md`',                              // 4
    '',                                             // 5
    '## Tasks',                                     // 6
    '- [x] T-001: Valid accepted task',             // 7
    '  - Risk: low',                                // 8
    '  - Model: `model-one`',                       // 9
    '  - Change: `src/safe.mjs`',                   // 10
    '',                                             // 11
    '- [ ] **T-002** — Bold ID header',             // 12 (malformed)
    '  - Risk: high',                               // 13 (must NOT overwrite T-001)
    '  - Depends on: T-001',                        // 14 (must NOT attach to T-001)
    '  - Model: `model-hijack`',                    // 15 (must NOT overwrite T-001)
    '  - Change: `src/secret.mjs`',                 // 16 (must NOT attach to T-001)
    '',                                             // 17
    '- [X] T-003: Uppercase checkbox',              // 18 (malformed)
    '  - Change: `src/x.mjs`',                      // 19
    '* [ ] T-004: Asterisk bullet',                 // 20 (malformed)
    '- [ ] T-2a: Non-numeric suffix',               // 21 (malformed)
    '- **T-005** (`high`) — chat summary pasted',   // 22 (malformed chat format)
  ].join('\n') + '\n';

  const parsed = parsePlan(md);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, 'T-001');
  assert.equal(parsed.tasks[0].risk, 'low');
  assert.equal(parsed.tasks[0].model, '`model-one`');
  assert.deepEqual(parsed.tasks[0].dependsOn, []);
  assert.deepEqual(parsed.tasks[0].change, ['src/safe.mjs']);

  const badLines = parsed.parseErrors.map((e) => e.line);
  assert.deepEqual(badLines, [12, 18, 20, 21, 22]);

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'plan-val-c01-')));
  try {
    const v = validatePlan(parsed, { workDir: tmp });
    assert.equal(v.ok, false);
    assert.equal(v.parseIssues.length, 5);
    assert.match(v.parseIssues[0], /\bline 12\b/i);
    assert.match(v.parseIssues[4], /\bline 22\b/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('C-02: normalizeRisk, isValidRisk, and isHighRisk enforce closed enum with case and trailing period only', () => {
  for (const [input, expected] of [
    ['low', 'low'],
    ['LOW.', 'low'],
    ['низкий', 'low'],
    ['Низкий.', 'low'],
    ['medium', 'medium'],
    ['Medium.', 'medium'],
    ['средний', 'medium'],
    ['СРЕДНИЙ.', 'medium'],
    ['high', 'high'],
    ['HIGH.', 'high'],
    ['высокий', 'high'],
    ['Высокий.', 'high'],
  ]) {
    assert.equal(normalizeRisk(input), expected, `expected ${input} -> ${expected}`);
    assert.equal(isValidRisk(input), true, `expected ${input} to be valid`);
    assert.equal(isHighRisk(input), expected === 'high', `isHighRisk(${input})`);
  }

  for (const invalid of [
    '',
    '   ',
    'high (billing)',
    'high (billing).',
    '**high**',
    'high — RBAC',
    'Высокий (деньги)',
    'critical',
    'low/medium',
  ]) {
    assert.equal(normalizeRisk(invalid), null, `expected "${invalid}" to be rejected`);
    assert.equal(isValidRisk(invalid), false, `expected "${invalid}" to be invalid`);
    assert.equal(isHighRisk(invalid), false, `expected isHighRisk("${invalid}") === false`);
  }
});

test('C-03: Frozen section parses numbered headings and rejects unbackticked items, nested bullets, bare directories, and missing files', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'plan-val-c03-')));
  try {
    mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    writeFileSync(path.join(tmp, 'tests', 'real.test.mjs'), 'export const ok = 1;\n');

    const badMd = [
      '# PLAN',
      '',
      '## 3. Frozen',
      '- `EXECUTOR.md`',
      '- `tests/real.test.mjs`',
      '- `tests/**`',
      '- tests/unbackticked.test.mjs — reference',
      '  - `tests/nested.test.mjs`',
      '- `tests`',
      '- `tests/`',
      '- `tests/missing.test.mjs`',
      '',
      '## Tasks',
      '- [ ] T-001: Demo',
      '  - Risk: low',
      '  - Change: `src/a.mjs`',
    ].join('\n');

    const parsed = parsePlan(badMd);
    assert.equal(parsed.frozenErrors.length, 2);
    assert.equal(parsed.frozenErrors[0].line, 7);
    assert.equal(parsed.frozenErrors[1].line, 8);

    const issues = validateFrozenEntries(parsed, { workDir: tmp });
    assert.equal(issues.length, 5, `expected 5 frozen issues, got: ${issues.join(' | ')}`);
    assert.ok(issues.some((x) => x.includes('line 7')));
    assert.ok(issues.some((x) => x.includes('line 8')));
    assert.ok(issues.some((x) => x.includes('"tests"') && /glob|directory/i.test(x)));
    assert.ok(issues.some((x) => x.includes('"tests/"') && /glob|\*/i.test(x)));
    assert.ok(issues.some((x) => x.includes('tests/missing.test.mjs')));

    const goodMd = [
      '# PLAN',
      '',
      '## 3. Заморожено',
      '- `EXECUTOR.md`',
      '- `tests/real.test.mjs`',
      '- `tests/*`',
      '- `tests/**`',
      '',
      '## 5. Задачи',
      '- [ ] T-001: Demo',
      '  - Риск: низкий.',
      '  - Менять: `src/a.mjs`',
    ].join('\n');
    const goodParsed = parsePlan(goodMd);
    const goodVal = validatePlan(goodParsed, { workDir: tmp });
    assert.equal(goodVal.ok, true, JSON.stringify(goodVal));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('C-04: validatePlan blocks open high-risk code tasks without referenceTests unless structural verification is explicitly marked', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'plan-val-c04-')));
  try {
    mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    writeFileSync(path.join(tmp, 'tests', 'rbac.test.py'), 'def test_rbac(): assert True\n');

    assert.equal(isExecutableCodeFile('server/billing.py'), true);
    assert.equal(isExecutableCodeFile('src/rbac.ts'), true);
    assert.equal(isExecutableCodeFile('db/migrations/001.sql'), false);
    assert.equal(isExecutableCodeFile('.agents/orchestrator.json'), false);
    assert.equal(isExecutableCodeFile('docs/guide.md'), false);

    // 1. Missing referenceTests on executable code outside bypassScanPaths -> blocked
    const missingRefPlan = parsePlan([
      '# PLAN',
      '## Frozen',
      '- `EXECUTOR.md`',
      '## Tasks',
      '- [ ] T-010: Billing capture logic',
      '  - Risk: high',
      '  - Change: `server/billing.py`',
      '  - Verify: `python3 -m pytest`',
    ].join('\n'));
    const v1 = validatePlan(missingRefPlan, { workDir: tmp });
    assert.equal(v1.ok, false);
    assert.equal(v1.highRiskTestIssues.length, 1);
    assert.match(v1.highRiskTestIssues[0], /T-010/);

    // 2. Explicit structural verification marker in Test cases -> allowed
    const structuralPlan = parsePlan([
      '# PLAN',
      '## Frozen',
      '- `EXECUTOR.md`',
      '## Tasks',
      '- [ ] T-011: Ignore and config wiring',
      '  - Risk: high',
      '  - Change: `scripts/check-env.sh`',
      '  - Test cases: structural verification via dedicated check command',
      '  - Verify: `npm test`',
    ].join('\n'));
    assert.equal(hasStructuralVerificationMarker(structuralPlan.tasks[0]), true);
    const v2 = validatePlan(structuralPlan, { workDir: tmp });
    assert.equal(v2.ok, true, JSON.stringify(v2));

    // 3. Frozen reference test present -> allowed
    const withFrozenPlan = parsePlan([
      '# PLAN',
      '## Frozen',
      '- `EXECUTOR.md`',
      '- `tests/rbac.test.py`',
      '## Tasks',
      '- [ ] T-012: RBAC guard',
      '  - Risk: Высокий.',
      '  - Change: `server/rbac.py`',
      '  - Test cases: `tests/rbac.test.py`',
      '  - Verify: `python3 -m pytest`',
    ].join('\n'));
    const v3 = validatePlan(withFrozenPlan, { workDir: tmp });
    assert.equal(v3.ok, true, JSON.stringify(v3));

    // 4. Non-executable files only (SQL / JSON / Markdown) -> allowed without referenceTests
    const nonExecPlan = parsePlan([
      '# PLAN',
      '## Frozen',
      '- `EXECUTOR.md`',
      '## Tasks',
      '- [ ] T-013: Schema & policy docs',
      '  - Risk: high',
      '  - Change: `db/001.sql`, `.agents/orchestrator.json`, `README.md`',
      '  - Verify: `npm test`',
    ].join('\n'));
    const v4 = validatePlan(nonExecPlan, { workDir: tmp });
    assert.equal(v4.ok, true, JSON.stringify(v4));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
