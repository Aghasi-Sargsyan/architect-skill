// Per-project control directory outside the working tree: ~/.config/architect/runs/<slug>-<hash8>/ (mode 0700).
// It holds what an agent must not write: the guard shims (shims/) and the permission question and answer files.
// Run logs stay in <workDir>/.agent-runs/. Owner: the Architect (Frozen); the path is part of the claude allowlist.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realOrResolved } from './permissions.mjs';

export const CONTROL_DIR_MODE = 0o700;

/**
 * Stable key of a project: sanitized basename of the real path plus 8 hex of its SHA-256
 * (the same scheme as the per-project claude settings file).
 * @param {string} workDir
 * @returns {string} e.g. "my-app-1a2b3c4d"
 */
export function projectKey(workDir) {
  const real = realOrResolved(workDir);
  const slug = path.basename(real).replace(/[^a-zA-Z0-9._-]/g, '_') || 'project';
  const hash8 = createHash('sha256').update(real).digest('hex').slice(0, 8);
  return `${slug}-${hash8}`;
}

/**
 * Path of the control directory; no side effects.
 * @param {{ workDir: string, home?: string }} opts
 * @returns {string} <home>/.config/architect/runs/<projectKey(workDir)>
 */
export function controlDirFor({ workDir, home = os.homedir() }) {
  return path.join(home, '.config', 'architect', 'runs', projectKey(workDir));
}

/**
 * Path of the shim directory inside the control directory; no side effects.
 * @param {{ workDir: string, home?: string }} opts
 * @returns {string} <controlDirFor(opts)>/shims
 */
export function controlShimDir({ workDir, home = os.homedir() }) {
  return path.join(controlDirFor({ workDir, home }), 'shims');
}

/**
 * Creates the control directory (parents as needed) and forces mode 0700 on it.
 * Fail-closed: a symlink, a non-directory or a directory of another user at that path throws.
 * @param {{ workDir: string, home?: string }} opts
 * @returns {string} the control directory path
 */
export function ensureControlDir({ workDir, home = os.homedir() }) {
  const dir = controlDirFor({ workDir, home });
  mkdirSync(path.dirname(dir), { recursive: true });
  let st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) {
    mkdirSync(dir, { mode: CONTROL_DIR_MODE });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`control directory is not a plain directory: ${dir}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`control directory belongs to another user: ${dir}`);
  chmodSync(dir, CONTROL_DIR_MODE);
  return dir;
}

/**
 * Ensures the control directory and returns an empty shim directory in it: shims left by an earlier run
 * (a file the agent planted there included) are removed before the loop writes its own.
 * @param {{ workDir: string, home?: string }} opts
 * @returns {string} <controlDirFor(opts)>/shims, existing and empty
 */
export function freshShimDir({ workDir, home = os.homedir() }) {
  ensureControlDir({ workDir, home });
  const dir = controlShimDir({ workDir, home });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: CONTROL_DIR_MODE });
  return dir;
}
