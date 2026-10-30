import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import * as cliMod from './cli.mjs';
import * as checkMod from './check.mjs';
import * as hooksMod from './hooks.mjs';

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

test('T-057: parseArgs supports --check-task T-NNN with optional --base <ref> and enforces mutual exclusion', () => {
  const ct = cliMod.parseArgs(['--check-task', 'T-057']);
  assert.equal(ct.checkTask, 'T-057');
  assert.equal(ct.base, null);

  const ctWithBase = cliMod.parseArgs(['--check-task', 'T-057', '--base', 'HEAD~2']);
  assert.equal(ctWithBase.checkTask, 'T-057');
  assert.equal(ctWithBase.base, 'HEAD~2');

  assert.throws(() => cliMod.parseArgs(['--check-task']), /T-NNN/i);
  assert.throws(() => cliMod.parseArgs(['--check-task', 'bad']), /T-NNN/i);
  assert.throws(() => cliMod.parseArgs(['--check-task', 'T-001', '--self-check']), /only one/i);
  assert.throws(() => cliMod.parseArgs(['--base', 'HEAD~1']), /--base.*--self-check/i);
});

test('T-057: runCheckTask and CLI --check-task verify Executor commits outside the loop (Change, Frozen, bypasses) with or without orchestrator.json', () => {
  assert.equal(typeof cliMod.runCheckTask, 'function', 'cli.mjs must export runCheckTask');
  const { root, g } = initTempRepo('t057-check-task-');
  const runMjs = path.join(orchDir, 'run.mjs');
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    writeFileSync(path.join(root, 'src', 'allowed.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'forbidden.ts'), 'export const b = 1;\n');
    writeFileSync(
      path.join(root, 'PLAN.md'),
      [
        '# PLAN',
        '',
        '## Frozen',
        '- `EXECUTOR.md`',
        '',
        '## Tasks',
        '- [ ] T-001: Implement feature a',
        '  - Risk: low',
        '  - Change: `src/allowed.ts`',
        '  - Check: `git status --short`',
      ].join('\n') + '\n',
    );
    g('add', '.');
    g('commit', '-q', '-m', 'arch: plan T-001');
    const planSha = g('rev-parse', 'HEAD');

    // 1. No Executor commit yet -> fails
    const noCommits = cliMod.runCheckTask({ realGit, workDir: root, taskId: 'T-001', orchestratorDir: orchDir });
    assert.equal(noCommits.ok, false);
    assert.match(noCommits.violations.join('\n'), /no new commit|no task commits/i);

    // 2. Valid Executor commit touching only Change -> passes even without .agents/orchestrator.json!
    writeFileSync(path.join(root, 'src', 'allowed.ts'), 'export const a = 2;\n');
    g('add', 'src/allowed.ts');
    g('commit', '-q', '-m', 'T-001: update allowed.ts');

    const cleanRes = cliMod.runCheckTask({ realGit, workDir: root, taskId: 'T-001', orchestratorDir: orchDir });
    assert.equal(cleanRes.ok, true, `expected clean T-001 to pass: ${cleanRes.violations.join('; ')}`);
    assert.equal(cleanRes.commits.length, 1);

    const cliPass = spawnSync(process.execPath, [runMjs, '--check-task', 'T-001'], {
      cwd: root,
      env: { ...process.env, AGENT_LOOP: '' },
      encoding: 'utf8',
    });
    assert.equal(cliPass.status, 0, `CLI --check-task T-001 must exit 0: ${cliPass.stdout}\n${cliPass.stderr}`);
    assert.match(cliPass.stdout, /Passed: YES/);

    // 3. Executor fix commit touching file outside Change and adding a check bypass -> fails!
    const bypassToken = ['as', 'any'].join(' ');
    writeFileSync(path.join(root, 'src', 'allowed.ts'), `export const a = 2 ${bypassToken};\n`);
    writeFileSync(path.join(root, 'src', 'forbidden.ts'), 'export const b = 2;\n');
    g('add', 'src/allowed.ts', 'src/forbidden.ts');
    g('commit', '-q', '-m', 'T-001 (fix 1): touch forbidden and add bypass');

    const badRes = cliMod.runCheckTask({ realGit, workDir: root, taskId: 'T-001', baseRef: planSha, orchestratorDir: orchDir });
    assert.equal(badRes.ok, false);
    assert.match(badRes.violations.join('\n'), /outside.*Change.*src\/forbidden\.ts/i);
    assert.match(badRes.violations.join('\n'), new RegExp(`check bypass.*${bypassToken}`, 'i'));

    const cliFail = spawnSync(process.execPath, [runMjs, '--check-task', 'T-001'], {
      cwd: root,
      env: { ...process.env, AGENT_LOOP: '' },
      encoding: 'utf8',
    });
    assert.equal(cliFail.status, 1, 'CLI --check-task must exit 1 on violation');
    assert.match(cliFail.stdout, /Passed: NO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-057: checkExecutorModelConfig and localChecks warn when Executor model is nowhere configured or .claude/agents/executor.md uses inherit or omits model', () => {
  assert.equal(typeof hooksMod.checkExecutorModelConfig, 'function', 'hooks.mjs must export checkExecutorModelConfig');
  const { root, g } = initTempRepo('t057-exec-model-');
  try {
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: x\n  - Change: `a.js`\n');
    writeFileSync(path.join(root, '.gitignore'), '.agent-runs/\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');

    // 1. No config file on disk (_missingConfigFile: true), no AGENTS.md model, no .claude/agents/executor.md -> problem reported
    const missingCfg = { ...DEFAULTS, executor: { model: '' }, _missingConfigFile: true };
    const probs1 = hooksMod.checkExecutorModelConfig({ workDir: root, config: missingCfg });
    assert.equal(probs1.length, 1);
    assert.match(probs1[0].detail, /Executor model is not configured/i);

    const lc1 = checkMod.localChecks({ config: missingCfg, workDir: root, realGit });
    assert.ok(lc1.some((c) => !c.ok && /Executor model/i.test(c.name)));

    // 2. Setting "Executor model: Gemini 3.8 Flash (High)" in AGENTS.md satisfies the check even without orchestrator.json
    writeFileSync(path.join(root, 'AGENTS.md'), '# Project Rules\n- Executor model: Gemini 3.8 Flash (High)\n');
    const probs2 = hooksMod.checkExecutorModelConfig({ workDir: root, config: missingCfg });
    assert.equal(probs2.length, 0, `expected AGENTS.md Executor model to satisfy check: ${JSON.stringify(probs2)}`);

    // 3. Creating .claude/agents/executor.md with model: inherit -> fails even when AGENTS.md or config has a model!
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      path.join(root, '.claude', 'agents', 'executor.md'),
      '---\nname: executor\nmodel: inherit\n---\nRead EXECUTOR.md and PLAN.md.\n',
    );
    const probs3 = hooksMod.checkExecutorModelConfig({ workDir: root, config: DEFAULTS });
    assert.equal(probs3.length, 1);
    assert.match(probs3[0].detail, /\.claude\/agents\/executor\.md.*inherit/i);

    // 4. Creating .claude/agents/executor.md without model: field -> fails
    writeFileSync(
      path.join(root, '.claude', 'agents', 'executor.md'),
      '---\nname: executor\ndescription: Executor\n---\nRead EXECUTOR.md and PLAN.md.\n',
    );
    const probs4 = hooksMod.checkExecutorModelConfig({ workDir: root, config: DEFAULTS });
    assert.equal(probs4.length, 1);
    assert.match(probs4[0].detail, /\.claude\/agents\/executor\.md.*model/i);

    // 5. Setting explicit model: sonnet in .claude/agents/executor.md -> passes
    writeFileSync(
      path.join(root, '.claude', 'agents', 'executor.md'),
      '---\nname: executor\nmodel: sonnet\n---\nRead EXECUTOR.md and PLAN.md.\n',
    );
    const probs5 = hooksMod.checkExecutorModelConfig({ workDir: root, config: DEFAULTS });
    assert.equal(probs5.length, 0, `expected explicit model: sonnet to pass: ${JSON.stringify(probs5)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
