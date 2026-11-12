// Fail-closed reads of committed files (ADR-073, C-33, C-45). Stub committed with the Cycle 37 plan.

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
export function readGitBlob(_realGit, _cwd, _ref, _file) {
  throw new Error('Not implemented');
}
