// Test monotonicity over a commit range (ADR-064, C-10): shared by the self-check and by the loop's
// pre-acceptance check from the task base.
import { git } from './git.mjs';
import { isTestFile } from './mechanics.mjs';

const DEFAULT_TEST_PATTERNS = ['\\b(?:test|it)\\s*\\(', '^\\s*def\\s+test_'];
const DEFAULT_ASSERT_PATTERNS = ['\\bassert\\.', '\\bexpect\\s*\\(', '^\\s*assert\\s+\\S'];

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Counts matches of `patterns` (or `fallback` when patterns is empty/not an array) in `content`
 * with flags 'gm'. Moved verbatim from selfcheck.mjs `countByPatterns`.
 * @param {string} content
 * @param {Array<string|RegExp>|undefined} patterns
 * @param {string[]} fallback
 * @returns {number}
 */
export function countByPatterns(content, patterns, fallback) {
  const list = Array.isArray(patterns) && patterns.length > 0 ? patterns : fallback;
  let total = 0;
  for (const p of list) total += (content.match(new RegExp(p instanceof RegExp ? p.source : String(p), 'gm')) ?? []).length;
  return total;
}

/** Test-call count with `config.testPatterns` or the selfcheck.mjs DEFAULT_TEST_PATTERNS (moved here). */
export function countTests(content, config) {
  return countByPatterns(content, config?.testPatterns, DEFAULT_TEST_PATTERNS);
}

/** Assertion count with `config.assertPatterns` or the selfcheck.mjs DEFAULT_ASSERT_PATTERNS (moved here). */
export function countAsserts(content, config) {
  return countByPatterns(content, config?.assertPatterns, DEFAULT_ASSERT_PATTERNS);
}

/**
 * True when `scanPaths` is empty/missing, or `file` equals or lies under one of them. Moved verbatim from
 * selfcheck.mjs `isUnderScanPaths`.
 * @param {string} file
 * @param {string[]|undefined} scanPaths
 * @returns {boolean}
 */
export function isUnderScanPaths(file, scanPaths) {
  if (!scanPaths || !scanPaths.length) return true;
  const n = norm(file);
  return scanPaths.some((p) => {
    const np = norm(p).replace(/\/+$/, '');
    return n === np || n.startsWith(np + '/');
  });
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
  const violations = [];
  const lsTree = (ref) => git(realGit, cwd, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
  const headFileSet = new Set(lsTree('HEAD'));
  const baseTestFiles = lsTree(baseSha).filter((f) => isTestFile(f, config?.testFilePatterns) && isUnderScanPaths(f, config?.bypassScanPaths));
  const monoWaivedFiles = new Set(commits.filter((c) => waivers.some((w) => /\bmonotonicity\b/i.test(w.rule) && c.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))).flatMap((c) => c.files.map(norm)));

  for (const testFile of baseTestFiles) {
    if (!headFileSet.has(testFile)) {
      if (!commits.some((c) => c.files.map(norm).includes(norm(testFile)) && /\bADR-\d+\b/.test(c.subject)) && !monoWaivedFiles.has(norm(testFile))) {
        violations.push(`test file deleted without ADR in commit message: ${testFile}`);
      }
    } else if (!monoWaivedFiles.has(norm(testFile))) {
      const baseContent = git(realGit, cwd, ['show', `${baseSha}:${testFile}`]), headContent = git(realGit, cwd, ['show', `HEAD:${testFile}`]);
      const baseTests = countTests(baseContent, config), headTests = countTests(headContent, config);
      if (headTests < baseTests) violations.push(`monotonicity: in ${testFile} test/it count decreased from ${baseTests} to ${headTests}`);
      const baseAsserts = countAsserts(baseContent, config), headAsserts = countAsserts(headContent, config);
      if (headAsserts < baseAsserts) violations.push(`monotonicity: in ${testFile} assert count decreased from ${baseAsserts} to ${headAsserts}`);
    }
  }
  return violations;
}
