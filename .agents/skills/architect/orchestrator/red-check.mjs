// Reference-test red-check (ADR-073, C-34). Stub committed with the Cycle 37 plan: the Cycle 37 task moves
// runRedCheck here from evidence.mjs and makes "red" mean a confirmed test-case failure.

/**
 * Runs the reference tests of open high-risk tasks before the Executor runs (red-check).
 *
 * Same options, skip rules and result shape as evidence.mjs `runRedCheck` today
 * (`{ ok, skipped, reason?, violations, notVerified, checked }`), with these changes:
 *  - default template (`node --test` / `node --test {file}`): the reference test runs through
 *    runTaskVerification as `node --test --test-reporter=spec --test-reporter-destination=stdout
 *    --test-reporter=<file URL of red-check-reporter.mjs> --test-reporter-destination=stderr <file>`;
 *    the last `ARCHITECT_RED_CHECK ` line of the output carries the structured result;
 *  - red = non-zero exit, at least one entry in `caseFailures` and none in `otherFailures`;
 *    `checked[i] = { file, status: 'red', failure, exitCode, outputTail }` where `failure` is
 *    'assertion' (every case failure has code ERR_ASSERTION), 'not-implemented' (every case failure is an
 *    assertion or has a message matching /not implemented/i, at least one of the latter) or 'error';
 *    'error' also adds `reference test <file> is red on <errorName>, not on an assertion (NOT VERIFIED)`
 *    to `notVerified` (non-blocking);
 *  - anything else after a non-zero exit is NOT a red: one violation
 *    (`reference test <file> failed to load (ERR_MODULE_NOT_FOUND): …` /
 *    `reference test <file> has syntax error (SyntaxError): …` when the output names them, otherwise
 *    `reference test <file> red not confirmed: failure outside a test case (load error, top-level throw or
 *    process.exit)` or `reference test <file> red not confirmed: no red-check reporter result`) plus
 *    `reference test <file>: red not confirmed (NOT VERIFIED)` in `notVerified`;
 *  - custom template: red only when `config.redCheckConfirmPattern` (non-empty string, RegExp source,
 *    flag 'm') matches the output tail → `failure: 'pattern'`; unset → violation
 *    `reference test <file> red not confirmed: redCheckConfirmPattern is not configured for custom
 *    redCheckCommand`; no match → violation `reference test <file> red not confirmed: output does not match
 *    redCheckConfirmPattern`; both add the NOT VERIFIED line above;
 *  - unchanged: green (exit 0), timeout, disallowed command, unsuitable template (non-blocking NOT VERIFIED),
 *    high-risk tasks without referenceTests, Executor-commit and escalation-resume skips.
 * @param {{ realGit: string, cwd?: string, baseSha: string, plan?: object, config?: object, env?: object }} opts
 * @returns {{ ok: boolean, skipped: boolean, reason?: string, violations: string[], notVerified: string[],
 *   checked: Array<{ file: string, status: 'red', failure: 'assertion'|'not-implemented'|'error'|'pattern',
 *   exitCode: number, outputTail: string }> }}
 */
export function runRedCheck(_opts = {}) {
  throw new Error('Not implemented');
}
