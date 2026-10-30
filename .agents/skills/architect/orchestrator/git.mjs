// Thin git helpers. Always the real git binary with AGENT_LOOP unset, never the agent-facing shim.
import { execFileSync } from 'node:child_process';

export function gitRaw(realGit, cwd, args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } });
}

export function git(realGit, cwd, args) {
  return gitRaw(realGit, cwd, args).trim();
}

export function head(realGit, cwd) {
  return git(realGit, cwd, ['rev-parse', 'HEAD']);
}

/** true if `p` is git-ignored, false if not; throws outside a repository or on other git errors. */
export function isIgnored(realGit, cwd, p) {
  try {
    git(realGit, cwd, ['check-ignore', '-q', p]);
    return true;
  } catch (err) {
    if (err instanceof Error && 'status' in err && err.status === 1) return false;
    throw err;
  }
}

export function porcelain(realGit, cwd) {
  return git(realGit, cwd, ['status', '--porcelain', '--untracked-files=normal']);
}

/** Commits in (base, HEAD], oldest first, with subject and touched files. */
export function commitsSince(realGit, cwd, base) {
  const shas = git(realGit, cwd, ['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
  return shas.map((sha) => ({
    sha,
    subject: git(realGit, cwd, ['show', '-s', '--format=%s', sha]),
    files: git(realGit, cwd, ['show', '--name-only', '--no-renames', '--format=', sha]).split('\n').filter(Boolean),
  }));
}
