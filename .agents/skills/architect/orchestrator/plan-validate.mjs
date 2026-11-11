// Validates parsed PLAN.md structure, closed Risk enum, Frozen paths/globs, and high-risk referenceTests gates.

/**
 * Normalizes a task Risk field to 'low' | 'medium' | 'high', or null if invalid/empty.
 * @param {string} _raw
 * @returns {'low' | 'medium' | 'high' | null}
 */
export function normalizeRisk(_raw) {
  throw new Error('Not implemented: normalizeRisk');
}

/**
 * @param {string} _raw
 * @returns {boolean}
 */
export function isValidRisk(_raw) {
  throw new Error('Not implemented: isValidRisk');
}

/**
 * @param {string} _raw
 * @returns {boolean}
 */
export function isHighRisk(_raw) {
  throw new Error('Not implemented: isHighRisk');
}

/**
 * Checks whether a task explicitly declares structural verification in Test cases.
 * @param {object} _task
 * @returns {boolean}
 */
export function hasStructuralVerificationMarker(_task) {
  throw new Error('Not implemented: hasStructuralVerificationMarker');
}

/**
 * Returns true when filePath represents executable source/test/script code rather than config, SQL, static, or docs.
 * @param {string} _filePath
 * @returns {boolean}
 */
export function isExecutableCodeFile(_filePath) {
  throw new Error('Not implemented: isExecutableCodeFile');
}

/**
 * Validates Frozen section entries against backtick formatting, glob rules, and existing files on disk.
 * @param {object} _plan
 * @param {{ workDir?: string, layout?: object }} [_opts]
 * @returns {string[]}
 */
export function validateFrozenEntries(_plan, _opts = {}) {
  throw new Error('Not implemented: validateFrozenEntries');
}

/**
 * Runs all structural and readiness validations on a parsed PLAN.md object.
 * @param {object} _plan
 * @param {{ workDir?: string, layout?: object, config?: object }} [_opts]
 * @returns {{ ok: boolean, parseIssues: string[], riskIssues: string[], frozenIssues: string[], highRiskTestIssues: string[] }}
 */
export function validatePlan(_plan, _opts = {}) {
  throw new Error('Not implemented: validatePlan');
}
