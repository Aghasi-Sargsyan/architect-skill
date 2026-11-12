// T-106 reference tests (C-22; ADR-061 item 3, ADR-066): the permission question and answer live in the control
// directory outside the working tree (<home>/.config/architect/runs/<key>/, mode 0700); the lock stays in .agent-runs/.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerPath, askPermission, clearQuestion, questionPath, readPendingQuestion, submitAnswer, writeAnswer } from './ask.mjs';
import { controlDirFor } from './control-dir.mjs';
import { DEFAULTS } from './config.mjs';
import { statusText, watch } from './feed.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
let root;
let home;
let workDir;
let runs;
let runDir;
const base = () => ({ id: 'T-001-exec-q', who: 'Executor', taskId: 'T-001', command: 'npm run lint', options: [{ answer: '2', rule: 'npm run lint' }] });
const qControl = () => path.join(controlDirFor({ workDir, home }), 'question.json');
const aControl = () => path.join(controlDirFor({ workDir, home }), 'answer.json');
const liveLock = () => writeFileSync(path.join(runs, '.lock'), String(process.pid));
const ask = (extra = {}) => askPermission({ question: base(), workDir, runDir, home, tty: false, timeoutMs: 2000, pollMs: 20, log: () => {}, ...extra });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-ask-control-')));
  home = path.join(root, 'home');
  workDir = path.join(root, 'work');
  runs = path.join(workDir, '.agent-runs');
  runDir = path.join(runs, '2026-11-12T10-00-00-000Z'); // a run folder name that --status recognizes
  mkdirSync(home);
  mkdirSync(runDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('questionPath and answerPath are in the control directory of the project, not in .agent-runs', () => {
  const dir = controlDirFor({ workDir, home });
  assert.equal(questionPath(workDir, home), path.join(dir, 'question.json'));
  assert.equal(answerPath(workDir, home), path.join(dir, 'answer.json'));
  assert.equal(questionPath(workDir, home).startsWith(`${workDir}${path.sep}`), false);
});

test('askPermission writes the question into the control directory (mode 0700); nothing lands in .agent-runs but the run copies', async () => {
  liveLock();
  const asked = ask();
  const qFile = questionPath(workDir, home);
  assert.ok(existsSync(qFile), 'the question is written before askPermission yields');
  assert.equal(statSync(path.dirname(qFile)).mode & 0o777, 0o700);
  assert.equal(existsSync(path.join(runs, 'question.json')), false, 'no question file in the working tree');
  const pending = readPendingQuestion(workDir, home);
  assert.equal(pending.question.id, JSON.parse(readFileSync(qFile, 'utf8')).id);
  assert.match(statusText(workDir, Date.parse('2026-11-12T10:05:00.000Z'), home), /waiting for an answer to a permission question/);
  writeAnswer({ workDir, home, answer: '2' });
  assert.ok(existsSync(answerPath(workDir, home)), 'writeAnswer writes into the control directory');
  assert.equal(existsSync(path.join(runs, 'answer.json')), false);
  assert.equal(await asked, '2');
  assert.equal(existsSync(qFile), false, 'the question is removed once answered');
  assert.equal(existsSync(answerPath(workDir, home)), false, 'the answer is removed once read');
  assert.deepEqual(readdirSync(runDir).sort(), ['T-001-exec-q.answer.json', 'T-001-exec-q.question.json'], 'run copies keep the label');
  assert.deepEqual(readdirSync(runs).sort(), ['.lock', '2026-11-12T10-00-00-000Z']);
});

test('a question.json left in the old place (.agent-runs) is ignored, even with a live loop', () => {
  liveLock();
  writeFileSync(path.join(runs, 'question.json'), JSON.stringify({ ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' }));
  assert.deepEqual(readPendingQuestion(workDir, home), { question: null, stale: false });
  assert.throws(() => submitAnswer({ workDir, home, answer: '2' }), /is not asking anything/);
  assert.equal(existsSync(path.join(runs, 'answer.json')), false);
  assert.equal(existsSync(answerPath(workDir, home)), false);
});

test('submitAnswer and clearQuestion work on the control directory; a stale question there is still refused', () => {
  const q = { ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' };
  mkdirSync(path.dirname(qControl()), { recursive: true });
  writeFileSync(qControl(), JSON.stringify(q));
  assert.equal(readPendingQuestion(workDir, home).stale, true, 'no live lock — the question is stale');
  assert.throws(() => submitAnswer({ workDir, home, answer: '2' }), /not running/);
  liveLock();
  assert.equal(submitAnswer({ workDir, home, answer: '2' }).command, 'npm run lint');
  assert.equal(JSON.parse(readFileSync(aControl(), 'utf8')).id, q.id);
  clearQuestion(workDir, home);
  assert.equal(existsSync(qControl()), false);
  assert.equal(existsSync(aControl()), false);
});

test('--watch sees a question of a live loop in the control directory: exit 2', async () => {
  liveLock();
  mkdirSync(path.dirname(qControl()), { recursive: true });
  writeFileSync(qControl(), JSON.stringify({ ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' }));
  const asked = await watch({ workDir, home, minutes: 1, pollMs: 10, graceMs: 50 });
  assert.equal(asked.code, 2);
  assert.match(asked.text, /npm run lint/);
});

test('run.mjs --answer resolves the control directory from the HOME of the process', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  Object.assign(env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const g = (...args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env });
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(workDir, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n  - Change: `a.txt`\n');
  writeFileSync(path.join(workDir, '.gitignore'), '.agent-runs/\n');
  mkdirSync(path.join(workDir, '.agents'));
  writeFileSync(path.join(workDir, '.agents', 'orchestrator.json'), JSON.stringify({ ...DEFAULTS, notify: false }));
  g('add', 'PLAN.md', '.gitignore', '.agents/orchestrator.json');
  g('commit', '-q', '-m', 'init');
  liveLock();
  const q = { ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' };
  mkdirSync(path.dirname(qControl()), { recursive: true });
  writeFileSync(qControl(), JSON.stringify(q));
  const res = spawnSync(process.execPath, [RUN, '--answer', '2'], { cwd: workDir, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(readFileSync(aControl(), 'utf8')).id, q.id);
  assert.equal(existsSync(path.join(runs, 'answer.json')), false);
});
