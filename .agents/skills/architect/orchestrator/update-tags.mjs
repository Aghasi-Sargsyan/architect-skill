// Release-tag resolution for --update and the update notice (C-39, ADR-076).
// Contract stub: the Executor implements it; the JSDoc is the contract.

/**
 * Release tag format: exactly `vMAJOR.MINOR.PATCH` with decimal numbers (`v3.55.0`).
 * Anything else (`v3.55`, `v3.55.0-rc1`, `x3.55.0`, branch refs) is not a release.
 */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Picks the newest release tag from `git ls-remote --tags <repo>` output.
 * - Lines are `<sha>\trefs/tags/<name>` or `<sha>\trefs/tags/<name>^{}` (peeled annotated tag).
 * - Only names matching RELEASE_TAG_RE count; order is numeric by (major, minor, patch): v3.10.0 > v3.9.0.
 * - For an annotated tag the peeled commit SHA (`^{}` line) wins over the tag-object SHA,
 *   whatever the line order; a lightweight tag uses its own SHA.
 * - SHAs are returned lower-case; a line whose SHA is not 40 hex characters is ignored.
 * @param {string} lsRemoteOutput
 * @returns {{ tag: string, sha: string } | null} null when no release tag is present
 */
export function pickLatestReleaseTag(lsRemoteOutput) {
  void lsRemoteOutput;
  throw new Error('Not implemented');
}

/**
 * Resolves the newest release tag of a remote repository with one
 * `git ls-remote --tags <repoUrl>` call (env GIT_TERMINAL_PROMPT=0, timeout `timeoutMs`).
 * Never throws: a spawn error, timeout, or non-zero exit is `unreachable`.
 * @param {{ realGit: string, repoUrl: string, timeoutMs?: number, env?: Record<string, string | undefined> }} opts
 * @returns {{ ok: true, tag: string, sha: string }
 *   | { ok: false, reason: 'unreachable' | 'no-release-tags', detail: string }}
 */
export function resolveLatestReleaseTag(opts) {
  void opts;
  throw new Error('Not implemented');
}
