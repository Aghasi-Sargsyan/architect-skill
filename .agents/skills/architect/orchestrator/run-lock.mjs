// Stub for T-112 (C-25): the contract lives in run-lock.test.mjs and PLAN.md; the Executor implements it.

const notImplemented = () => { throw new Error('Not implemented'); };

/** @param {string} _runsDir @returns {() => void} release function */
export function acquireRunLock(_runsDir) { return notImplemented(); }

/** @param {string} _runsDir @returns {{pid: number, alive: boolean, legacy: boolean} | null} */
export function readLockOwner(_runsDir) { return notImplemented(); }

/** @param {import('node:child_process').ChildProcess} _child */
export function trackChild(_child) { return notImplemented(); }

/** @param {{graceMs?: number}} [_opts] @returns {Promise<void>} */
export async function killTrackedChildren(_opts) { return notImplemented(); }

/** @param {{cleanup: () => void, exit?: (code: number) => void, graceMs?: number}} _opts */
export function installStopHandlers(_opts) { return notImplemented(); }

/** @param {{runsDir: string, signalWaitSteps?: number}} _opts @returns {Promise<{stopped: boolean, pid?: number, reason?: string}>} */
export async function stopLoop(_opts) { return notImplemented(); }
