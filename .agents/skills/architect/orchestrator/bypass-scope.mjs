// Scoping of config.bypassPatterns: which file kinds a known pattern applies to and which view of the added line it sees.
// Patterns the code does not know apply to every file and see the raw line, as before.

const JS_FILE = /\.(?:tsx?|jsx?|[mc][jt]s)$/;
const PY_FILE = /\.py$/;
const RS_FILE = /\.rs$/;

export const TEST_SKIP_ONLY_RE = /\b(?:describe|it|test|suite|context|bench|t)(?:\s*\.\s*(?:concurrent|sequential|todo|shuffle|scoped|serial|each|for))*(?:\s*\([^)]*\))?\s*\.\s*(?:skip|only)\s*\(/;

// Keys are the pattern sources from config.example.json; sources that name a directive are split so this file does not flag itself.
const SRC = String.raw;
const RULES = new Map([
  [SRC`[:<,|=>&[(]\s*any\b`, { file: JS_FILE, view: 'code' }],
  [SRC`\bas\s+any\b`, { file: JS_FILE, view: 'code' }],
  [SRC`@ts-(ignore|expect-error|nocheck)`, { file: JS_FILE }],
  ['eslint-' + 'disable', { file: JS_FILE }],
  [SRC`\.(skip|only)\(`, { file: JS_FILE, view: 'code', matcher: TEST_SKIP_ONLY_RE }],
  [SRC`#\s*noqa\b`, { file: PY_FILE }],
  [SRC`#\s*type:\s*ignore`, { file: PY_FILE }],
  [SRC`#\[allow\(`, { file: RS_FILE }],
  [SRC`\[['"](?:skip|only)['"]\]\s*\(`, { file: JS_FILE, testOnly: true, view: 'comments' }],
  [SRC`\b(?:skip|only)\s*:\s*true\b`, { file: JS_FILE, testOnly: true, view: 'comments' }],
  [SRC`\b(?:describe|it|test)\s*\.\s*todo\s*\(`, { file: JS_FILE, testOnly: true, view: 'comments' }],
  [SRC`(?:^|[^\w$.])x(?:it|describe|test)\s*\(`, { file: JS_FILE, testOnly: true, view: 'comments' }],
  [SRC`@pytest\.mark\.(?:skip|skipif|xfail)\b`, { file: PY_FILE }],
]);

/**
 * Blanks comments (`//…`, `/* … *\/`, doc lines starting with `*`) and, when blankStrings is set,
 * the contents of string/template literals; the result keeps the length of the line.
 * An unterminated quote blanks to the end of the line.
 * @param {string} line
 * @param {boolean} blankStrings
 * @returns {string}
 */
export function scrubLine(line, blankStrings) {
  if (/^\s*\*(?:[\s/]|$)/.test(line)) return ' '.repeat(line.length);
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        const esc = line.slice(i, i + 2);
        out += blankStrings ? ' '.repeat(esc.length) : esc;
        i += esc.length - 1;
      } else if (c === quote) {
        quote = '';
        out += c;
      } else {
        out += blankStrings ? ' ' : c;
      }
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
    } else if (c === '/' && line[i + 1] === '/') {
      return out + ' '.repeat(line.length - i);
    } else if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end === -1 ? line.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Whether one bypass pattern hits an added line of `file`.
 * Without a known file (a diff without headers) the pattern sees the raw line.
 * @param {RegExp} re
 * @param {string|null} file
 * @param {string} added
 * @param {boolean} isTest
 * @returns {boolean}
 */
export function bypassHit(re, file, added, isTest) {
  const rule = RULES.get(re.source);
  if (!rule) return re.test(added);
  const matcher = rule.matcher ?? re;
  if (!file) return matcher.test(added);
  if (!rule.file.test(file.toLowerCase()) || (rule.testOnly && !isTest)) return false;
  return matcher.test(rule.view ? scrubLine(added, rule.view === 'code') : added);
}
