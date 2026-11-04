import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import * as planMod from './plan.mjs';
import * as mechanicsMod from './mechanics.mjs';
import { resolveEscalationResume } from './check.mjs';
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

const DOT_SKIP = '.' + 'skip(';
const DOT_ONLY = '.' + 'only(';

let tmp;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-field-t071-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('T-071 (a): findBypasses catches test-runner .skip/.only calls but does NOT false-positive on domain methods like this.skip(), adapter.skip(), or presenter.skip()', () => {
  const compiled = DEFAULTS.bypassPatterns.map((p) => new RegExp(p));

  const domainDiff = [
    '+++ b/src/scene/MultiplierSlamPresenter.ts',
    '@@ -10,0 +11,4 @@',
    `+    this${DOT_SKIP});`,
    `+    adapter${DOT_SKIP});`,
    `+    presenter${DOT_SKIP});`,
    '+++ b/tests/cascade-presenter.frozen.test.ts',
    '@@ -20,0 +21,2 @@',
    `+    presenter${DOT_SKIP});`,
    `+    timelineAdapter${DOT_SKIP});`,
  ].join('\n');

  assert.deepEqual(
    mechanicsMod.findBypasses(domainDiff, compiled),
    [],
    'domain method .skip() calls in src/ or tests/ must not be flagged as test-skip bypasses',
  );

  const testBypassesDiff = [
    '+++ b/tests/cascade-presenter.frozen.test.ts',
    '@@ -1,0 +1,6 @@',
    `+test${DOT_SKIP}"skipped test", () => {});`,
    `+it${DOT_ONLY}"focused test", () => {});`,
    `+describe${DOT_SKIP}"skipped suite", () => {});`,
    `+test.concurrent${DOT_SKIP}"concurrent skip", () => {});`,
    `+t${DOT_SKIP}"node test context skip");`,
  ].join('\n');

  const hits = mechanicsMod.findBypasses(testBypassesDiff, compiled);
  assert.equal(hits.length, 5, `all 5 test-runner skip/only forms must be caught, got: ${hits.join(' | ')}`);
});

test('T-071 (b): matchesFrozenPath supports glob patterns (dir/*, dir/**) in Frozen and parsePlan parses "-Проверка:" without space and extracts referenceTests from Verify when Test cases is omitted', () => {
  assert.equal(typeof planMod.matchesFrozenPath, 'function', 'plan.mjs must export matchesFrozenPath');

  const frozenList = ['EXECUTOR.md', 'src/contracts/*', 'games/shining-crown/**', 'tests/*.frozen.test.ts'];
  assert.equal(planMod.matchesFrozenPath('EXECUTOR.md', frozenList), true);
  assert.equal(planMod.matchesFrozenPath('src/contracts/roundTimeline.ts', frozenList), true);
  assert.equal(planMod.matchesFrozenPath('games/shining-crown/math/paytable.json', frozenList), true);
  assert.equal(planMod.matchesFrozenPath('tests/browser-visual.frozen.test.ts', frozenList), true);
  assert.equal(planMod.matchesFrozenPath('src/main.ts', frozenList), false);

  const planMd = `# PLAN

## Frozen
- \`EXECUTOR.md\`
- \`src/contracts/*\`
- \`tests/amusnet-harvest.frozen.test.ts\`
- \`tests/browser-visual.frozen.test.ts\`

## Задачи
- [ ] T-019: Harvest Amusnet 831
  - Риск: высокий
  - Зависит от: —
  - Менять: \`scripts/harvest.ts\`
  -Проверка: \`npm run typecheck\`, \`npx vitest run tests/amusnet-harvest.frozen.test.ts\`

- [ ] T-025: Browser visual conformance
  - Риск: высокий
  - Зависит от: T-019
  - Параллельно с: T-019
  - Менять: \`src/contracts/assetManifest.ts\`, \`scripts/verify-browser-visual.ts\`
  - Проверка: \`npm run typecheck\`, \`npx vitest run tests/browser-visual.frozen.test.ts\`
`;

  const parsed = planMod.parsePlan(planMd);
  assert.equal(parsed.tasks.length, 2);
  const [t19, t25] = parsed.tasks;

  assert.deepEqual(
    t19.verifyCommands,
    ['npm run typecheck', 'npx vitest run tests/amusnet-harvest.frozen.test.ts'],
    'parsePlan must parse "-Проверка:" even without a space after the dash',
  );
  assert.deepEqual(
    t19.referenceTests,
    ['tests/amusnet-harvest.frozen.test.ts'],
    'parsePlan must fallback-extract frozen test paths from Verify commands when Test cases field is omitted',
  );
  assert.deepEqual(
    t25.referenceTests,
    ['tests/browser-visual.frozen.test.ts'],
  );

  const parProblems = planMod.checkParallelTasks(parsed);
  assert.ok(
    parProblems.some((p) => p.includes('src/contracts/assetManifest.ts') && p.includes('frozen')),
    `checkParallelTasks must catch Change matching Frozen glob src/contracts/*, got: ${parProblems.join('; ')}`,
  );
});

