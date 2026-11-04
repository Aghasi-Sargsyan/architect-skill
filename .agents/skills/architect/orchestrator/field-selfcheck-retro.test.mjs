import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfCheckGit } from './selfcheck.mjs';
import { runRedCheck } from './evidence.mjs';
import { parsePlan } from './plan.mjs';
import { which } from './guards.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'),
);
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let tmp;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-field-t072-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('T-072 (a): runSelfCheckGit rejects cycle closure archives in docs/plans/ or .architect/plans/ that omit the ## Retrospective / Ретроспектива section or Rules: added N / removed M line', () => {
  const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  mkdirSync(path.join(tmp, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n');
  g('add', 'PLAN.md');
  g('commit', '-q', '-m', 'arch: plan cycle 5');
  const baseSha = g('rev-parse', 'HEAD');

  // 1. Archive missing ## Ретроспектива / ## Retrospective and Rules: added N / removed M (like sl-factory-kit Cycles 5 & 6)
  writeFileSync(
    path.join(tmp, 'docs', 'plans', '2026-11-04-cycle-5.md'),
    '# PLAN (Cycle 5 Archive)\n\n## Задачи\n- [x] T-019: Done\n',
  );
  g('add', 'docs/plans/2026-11-04-cycle-5.md');
  g('commit', '-q', '-m', 'arch: close cycle 5 authentic-amusnet-clone');

  const badRes = runSelfCheckGit({
    realGit,
    cwd: tmp,
    baseRef: baseSha,
    config: { bypassScanPaths: ['src', 'tests'], bypassPatterns: [] },
  });
  assert.equal(badRes.ok, false, 'runSelfCheckGit must fail when cycle closure archive lacks Retrospective section or Rules: added line');
  assert.ok(
    badRes.violations.some((v) => v.includes('2026-11-04-cycle-5.md') && /Retrospective|Ретроспектива|Rules:\s*added/i.test(v)),
    `expected retrospective violation for 2026-11-04-cycle-5.md, got: ${badRes.violations.join('; ')}`,
  );

  // 2. Remediate on HEAD by appending ## Ретроспектива and Rules: added 0 / removed 0 -> passes!
  writeFileSync(
    path.join(tmp, 'docs', 'plans', '2026-11-04-cycle-5.md'),
    '# PLAN (Cycle 5 Archive)\n\n## Задачи\n- [x] T-019: Done\n\n## Ретроспектива Цикла 5\n\n| Измерение | Статус |\n|---|---|\n| Boundaries | OK |\n\nRules: added 0 / removed 0\n',
  );
  g('add', 'docs/plans/2026-11-04-cycle-5.md');
  g('commit', '-q', '-m', 'arch: add missing retrospective to cycle 5 archive');

  const fixedRes = runSelfCheckGit({
    realGit,
    cwd: tmp,
    baseRef: baseSha,
    config: { bypassScanPaths: ['src', 'tests'], bypassPatterns: [] },
  });
  assert.equal(fixedRes.ok, true, `expected fixed archive on HEAD to pass, got: ${fixedRes.violations.join('; ')}`);
});

test('T-072 (b): runRedCheck reports NOT VERIFIED when an open high-risk code task has 0 referenceTests in PLAN.md', () => {
  const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  mkdirSync(path.join(tmp, 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
  g('add', 'src/a.ts');
  g('commit', '-q', '-m', 'arch: close cycle 1');
  const baseSha = g('rev-parse', 'HEAD');

  const planMd = `# PLAN

## Frozen
- \`EXECUTOR.md\`

## Задачи
- [ ] T-023: High-risk code task without frozen reference test
  - Риск: высокий
  - Зависит от: —
  - Менять: \`src/a.ts\`
  - Проверка: \`npm test\`
`;
  writeFileSync(path.join(tmp, 'PLAN.md'), planMd);
  g('add', 'PLAN.md');
  g('commit', '-q', '-m', 'arch: plan cycle 2');

  const redRes = runRedCheck({
    realGit,
    cwd: tmp,
    baseSha,
    plan: parsePlan(planMd),
    config: { bypassScanPaths: ['src', 'tests'] },
  });
  assert.ok(
    redRes.notVerified.some((nv) => nv.includes('T-023') && /referenceTests|NOT VERIFIED/i.test(nv)),
    `runRedCheck must report NOT VERIFIED when high-risk code task T-023 has 0 frozen referenceTests, got: ${redRes.notVerified.join('; ')}`,
  );

  for (const modName of ['selfcheck.mjs', 'evidence.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
