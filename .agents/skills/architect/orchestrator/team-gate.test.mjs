import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS, loadConfig } from './config.mjs';
import * as planMod from './plan.mjs';
import * as checkMod from './check.mjs';
import * as cliMod from './cli.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

function initTempRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-068 (a): parsePlan extracts Executor (@handle · Env · Model) and Parallel with, and checkParallelTasks catches Change/Frozen/referenceTests overlaps', () => {
  assert.equal(typeof planMod.checkParallelTasks, 'function');
  const planText = [
    '# PLAN',
    '',
    '## Frozen',
    '- `EXECUTOR.md`',
    '- `tests/ref1.test.mjs`',
    '- `tests/ref2.test.mjs`',
    '',
    '## Tasks',
    '- [ ] T-001: Task one',
    '  - Risk: high',
    '  - Depends on: —',
    '  - Parallel with: T-002',
    '  - Executor: @alice · Claude Code · Claude Sonnet 4.6 (`claude-sonnet-4-6`)',
    '  - Change: `src/a.mjs`, `src/shared.mjs`',
    '  - Test cases: `tests/ref1.test.mjs`',
    '- [ ] T-002: Task two',
    '  - Risk: high',
    '  - Depends on: — (parallel with T-001)',
    '  - Исполнитель: @bob · Antigravity · Gemini 3.8 Flash / High (`gemini-3.8-flash-high`)',
    '  - Change: `src/b.mjs`, `src/shared.mjs`',
    '  - Test cases: `tests/ref1.test.mjs`',
  ].join('\n');

  const parsed = planMod.parsePlan(planText);
  assert.equal(parsed.tasks[0].executorInfo?.handle, '@alice');
  assert.equal(parsed.tasks[0].executorInfo?.runner, 'claude');
  assert.deepEqual(parsed.tasks[0].parallelWith, ['T-002']);
  assert.equal(parsed.tasks[1].executorInfo?.handle, '@bob');
  assert.equal(parsed.tasks[1].executorInfo?.runner, 'agy');
  assert.deepEqual(parsed.tasks[1].parallelWith, ['T-001']);

  const overlapProblems = planMod.checkParallelTasks(parsed);
  assert.ok(overlapProblems.some((p) => p.includes('src/shared.mjs')), `expected Change overlap on src/shared.mjs: ${overlapProblems.join('; ')}`);
  assert.ok(overlapProblems.some((p) => p.includes('tests/ref1.test.mjs')), `expected referenceTests overlap on tests/ref1.test.mjs: ${overlapProblems.join('; ')}`);

  // Disjoint parallel tasks pass checkParallelTasks
  const cleanPlan = planMod.parsePlan(
    planText
      .replace("Change: `src/b.mjs`, `src/shared.mjs`", "Change: `src/b.mjs`")
      .replace(/Test cases: `tests\/ref1\.test\.mjs`$/, 'Test cases: `tests/ref2.test.mjs`'),
  );
  assert.deepEqual(planMod.checkParallelTasks(cleanPlan), []);
});

