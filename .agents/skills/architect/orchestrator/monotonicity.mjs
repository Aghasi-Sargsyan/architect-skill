// Test monotonicity over a commit range (ADR-064, C-10): shared by the self-check and by the loop's
// pre-acceptance check from the task base.
// Contract stub written by the Architect; the Executor implements it by MOVING the existing logic out of
// selfcheck.mjs (runSelfCheckGit, block "2. Monotonicity checks", test-file part) without changing behavior.

/**
 * Counts matches of `patterns` (or `fallback` when patterns is empty/not an array) in `content`
 * with flags 'gm'. Moved verbatim from selfcheck.mjs `countByPatterns`.
 * @param {string} content
 * @param {Array<string|RegExp>|undefined} patterns
 * @param {string[]} fallback
 * @returns {number}
 */
export function countByPatterns(content, patterns, fallback) {
  throw new Error('Not implemented: countByPatterns');
}

/** Test-call count with `config.testPatterns` or the selfcheck.mjs DEFAULT_TEST_PATTERNS (moved here). */
export function countTests(content, config) {
  throw new Error('Not implemented: countTests');
}

/** Assertion count with `config.assertPatterns` or the selfcheck.mjs DEFAULT_ASSERT_PATTERNS (moved here). */
export function countAsserts(content, config) {
  throw new Error('Not implemented: countAsserts');
}

/**
 * True when `scanPaths` is empty/missing, or `file` equals or lies under one of them. Moved verbatim from
 * selfcheck.mjs `isUnderScanPaths`.
 * @param {string} file
 * @param {string[]|undefined} scanPaths
 * @returns {boolean}
 */
export function isUnderScanPaths(file, scanPaths) {
  throw new Error('Not implemented: isUnderScanPaths');
}

/**
 * Test-file monotonicity over (baseSha, HEAD] — the exact semantics and violation strings of the current
 * selfcheck.mjs block:
 *  - base test files = files of `git ls-tree -r --name-only <baseSha>` that are test files (isTestFile with
 *    config.testFilePatterns) and under config.bypassScanPaths;
 *  - a monotonicity waiver is a waiver whose `rule` matches /\bmonotonicity\b/i and whose sha7 prefixes a commit
 *    in `commits`; files touched by such commits are exempt;
 *  - deleted at HEAD without a touching commit whose subject contains `ADR-<digits>` and not exempt →
 *    `test file deleted without ADR in commit message: <file>`;
 *  - present and not exempt: count decrease →
 *    `monotonicity: in <file> test/it count decreased from <base> to <head>` and/or
 *    `monotonicity: in <file> assert count decreased from <base> to <head>`.
 * @param {{ realGit: string, cwd: string, baseSha: string, config: object,
 *   commits: Array<{ sha: string, files: string[] }>, waivers?: Array<{ sha7: string, rule: string }> }} opts
 *   `commits` = commitsSince(realGit, cwd, baseSha) supplied by the caller.
 * @returns {string[]} violations in base-file order
 */
export function checkTestMonotonicity({ realGit, cwd, baseSha, config, commits, waivers = [] }) {
  throw new Error('Not implemented: checkTestMonotonicity');
}
