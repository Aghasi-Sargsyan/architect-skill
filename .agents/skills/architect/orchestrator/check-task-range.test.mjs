// Reference tests for T-096 (ADR-064, C-08/C-11): `--check-task` counts from the task base, reads the plan from
// its owner state, and PLAN.md in Change is rejected by plan validation and `--check`. Frozen for T-096.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import * as cliMod from './cli.mjs';
import * as checkMod from './check.mjs';
import * as hooksMod from './hooks.mjs';
import { parsePlan } from './plan.mjs';
import { validatePlan } from './plan-validate.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const RUN = path.join(orchDir, 'run.mjs');
const planText = (change) => `# PLAN\n\n## Frozen\n- \`EXECUTOR.md\`\n\n## Tasks\n- [ ] T-001: Implement a\n  - Risk: low\n  - Change: ${change}\n  - Check: \`git status --short\`\n`;

function repo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } }).trim();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const commit = (msg, files) => {
    g('add', '--', ...files);
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  write('EXECUTOR.md', '# Executor\n');
  write('.gitignore', '.agent-runs/\n');
  write('src/allowed.ts', 'export const a = 1;\n');
  write('src/forbidden.ts', 'export const b = 1;\n');
  write('PLAN.md', planText('`src/allowed.ts`'));
  const planSha = commit('arch: plan T-001', ['.']);
  return { root, g, write, commit, planSha };
}

const checkTask = (root) => cliMod.runCheckTask({ realGit, workDir: root, taskId: 'T-001', orchestratorDir: orchDir });

test('C-08: --check-task without --base counts from the task base, so an arch: commit on HEAD does not hide an earlier violation', () => {
  const { root, write, commit } = repo('t096-arch-head-');
  try {
    write('src/allowed.ts', 'export const a = 2;\n');
    write('src/forbidden.ts', 'export const b = 2;\n');
    commit('T-001: touch allowed and forbidden', ['src/allowed.ts', 'src/forbidden.ts']);
    write('NOTES.md', 'review notes\n');
    commit('arch: review notes after stop', ['NOTES.md']);

    const res = checkTask(root);
    assert.equal(res.ok, false);
    assert.match(res.violations.join('\n'), /outside task "Change" list: src\/forbidden\.ts/);
    assert.equal(res.commits.filter((c) => c.subject.startsWith('T-001')).length, 1, 'the task commit before the arch: HEAD is in range');

    const cli = spawnSync(process.execPath, [RUN, '--check-task', 'T-001'], { cwd: root, env: { ...process.env, AGENT_LOOP: '' }, encoding: 'utf8' });
    assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, /Passed: NO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery: expanding Change in an arch: commit makes --check-task green; the plan is read from its owner state', () => {
  const { root, write, commit } = repo('t096-expand-');
  try {
    write('src/forbidden.ts', 'export const b = 2;\n');
    commit('T-001: needed change outside Change', ['src/forbidden.ts']);
    assert.equal(checkTask(root).ok, false);

    write('PLAN.md', planText('`src/allowed.ts`, `src/forbidden.ts`'));
    commit('arch: add src/forbidden.ts to T-001 Change after escalation', ['PLAN.md']);
    const res = checkTask(root);
    assert.deepEqual(res.violations, []);
    assert.equal(res.ok, true);
    assert.equal(hooksMod.resolveBaseShaForTask({ realGit, workDir: root, taskId: 'T-001' }), execFileSync(realGit, ['rev-parse', 'HEAD~2'], { cwd: root, encoding: 'utf8' }).trim(), 'base = parent of the first task commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task commit that edits PLAN.md cannot widen its own Change: the plan comes from the owner state and PLAN.md is a violation', () => {
  const { root, write, commit } = repo('t096-tamper-');
  try {
    write('PLAN.md', planText('`src/allowed.ts`, `src/secret.ts`, `PLAN.md`'));
    write('src/secret.ts', 'export const s = 1;\n');
    commit('T-001: widen own Change', ['PLAN.md', 'src/secret.ts']);
    const text = checkTask(root).violations.join('\n');
    assert.match(text, /modifies PLAN\.md: task commits must not modify PLAN\.md/);
    assert.match(text, /outside task "Change" list: src\/secret\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R-7 (C-11): validatePlan and --check reject PLAN.md or .architect/PLAN.md in Change of an open task', () => {
  const open = parsePlan(planText('`src/allowed.ts`, `PLAN.md`'));
  const v1 = validatePlan(open);
  assert.equal(v1.ok, false);
  assert.deepEqual(v1.changeIssues, ['task T-001: PLAN.md must not be listed in Change (plan edits belong to the Architect)']);
  const compact = validatePlan(parsePlan(planText('`.architect/PLAN.md`')));
  assert.deepEqual(compact.changeIssues, ['task T-001: .architect/PLAN.md must not be listed in Change (plan edits belong to the Architect)']);
  const done = validatePlan(parsePlan(planText('`PLAN.md`').replace('- [ ] T-001', '- [x] T-001')));
  assert.deepEqual(done.changeIssues, [], 'accepted tasks are history, not a readiness problem');
  assert.deepEqual(validatePlan(parsePlan(planText('`src/allowed.ts`'))).changeIssues, []);

  const { root, write, commit } = repo('t096-check-');
  try {
    write('PLAN.md', planText('`src/allowed.ts`, `PLAN.md`'));
    commit('arch: plan with PLAN.md in Change', ['PLAN.md']);
    const checks = checkMod.localChecks({ config: { ...DEFAULTS }, workDir: root, realGit });
    const item = checks.find((c) => c.name === 'Change («Менять») field' && !c.ok);
    assert.ok(item, `--check must fail the Change field: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
    assert.match(item.detail, /T-001: PLAN\.md must not be listed in Change/);
    const cliLines = readFileSync(path.join(orchDir, 'cli.mjs'), 'utf8').split('\n').length;
    assert.ok(cliLines <= 400, `cli.mjs must stay <= 400 lines (got ${cliLines})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