test('T-068 (b): --check shows resolved model source, task Executor never overrides .local.json, and readiness refuses task on runner mismatch', () => {
  const { root, g } = initTempRepo('t068-runner-mismatch-');
  try {
    mkdirSync(path.join(root, '.architect'), { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), '.agent-runs/\n.architect/config.local.json\n.agents/orchestrator.local.json\n');
    writeFileSync(path.join(root, '.architect', 'EXECUTOR.md'), readFileSync(path.join(path.dirname(orchDir), 'EXECUTOR.md'), 'utf8'));
    writeFileSync(
      path.join(root, '.architect', 'config.json'),
      JSON.stringify({ ...DEFAULTS, layout: 'compact', team: true, runner: 'agy', executor: { model: 'gemini-3.8-flash-high' }, architect: { model: 'gemini-4-argon-high' } }, null, 2) + '\n',
    );
    writeFileSync(
      path.join(root, '.architect', 'config.local.json'),
      JSON.stringify({ runner: 'agy', executor: { model: 'gemini-4-argon-high' } }, null, 2) + '\n',
    );
    writeFileSync(
      path.join(root, '.architect', 'PLAN.md'),
      [
        '# PLAN',
        '',
        '## Frozen',
        '- `.architect/EXECUTOR.md`',
        '',
        '## Tasks',
        '- [ ] T-001: Assigned to Claude Code',
        '  - Risk: low',
        '  - Executor: @alice · Claude Code · Claude Sonnet 4.6 (`claude-sonnet-4-6`)',
        '  - Change: `src/a.mjs`',
      ].join('\n') + '\n',
    );
    g('add', '.gitignore', '.architect/EXECUTOR.md', '.architect/config.json', '.architect/PLAN.md');
    g('commit', '-q', '-m', 'arch: plan team task');

    const cfg = loadConfig(path.join(root, '.architect', 'config.json'));
    const lChecks = checkMod.localChecks({ config: cfg, workDir: root, realGit });
    const modelEntry = lChecks.find((c) => c.name === 'Executor model');
    assert.ok(modelEntry && modelEntry.ok, `localChecks must include passing Executor model entry: ${JSON.stringify(lChecks)}`);
    assert.match(modelEntry.detail, /gemini-4-argon-high.*source: \.architect\/config\.local\.json/);

    // readiness refuses T-001 because Executor environment is Claude Code ("claude") while local runner is "agy"
    const rChecks = checkMod.readiness({ config: cfg, workDir: root, realGit });
    const execModelReady = rChecks.find((c) => c.name === 'T-001: Executor model');
    assert.ok(execModelReady, 'readiness must check T-001: Executor model');
    assert.equal(execModelReady.ok, false, 'readiness must refuse task assigned to another runner environment');
    assert.match(execModelReady.detail, /Claude Code.*agy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-068 (c): runCheckTask reads PLAN.md from <base>:PLAN.md, rejects PLAN.md modification on task branch, uses merge-base on behind branch and synthetic PR merge ref, and runs Verify from <base>:PLAN.md', () => {
  const { root, g } = initTempRepo('t068-gate-base-plan-');
  const runMjs = path.join(orchDir, 'run.mjs');
  try {
    // 0. CLI --init --team works and rejects --team without --init
    assert.throws(() => cliMod.parseArgs(['--team']), /--team.*--init/i);
    assert.equal(cliMod.parseArgs(['--init', '--team']).team, true);

    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 0;\n');
    writeFileSync(path.join(root, 'src', 'b.mjs'), 'export const b = 0;\n');
    writeFileSync(path.join(root, 'src', 'secret.mjs'), 'export const s = 0;\n');

    const basePlan = [
      '# PLAN',
      '',
      '## Frozen',
      '- `EXECUTOR.md`',
      '',
      '## Tasks',
      '- [ ] T-001: Implement a',
      '  - Risk: low',
      '  - Change: `src/a.mjs`',
      '  - Verify: `node --version`',
      '- [ ] T-002: Implement b',
      '  - Risk: low',
      '  - Change: `src/b.mjs`',
    ].join('\n') + '\n';

    g('checkout', '-q', '-b', 'cycle/1');
    writeFileSync(path.join(root, 'PLAN.md'), basePlan);
    g('add', 'EXECUTOR.md', 'PLAN.md', 'src/a.mjs', 'src/b.mjs', 'src/secret.mjs');
    g('commit', '-q', '-m', 'arch: plan cycle 1');

    // Branch task/T-001 from cycle/1 initial plan
    g('checkout', '-q', '-b', 'task/T-001');
    writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
    g('add', 'src/a.mjs');
    g('commit', '-q', '-m', 'T-001: implement a');
    const t1TipSha = g('rev-parse', 'HEAD');

    // Advance cycle/1 with T-002 (containing a bypass token in src/b.mjs!) and arch: accept T-002
    g('checkout', '-q', 'cycle/1');
    const bypassToken = ['as', 'any'].join(' ');
    writeFileSync(path.join(root, 'src', 'b.mjs'), `export const b = 2 ${bypassToken};\n`);
    g('add', 'src/b.mjs');
    g('commit', '-q', '-m', 'T-002: implement b');
    writeFileSync(path.join(root, 'PLAN.md'), basePlan.replace('- [ ] T-002:', '- [x] T-002:'));
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: accept T-002');
    const advancedCycleSha = g('rev-parse', 'HEAD');

    // 1. Checking behind branch task/T-001 against advanced cycle/1 uses merge-base (no reverse diff false positive from src/b.mjs or PLAN.md!)
    g('checkout', '-q', 'task/T-001');
    const behindRes = cliMod.runCheckTask({
      realGit,
      workDir: root,
      taskId: 'T-001',
      baseRef: advancedCycleSha,
      orchestratorDir: orchDir,
    });
    assert.equal(behindRes.ok, true, `behind task/T-001 branch must pass via merge-base: ${behindRes.violations.join('; ')}`);

    // 2. Checking synthetic PR merge commit (refs/pull/N/merge: first parent = cycle/1, second parent = task/T-001) also passes!
    g('checkout', '-q', advancedCycleSha);
    g('merge', '--no-ff', '-q', '-m', 'Merge commit refs/pull/1/merge', t1TipSha);
    const prMergeRes = cliMod.runCheckTask({
      realGit,
      workDir: root,
      taskId: 'T-001',
      baseRef: advancedCycleSha,
      orchestratorDir: orchDir,
    });
    assert.equal(prMergeRes.ok, true, `synthetic PR merge commit must pass: ${prMergeRes.violations.join('; ')}`);

    // 3. Attack on task/T-001: modifying PLAN.md on the task branch to expand Change to src/secret.mjs is caught because PLAN.md is read from <base>:PLAN.md and touching PLAN.md is forbidden!
    g('checkout', '-q', 'task/T-001');
    writeFileSync(path.join(root, 'PLAN.md'), basePlan.replace('Change: `src/a.mjs`', 'Change: `src/a.mjs`, `src/secret.mjs`, `PLAN.md`'));
    writeFileSync(path.join(root, 'src', 'secret.mjs'), 'export const s = 999;\n');
    g('add', 'PLAN.md', 'src/secret.mjs');
    g('commit', '-q', '-m', 'T-001 (fix 1): tamper with PLAN.md and secret.mjs');

    const tamperRes = cliMod.runCheckTask({
      realGit,
      workDir: root,
      taskId: 'T-001',
      baseRef: advancedCycleSha,
      orchestratorDir: orchDir,
    });
    assert.equal(tamperRes.ok, false, 'tampering with PLAN.md on task branch must fail');
    assert.match(tamperRes.violations.join('\n'), /PLAN\.md/);
    assert.match(tamperRes.violations.join('\n'), /src\/secret\.mjs/);

    // 4. Unresolvable --base exits with code 1 and fetch-depth: 0 hint
    const badBaseCli = spawnSync(process.execPath, [runMjs, '--check-task', 'T-001', '--base', 'origin/nonexistent-cycle'], {
      cwd: root,
      env: { ...process.env, AGENT_LOOP: '' },
      encoding: 'utf8',
    });
    assert.equal(badBaseCli.status, 1);
    assert.match(`${badBaseCli.stdout}\n${badBaseCli.stderr}`, /fetch-depth: 0/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
