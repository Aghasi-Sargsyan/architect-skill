// Resolves which installed skill folders `--update` may replace, so a symlinked install is updated once and never replaced by a copy.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveInstalledSkillDir } from './layout.mjs';

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
 * @param {{ workDir?: string, orchestratorDir?: string }} param0
 * @returns {{ targets: string[], skipped: string[] }}
 */
export function resolveSkillUpdateTargets({ workDir = process.cwd(), orchestratorDir } = {}) {
  const candidates = [
    path.join(workDir, '.agents', 'skills', 'architect'),
    path.join(workDir, '.claude', 'skills', 'architect'),
  ];
  const resolved = resolveInstalledSkillDir(workDir, orchestratorDir);
  if (resolved) {
    candidates.push(resolved);
  }

  const targets = [];
  const skipped = [];
  const seenReal = new Set();
  const realWorkDir = realpathSync(workDir);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    let real;
    try {
      real = realpathSync(candidate);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        continue;
      }
      throw err;
    }
    if (seenReal.has(real)) {
      continue;
    }
    seenReal.add(real);

    const rel = path.relative(realWorkDir, real);
    const isInside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (isInside) {
      targets.push(path.join(workDir, rel));
    } else {
      skipped.push(candidate);
    }
  }

  return { targets, skipped };
}
