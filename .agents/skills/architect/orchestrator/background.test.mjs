// Reference tests for T-118 (ADR-071): `--background` returns only after the detached loop has confirmed its start
// (the lock names the child, or the child already created a run folder newer than the launch), prints the delivery
// channels and the next `--watch` command; `sendNotification` logs what it actually did. No real time: `sleep` is a
// counted stand-in, the lock is a real file read by the real `readLockOwner`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackground } from './background.mjs';
import * as events from './events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = '2026-11-12T20-00-00-000Z';
const SECRET_URL = 'https://hooks.example.invalid/secret-token';
let root;
let workDir;
let runsDir;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-bg-')));
  workDir = path.join(root, 'repo');
  runsDir = path.join(workDir, '.agent-runs');
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** The detached child stand-in: a pid, unref() and exit/error events; every spawn call is recorded. */
function fakeSpawn(pid) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  const spawnFn = (cmd, args, options) => { calls.push({ cmd, args, options }); return child; };
  return { spawnFn, calls, child };
}

/** sleep stand-in: counts calls and records the requested ms; action N runs during wait N. Never waits. */
function countedSleep(actions = {}) {
  const state = { calls: 0, ms: [] };
  state.sleep = async (ms) => {
    state.calls++;
    state.ms.push(ms);
    await actions[state.calls]?.();
  };
  return state;
}

const writeLock = (pid) => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ pid, startedAt: '', token: 'test' }));
};
const logPath = () => path.join(runsDir, `background-${LAUNCH}.log`);
const opts = (extra) => ({
  workDir,
  runsDir,
  args: ['--only', 'T-001'],
  scriptPath: path.join(here, 'run.mjs'),
  config: { notify: false },
  env: {},
  home: root,
  webhookFile: path.join(root, 'no-webhook'),
  platform: 'linux',
  stamp: () => LAUNCH,
  steps: 50,
  stepMs: 100,
  ...extra,
});

test('T-118: confirmed only when the lock names the child; spawn is detached; the output names the pid, channels and next --watch', async () => {
  const { spawnFn, calls, child } = fakeSpawn(4242);
  const s = countedSleep({ 2: () => writeLock(999), 4: () => writeLock(4242) });
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep }));
  assert.equal(res.ok, true, res.text);
  assert.equal(res.pid, 4242);
  assert.equal(s.calls, 4, 'polls until the lock names the child: a lock of another pid does not count');
  assert.ok(s.ms.every((ms) => ms === 100), 'every wait is stepMs');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [path.join(here, 'run.mjs'), '--only', 'T-001']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.cwd, workDir);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(typeof calls[0].options.stdio[1], 'number', 'child output goes to the background log file');
  assert.equal(child.unrefCalls, 1);
  assert.equal(res.logFile, logPath());
  assert.ok(existsSync(res.logFile), 'the output file is created in runsDir');
  assert.match(res.text, /loop started in background \(pid 4242\); output — \.agent-runs\/background-2026-11-12T20-00-00-000Z\.log/);
  assert.match(res.text, /questions reach the chat only through --watch/);
  assert.match(res.text, /notifications: off/);
  assert.match(res.text, /in the background now/);
  assert.match(res.text, /run\.mjs --watch --since 0/);
});

test('T-118: the owner is matched by pid alone, so a sandbox without ps (verified: false) still confirms at the first look', async () => {
  const { spawnFn } = fakeSpawn(4246);
  const s = countedSleep();
  const seen = [];
  const readOwner = (dir) => { seen.push(dir); return { pid: 4246, alive: true, legacy: false, verified: false }; };
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep, readOwner }));
  assert.equal(res.ok, true, res.text);
  assert.equal(s.calls, 0);
  assert.deepEqual(seen, [runsDir]);
});

test('T-118: a child that exits before its lock is a failed start: exit code and the tail of its output, no --watch hint', async () => {
  const { spawnFn, child } = fakeSpawn(4243);
  mkdirSync(path.join(runsDir, '2026-11-12T18-13-09-089Z'), { recursive: true });
  mkdirSync(path.join(runsDir, 'check-2026-11-12T20-00-04-000Z'), { recursive: true });
  const s = countedSleep({
    2: () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      lines.push(`config read from ${root}/private/dir`, 'agent-loop: not ready to start:', '✗ self-check: dirty tree');
      writeFileSync(logPath(), `${lines.join('\n')}\n\n`);
      child.emit('exit', 1, null);
    },
  });
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep }));
  assert.equal(res.ok, false);
  assert.equal(s.calls, 2, 'stops polling as soon as the child is gone');
  assert.match(res.text, /loop did not start/);
  assert.match(res.text, /exit code 1/);
  assert.match(res.text, /✗ self-check: dirty tree/);
  assert.match(res.text, /line 30/);
  assert.equal(/(^|\s)line 5(\s|$)/.test(res.text), false, 'only the last 20 non-empty lines');
  assert.match(res.text, /config read from ~\/private\/dir/);
  assert.equal(res.text.includes(root), false, 'the home directory is not printed');
  assert.equal(/--watch --since/.test(res.text), false, 'nothing to watch after a failed start');
});

