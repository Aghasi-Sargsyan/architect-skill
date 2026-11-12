// All-or-nothing skill install for --update and the untracked-file guard (C-39, ADR-077).
// Contract stub: the Executor implements it; the JSDoc is the contract.

/**
 * Replaces every target skill folder with a copy of `sourceDir`, all or nothing.
 * 1. Stage: for each target copy `sourceDir` (skipping any path with a `.git` segment) to a sibling
 *    `<target>.update-new-<id>` and write `.version` (`versionLine` + '\n') into it; each `files`
 *    entry is staged as a byte copy of `from` at `<to>.update-new-<id>`.
 * 2. Swap: rename each existing target (then each existing file `to`) to `<path>.update-old-<id>`,
 *    then rename the staged copy into place.
 * 3. Any error in steps 1–2: undo the finished renames in reverse order, delete every staged copy,
 *    and rethrow the original error. Targets and files are then byte-identical to the state before
 *    the call and no `*.update-new-*` / `*.update-old-*` entry is left next to them.
 * 4. Success: delete every `*.update-old-*` entry.
 * `<id>` is one random suffix per call. `rename` is injectable for tests and defaults to fs.renameSync.
 * @param {{ sourceDir: string, targets: string[], versionLine: string,
 *   files?: Array<{ from: string, to: string }>, rename?: (from: string, to: string) => void }} opts
 * @returns {{ replaced: string[], files: string[] }} absolute paths, in input order
 */
export function installSkillAtomically(opts) {
  void opts;
  throw new Error('Not implemented');
}

/**
 * Lists files inside the target skill folders that git reports as untracked (`??`), as
 * workDir-relative POSIX paths, sorted. Ignored files and `.version` files are not listed.
 * A target with no tracked file at all is not managed by git and is skipped.
 * No `.git` in `workDir` → []. A git failure throws: the update must not delete what it cannot see.
 * @param {{ realGit: string, workDir: string, targets: string[] }} opts
 * @returns {string[]}
 */
export function findUntrackedSkillFiles(opts) {
  void opts;
  throw new Error('Not implemented');
}
