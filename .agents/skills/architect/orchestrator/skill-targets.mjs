// Resolves which installed skill folders `--update` may replace, so a symlinked install is updated once and never replaced by a copy.

/**
 * Resolves the installed architect skill folders that `--update` may replace.
 *
 * Candidates, in this order:
 *   1. `<workDir>/.agents/skills/architect`
 *   2. `<workDir>/.claude/skills/architect`
 *   3. `resolveInstalledSkillDir(workDir, orchestratorDir)` from `layout.mjs`, when it is not null.
 *
 * Rules:
 * - A candidate that does not exist (`existsSync` is false, including a dangling symlink) is ignored.
 * - Every existing candidate is resolved with `realpathSync`; `realWorkDir = realpathSync(workDir)`.
 * - A candidate whose real path is not strictly inside `realWorkDir` goes to `skipped`, spelled exactly
 *   as in the candidate list, and is never a target.
 * - Otherwise its target is `path.join(workDir, path.relative(realWorkDir, realCandidate))`: the real
 *   folder spelled under `workDir`. A symlink is therefore never a target, so replacing a target can
 *   never delete a link.
 * - Entries are de-duplicated by real path (the first candidate wins) and keep candidate order.
 * - Errors other than a missing path propagate (fail-closed).
 *
 * @param {{ workDir: string, orchestratorDir?: string }} param0
 * @returns {{ targets: string[], skipped: string[] }}
 */
export function resolveSkillUpdateTargets({ workDir, orchestratorDir } = {}) {
  throw new Error(`Not implemented: resolveSkillUpdateTargets(${workDir}, ${orchestratorDir})`);
}
