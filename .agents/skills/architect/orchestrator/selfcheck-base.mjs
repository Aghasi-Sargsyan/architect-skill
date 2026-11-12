// Self-check range (ADR-073, C-31). Stub committed with the Cycle 37 plan: the Cycle 37 task moves
// resolveSelfCheckBase here from selfcheck.mjs and adds resolveSelfCheckRange.

/**
 * Moved from selfcheck.mjs with the same priority and result: `--base` (`source: 'explicit'`, unresolvable →
 * throw with the fetch-depth hint) > last `arch: close cycle` / `arch: закрытие цикла` commit that is not
 * HEAD (`'close-cycle'`) > `@{u}` only when no close commit exists (`'upstream'`) > root commit (`'root'`).
 * Change: a close commit that changes no files (an empty commit) is never a candidate — it cannot reset the
 * range. A close commit without a plan archive still is (selfcheck.test.mjs), see resolveSelfCheckRange.
 * @param {{ realGit: string, cwd: string, baseRef?: string|null }} opts
 * @returns {{ sha: string, source: 'explicit'|'close-cycle'|'upstream'|'root' }}
 */
export function resolveSelfCheckBase(_opts = {}) {
  throw new Error('Not implemented');
}

/**
 * The self-check range (base, HEAD] with what the report must show about it.
 *  - `commitCount` = `git rev-list --count <base>..HEAD`; `empty` = baseSha === headSha;
 *  - violations: shallow repository (`git rev-parse --is-shallow-repository` → `true`) without an explicit
 *    `baseRef` → `shallow clone: the self-check range cannot be verified — fetch the full history
 *    (fetch-depth: 0) or pass --base <ref>`;
 *  - warnings: `source === 'close-cycle'` and the base commit changes no `docs/plans/*.md` /
 *    `.architect/plans/*.md` file → `self-check base <sha7> is an arch: close cycle commit without a plan
 *    archive (docs/plans/*.md)`.
 * @param {{ realGit: string, cwd: string, baseRef?: string|null }} opts
 * @returns {{ baseSha: string, headSha: string, source: string, commitCount: number, empty: boolean,
 *   violations: string[], warnings: string[] }}
 */
export function resolveSelfCheckRange(_opts = {}) {
  throw new Error('Not implemented');
}
