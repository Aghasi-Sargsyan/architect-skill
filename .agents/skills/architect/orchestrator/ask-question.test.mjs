// T-101 reference tests (C-13, C-17): random question id, stale or broken question.json, --answer gate.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerPath, askPermission, questionPath, readPendingQuestion, submitAnswer, writeAnswer } from './ask.mjs';
import { printStatus, watch } from './feed.mjs';

let workDir;
let runs;
let runDir;
const base = () => ({ id: 'T-001-exec-q', who: 'Executor', taskId: 'T-001', command: 'npm run lint', options: [{ answer: '2', rule: 'npm run lint' }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NONCE_ID = /^T-001-exec-q-[0-9a-f]{24}$/;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const liveLock = () => writeFileSync(path.join(runs, '.lock'), String(process.pid));

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'orch-ask-question-'));
  runs = path.join(workDir, '.agent-runs');
  runDir = path.join(runs, 'run1');
  mkdirSync(runDir, { recursive: true });
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

test('C-13: the question id gets a random 24-hex suffix per question; the caller object is not changed; run copies keep the label', async () => {
  const question = base();
  const first = askPermission({ question, workDir, runDir, tty: false, timeoutMs: 2000, pollMs: 20, log: () => {} });
  const firstId = JSON.parse(readFileSync(questionPath(workDir), 'utf8')).id;
  assert.match(firstId, NONCE_ID);
  assert.equal(question.id, 'T-001-exec-q', 'askPermission must not mutate the question it was given');
  writeAnswer({ workDir, answer: '2' });
  assert.equal(JSON.parse(readFileSync(answerPath(workDir), 'utf8')).id, firstId, 'writeAnswer copies the id from question.json');
  assert.equal(await first, '2');
  assert.deepEqual(readdirSync(runDir).sort(), ['T-001-exec-q.answer.json', 'T-001-exec-q.question.json']);
  assert.equal(JSON.parse(readFileSync(path.join(runDir, 'T-001-exec-q.question.json'), 'utf8')).id, firstId);

  const second = askPermission({ question, workDir, runDir, tty: false, timeoutMs: 2000, pollMs: 20, log: () => {} });
  const secondId = JSON.parse(readFileSync(questionPath(workDir), 'utf8')).id;
  assert.match(secondId, NONCE_ID);
  assert.notEqual(secondId, firstId, 'two questions with the same label never share an id');
  writeAnswer({ workDir, answer: '3' });
  assert.equal(await second, '3');
});

test('C-13: an answer.json written before the question is never accepted, even with the label id', async () => {
  writeFileSync(answerPath(workDir), JSON.stringify({ id: 'T-001-exec-q', answer: '2' }));
  const asked = askPermission({ question: base(), workDir, runDir, tty: false, timeoutMs: 200, pollMs: 20, log: () => {} });
  assert.ok(existsSync(questionPath(workDir)), 'the question is written before askPermission yields');
  assert.equal(existsSync(answerPath(workDir)), false, 'the old answer is gone once the question exists');
  assert.equal(await asked, null, 'a pre-placed answer must not answer the question');
  assert.equal(existsSync(questionPath(workDir)), false);
});

test('C-13: the direct form (question, opts) ignores a pre-placed answer too', async () => {
  writeFileSync(answerPath(workDir), JSON.stringify({ id: 'q-direct-1', answer: '2' }));
  const decision = await askPermission(
    { id: 'q-direct-1', command: 'pytest', options: [{ answer: '2', rule: 'pytest' }] },
    { workDir, runDir, timeoutMs: 200, pollMs: 20, log: () => {} },
  );
  assert.deepEqual(decision, { allow: false, reason: 'permission wait timeout' });
});

test('C-13: an answer with another id is dropped and the question keeps waiting', async () => {
  const asked = askPermission({ question: base(), workDir, runDir, tty: false, timeoutMs: 2000, pollMs: 20, log: () => {} });
  writeFileSync(answerPath(workDir), JSON.stringify({ id: 'T-001-exec-q', answer: '2' }));
  await sleep(80);
  assert.equal(existsSync(answerPath(workDir)), false, 'an answer to another id is removed');
  assert.ok(existsSync(questionPath(workDir)), 'the question is still open');
  writeAnswer({ workDir, answer: '2' });
  assert.equal(await asked, '2');
});

test('C-17: readPendingQuestion — none, stale (no lock / dead PID), broken (live lock), valid (live lock)', () => {
  assert.deepEqual(readPendingQuestion(workDir), { question: null, stale: false });
  const q = { ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' };
  writeFileSync(questionPath(workDir), JSON.stringify(q));
  assert.deepEqual(readPendingQuestion(workDir), { question: null, stale: true }, 'no lock: the question belongs to a dead loop');
  assert.ok(existsSync(questionPath(workDir)), 'readPendingQuestion is read-only');
  writeFileSync(path.join(runs, '.lock'), String(deadPid()));
  assert.deepEqual(readPendingQuestion(workDir), { question: null, stale: true }, 'a dead PID in the lock is stale too');
  liveLock();
  assert.deepEqual(readPendingQuestion(workDir), { question: q, stale: false });
  const broken = [
    '{"id": "x", "command": ',
    JSON.stringify([q]),
    JSON.stringify({ ...q, id: 7 }),
    JSON.stringify({ ...q, command: undefined }),
    JSON.stringify({ ...q, options: undefined }),
    JSON.stringify({ ...q, options: [{ rule: 'npm run lint' }] }),
    JSON.stringify({ ...q, options: [null] }),
  ];
  for (const text of broken) {
    writeFileSync(questionPath(workDir), text);
    const res = readPendingQuestion(workDir);
    assert.equal(res.question, null, text);
    assert.equal(res.stale, false, text);
    assert.equal(typeof res.error, 'string', text);
    assert.ok(res.error.length > 0 && !res.error.includes('\n'), `one-line reason for ${text}`);
  }
});

test('C-17: submitAnswer answers only a live loop; writes nothing otherwise', () => {
  assert.throws(() => submitAnswer({ workDir, answer: '2' }), /is not asking anything/);
  const q = { ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' };
  writeFileSync(questionPath(workDir), JSON.stringify(q));
  assert.throws(() => submitAnswer({ workDir, answer: '2' }), (err) => /is not asking anything/.test(err.message) && /not running/.test(err.message));
  assert.equal(existsSync(answerPath(workDir)), false, 'no answer for a stale question');
  liveLock();
  writeFileSync(questionPath(workDir), '{broken');
  assert.throws(() => submitAnswer({ workDir, answer: '2' }), /cannot be read/);
  assert.equal(existsSync(answerPath(workDir)), false);
  writeFileSync(questionPath(workDir), JSON.stringify(q));
  assert.throws(() => submitAnswer({ workDir, answer: '4' }), /not one of the options/);
  assert.equal(existsSync(answerPath(workDir)), false);
  assert.equal(submitAnswer({ workDir, answer: '2' }).command, 'npm run lint');
  const written = JSON.parse(readFileSync(answerPath(workDir), 'utf8'));
  assert.equal(written.id, q.id);
  assert.equal(written.answer, '2');
});

test('C-17: --watch — a broken question of a live loop → exit 3 with the reason; a stale question → not exit 2', async () => {
  mkdirSync(path.join(runs, '2026-11-12T10-00-00-000Z'), { recursive: true });
  writeFileSync(path.join(runs, '2026-11-12T10-00-00-000Z', 'summary.md'), '■ Stop: T-001 escalated\n');
  liveLock();
  writeFileSync(questionPath(workDir), '{"id": "x"');
  const broken = await watch({ workDir, minutes: 1, pollMs: 10, graceMs: 50 });
  assert.equal(broken.code, 3);
  assert.match(broken.text, /permission question cannot be read/);
  rmSync(path.join(runs, '.lock'));
  writeFileSync(questionPath(workDir), JSON.stringify({ ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' }));
  const stale = await watch({ workDir, minutes: 1, pollMs: 10, graceMs: 50 });
  assert.deepEqual(stale, { code: 3, text: '■ Stop: T-001 escalated' }, 'a question left by a dead loop is not a question');
});

test('C-17: --status shows no permission wait for a stale question', () => {
  writeFileSync(questionPath(workDir), JSON.stringify({ ...base(), id: 'T-001-exec-q-0123456789abcdef01234567' }));
  const chunks = [];
  printStatus({ workDir, planPath: 'PLAN.md', out: { write: (s) => chunks.push(String(s)) } });
  assert.doesNotMatch(chunks.join(''), /permission/i);
});

test('C-13: the --answer comment in cli-dispatch.mjs no longer claims an agent can never answer its own question', () => {
  const src = readFileSync(new URL('./cli-dispatch.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('can never answer its own permission request'), 'the old comment contradicts C-13');
  assert.match(src, /submitAnswer\(/, '--answer goes through submitAnswer');
});
