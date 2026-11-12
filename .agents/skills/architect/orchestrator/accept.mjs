// Deterministic task acceptance in the automated loop (ADR-061 R-2, ADR-064): the orchestrator, not the
// Architect model, marks the task [x] in PLAN.md and creates the `arch: accept T-NNN` commit.
// Signatures and JSDoc are the contract written by the Architect.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, head, porcelain } from './git.mjs';

const OPEN_PREFIX = '- [ ] ';
const DONE_PREFIX = '- [x] ';

/**
 * Pure. Switches exactly one task line `- [ ] <taskId>: …` (column 0, as plan.mjs TASK_RE) to `- [x] <taskId>: …`.
 * Every other byte of `planText` is preserved (line endings included).
 * @param {string} planText
 * @param {string} taskId
 * @returns {string}
 * @throws {Error} fail-closed:
 *   - task already `[x]`: message contains `already marked [x]`;
 *   - no open line for the task: message contains `not found`;
 *   - more than one open line for the task: message contains `more than once`.
 */
export function markTaskDone(planText, taskId) {
  // Lines keep their trailing "\r", so CRLF plans round-trip byte for byte.
  const lines = planText.split('\n');
  const open = [];
  let done = 0;
  lines.forEach((line, i) => {
    if (line.startsWith(`${OPEN_PREFIX}${taskId}:`)) open.push(i);
    else if (line.startsWith(`${DONE_PREFIX}${taskId}:`)) done += 1;
  });
  if (open.length > 1) throw new Error(`task ${taskId} is open more than once in the plan`);
  if (open.length === 0) {
    if (done > 0) throw new Error(`task ${taskId} is already marked [x] in the plan`);
    throw new Error(`task ${taskId} not found as an open task line in the plan`);
  }
  const i = open[0];
  lines[i] = `${DONE_PREFIX}${lines[i].slice(OPEN_PREFIX.length)}`;
  return lines.join('\n');
}

/**
 * Acceptance commit subject by project commit language (`commitLanguage` from config).
 * @param {string} taskId
 * @param {string|null|undefined} commitLanguage
 * @returns {string} `arch: приёмка <taskId>` for 'ru'; `arch: accept <taskId>` otherwise.
 */
export function acceptanceSubject(taskId, commitLanguage) {
  return commitLanguage === 'ru' ? `arch: приёмка ${taskId}` : `arch: accept ${taskId}`;
}

function errorText(err) {
  if (!(err instanceof Error)) return String(err);
  const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
  return stderr ? `${err.message}\n${stderr}` : err.message;
}

/**
 * Marks `taskId` done in `<cwd>/<planPath>` and commits only that file with the real git binary
 * (git.mjs helpers: AGENT_LOOP unset, never the agent-facing shim, never `--no-verify`).
 * Preconditions, checked before any write (failure → `{ ok: false, error }`, file and repo untouched):
 *   1. `git rev-parse HEAD` === expectedHead (error contains `HEAD moved`);
 *   2. `git status --porcelain --untracked-files=normal` is empty (error contains `working tree is not clean`);
 *   3. markTaskDone succeeds on the current file content (error is its message).
 * Steps: write the new plan text; `git add -- <planPath>`; `git commit --only -m <acceptanceSubject> -- <planPath>`.
 * Postconditions (failure → error contains `postcondition`): new HEAD's first parent === expectedHead;
 *   `git show --name-only --format= HEAD` lists exactly `<planPath>`; working tree clean.
 * If `git add` or `git commit` fails: restore the original plan bytes, run `git reset -q -- <planPath>` and
 *   return `{ ok: false, error }` whose message contains `commit failed`; HEAD stays expectedHead.
 * @param {{ realGit: string, cwd: string, planPath: string, taskId: string, expectedHead: string,
 *   commitLanguage?: string|null }} opts planPath is relative to cwd (`PLAN.md` or `.architect/PLAN.md`)
 * @returns {{ ok: true, sha: string, subject: string } | { ok: false, error: string }}
 */
export function commitAcceptance({ realGit, cwd, planPath, taskId, expectedHead, commitLanguage = null }) {
  const planFile = path.join(cwd, planPath);
  const subject = acceptanceSubject(taskId, commitLanguage);

  let original;
  let updated;
  try {
    const current = head(realGit, cwd);
    if (current !== expectedHead) {
      return { ok: false, error: `HEAD moved: expected ${expectedHead.slice(0, 7)}, found ${current.slice(0, 7)}` };
    }
    const status = porcelain(realGit, cwd);
    if (status) return { ok: false, error: `working tree is not clean:\n${status}` };
    original = readFileSync(planFile);
    updated = markTaskDone(original.toString('utf8'), taskId);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  try {
    writeFileSync(planFile, updated);
    git(realGit, cwd, ['add', '--', planPath]);
    git(realGit, cwd, ['commit', '--only', '-m', subject, '--', planPath]);
  } catch (err) {
    const failure = errorText(err);
    const restoreErrors = [];
    try {
      writeFileSync(planFile, original);
    } catch (restoreErr) {
      restoreErrors.push(`restoring ${planPath} failed: ${errorText(restoreErr)}`);
    }
    try {
      git(realGit, cwd, ['reset', '-q', '--', planPath]);
    } catch (resetErr) {
      restoreErrors.push(`git reset failed: ${errorText(resetErr)}`);
    }
    const suffix = restoreErrors.length ? `\n${restoreErrors.join('\n')}` : '';
    return { ok: false, error: `commit failed: ${failure}${suffix}` };
  }

  try {
    const sha = head(realGit, cwd);
    const parent = git(realGit, cwd, ['rev-parse', 'HEAD^1']);
    if (parent !== expectedHead) {
      return { ok: false, error: `postcondition failed: parent of the acceptance commit is ${parent.slice(0, 7)}, expected ${expectedHead.slice(0, 7)}` };
    }
    const files = git(realGit, cwd, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    if (files.length !== 1 || files[0] !== planPath) {
      return { ok: false, error: `postcondition failed: acceptance commit touches [${files.join(', ')}], expected only ${planPath}` };
    }
    const left = porcelain(realGit, cwd);
    if (left) return { ok: false, error: `postcondition failed: working tree is not clean after the commit:\n${left}` };
    return { ok: true, sha, subject };
  } catch (err) {
    return { ok: false, error: `postcondition check failed: ${errorText(err)}` };
  }
}
