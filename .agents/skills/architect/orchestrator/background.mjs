// `--background` (ADR-071): starts the loop as a detached child and returns only once its start is confirmed, so a
// `--watch` started right after it never mistakes the seconds before the child takes the lock for a stop.
// Reference tests: background.test.mjs.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { deliveryChannels } from './events.mjs';
import { readLockOwner } from './run-lock.mjs';

const RUN_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const TAIL_LINES = 20;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * CONTRACT. Spawns `process.execPath` with `[scriptPath, ...args]` detached (`cwd: workDir`, `env`, stdio
 * `['ignore', fd, fd]` where fd is `<runsDir>/background-<stamp()>.log` opened for append; `runsDir` is created first).
 * The parent closes its copy of fd, calls `child.unref()` and never takes the lock. It records the child's `exit`
 * (code, signal) and `error` events, then runs at most `steps` polling steps, each in this order:
 * 1. `readOwner(runsDir)?.pid === child.pid` → confirmed. The pid alone decides: without `ps` (claude sandbox) the
 *    owner is `verified: false` (ADR-070) and still counts; a lock of another pid does not.
 * 2. the child has exited or failed to spawn → confirmed only when `runsDir` holds a run folder (name
 *    `YYYY-MM-DDTHH-MM-SS-mmmZ`, compared as a string) not older than the launch stamp: the loop got past its lock and
 *    already stopped. Otherwise a failed start. `check-*`, `background-*` and older run folders never confirm.
 * 3. `await sleep(stepMs)`.
 * Nothing confirmed after `steps` waits → not confirmed (the child may still be starting; it is not killed).
 *
 * `text`, printed by run.mjs as is:
 * - confirmed — three lines:
 *   `• loop started in background (pid <pid>); output — .agent-runs/background-<stamp>.log; summary — .agent-runs/<time>/summary.md`
 *   `• delivery: <deliveryChannels({ config, env, home, webhookFile, platform }) from events.mjs>`
 *   `• next: start in the background now — node <scriptPath relative to workDir, absolute when outside> --watch --since 0`
 * - failed start: `✗ loop did not start (exit code <n> | signal <name> | <spawn error message>); last lines of
 *   .agent-runs/background-<stamp>.log:` followed by the last 20 non-empty lines of that file (`home` replaced by `~`;
 *   `(no output)` when the file is missing or empty). No `--watch` hint.
 * - not confirmed: `✗ loop start not confirmed after <steps × stepMs / 1000> s (pid <pid> still running); output —
 *   .agent-runs/background-<stamp>.log; check --status`.
 *
 * @param {{
 *   workDir: string, runsDir: string, args: string[], scriptPath: string, config: { notify?: boolean },
 *   env?: Record<string, string | undefined>, home?: string, webhookFile?: string, platform?: string,
 *   spawnFn?: Function, readOwner?: (runsDir: string) => ({ pid: number } | null),
 *   sleep?: (ms: number) => Promise<void>, stamp?: () => string, steps?: number, stepMs?: number,
 * }} opts Defaults: env `process.env`, home `os.homedir()`, platform `process.platform`, spawnFn `spawn` from
 *   node:child_process, readOwner `readLockOwner` from run-lock.mjs, sleep — a `setTimeout` promise, stamp — ISO time
 *   with `:` and `.` replaced by `-` (the run.mjs format), steps 600, stepMs 100.
 * @returns {Promise<{ ok: boolean, pid: number | null, logFile: string, text: string }>} ok — the start is confirmed;
 *   logFile — absolute path of the child's output file.
 */
export async function startBackground(opts) {
  const {
    workDir, runsDir, args, scriptPath, config,
    env = process.env, home = os.homedir(), webhookFile, platform = process.platform,
    spawnFn = spawn, readOwner = readLockOwner, sleep = defaultSleep, stamp = defaultStamp, steps = 600, stepMs = 100,
  } = opts;
  const launch = stamp();
  const logName = `background-${launch}.log`;
  const logFile = path.join(runsDir, logName);
  const shown = (file) => path.relative(workDir, file);

  mkdirSync(runsDir, { recursive: true });
  const fd = openSync(logFile, 'a');
  let child;
  try {
    child = spawnFn(process.execPath, [scriptPath, ...args], { cwd: workDir, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const pid = child.pid ?? null;
  let exited = null;
  let spawnError = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { spawnError = err; });

  const reachedRunFolder = () => readdirSync(runsDir).some((name) => RUN_FOLDER.test(name) && name >= launch);
  // 'confirmed' | 'failed' | null (keep waiting)
  const look = () => {
    if (pid !== null && readOwner(runsDir)?.pid === pid) return 'confirmed';
    if (exited !== null || spawnError !== null) return spawnError === null && reachedRunFolder() ? 'confirmed' : 'failed';
    return null;
  };

  let verdict = look();
  for (let step = 0; verdict === null && step < steps; step++) {
    await sleep(stepMs);
    verdict = look();
  }

  if (verdict === 'confirmed') {
    const channels = deliveryChannels({ config, env, home, webhookFile, platform });
    const rel = path.relative(workDir, scriptPath);
    const script = rel.startsWith('..') || path.isAbsolute(rel) ? scriptPath : rel;
    const text = [
      `• loop started in background (pid ${pid}); output — ${shown(logFile)}; summary — ${shown(runsDir)}/<time>/summary.md`,
      `• delivery: ${channels}`,
      `• next: start in the background now — node ${script} --watch --since 0`,
    ].join('\n');
    return { ok: true, pid, logFile, text };
  }
  if (verdict === 'failed') {
    const reason = spawnError !== null
      ? spawnError.message
      : exited.code !== null ? `exit code ${exited.code}` : `signal ${exited.signal}`;
    const text = `✗ loop did not start (${reason}); last lines of ${shown(logFile)}:\n${tailOf(logFile, home)}`;
    return { ok: false, pid, logFile, text };
  }
  const text = `✗ loop start not confirmed after ${(steps * stepMs) / 1000} s (pid ${pid} still running); output — ${shown(logFile)}; check --status`;
  return { ok: false, pid, logFile, text };
}

/** The last non-empty lines of the child's output with the home directory shown as `~`; `(no output)` when there are none. */
function tailOf(file, home) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '(no output)';
    throw err;
  }
  const lines = content.split('\n').filter((line) => line.trim() !== '').slice(-TAIL_LINES);
  if (lines.length === 0) return '(no output)';
  return lines.map((line) => (home.length > 1 ? line.split(home).join('~') : line)).join('\n');
}
