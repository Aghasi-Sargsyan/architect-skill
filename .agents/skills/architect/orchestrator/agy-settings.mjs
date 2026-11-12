// The shared Antigravity settings file (~/.gemini/antigravity-cli/settings.json): read, merge, check.
// The settings-file functions of permissions.mjs move here (C-21, ADR-066); permissions.mjs re-exports them.

/**
 * CONTRACT (C-21, ADR-066): is `rule` a file rule of another project in the shared settings file?
 * A rule `write_file(T)` or `read_file(T)` is foreign when realOrResolved(T) is exactly the root of a git
 * project (`T/.git` exists — a directory or a worktree file) and that root is not the current project
 * (realOrResolved(workDir)), not inside it and not above it, and is not the home directory or above it.
 * Anything else (another kind of rule, a subdirectory of a project, a directory without .git, a parent
 * of the current project) is not foreign: the function returns null and `ruleProblem` decides.
 * @param {string} rule
 * @param {{ workDir: string, home: string }} ctx
 * @returns {string | null} a note for the check output, e.g. "write_file of another project (<T>)"; it contains "another project"
 */
export function foreignProjectRule(rule, ctx) {
  void rule;
  void ctx;
  throw new Error('Not implemented');
}
