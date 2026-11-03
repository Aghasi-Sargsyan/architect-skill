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

/** Commits in (base, HEAD], oldest first, with subject, body, parents, isMerge flag, and touched files. */
export function commitsSince(realGit, cwd, base) {
  const shas = git(realGit, cwd, ['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
  return shas.map((sha) => {
    const parents = git(realGit, cwd, ['show', '-s', '--format=%P', sha]).split(/\s+/).filter(Boolean);
    return {
      sha,
      subject: git(realGit, cwd, ['show', '-s', '--format=%s', sha]),
      body: git(realGit, cwd, ['show', '-s', '--format=%b', sha]),
      parents,
      isMerge: parents.length > 1,
      files: git(realGit, cwd, ['show', '--name-only', '--no-renames', '--format=', sha]).split('\n').filter(Boolean),
    };
  });
}

/** Resolves common ancestor between baseRef and headRef using git merge-base, falling back to baseRef. */
export function resolveMergeBase(realGit, cwd, baseRef, headRef = 'HEAD') {
  try {
    return git(realGit, cwd, ['merge-base', baseRef, headRef]);
  } catch (err) {
    if (!err || typeof err !== 'object') throw err;
    // cleanup: abort merge-base resolution and fallback to baseRef
    return baseRef;
  }
}

const SQUASH_PR_RE = /\(#\d+\)/;
const SQUASH_BODY_MARKERS_RE = /(?:Squashed commit of the following:|^\*\s+(?:T-\d+|arch:))/m;
const PLAN_TASK_DONE_RE = /^\+\s*-\s*\[x\]\s*(T-\d+):/m;
const isPlan = (f) => f === 'PLAN.md' || f === '.architect/PLAN.md';

/**
 * Returns violations if commits in range represent squashed changes.
 * Suffix (#N) in subject is only flagged if accompanied by a second squash indicator.
 */
export function findSquashViolations({ realGit, cwd, baseSha, headSha = 'HEAD', commits: rawCommits }) {
  const violations = [];
  const commits = rawCommits ?? (baseSha ? commitsSince(realGit, cwd, baseSha) : []);

  for (const c of commits) {
    if (c.isMerge) continue;
    const short = c.sha.slice(0, 7);
    const hasPrSuffix = SQUASH_PR_RE.test(c.subject);
    const hasSquashBody = SQUASH_BODY_MARKERS_RE.test(c.body || '');

    if (hasSquashBody && (hasPrSuffix || /Squashed commit of the following:/.test(c.body || ''))) {
      violations.push(`squash commit detected (${short}): squashed commit markers in body ("${c.subject}")`);
      continue;
    }

    if (hasPrSuffix) {
      const touchesPlan = c.files.some(isPlan);
      const touchesCode = c.files.some((f) => !isPlan(f));
      if (touchesPlan && touchesCode) {
        try {
          const planDiff = git(realGit, cwd, ['show', '-U0', c.sha, '--', 'PLAN.md', '.architect/PLAN.md']);
          if (PLAN_TASK_DONE_RE.test(planDiff)) {
            violations.push(`squash commit detected (${short}): mixed task completion in PLAN.md and code files in single commit ("${c.subject}")`);
            continue;
          }
        } catch (err) {
          if (!err || typeof err !== 'object') throw err;
          // cleanup: abort plan diff inspection
        }
      }
    }
  }

  // Check 3: If any commit has (#N), check if a task was marked done on baseSha..headSha without its own commit
  const prCommit = commits.find((c) => !c.isMerge && SQUASH_PR_RE.test(c.subject));
  if (prCommit && baseSha && headSha && baseSha !== headSha) {
    try {
      const planDiff = git(realGit, cwd, ['diff', '-U0', baseSha, headSha, '--', 'PLAN.md', '.architect/PLAN.md']);
      const doneTaskMatches = [...planDiff.matchAll(/^\+\s*-\s*\[x\]\s*(T-\d+):/gm)];
      for (const m of doneTaskMatches) {
        const taskId = m[1];
        const hasCommit = commits.some((c) => new RegExp(`^${taskId}(?:\\s*\\(fix\\s+\\d+\\))?:`).test(c.subject));
        if (!hasCommit) {
          violations.push(`squash commit detected (${prCommit.sha.slice(0, 7)}): task ${taskId} marked [x] in PLAN.md without corresponding commit ${taskId}: ("${prCommit.subject}")`);
        }
      }
    } catch (err) {
      if (!err || typeof err !== 'object') throw err;
      // cleanup: abort range plan diff inspection
    }
  }

  return violations;
}
