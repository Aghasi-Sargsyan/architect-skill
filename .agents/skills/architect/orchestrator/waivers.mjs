// WAIVER lines of PLAN.md (ADR-073, C-32, Р-10). Stub committed with the Cycle 37 plan: the Cycle 37 task moves
// parseWaivers here from selfcheck.mjs and narrows every WAIVER to its rule and its commit.

/**
 * Moved verbatim from selfcheck.mjs: `- WAIVER <sha7+>: <rule> — <reason>` lines under `## Decisions` /
 * `## Решения` → `[{ sha7, rule, reason, raw }]`.
 * @param {string} planText
 * @returns {Array<{ sha7: string, rule: string, reason: string, raw: string }>}
 */
export function parseWaivers(_planText) {
  throw new Error('Not implemented');
}

/**
 * True when `waiver.rule` names `rule` as a whole word (case-insensitive: /\bmonotonicity\b/i,
 * /\bfix-frozen\b/i) AND `waiver.sha7` is a case-insensitive prefix of `sha`. A WAIVER never covers
 * another rule or another commit.
 * @param {{ sha7: string, rule: string }} waiver
 * @param {string} sha full commit SHA
 * @param {'monotonicity'|'fix-frozen'} rule
 * @returns {boolean}
 */
export function waiverCovers(_waiver, _sha, _rule) {
  throw new Error('Not implemented');
}

/**
 * WAIVERs of the committed plan only: the first of [config?.paths?.planPath, '.architect/PLAN.md',
 * 'PLAN.md'] present at HEAD (git-read.mjs readGitBlob), parsed with parseWaivers; `[]` when none is
 * committed. Never reads the working tree; a git read error propagates (fail-closed).
 * @param {{ realGit: string, cwd: string, config?: object }} opts
 * @returns {Array<{ sha7: string, rule: string, reason: string, raw: string }>}
 */
export function readCommittedWaivers(_opts = {}) {
  throw new Error('Not implemented');
}