test('T-071 (c): checkExecutorRun and resolveEscalationResume enforce glob entries in Frozen', () => {
  const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  mkdirSync(path.join(tmp, 'src', 'contracts'), { recursive: true });
  writeFileSync(path.join(tmp, 'src', 'contracts', 'roundTimeline.ts'), 'export const v = 1;\n');
  writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n- `src/contracts/*`\n');
  g('add', 'src/contracts/roundTimeline.ts', 'PLAN.md');
  g('commit', '-q', '-m', 'init');

  const base = g('rev-parse', 'HEAD');
  writeFileSync(path.join(tmp, 'src', 'contracts', 'roundTimeline.ts'), 'export const v = 2;\n');
  g('add', 'src/contracts/roundTimeline.ts');
  g('commit', '-q', '-m', 'T-023: touch frozen contract under glob');

  const mechRes = mechanicsMod.checkExecutorRun({
    realGit,
    cwd: tmp,
    base,
    task: { id: 'T-023', risk: 'high', change: ['src/contracts/roundTimeline.ts'] },
    frozen: ['EXECUTOR.md', 'src/contracts/*'],
    scanPaths: ['src'],
    bypassPatterns: [],
  });
  assert.equal(mechRes.ok, false, 'checkExecutorRun must reject modifying a file matched by Frozen glob src/contracts/*');
  assert.ok(
    mechRes.violations.some((v) => v.includes('Frozen') && v.includes('src/contracts/roundTimeline.ts')),
    `expected Frozen violation on src/contracts/roundTimeline.ts, got: ${mechRes.violations.join('; ')}`,
  );

  // Also check resolveEscalationResume on dirty file matching Frozen glob
  const runDir = path.join(tmp, '.agent-runs', '2026-11-04T12-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join( tmp, 'src', 'contracts', 'roundTimeline.ts'), 'export const v = 3;\n');
  const statusOut = execFileSync(realGit, ['status', '--porcelain', '--untracked-files=all'], { cwd: tmp, encoding: 'utf8', env: GIT_ENV });
  const diffOut = execFileSync(realGit, ['diff', 'HEAD'], { cwd: tmp, encoding: 'utf8', env: GIT_ENV });
  writeFileSync(path.join(runDir, 'stop.status.txt'), statusOut);
  writeFileSync(path.join(runDir, 'stop.diff'), diffOut);
  writeFileSync(path.join(runDir, 'summary.md'), 'T-023: Executor escalation\n');
  writeFileSync(path.join(runDir, 'T-023-exec.report.md'), 'Escalation T-023\n');

  const resumeRes = resolveEscalationResume({
    realGit,
    workDir: tmp,
    task: { id: 'T-023', change: ['src/contracts/roundTimeline.ts'] },
  });
  assert.equal(resumeRes.ok, false);
  assert.match(resumeRes.reason, /Frozen/);

  for (const modName of ['plan.mjs', 'mechanics.mjs', 'check.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
