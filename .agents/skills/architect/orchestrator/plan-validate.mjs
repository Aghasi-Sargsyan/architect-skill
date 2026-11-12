// Validates parsed PLAN.md structure, closed Risk enum, Frozen paths/globs, and high-risk referenceTests gates.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAlwaysFrozenFile } from './layout.mjs';

const NON_EXEC_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.lock',
  '.sql',
  '.css', '.scss', '.less', '.sass',
  '.html', '.htm',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.csv', '.tsv',
]);

const STRUCTURAL_MARKER_RE = /\bstructural verification\b|структурн(?:ая|ой|ую)\s+проверк/i;

/**
 * Normalizes a task Risk field to 'low' | 'medium' | 'high', or null if invalid/empty.
 * @param {string} raw
 * @returns {'low' | 'medium' | 'high' | null}
 */
export function normalizeRisk(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\.$/, '').toLowerCase();
  if (s === 'low' || s === 'низкий') return 'low';
  if (s === 'medium' || s === 'средний') return 'medium';
  if (s === 'high' || s === 'высокий') return 'high';
  return null;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidRisk(raw) {
  return normalizeRisk(raw) !== null;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isHighRisk(raw) {
  return normalizeRisk(raw) === 'high';
}

/**
 * Checks whether a task explicitly declares structural verification in Test cases.
 * @param {object} task
 * @returns {boolean}
 */
export function hasStructuralVerificationMarker(task) {
  const text = (task?.rawTestCases ?? []).join('\n');
  return STRUCTURAL_MARKER_RE.test(text);
}

/**
 * Returns true when filePath represents executable source/test/script code rather than config, SQL, static, or docs.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExecutableCodeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const norm = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(norm);
  const lowerBase = base.toLowerCase();
  if (
    lowerBase === '.gitignore' ||
    lowerBase === '.dockerignore' ||
    lowerBase === 'makefile' ||
    lowerBase === 'notice' ||
    lowerBase === 'codeowners' ||
    lowerBase === 'executor.md' ||
    lowerBase === 'skill.md' ||
    lowerBase.startsWith('dockerfile') ||
    lowerBase.startsWith('license') ||
    lowerBase.startsWith('readme') ||
    lowerBase.startsWith('changelog')
  ) {
    return false;
  }
  const ext = path.posix.extname(base).toLowerCase();
  if (NON_EXEC_EXTENSIONS.has(ext)) return false;
  return true;
}

/**
 * Validates Frozen section entries against backtick formatting, glob rules, and existing files on disk.
 * @param {object} plan
 * @param {{ workDir?: string, layout?: object }} [opts]
 * @returns {string[]}
 */
export function validateFrozenEntries(plan, opts = {}) {
  const issues = [];
  for (const err of plan?.frozenErrors ?? []) {
    issues.push(`line ${err.line}: ${err.reason} ("${err.text}")`);
  }

  const { workDir, layout } = opts;
  const executorPath = layout?.executorPath ?? 'EXECUTOR.md';

  for (const entry of plan?.frozen ?? []) {
    const norm = String(entry ?? '').replace(/\\/g, '/');
    if (
      path.isAbsolute(norm) ||
      /^[a-zA-Z]:/.test(norm) ||
      norm.startsWith('/') ||
      norm.split('/').includes('..')
    ) {
      issues.push(`Frozen entry "${entry}" must be a relative path without ".."`);
      continue;
    }

    if (!norm.includes('*')) {
      if (norm.endsWith('/')) {
        issues.push(`Frozen entry "${entry}" ends with "/" but lacks a glob pattern; use "${norm}*" or "${norm}**"`);
        continue;
      }

      if (workDir) {
        const fullPath = path.join(workDir, norm);
        if (existsSync(fullPath)) {
          try {
            const st = statSync(fullPath);
            if (st.isDirectory()) {
              issues.push(`Frozen entry "${entry}" is a directory without glob pattern; use "${norm}/*" or "${norm}/**"`);
            }
          } catch (err) {
            issues.push(`Failed to inspect frozen entry "${entry}": ${err.message}`);
          }
        } else if (norm !== 'EXECUTOR.md' && norm !== executorPath) {
          issues.push(`Frozen file "${entry}" not found on disk`);
        }
      }
    }
  }

  return issues;
}

/**
 * Runs all structural and readiness validations on a parsed PLAN.md object.
 * @param {object} plan
 * @param {{ workDir?: string, layout?: object, config?: object }} [opts]
 * @returns {{ ok: boolean, parseIssues: string[], riskIssues: string[], frozenIssues: string[], highRiskTestIssues: string[], changeIssues: string[] }}
 */
export function validatePlan(plan, opts = {}) {
  const parseIssues = (plan?.parseErrors ?? []).map(
    (e) => `line ${e.line}: ${e.reason} ("${e.text}")`,
  );
  const frozenIssues = validateFrozenEntries(plan, opts);
  const riskIssues = [];
  const highRiskTestIssues = [];
  const changeIssues = [];

  for (const t of plan?.tasks ?? []) {
    if (t.done) continue;

    for (const f of t.change ?? []) {
      const norm = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
      if (norm === 'PLAN.md' || norm === '.architect/PLAN.md') {
        changeIssues.push(`task ${t.id}: ${norm} must not be listed in Change (plan edits belong to the Architect)`);
      }
      if (isAlwaysFrozenFile(norm, { workDir: opts.workDir ?? process.cwd() })) {
        changeIssues.push(`task ${t.id}: ${norm} is always frozen for the Executor — change it in an Architect commit (arch: …), not in Change`);
      }
    }

    if (!isValidRisk(t.risk)) {
      riskIssues.push(`task ${t.id}: invalid or empty Risk "${t.risk ?? ''}"`);
    }

    if (isHighRisk(t.risk)) {
      const hasExec = (t.change ?? []).some(isExecutableCodeFile);
      const hasRefs = (t.referenceTests ?? []).length > 0;
      const hasStructural = hasStructuralVerificationMarker(t);

      if (hasExec && !hasRefs && !hasStructural) {
        highRiskTestIssues.push(
          `task ${t.id}: high-risk task with executable code in Change has no frozen referenceTests in PLAN.md`,
        );
      }
    }
  }

  const ok =
    parseIssues.length === 0 &&
    riskIssues.length === 0 &&
    frozenIssues.length === 0 &&
    highRiskTestIssues.length === 0 &&
    changeIssues.length === 0;

  return { ok, parseIssues, riskIssues, frozenIssues, highRiskTestIssues, changeIssues };
}
