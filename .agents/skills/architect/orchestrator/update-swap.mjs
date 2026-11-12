// All-or-nothing skill install for --update and the untracked-file guard (C-39, ADR-077).
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function removeQuietly(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* cleanup: leftover staging entry is harmless to the install result */ }
}

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
export function installSkillAtomically({ sourceDir, targets, versionLine, files = [], rename = renameSync }) {
  const id = randomBytes(4).toString('hex');
  const items = [
    ...targets.map((to) => ({ to: path.resolve(to), dir: true })),
    ...files.map((f) => ({ to: path.resolve(f.to), from: f.from, dir: false })),
  ].map((it) => ({ ...it, staged: `${it.to}.update-new-${id}`, old: `${it.to}.update-old-${id}` }));

  const done = [];
  try {
    for (const it of items) {
      mkdirSync(path.dirname(it.to), { recursive: true });
      if (it.dir) {
        cpSync(sourceDir, it.staged, {
          recursive: true,
          filter: (src) => !path.relative(sourceDir, src).split(path.sep).includes('.git'),
        });
        writeFileSync(path.join(it.staged, '.version'), `${versionLine}\n`);
      } else {
        copyFileSync(it.from, it.staged);
      }
    }
    for (const it of items) {
      if (pathExists(it.to)) {
        rename(it.to, it.old);
        done.push({ from: it.to, to: it.old });
      }
      rename(it.staged, it.to);
      done.push({ from: it.staged, to: it.to });
    }
  } catch (err) {
    const undoFailures = [];
    for (const step of done.reverse()) {
      try {
        renameSync(step.to, step.from);
      } catch (undoErr) {
        undoFailures.push(`${step.to} -> ${step.from}: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`);
      }
    }
    if (undoFailures.length > 0) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} (rollback incomplete, restore manually: ${undoFailures.join('; ')})`, { cause: err });
    }
    for (const it of items) removeQuietly(it.staged);
    throw err;
  }

  for (const it of items) removeQuietly(it.old);
  return { replaced: items.filter((it) => it.dir).map((it) => it.to), files: items.filter((it) => !it.dir).map((it) => it.to) };
}

function gitLines(realGit, workDir, args) {
  const res = spawnSync(realGit, args, { cwd: workDir, encoding: 'utf8' });
  if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed (exit ${res.status}): ${(res.stderr ?? '').trim()}`);
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Lists files inside the target skill folders that git reports as untracked (`??`), as
 * workDir-relative POSIX paths, sorted. Ignored files and `.version` files are not listed.
 * A target with no tracked file at all is not managed by git and is skipped.
 * No `.git` in `workDir` → []. A git failure throws: the update must not delete what it cannot see.
 * @param {{ realGit: string, workDir: string, targets: string[] }} opts
 * @returns {string[]}
 */
export function findUntrackedSkillFiles({ realGit, workDir, targets }) {
  if (!existsSync(path.join(workDir, '.git'))) return [];
  const found = [];
  for (const target of targets) {
    const rel = path.relative(workDir, target) || '.';
    if (gitLines(realGit, workDir, ['ls-files', '-z', '--', rel]).length === 0) continue;
    for (const file of gitLines(realGit, workDir, ['ls-files', '-z', '--others', '--exclude-standard', '--', rel])) {
      if (path.posix.basename(file) !== '.version') found.push(file);
    }
  }
  return found.sort();
}
