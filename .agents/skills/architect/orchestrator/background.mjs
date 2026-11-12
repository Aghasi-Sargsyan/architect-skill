// `--background` (ADR-071): starts the loop as a detached child and returns only once its start is confirmed, so a
// `--watch` started right after it never mistakes the seconds before the child takes the lock for a stop.
// STUB until the contract below is implemented (reference tests: background.test.mjs).

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
  void opts;
  throw new Error('Not implemented');
}