test('T-118: a child that already stopped counts as started when it created a run folder newer than the launch', async () => {
  const { spawnFn, child } = fakeSpawn(4244);
  const s = countedSleep({
    1: () => {
      mkdirSync(path.join(runsDir, '2026-11-12T20-00-03-500Z'), { recursive: true });
      child.emit('exit', 0, null);
    },
  });
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep }));
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /loop started in background \(pid 4244\)/);
  assert.match(res.text, /--watch --since 0/);
});

test('T-118: a spawn error is a failed start that names the error; a missing output file prints (no output)', async () => {
  const { spawnFn, child } = fakeSpawn(undefined);
  const s = countedSleep({ 1: () => { child.emit('error', new Error('spawn EACCES')); } });
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep }));
  assert.equal(res.ok, false);
  assert.equal(res.pid, null);
  assert.match(res.text, /spawn EACCES/);
  assert.match(res.text, /\(no output\)/);
});

test('T-118: no confirmation within the step budget: not ok, still-running pid and a --status hint, exactly `steps` waits', async () => {
  const { spawnFn } = fakeSpawn(4245);
  const s = countedSleep();
  let reads = 0;
  const readOwner = () => { reads++; return { pid: 1, alive: true, legacy: false, verified: true }; };
  const res = await startBackground(opts({ spawnFn, sleep: s.sleep, readOwner, steps: 7, stepMs: 25 }));
  assert.equal(res.ok, false);
  assert.equal(s.calls, 7);
  assert.ok(s.ms.every((ms) => ms === 25));
  assert.ok(reads >= 7 && reads <= 8, `owner reads bounded by the steps (got ${reads})`);
  assert.match(res.text, /not confirmed/);
  assert.match(res.text, /pid 4245 still running/);
  assert.match(res.text, /--status/);
  assert.equal(/--watch --since/.test(res.text), false);
});

test('T-118: deliveryChannels names what can reach the person and never prints the webhook URL', () => {
  assert.equal(typeof events.deliveryChannels, 'function', 'events.mjs exports deliveryChannels');
  const none = path.join(root, 'no-webhook');
  const off = events.deliveryChannels({ config: { notify: false }, env: { AGENT_LOOP_WEBHOOK_URL: SECRET_URL }, home: root, webhookFile: none, platform: 'darwin' });
  assert.match(off, /questions reach the chat only through --watch/);
  assert.match(off, /notifications: off/);
  assert.equal(off.includes('webhook: configured'), false, 'with notify off no channel is used');
  const mac = events.deliveryChannels({ config: { notify: true }, env: {}, home: root, webhookFile: none, platform: 'darwin' });
  assert.match(mac, /questions reach the chat only through --watch/);
  assert.match(mac, /macOS notification: on/);
  assert.match(mac, /webhook: not configured/);
  const linux = events.deliveryChannels({ config: { notify: true }, env: { AGENT_LOOP_WEBHOOK_URL: SECRET_URL }, home: root, webhookFile: none, platform: 'linux' });
  assert.equal(linux.includes('macOS notification: on'), false);
  assert.match(linux, /webhook: configured/);
  for (const text of [off, mac, linux]) {
    assert.equal(text.includes('secret-token'), false, 'the webhook URL is a secret');
    assert.equal(text.includes('\n'), false, 'one line');
  }
});

test('T-118: sendNotification logs what it did — macOS sent, webhook not configured or sent — and never the URL', async () => {
  const none = path.join(root, 'no-webhook');
  const logs = [];
  const res = await events.sendNotification({
    config: { notify: true }, text: 'T-001: stopped', eventType: 'stop', env: {}, home: root, webhookFile: none,
    platform: 'darwin', execOsascript: () => {}, log: (m) => logs.push(m),
  });
  assert.equal(res.osascriptSent, true);
  assert.ok(logs.some((m) => /notification: macOS sent/.test(m)), logs.join('\n'));
  assert.ok(logs.some((m) => /webhook: not configured/.test(m)), logs.join('\n'));

  const logs2 = [];
  const calls = [];
  const res2 = await events.sendNotification({
    config: { notify: true }, text: 'permission required: ps', eventType: 'question', taskId: 'T-001', role: 'executor',
    env: { AGENT_LOOP_WEBHOOK_URL: SECRET_URL }, home: root, webhookFile: none, platform: 'linux',
    fetchFn: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
    log: (m) => logs2.push(m),
  });
  assert.equal(res2.webhookSent, true);
  assert.equal(calls.length, 1);
  assert.ok(logs2.some((m) => /webhook: sent/.test(m)), logs2.join('\n'));
  assert.equal(logs2.some((m) => /notification: macOS sent/.test(m)), false, 'no macOS line off darwin');
  assert.equal(logs2.join('\n').includes('secret-token'), false, 'the webhook URL is never logged');
});
