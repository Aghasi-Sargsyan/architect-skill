// Catch-block scanners (ADR-073, C-33): the diff splitter, the lenient legacy scanner and the strict scanner
// used by the self-check. selfcheck.mjs re-exports the legacy API; this module never imports selfcheck.mjs.

/** Cleanup calls that may be wrapped in `try { <one call>; } catch { /* cleanup: <reason> *\/ }`. */
export const CLEANUP_CALLS = [
  'close', 'stop', 'abort', 'kill', 'destroy', 'disconnect', 'unref', 'end', 'restore', 'terminate',
  'removeAllListeners', 'clearTimeout', 'clearInterval', 'rmSync', 'rmdirSync', 'unlinkSync', 'closeSync',
];

const CATCH_RE = /(?:^|[^\w.])(catch\s*(?:\([^)]*\))?\s*\{([^}]*)\})/g;
const PROMISE_CATCH_RE = /(\.catch\s*\(\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)?\s*(?:=>|function[^{]*)\s*\{([^}]*)\}\s*\))/g;
const CLEANUP_RE = /\b(?:stop|abort|close)\b/i;
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/.*/g;
const VOID_ONLY_RE = /^(?:void\s+[A-Za-z_$][\w$]*\s*;?\s*)+$/;
const CLEANUP_COMMENT_RE = /\bcleanup:\s*\S/;
const CALL_HEAD_RE = /^(?:await\s+)?(?:[\w$]+\s*(?:\?\.|\.)\s*)*([\w$]+)\s*\(/;

/**
 * Moved verbatim from selfcheck.mjs (unchanged semantics, selfcheck.test.mjs, packaging-clean.test.mjs).
 * @param {string} diffText
 * @returns {Array<{ file: string, hunks: string[][] }>}
 */
export function splitDiffByFiles(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const files = [];
  let cur = null, hunk = [], hunks = [];
  const pushFile = () => {
    if (!cur) return;
    if (hunk.length) hunks.push(hunk);
    files.push({ file: cur, hunks });
    cur = null; hunk = []; hunks = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      pushFile();
      const raw = line.slice(6).split('\t')[0].trim();
      cur = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    } else if (line.startsWith('@@')) {
      if (hunk.length) { hunks.push(hunk); hunk = []; }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.push(line.slice(1));
    }
  }
  pushFile();
  return files;
}

/**
 * Moved verbatim from selfcheck.mjs: the lenient legacy scanner (a comment with stop|abort|close exempts a
 * comment-only catch). Kept for API compatibility only; the self-check uses findSilentCatches.
 * @param {string} diffText
 * @returns {Array<{ file: string, lines: string[], line: string }>}
 */
export function findEmptyCatches(diffText) {
  const result = [];
  const scan = (text, re, file) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[2];
      const stripped = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim();
      if (stripped === '' && !CLEANUP_RE.test(body)) {
        const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
        result.push({ file, lines, line: m[1].trim() });
      }
    }
  };
  for (const { file, hunks } of splitDiffByFiles(diffText)) {
    for (const hunk of hunks) {
      const text = hunk.join('\n');
      scan(text, CATCH_RE, file);
      scan(text, PROMISE_CATCH_RE, file);
    }
  }
  return result;
}

function openingBrace(text, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{' && --depth === 0) return i;
  }
  return -1;
}

function isSingleCleanupCall(code) {
  const stmt = code.replace(COMMENT_RE, '').trim().replace(/;$/, '').trim();
  const head = CALL_HEAD_RE.exec(stmt);
  if (!head || !CLEANUP_CALLS.includes(head[1])) return false;
  let depth = 0;
  for (let i = head[0].length - 1; i < stmt.length; i++) {
    if (stmt[i] === '(') depth++;
    else if (stmt[i] === ')' && --depth === 0) return i === stmt.length - 1;
  }
  return false;
}

function hasCleanupTry(text, catchStart) {
  const before = text.slice(0, catchStart).trimEnd();
  if (!before.endsWith('}')) return false;
  const open = openingBrace(before, before.length - 1);
  if (open === -1 || !/\btry\s*$/.test(before.slice(0, open))) return false;
  return isSingleCleanupCall(before.slice(open + 1, before.length - 1));
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
export function findSilentCatches(diffText) {
  const result = [];
  const scan = (text, re, file, isClause) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[2];
      const stripped = body.replace(COMMENT_RE, '').trim();
      if (stripped !== '' && !VOID_ONLY_RE.test(stripped)) continue;
      const catchStart = m.index + m[0].length - m[1].length;
      if (isClause && CLEANUP_COMMENT_RE.test(body) && hasCleanupTry(text, catchStart)) continue;
      const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
      result.push({ file, lines, line: m[1].trim() });
    }
  };
  for (const { file, hunks } of splitDiffByFiles(diffText)) {
    for (const hunk of hunks) {
      const text = hunk.join('\n');
      scan(text, CATCH_RE, file, true);
      scan(text, PROMISE_CATCH_RE, file, false);
    }
  }
  return result;
}
