// Reference tests for T-099 (ADR-061 R-2, ADR-064, C-07/C-09/C-10/C-12): the full loop with a fake runner.
// The Architect review is read-only, the orchestrator commits acceptance, a resumed task with unresolved range
// violations stops before any agent call, and the reviewer summary names the task range. Frozen for T-099.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan.mjs';
import { DEFAULTS } from './config.mjs';
import { agySettingsPath, rulesFor, writeAgyAllowlist } from './permissions.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const PLAN = '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n- `contract.md`\n\n## Tasks\n\n- [ ] T-001: update a.txt\n  - Risk: low.\n  - Change: `a.txt`.\n  - Verify: `git status --short`.\n';

let root;
let work;
let env;
let g;

const FAKE_AGY = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');
  console.log('gemini-4-argon-high\\tGemini 4 Argon (High)');
  process.exit(0);
}
const prompt = args.indexOf('-p') >= 0 ? args[args.indexOf('-p') + 1] : '';
const home = process.env.HOME;
const callsFile = path.join(home, 'calls.json');
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
const isArchitect = prompt.includes('Role: Chief Architect');
calls.push({ role: isArchitect ? 'architect' : 'executor', prompt });
fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2));
const mode = fs.readFileSync(path.join(home, 'mode.txt'), 'utf8').trim();
const git = (...gArgs) => execFileSync(${JSON.stringify(realGit)}, gArgs, { encoding: 'utf8' }).trim();
const reply = (obj, id) => process.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: id, response: JSON.stringify(obj) }));
const execCount = calls.filter((c) => c.role === 'executor').length;
const archCount = calls.filter((c) => c.role === 'architect').length;
if (!isArchitect) {
  fs.writeFileSync('a.txt', execCount === 1 ? 'first\\n' : 'second\\n');
  git('add', 'a.txt');
  git('commit', '--only', 'a.txt', '-m', execCount === 1 ? 'T-001: write a' : 'T-001 (fix 1): rework a');
  const sha = git('rev-parse', 'HEAD');
  reply({ task_id: 'T-001', status: 'done', check_passed: true, self_check: true, retry_count: 0, commits: [sha], report_markdown: 'done ' + execCount }, 'e' + execCount);
} else if (mode === 'rework-then-accept' && archCount === 1) {
  reply({ task_id: 'T-001', verdict: 'rework', issues: ['important: needs second value'], rework_instructions: 'REWORK_MARKER: write the second value', arch_commits: [], summary: 'rework requested' }, 'a1');
} else if (mode === 'architect-commits') {
  fs.writeFileSync('PLAN.md', fs.readFileSync('PLAN.md', 'utf8').replace('- [ ] T-001:', '- [x] T-001:'));
  git('add', 'PLAN.md');
  git('commit', '--only', 'PLAN.md', '-m', 'arch: accept T-001');
  reply({ task_id: 'T-001', verdict: 'accepted', issues: [], rework_instructions: '', arch_commits: [git('rev-parse', 'HEAD')], summary: 'accepted and committed by the model' }, 'a2');
} else if (mode === 'architect-dirty') {
  fs.writeFileSync('review-notes.txt', 'notes\\n');
  reply({ task_id: 'T-001', verdict: 'accepted', issues: [], rework_instructions: '', arch_commits: [], summary: 'accepted with a stray file' }, 'a3');
} else {
  reply({ task_id: 'T-001', verdict: 'accepted', issues: [], rework_instructions: '', arch_commits: [], summary: 'accepted read-only' }, 'a4');
}
`;

const calls = () => (existsSync(path.join(env.HOME, 'calls.json')) ? JSON.parse(readFileSync(path.join(env.HOME, 'calls.json'), 'utf8')) : []);
const runLoop = (mode) => {
  writeFileSync(path.join(env.HOME, 'mode.txt'), `${mode}\n`);
  return spawnSync(process.execPath, [RUN, '--only', 'T-001'], { cwd: work, env, encoding: 'utf8', timeout: 60000 });
};
const subjects = () => g('log', '--format=%s').split('\n');

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-accept-loop-')));
  work = path.join(root, 'work');
  mkdirSync(work, { recursive: true });
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  env = { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(work, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n# Executor\n');
  writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(work, 'a.txt'), 'init\n');
  writeFileSync(path.join(work, 'contract.md'), 'frozen contract\n');
  writeFileSync(path.join(work, 'PLAN.md'), PLAN);
  const agy = path.join(root, 'fake-agy-accept');
  writeFileSync(agy, FAKE_AGY);
  chmodSync(agy, 0o755);
  const config = { ...DEFAULTS, agyBin: agy, maxFixRounds: 1, notify: false };
  mkdirSync(path.join(work, '.agents'), { recursive: true });
  writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config, null, 2));
  g('add', '.');
  g('commit', '-q', '-m', 'arch: plan T-001');
  writeAgyAllowlist({ settingsPath: agySettingsPath(env.HOME), ...rulesFor(config, work) });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('R-2: a read-only review is accepted by the orchestrator itself — [x] and arch: accept T-001 touching only PLAN.md; rework instructions are saved in the run dir', () => {
  const res = runLoop('rework-then-accept');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const c = calls();
  assert.deepEqual(c.map((x) => x.role), ['executor', 'architect', 'executor', 'architect']);
  assert.match(c[1].prompt, /read-only/i, 'the review prompt must state read-only mode');
  assert.doesNotMatch(c[1].prompt, /mark T-001 \[x\]/, 'the review prompt must not ask the model to mark the task');
  assert.match(c[1].prompt, /task range [0-9a-f]{7}\.\.[0-9a-f]{7}: commits [0-9a-f]{7} "T-001: write a"; files only from Change/);
  assert.match(c[1].prompt, /bypass scan skipped: no changed task files under src tests/, 'C-12: no scan claim when no changed file is under bypassScanPaths');
  assert.match(c[3].prompt, /commits [0-9a-f]{7} "T-001: write a", [0-9a-f]{7} "T-001 \(fix 1\): rework a"/, 'C-07: the second review sees the whole task range');
  assert.match(c[2].prompt, /REWORK_MARKER/);

  assert.deepEqual(subjects().slice(0, 3), ['arch: accept T-001', 'T-001 (fix 1): rework a', 'T-001: write a']);
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['PLAN.md']);
  assert.equal(parsePlan(readFileSync(path.join(work, 'PLAN.md'), 'utf8')).tasks[0].done, true);
  assert.equal(g('status', '--porcelain'), '');

  const runsDir = path.join(work, '.agent-runs');
  const runDir = readdirSync(runsDir).map((d) => path.join(runsDir, d)).find((d) => existsSync(path.join(d, 'T-001-review0.rework.md')));
  assert.ok(runDir, 'T-001-review0.rework.md must be written in the run directory');
  assert.match(readFileSync(path.join(runDir, 'T-001-review0.rework.md'), 'utf8'), /REWORK_MARKER: write the second value/);
});

test('C-09: an Architect that commits during review (amend or new commit) stops the loop and no acceptance commit is added on top', () => {
  const res = runLoop('architect-commits');
  assert.match(res.stdout + res.stderr, /post-review violation — Architect review changed HEAD \(read-only in the automated loop\)/);
  assert.deepEqual(calls().map((x) => x.role), ['executor', 'architect']);
  assert.equal(subjects().filter((s) => s === 'arch: accept T-001').length, 1, 'only the model commit exists, the orchestrator adds none');
  assert.equal(g('log', '-1', '--format=%s', 'HEAD~1'), 'T-001: write a');
});

test('R-2: a stray file left by the review is a violation and nothing is committed', () => {
  const res = runLoop('architect-dirty');
  assert.match(res.stdout + res.stderr, /post-review violation — working tree is not clean after review/);
  assert.equal(g('log', '-1', '--format=%s'), 'T-001: write a');
  assert.equal(parsePlan(readFileSync(path.join(work, 'PLAN.md'), 'utf8')).tasks[0].done, false);
});

test('C-07: a resumed task whose range already violates Frozen stops before any agent call and names the recovery protocol', () => {
  writeFileSync(path.join(work, 'contract.md'), 'weakened contract\n');
  writeFileSync(path.join(work, 'a.txt'), 'partial\n');
  g('add', 'contract.md', 'a.txt');
  g('commit', '-q', '-m', 'T-001: earlier attempt that touched Frozen');
  const head = g('rev-parse', 'HEAD');

  const res = runLoop('accept');
  const out = res.stdout + res.stderr;
  assert.deepEqual(calls(), [], 'no Executor or Architect call for a resumed task with unresolved range violations');
  assert.match(out, /T-001: resumed task has unresolved violations in task range [0-9a-f]{7}\.\.[0-9a-f]{7}/);
  assert.match(out, /touched Frozen: contract\.md/);
  assert.match(out, /Task recovery/);
  assert.equal(g('rev-parse', 'HEAD'), head);
});
