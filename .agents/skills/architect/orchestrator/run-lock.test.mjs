// Reference tests for T-112 (C-25): atomic loop lock, owner check beyond the PID, and an orderly stop
// (the agent process ends first, then the guards are restored and the lock is released).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, readLockOwner, stopLoop } from './run-lock.mjs';

const MODULE_URL = new URL('./run-lock.mjs', import.meta.url).href;
void fileURLToPath;
let root;
let runsDir;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-lock-')));
  runsDir = path.join(root, '.agent-runs');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const startedAtOf = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

test('T-112: acquire writes the owner (pid and process start time) and release removes the lock', () => {
  const release = acquireRunLock(runsDir);
  const owner = readLockOwner(runsDir);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.alive, true);
  assert.equal(owner.legacy, false);
  assert.equal(JSON.parse(readFileSync(path.join(runsDir, '.lock'), 'utf8')).startedAt, startedAtOf(process.pid));
  assert.throws(() => acquireRunLock(runsDir), /already running/);
  release();
  assert.equal(existsSync(path.join(runsDir, '.lock')), false);
  assert.equal(readLockOwner(runsDir), null);
});

test('T-112: a release of a lock that another loop took over does not delete the new lock', () => {
  const release = acquireRunLock(runsDir);
  writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ pid: 1, startedAt: 'other', token: 'other' }));
  release();
  assert.equal(existsSync(path.join(runsDir, '.lock')), true, 'a foreign lock stays');
});

test('T-112: a lock with a live PID but another process start time is stale (PID reuse) and is replaced', () => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }));
  const owner = readLockOwner(runsDir);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.alive, false);
  const release = acquireRunLock(runsDir);
  assert.equal(readLockOwner(runsDir).alive, true);
  release();
});

test('T-112: a legacy lock (a bare PID) of a live process still blocks; of a dead process it is stale', () => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, '.lock'), String(process.pid));
  const owner = readLockOwner(runsDir);
  assert.deepEqual([owner.pid, owner.alive, owner.legacy], [process.pid, true, true]);
  assert.throws(() => acquireRunLock(runsDir), /already running/);
  const dead = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(dead.status, 0);
  writeFileSync(path.join(runsDir, '.lock'), '999999');
  assert.equal(readLockOwner(runsDir).alive, false);
  acquireRunLock(runsDir)();
});

test('T-112: of 8 simultaneous acquire attempts exactly one wins', async () => {
  mkdirSync(runsDir, { recursive: true });
  const script = `import { acquireRunLock } from ${JSON.stringify(MODULE_URL)};
try { acquireRunLock(${JSON.stringify(runsDir)}); process.stdout.write('WON'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
catch (err) { process.stdout.write('LOST'); process.exit(0); }`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const outputs = await Promise.all(children.map((child) => new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out === 'LOST' || out === 'WON') resolve(out); });
    child.on('exit', () => resolve(out));
  })));
  for (const child of children) child.stdin.end();
  await Promise.all(children.map((child) => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.on('exit', resolve); })));
  assert.equal(outputs.filter((o) => o === 'WON').length, 1, outputs.join(','));
  assert.equal(outputs.filter((o) => o === 'LOST').length, 7, outputs.join(','));
});

test('T-112: stopLoop ends the tracked agent first, then runs cleanup, releases the lock and reports the stop', async () => {
  mkdirSync(runsDir, { recursive: true });
  const marker = path.join(root, 'cleanup-saw-agent-alive.txt');
  const script = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { acquireRunLock, trackChild, installStopHandlers } from ${JSON.stringify(MODULE_URL)};
const release = acquireRunLock(${JSON.stringify(runsDir)});
const agent = spawn('sleep', ['300'], { stdio: 'ignore' });
trackChild(agent);
installStopHandlers({ cleanup: () => {
  let alive = true;
  try { process.kill(agent.pid, 0); } catch { alive = false; }
  writeFileSync(${JSON.stringify(marker)}, alive ? 'ALIVE' : 'DEAD');
  release();
} });
process.stdout.write('READY ' + agent.pid + '\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const agentPid = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /READY (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on('exit', () => reject(new Error('child exited early: ' + out)));
  });
  assert.equal(isAlive(agentPid), true);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const res = await stopLoop({ runsDir });
  await exited;
  assert.equal(res.stopped, true);
  assert.equal(readFileSync(marker, 'utf8'), 'DEAD', 'the agent is gone before the guards are restored');
  assert.equal(isAlive(agentPid), false);
  assert.equal(existsSync(path.join(runsDir, '.lock')), false);
});

test('T-112: stopLoop with no running loop reports it and changes nothing', async () => {
  const res = await stopLoop({ runsDir });
  assert.equal(res.stopped, false);
  assert.match(res.reason, /no running loop/i);
});

test('T-112: stopLoop never signals a process whose lock is stale (PID reuse)', async () => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }));
  const res = await stopLoop({ runsDir });
  assert.equal(res.stopped, false);
  assert.equal(isAlive(process.pid), true);
});
