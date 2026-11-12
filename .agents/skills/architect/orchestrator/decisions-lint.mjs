// Self-check warning for long lines added to the ADR index (C-38, ADR-074).
// Contract stub: the Executor implements it; the JSDoc is the contract.

/** Longest allowed added index line, in Unicode code points. */
export const DECISIONS_INDEX_LINE_LIMIT = 300;

/** ADR index files (classic and compact layouts). `decisions-full.md` is never an index. */
export const DECISIONS_INDEX_FILES = ['docs/decisions.md', '.architect/decisions.md'];

/**
 * Warns about long lines added to the ADR index in the self-check range.
 * - Reads `git diff --unified=0 --no-color --no-ext-diff <baseSha> <headSha> -- <DECISIONS_INDEX_FILES>`;
 *   only added lines count (start with '+' but not '+++'); blank added lines are ignored.
 *   A changed old line is an added line.
 * - Length is `[...line].length` (code points), so Cyrillic text is not penalised.
 * - `baseSha` null or '' → [] (an EMPTY range checks nothing).
 * - A git failure → exactly one warning `decisions index: cannot read the diff (<detail>)`, never silence.
 * - One warning per long line, in diff order:
 *   `decisions index: line too long in <file> (<len> > 300 chars): "<first 60 code points>…" — keep one short line per ADR and move the full text to decisions-full.md`
 * @param {{ realGit: string, cwd: string, baseSha: string | null, headSha?: string }} opts headSha defaults to 'HEAD'
 * @returns {string[]}
 */
export function checkDecisionsIndex(opts) {
  void opts;
  throw new Error('Not implemented');
}
