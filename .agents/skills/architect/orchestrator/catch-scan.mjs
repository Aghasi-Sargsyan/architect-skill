// Catch-block scanners (ADR-073, C-33). Stub committed with the Cycle 37 plan: the Cycle 37 task moves
// splitDiffByFiles, findEmptyCatches and their regexes here from selfcheck.mjs (selfcheck.mjs re-exports
// them; this module never imports selfcheck.mjs) and adds the strict scanner used by the self-check.

/** Cleanup calls that may be wrapped in `try { <one call>; } catch { /* cleanup: <reason> *\/ }`. */
export const CLEANUP_CALLS = [
  'close', 'stop', 'abort', 'kill', 'destroy', 'disconnect', 'unref', 'end', 'restore', 'terminate',
  'removeAllListeners', 'clearTimeout', 'clearInterval', 'rmSync', 'rmdirSync', 'unlinkSync', 'closeSync',
];

/**
 * Moved verbatim from selfcheck.mjs (unchanged semantics, selfcheck.test.mjs, packaging-clean.test.mjs).
 * @param {string} diffText
 * @returns {Array<{ file: string, hunks: string[][] }>}
 */
export function splitDiffByFiles(_diffText) {
  throw new Error('Not implemented');
}

/**
 * Moved verbatim from selfcheck.mjs: the lenient legacy scanner (a comment with stop|abort|close exempts a
 * comment-only catch). Kept for API compatibility only; the self-check uses findSilentCatches.
 * @param {string} diffText
 * @returns {Array<{ file: string, lines: string[], line: string }>}
 */
export function findEmptyCatches(_diffText) {
  throw new Error('Not implemented');
}

/**
 * Strict scanner over the added lines of `diffText` (same input format and result shape as
 * findEmptyCatches). A catch is silent when its body, after removing comments, is empty or consists only of
 * `void <identifier>;` statements. Every silent `.catch(…)` callback is reported. A silent `catch` clause is
 * allowed only in the cleanup shape:
 *  - its comment contains `cleanup:` followed by a reason, and
 *  - the `try { … }` block right before it is visible in the same hunk and holds exactly one statement: a
 *    call (optionally `await`-ed) whose callee name is in CLEANUP_CALLS, e.g. `proc.kill()`,
 *    `rmSync(dir, { recursive: true, force: true })`, `await server.close()`.
 * The word stop/abort/close in a comment no longer exempts anything.
 * @param {string} diffText
 * @returns {Array<{ file: string, lines: string[], line: string }>}
 */
export function findSilentCatches(_diffText) {
  throw new Error('Not implemented');
}
