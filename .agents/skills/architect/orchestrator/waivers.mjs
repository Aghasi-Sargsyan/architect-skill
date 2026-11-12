// WAIVER lines of PLAN.md (ADR-073, C-32, Р-10): read only from the committed plan, each WAIVER covers only its
// own rule and its own commit.
import { readGitBlob } from './git-read.mjs';

const RULE_RES = { monotonicity: /\bmonotonicity\b/i, 'fix-frozen': /\bfix-frozen\b/i };

/**
 * Moved verbatim from selfcheck.mjs: `- WAIVER <sha7+>: <rule> — <reason>` lines under `## Decisions` /
 * `## Решения` → `[{ sha7, rule, reason, raw }]`.
 * @param {string} planText
 * @returns {Array<{ sha7: string, rule: string, reason: string, raw: string }>}
 */
export function parseWaivers(planText) {
  if (!planText || typeof planText !== 'string') return [];
  const waivers = [];
  let inDecisions = false;
  for (const line of planText.split('\n')) {
    if (line.startsWith('## ')) inDecisions = /^##\s+(?:decisions|решения)(?![\p{L}\p{N}_])/iu.test(line); // \b is ASCII-only: it never matches after Cyrillic
    else if (inDecisions) {
      const m = line.match(/^- WAIVER\s+([0-9a-fA-F]{7,})\s*:\s*(.+?)\s+(?:[—–]|--|-)\s+(.+)$/);
      if (m) waivers.push({ sha7: m[1], rule: m[2].trim(), reason: m[3].trim(), raw: line.trim() });
    }
  }
  return waivers;
}

/**
 * True when `waiver.rule` names `rule` as a whole word (case-insensitive: /\bmonotonicity\b/i,
 * /\bfix-frozen\b/i) AND `waiver.sha7` is a case-insensitive prefix of `sha`. A WAIVER never covers
 * another rule or another commit; an unknown `rule` is covered by nothing.
 * @param {{ sha7: string, rule: string }} waiver
 * @param {string} sha full commit SHA
 * @param {'monotonicity'|'fix-frozen'} rule
 * @returns {boolean}
 */
export function waiverCovers(waiver, sha, rule) {
  const ruleRe = RULE_RES[rule];
  if (!ruleRe || !waiver || typeof waiver.sha7 !== 'string' || typeof waiver.rule !== 'string' || typeof sha !== 'string') return false;
  return ruleRe.test(waiver.rule) && waiver.sha7 !== '' && sha.toLowerCase().startsWith(waiver.sha7.toLowerCase());
}

/**
 * WAIVERs of the committed plan only: the first of [config?.paths?.planPath, '.architect/PLAN.md',
 * 'PLAN.md'] present at HEAD (git-read.mjs readGitBlob), parsed with parseWaivers; `[]` when none is
 * committed. Never reads the working tree; a git read error propagates (fail-closed).
 * @param {{ realGit: string, cwd: string, config?: object }} opts
 * @returns {Array<{ sha7: string, rule: string, reason: string, raw: string }>}
 */
export function readCommittedWaivers({ realGit, cwd, config } = {}) {
  for (const rel of [config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)) {
    const blob = readGitBlob(realGit, cwd, 'HEAD', rel);
    if (blob.status === 'ok') return parseWaivers(blob.text);
  }
  return [];
}
