// Loop lock and orderly stop (C-25): an atomic lock whose owner is checked beyond the PID, tracking of the
// spawned agent processes, SIGINT/SIGTERM handlers (agent first, then guards, then lock) and `--stop`.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const LOCK_NAME = '.lock';
const SETTLE_STEPS = 20;
const SETTLE_STEP_MS = 5;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

const tracked = new Set();
let stopping = false;

const isCode = (err, code) => err instanceof Error && 'code' in err && err.code === code;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** ESRCH: no such process; EPERM: the process exists but belongs to someone else. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isCode(err, 'ESRCH')) return false;
    if (isCode(err, 'EPERM')) return true;
    throw err;
  }
}

/** Process start time as `ps` prints it; '' when `ps` is unavailable (the owner check then falls back to the PID). */
function startTimeOf(pid) {
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return res.error || res.status !== 0 ? '' : res.stdout.trim();
}

/** Raw lock content, or null when there is no lock. A file that is still empty is given a few steps to be written. */
function readRaw(lock, settle = false) {
  for (let step = 0; ; step++) {
    let raw;
    try {
      raw = readFileSync(lock, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
    if (raw.trim() !== '' || !settle || step >= SETTLE_STEPS) return raw;
    sleepSync(SETTLE_STEP_MS);
  }
}

/** The owner recorded in the lock: a bare PID (legacy) or JSON `{pid, startedAt, token}`; null for anything else. */
function parseOwner(raw) {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid, startedAt: '', token: '', legacy: true } : null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Garbage content is not an owner: the lock counts as stale.
    return null;
  }
  if (data === null || typeof data !== 'object' || !Number.isInteger(data.pid) || data.pid <= 0) return null;
  return { pid: data.pid, startedAt: typeof data.startedAt === 'string' ? data.startedAt : '', token: typeof data.token === 'string' ? data.token : '', legacy: false };
}

/**
 * alive: the PID exists and (for a JSON lock) its start time matches. When `ps` gives no start time the lock still
 * counts as alive (refusing a second loop is the safe side) but `verified` is false: `--stop` does not signal it.
 */
function describe(owner) {
  if (!pidAlive(owner.pid)) return { pid: owner.pid, alive: false, legacy: owner.legacy, verified: false };
  if (owner.legacy || !owner.startedAt) return { pid: owner.pid, alive: true, legacy: owner.legacy, verified: true };
  const now = startTimeOf(owner.pid);
  return { pid: owner.pid, alive: now === '' || now === owner.startedAt, legacy: false, verified: now === owner.startedAt };
}

/** @returns {{pid: number, alive: boolean, legacy: boolean, verified: boolean} | null} null: no lock (or content that names no owner). */
export function readLockOwner(runsDir) {
  const raw = readRaw(path.join(runsDir, LOCK_NAME));
  const owner = raw === null ? null : parseOwner(raw);
  return owner ? describe(owner) : null;
}

/**
 * One loop per working tree: the lock is created exclusively (`wx`) with the owner inside.
 * A lock of a dead owner (or of a reused PID) is removed once and taken over.
 * @returns {() => void} release: removes the lock only while it still carries this loop's token
 */
export function acquireRunLock(runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const lock = path.join(runsDir, LOCK_NAME);
  const token = randomBytes(8).toString('hex');
  const content = JSON.stringify({ pid: process.pid, startedAt: startTimeOf(process.pid), token });
  for (let attempt = 0; ; attempt++) {
    let fd;
    try {
      fd = openSync(lock, 'wx');
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
      const raw = readRaw(lock, true);
      const owner = raw === null ? null : parseOwner(raw);
      const info = owner ? describe(owner) : null;
      if (info?.alive || attempt > 0) throw new Error(`loop is already running (PID ${info?.pid ?? 'unknown'}, ${lock})`);
      // Remove only what was judged stale: a lock that a faster loop has just written stays.
      if (raw !== null && readRaw(lock) === raw) rmSync(lock, { force: true });
      continue;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return () => {
      const raw = readRaw(lock);
      if (raw !== null && parseOwner(raw)?.token === token) rmSync(lock, { force: true });
    };
  }
}

/** Registers a spawned agent process; once a stop has begun, a process spawned later is ended at once. */
export function trackChild(child) {
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
  if (stopping) child.kill('SIGTERM');
}

/** SIGTERM to every tracked process, SIGKILL after the grace period; resolves when all are gone. */
export async function killTrackedChildren({ graceMs = 5000 } = {}) {
  await Promise.all([...tracked].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    child.kill('SIGTERM');
  })));
}

/** SIGINT/SIGTERM: the agent process ends first, then `cleanup` (guards, lock) runs, then the loop exits with 130. */
export function installStopHandlers({ cleanup, exit = process.exit, graceMs = 5000 }) {
  const handler = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await killTrackedChildren({ graceMs });
      cleanup();
    } catch (err) {
      process.stderr.write(`stop: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      exit(130);
    }
  };
  for (const sig of STOP_SIGNALS) process.on(sig, handler);
}

/**
 * `--stop`: SIGTERM to the live owner of the lock, then bounded polling (counted steps) until the lock is gone
 * or the process has exited. A stale lock is never signalled (its PID may belong to another process now).
 * @returns {Promise<{stopped: boolean, pid?: number, reason?: string}>}
 */
export async function stopLoop({ runsDir, signalWaitSteps = 300, stepMs = 100 }) {
  const owner = readLockOwner(runsDir);
  if (!owner?.alive) return { stopped: false, reason: 'no running loop' };
  if (!owner.verified) return { stopped: false, pid: owner.pid, reason: `cannot verify that PID ${owner.pid} is the loop (no process start time from ps); not signalled` };
  try {
    process.kill(owner.pid, 'SIGTERM');
  } catch (err) {
    if (isCode(err, 'ESRCH')) return { stopped: true, pid: owner.pid };
    return { stopped: false, pid: owner.pid, reason: `cannot signal PID ${owner.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  for (let step = 0; step < signalWaitSteps; step++) {
    const now = readLockOwner(runsDir);
    if (!now || now.pid !== owner.pid || !now.alive) return { stopped: true, pid: owner.pid };
    await sleep(stepMs);
  }
  return { stopped: false, pid: owner.pid, reason: `PID ${owner.pid} did not stop in time` };
}
