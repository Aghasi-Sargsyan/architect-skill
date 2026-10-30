import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import * as gitMod from './git.mjs';
import * as checkMod from './check.mjs';
import { executorPrompt } from './prompts.mjs';
import { agySettingsPath, rulesFor, writeAgyAllowlist } from './permissions.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(orchDir, 'run.mjs');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();

function makeRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
  const g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();
  g('init', '-q', '-b', 'master');
  return { root, work, home, env, g };
}

test('T-056: gitRaw preserves trailing blank context lines so stop.diff passes git apply --check', () => {
  assert.equal(typeof gitMod.gitRaw, 'function', 'git.mjs must export gitRaw(realGit, cwd, args)');
  const { root, work, env, g } = makeRepo('orch-t056-diff-');
  try {
    // File ends with a blank line after a content line so unified diff ends with a space-only context line (" \n")
    writeFileSync(path.join(work, 'a.txt'), 'line1\nline2\n\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'init');

    writeFileSync(path.join(work, 'a.txt'), 'line1-modified\nline2\n\n');
    const rawDiff = gitMod.gitRaw(realGit, work, ['diff', 'HEAD']);
    const patchFile = path.join(root, 'stop.diff');
    writeFileSync(patchFile, rawDiff.endsWith('\n') || !rawDiff ? rawDiff : `${rawDiff}\n`);

    const applyCheck = spawnSync(realGit, ['apply', '--check', '--reverse', patchFile], { cwd: work, env, encoding: 'utf8' });
    assert.equal(applyCheck.status, 0, `git apply --check failed on stop.diff: ${applyCheck.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-056: resolveEscalationResume and localChecks allow dirty tree only when matching escalation snapshot and task Change, and executorPrompt includes escalation report', () => {
  assert.equal(typeof checkMod.resolveEscalationResume, 'function', 'check.mjs must export resolveEscalationResume');
  const { root, work, home, env, g } = makeRepo('orch-t056-resume-');
  try {
    const agy = path.join(root, 'fake-agy');
    writeFileSync(agy, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('m\\tM'); process.exit(0); }
const countFile = path.join(process.env.HOME, 'calls');
const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
fs.writeFileSync(countFile, String(n));
const prompt = args[args.indexOf('-p') + 1] || '';
fs.writeFileSync(path.join(process.env.HOME, 'prompt-' + n + '.txt'), prompt);
if (n === 1) {
  // Executor run 1: modifies a.txt with trailing blank context line and escalates
  fs.writeFileSync('a.txt', 'changed\\nkeep\\n\\n');
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    response: JSON.stringify({ task_id: 'T-001', status: 'escalation', commits: [], report_markdown: '### Escalation T-001\\nNeed contract clarification' }),
  }));
} else if (n === 2) {
  // Executor run 2 (resumed after escalation): commits a.txt and returns done
  const { execFileSync } = require('child_process');
  execFileSync('git', ['add', 'a.txt']);
  execFileSync('git', ['commit', '--only', 'a.txt', '-m', 'T-001: complete after escalation']);
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    response: JSON.stringify({ task_id: 'T-001', status: 'done', commits: ['T-001'], report_markdown: 'Done after escalation' }),
  }));
} else {
  // Architect review: marks T-001 [x] in PLAN.md and commits arch:
  const { execFileSync } = require('child_process');
  const plan = fs.readFileSync('PLAN.md', 'utf8').replace('- [ ] T-001:', '- [x] T-001:');
  fs.writeFileSync('PLAN.md', plan);
  execFileSync('git', ['add', 'PLAN.md']);
  execFileSync('git', ['commit', '--only', 'PLAN.md', '-m', 'arch: T-001 accepted']);
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    response: JSON.stringify({ task_id: 'T-001', verdict: 'accepted', summary: 'Accepted T-001' }),
  }));
}
`);
    chmodSync(agy, 0o755);

    writeFileSync(path.join(work, 'a.txt'), 'initial\nkeep\n\n');
    writeFileSync(path.join(work, 'other.txt'), 'other\n');
    writeFileSync(path.join(work, 'EXECUTOR.md'), readFileSync(path.join(orchDir, '..', 'EXECUTOR.md'), 'utf8'));
    writeFileSync(path.join(work, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n\n- [ ] T-001: test escalation\n  - Risk: low\n  - Change: `a.txt`\n  - Verify: `git status`\n');
    writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n');
    const config = { ...DEFAULTS, agyBin: agy, notify: false };
    mkdirSync(path.join(work, '.agents'), { recursive: true });
    writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config));
    g('add', 'a.txt', 'other.txt', 'EXECUTOR.md', 'PLAN.md', '.gitignore', '.agents/orchestrator.json');
    g('commit', '-q', '-m', 'init');
    writeAgyAllowlist({ settingsPath: agySettingsPath(home), ...rulesFor(config, work) });

    // Run 1: stops on escalation with dirty a.txt
    const run1 = spawnSync(process.execPath, [RUN], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run1.status, 0, run1.stderr);
    const runsDir = path.join(work, '.agent-runs');
    const firstRunDir = path.join(runsDir, readdirSync(runsDir).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().at(-1));
    const stopDiffPath = path.join(firstRunDir, 'stop.diff');
    assert.ok(existsSync(stopDiffPath), 'stop.diff must be written on escalation with dirty tree');
    const applyCheck = spawnSync(realGit, ['apply', '--check', '--reverse', stopDiffPath], { cwd: work, env, encoding: 'utf8' });
    assert.equal(applyCheck.status, 0, `stop.diff written by run.mjs must pass git apply --check: ${applyCheck.stderr}`);

    // Verify resolveEscalationResume and localChecks pass on matching dirty tree
    const task = { id: 'T-001', title: 'test escalation', change: ['a.txt'] };
    const resumeOk = checkMod.resolveEscalationResume({ realGit, workDir: work, task });
    assert.equal(resumeOk.ok, true, 'resolveEscalationResume must succeed when dirty tree matches stop snapshot and task.change');
    assert.match(resumeOk.reportText, /Escalation T-001/);

    const promptWithEsc = executorPrompt(task, null, 'm', { planPath: 'PLAN.md', executorPath: 'EXECUTOR.md', escalationReport: resumeOk.reportText });
    assert.match(promptWithEsc, /Escalation T-001/, 'executorPrompt must include the escalation report when resuming');

    // If an unrelated file outside Change is dirty, localChecks / resolveEscalationResume must reject
    writeFileSync(path.join(work, 'other.txt'), 'tampered\n');
    const resumeOutside = checkMod.resolveEscalationResume({ realGit, workDir: work, task });
    assert.equal(resumeOutside.ok, false, 'resolveEscalationResume must reject dirty file outside task.change');
    const checksOutside = checkMod.localChecks({ config, workDir: work, realGit });
    assert.equal(checksOutside.find((c) => c.name === 'clean working tree')?.ok, false);
    writeFileSync(path.join(work, 'other.txt'), 'other\n');

    // If a.txt is modified beyond stop.diff, resolveEscalationResume must reject
    writeFileSync(path.join(work, 'a.txt'), 'different-from-snapshot\nkeep\n\n');
    assert.equal(checkMod.resolveEscalationResume({ realGit, workDir: work, task }).ok, false);
    writeFileSync(path.join(work, 'a.txt'), 'changed\nkeep\n\n');

    // Run 2: starts cleanly on the escalation-resumed dirty tree, passes escalation report to Executor, and completes T-001
    const run2 = spawnSync(process.execPath, [RUN], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run2.status, 0, `run2 failed: ${run2.stdout}\n${run2.stderr}`);
    const prompt2 = readFileSync(path.join(home, 'prompt-2.txt'), 'utf8');
    assert.match(prompt2, /Escalation T-001/, 'Run 2 must pass the escalation report to Executor prompt');
    assert.match(readFileSync(path.join(work, 'PLAN.md'), 'utf8'), /- \[x\] T-001:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const modName of ['git.mjs', 'check.mjs', 'prompts.mjs', 'run.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
