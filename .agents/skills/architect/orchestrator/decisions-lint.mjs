// Self-check warning for long lines added to the ADR index (C-38, ADR-074).
import { spawnSync } from 'node:child_process';

/** Longest allowed added index line, in Unicode code points. */
export const DECISIONS_INDEX_LINE_LIMIT = 300;

/** ADR index files (classic and compact layouts). `decisions-full.md` is never an index. */
export const DECISIONS_INDEX_FILES = ['docs/decisions.md', '.architect/decisions.md'];

const MAX_BUFFER = 256 * 1024 * 1024;
const EXCERPT_LENGTH = 60;
const FILE_HEADER = '+++ b/';

function diffWarning(detail) {
  return `decisions index: cannot read the diff (${detail})`;
}

function readDiff({ realGit, cwd, baseSha, headSha }) {
  if (baseSha.startsWith('-') || headSha.startsWith('-')) {
    return { error: 'ref must not start with "-"' };
  }
  const res = spawnSync(
    realGit,
    ['diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha, headSha, '--', ...DECISIONS_INDEX_FILES],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, AGENT_LOOP: '' },
    },
  );
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) return { error: res.stderr.trim() || `git diff exited with ${res.status}` };
  return { text: res.stdout };
}

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
export function checkDecisionsIndex({ realGit, cwd, baseSha, headSha = 'HEAD' }) {
  if (!baseSha) return [];
  const diff = readDiff({ realGit, cwd, baseSha, headSha });
  if (diff.error !== undefined) return [diffWarning(diff.error)];

  const warnings = [];
  let file = null;
  let inHunk = false;
  for (const raw of diff.text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    } else if (raw.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk) {
      if (raw.startsWith(FILE_HEADER)) file = raw.slice(FILE_HEADER.length);
    } else if (raw.startsWith('+') && file !== null) {
      const chars = [...raw.slice(1).replace(/\r$/, '')];
      if (chars.join('').trim() === '' || chars.length <= DECISIONS_INDEX_LINE_LIMIT) continue;
      const excerpt = chars.slice(0, EXCERPT_LENGTH).join('');
      warnings.push(
        `decisions index: line too long in ${file} (${chars.length} > ${DECISIONS_INDEX_LINE_LIMIT} chars): "${excerpt}…" — keep one short line per ADR and move the full text to decisions-full.md`,
      );
    }
  }
  return warnings;
}
