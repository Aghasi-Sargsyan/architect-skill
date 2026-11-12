// Fail-closed reads of committed files (ADR-073, C-33, C-45).
import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;
const TREE_ENTRY_RE = /^\d+ (\w+) ([0-9a-f]+)\t/;

function runGit(realGit, cwd, args, what) {
  const res = spawnSync(realGit, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, AGENT_LOOP: '' },
  });
  if (res.error) throw new Error(`cannot read ${what}: ${res.error.message}`);
  return res;
}

/**
 * Reads `<ref>:<file>` for security checks without writing anything to the parent's stderr.
 *  - `ref` must resolve to a commit (`git rev-parse --verify --quiet <ref>^{commit}`), otherwise throw;
 *  - the path is absent from that commit's tree (`git ls-tree <ref> -- <file>` prints nothing) →
 *    `{ status: 'missing' }` — the only non-error "no content" outcome;
 *  - otherwise the blob is read (`git cat-file blob <oid>`); any failure (unreadable or corrupt object,
 *    git error) → throw an Error whose message names `<ref>:<file>` and includes git's stderr.
 * Every git call pipes stdin/stdout/stderr (no inherited stderr — no `fatal: path …` noise) and runs with
 * `env: { ...process.env, AGENT_LOOP: '' }` like git.mjs.
 * @param {string} realGit
 * @param {string} cwd
 * @param {string} ref
 * @param {string} file repo-relative path
 * @returns {{ status: 'ok', text: string } | { status: 'missing' }}
 */
export function readGitBlob(realGit, cwd, ref, file) {
  const what = `${ref}:${file}`;
  if (ref.startsWith('-')) throw new Error(`cannot read ${what}: ref must not start with "-"`);

  const resolved = runGit(realGit, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], what);
  if (resolved.status !== 0) {
    throw new Error(`cannot read ${what}: ${ref} does not resolve to a commit${resolved.stderr.trim() ? `: ${resolved.stderr.trim()}` : ''}`);
  }

  const tree = runGit(realGit, cwd, ['ls-tree', ref, '--', file], what);
  if (tree.status !== 0) throw new Error(`cannot read ${what}: ${tree.stderr.trim() || `git ls-tree exited with ${tree.status}`}`);
  const firstLine = tree.stdout.split('\n').find(Boolean);
  if (firstLine === undefined) return { status: 'missing' };
  const entry = TREE_ENTRY_RE.exec(firstLine);
  if (!entry || entry[1] !== 'blob') throw new Error(`cannot read ${what}: not a regular file in the tree`);

  const blob = runGit(realGit, cwd, ['cat-file', 'blob', entry[2]], what);
  if (blob.status !== 0) throw new Error(`cannot read ${what}: ${blob.stderr.trim() || `git cat-file exited with ${blob.status}`}`);
  return { status: 'ok', text: blob.stdout };
}
