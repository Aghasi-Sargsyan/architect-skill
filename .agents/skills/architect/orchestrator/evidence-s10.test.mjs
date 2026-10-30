import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { parsePlan } from './plan.mjs';
import { checkEvalEvidence, runRedCheck } from './evidence.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

// Build eval strings via concatenation so self-check / checkEvalEvidence never flags this test file
const PASS_WORD = 'PA' + 'SS';
const EVAL_WORD = 'ev' + 'al';
const LIVE_WORD = 'li' + 've';

function initTempRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-047: checkEvalEvidence verifies eval <run-id> @ <sha7>: X/Y PASS against results.md, flags unanchored counters on HEAD, and marks missing dir or (dirty) as NOT VERIFIED', () => {
  const { root, g } = initTempRepo('s10-t047-eval-');
  try {
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: close cycle 9');
    const baseSha = g('rev-parse', 'HEAD');

    const runId = '2026-10-30T12-00-00-000Z';
    const shaFull = 'abcdef0123456789abcdef0123456789abcdef01';
    const sha7 = shaFull.slice(0, 7);
    const proofLine = `${EVAL_WORD} ${runId} @ ${sha7}: 5/5 ${PASS_WORD}`;

    // 1. When .agent-runs/evals/ does not exist at all -> NOT VERIFIED, not a violation
    writeFileSync(path.join(root, 'PLAN.md'), `# PLAN\n- ${proofLine}\n`);
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: add eval proof line');

    const noDirRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(noDirRes.ok, true);
    assert.equal(noDirRes.violations.length, 0);
    assert.ok(noDirRes.notVerified.length >= 1);

    // 2. When .agent-runs/evals/ exists and results.md matches X/Y and Commit: <sha> -> ok
    const runDir = path.join(root, '.agent-runs', 'evals', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'results.md'),
      `# Live evals ${runId}\nCommit: ${shaFull}\nTotal: 5 passed, 0 failed, 0 errors (total: 5)\n`,
    );
    const validRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(validRes.ok, true, `expected valid eval proof: ${validRes.violations.join('; ')}`);
    assert.equal(validRes.notVerified.length, 0);

    // 3. When Commit: <sha> (dirty) or legacy results.md without Commit: line -> NOT VERIFIED (not accepted as verified proof)
    writeFileSync(
      path.join(runDir, 'results.md'),
      `# Live evals ${runId}\nCommit: ${shaFull} (dirty)\nTotal: 5 passed, 0 failed, 0 errors (total: 5)\n`,
    );
    const dirtyRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(dirtyRes.ok, true);
    assert.ok(dirtyRes.notVerified.some((m) => /dirty/i.test(m)), 'dirty commit in results.md must be marked NOT VERIFIED');

    writeFileSync(
      path.join(runDir, 'results.md'),
      `# Live evals ${runId}\nTotal: 5 passed, 0 failed, 0 errors (total: 5)\n`,
    );
    const legacyNoCommitRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(legacyNoCommitRes.ok, true);
    assert.ok(legacyNoCommitRes.notVerified.some((m) => /Commit/i.test(m)), 'legacy results.md without Commit: line must be marked NOT VERIFIED');

    // 3b. When Commit: <other-sha> mismatches @ <sha7> -> VIOLATION!
    writeFileSync(
      path.join(runDir, 'results.md'),
      `# Live evals ${runId}\nCommit: 9999999999999999999999999999999999999999\nTotal: 5 passed, 0 failed, 0 errors (total: 5)\n`,
    );
    const mismatchCommitRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(mismatchCommitRes.ok, false);
    assert.match(mismatchCommitRes.violations.join('\n'), /commit|sha|abcdef0/i);

    // 4. Restore clean results.md, then add an unanchored "live ... 10/10 PASS" line in docs/plans/retro.md -> VIOLATION
    writeFileSync(
      path.join(runDir, 'results.md'),
      `# Live evals ${runId}\nCommit: ${shaFull}\nTotal: 5 passed, 0 failed, 0 errors (total: 5)\n`,
    );
    writeFileSync(path.join(root, 'docs', 'plans', 'retro.md'), `# Retro\n${LIVE_WORD} run result: 10/10 ${PASS_WORD}\n`);
    g('add', 'docs/plans/retro.md');
    g('commit', '-q', '-m', 'arch: add unanchored counter');

    const badCounterRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(badCounterRes.ok, false);
    assert.ok(badCounterRes.violations.length >= 1);

    // 5. Remediability: remove the unanchored line from docs/plans/retro.md on HEAD -> no longer a violation!
    writeFileSync(path.join(root, 'docs', 'plans', 'retro.md'), `# Retro\n- ${proofLine}\n`);
    g('add', 'docs/plans/retro.md');
    g('commit', '-q', '-m', 'arch: replace unanchored counter with proof line');

    const remediatedRes = checkEvalEvidence({ realGit, cwd: root, baseSha });
    assert.equal(remediatedRes.ok, true, `remediated eval line must pass: ${remediatedRes.violations.join('; ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-047: runRedCheck strips NODE_TEST_CONTEXT via runTaskVerification, confirms red reference tests, rejects green/syntax-error tests, and skips after T-NNN commit', () => {
  const { root, g } = initTempRepo('s10-t047-redcheck-');
  try {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# Init\n');
    g('add', 'README.md');
    g('commit', '-q', '-m', 'arch: close cycle 9');
    const baseSha = g('rev-parse', 'HEAD');

    // Reference test that simulates Node 22 NODE_TEST_CONTEXT=child-v8 bug (exits 0 if NODE_TEST_CONTEXT is inherited)
    // and otherwise fails on a real assertion (exit 1).
    writeFileSync(
      path.join(root, 'tests', 'ref-red.test.mjs'),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'if (process.env.NODE_TEST_CONTEXT === "inherited-outer-context") process.exit(0);',
        'test("red before implementation", () => {',
        '  assert.equal(1, 2, "expected red failure before Executor runs");',
        '});',
      ].join('\n') + '\n',
    );

    const planMd = `# PLAN

## Frozen
- \`EXECUTOR.md\`
- \`tests/ref-red.test.mjs\`

## Задачи
- [ ] T-045: Feature A
  - Риск: высокий.
  - Зависит от: —.
  - Менять: \`src/a.mjs\`.
  - Тест-кейсы: \`tests/ref-red.test.mjs\`.
  - Проверка: \`node --test tests/ref-red.test.mjs\`.
`;
    writeFileSync(path.join(root, 'PLAN.md'), planMd);
    g('add', 'PLAN.md', 'tests/ref-red.test.mjs');
    g('commit', '-q', '-m', 'arch: plan Cycle 10');

    const childEnvWithContext = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
    const redRes = runRedCheck({
      realGit,
      cwd: root,
      baseSha,
      plan: parsePlan(planMd),
      config: {},
      env: childEnvWithContext,
    });
    assert.equal(redRes.ok, true, `red test must pass red-check: ${redRes.violations.join('; ')}`);
    assert.equal(redRes.skipped, false);
    assert.equal(redRes.checked.length, 1);
    assert.equal(redRes.checked[0].file, 'tests/ref-red.test.mjs');
    assert.equal(redRes.checked[0].status, 'red');

    // Uncommitted change making the reference test GREEN (exit 0) -> VIOLATION!
    writeFileSync(
      path.join(root, 'tests', 'ref-red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green", () => { assert.equal(1, 1); });\n',
    );
    const greenRes = runRedCheck({
      realGit,
      cwd: root,
      baseSha,
      plan: parsePlan(planMd),
      config: {},
      env: childEnvWithContext,
    });
    assert.equal(greenRes.ok, false, 'green reference test before implementation must be a VIOLATION');
    assert.match(greenRes.violations.join('\n'), /passed|exit 0|green/i);

    // Uncommitted change introducing ERR_MODULE_NOT_FOUND -> VIOLATION with load/syntax error message!
    writeFileSync(
      path.join(root, 'tests', 'ref-red.test.mjs'),
      'import { missing } from "./non-existent-module-xyz.mjs";\n',
    );
    const errModRes = runRedCheck({
      realGit,
      cwd: root,
      baseSha,
      plan: parsePlan(planMd),
      config: {},
      env: childEnvWithContext,
    });
    assert.equal(errModRes.ok, false);
    assert.match(errModRes.violations.join('\n'), /ERR_MODULE_NOT_FOUND|SyntaxError|load/i);

    // Restore red test and add a T-045 commit -> runRedCheck skips with a note
    g('checkout', '--', 'tests/ref-red.test.mjs');
    writeFileSync(path.join(root, 'README.md'), '# Implemented\n');
    g('add', 'README.md');
    g('commit', '-q', '-m', 'T-045: implement feature A');

    const skippedRes = runRedCheck({
      realGit,
      cwd: root,
      baseSha,
      plan: parsePlan(planMd),
      config: {},
      env: childEnvWithContext,
    });
    assert.equal(skippedRes.ok, true);
    assert.equal(skippedRes.skipped, true);

    const evidenceLines = readFileSync(path.join(orchDir, 'evidence.mjs'), 'utf8').split('\n').length;
    const mechLines = readFileSync(path.join(orchDir, 'mechanics.mjs'), 'utf8').split('\n').length;
    assert.ok(evidenceLines <= 400, `evidence.mjs must stay <= 400 lines (got ${evidenceLines})`);
    assert.ok(mechLines <= 400, `mechanics.mjs must stay <= 400 lines (got ${mechLines})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
