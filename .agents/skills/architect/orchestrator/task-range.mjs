// Task-range checks (ADR-064, C-07/C-08/C-12): the task base comes from git history, and content rules
// (Change, Frozen, PLAN.md, protected configs, bypasses) cover every commit of the task since that base.
// Contract written by the Architect; signatures and JSDoc are the contract.
import { git, gitRaw, commitsSince } from './git.mjs';
import { isAlwaysFrozenFile } from './layout.mjs';
import { matchesFrozenPath } from './plan.mjs';
import { isHighRisk } from './plan-validate.mjs';
import { findBypasses, matchesProtectedConfig } from './mechanics.mjs';

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const isPlanFile = (f) => f === 'PLAN.md' || f === '.architect/PLAN.md';
const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/**
 * Subject matcher for commits of one task: `T-NNN: …` and `T-NNN (fix N): …`.
 * @param {string} taskId task ID in the `T-NNN` form
 * @returns {RegExp} `^T-NNN(?: \(fix [0-9]+\))?: ` (anchored, no flags)
 */
export function taskSubjectRe(taskId) {
  const escaped = String(taskId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?: \\(fix [0-9]+\\))?: `);
}

/**
 * Resolves the base of task `taskId` from git history only, so it survives loop restarts and
 * intermediate `arch:` commits (C-07).
 * Algorithm: walk `git log --first-parent --format=%H%x09%s <headRef>`; the oldest commit whose subject
 * matches taskSubjectRe(taskId) is the first task commit; the base is its first parent.
 * `arch:` commits made before the first task commit therefore lie outside the range.
 * @param {{ realGit: string, cwd: string, taskId: string, headRef?: string }} opts headRef defaults to 'HEAD'
 * @returns {{ baseSha: string, firstTaskSha: string|null }}
 *   - no task commit on the first-parent history → `{ baseSha: <full sha of headRef>, firstTaskSha: null }`;
 *   - otherwise `{ baseSha: <full sha of the first task commit's first parent>, firstTaskSha: <full sha> }`.
 * @throws {Error} fail-closed when git fails, or when the first task commit has no parent
 *   (message contains `has no parent`).
 */
export function resolveTaskBase({ realGit, cwd, taskId, headRef = 'HEAD' }) {
  const re = taskSubjectRe(taskId);
  const lines = git(realGit, cwd, ['log', '--first-parent', '--format=%H%x09%s', headRef, '--']).split('\n').filter(Boolean);
  let firstTaskSha = null;
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (re.test(line.slice(tab + 1))) firstTaskSha = line.slice(0, tab);
  }
  if (firstTaskSha === null) {
    return { baseSha: git(realGit, cwd, ['rev-parse', headRef]), firstTaskSha: null };
  }
  const [parent] = git(realGit, cwd, ['show', '-s', '--format=%P', firstTaskSha]).split(/\s+/).filter(Boolean);
  if (!parent) throw new Error(`first commit ${firstTaskSha.slice(0, 7)} of ${taskId} has no parent: task base cannot be resolved`);
  return { baseSha: parent, firstTaskSha };
}

/** `git diff --quiet`: exit 0 → false, exit 1 → true, anything else (other exit, signal) throws. */
function differs(realGit, cwd, refSha, headRef, file) {
  try {
    gitRaw(realGit, cwd, ['diff', '--quiet', refSha, headRef, '--', file]);
    return false;
  } catch (err) {
    if (err instanceof Error && 'status' in err && err.status === 1 && !err.signal) return true;
    throw err;
  }
}

/**
 * Ownership attribution (ADR-064 recovery invariant). Walks `commits` oldest first.
 * - Merge commits are skipped entirely.
 * - A non-merge commit with `isTaskCommit(c) === true` is a task commit; every other non-merge commit is an
 *   owner commit (in practice `arch: …`; a foreign commit is reported separately by checkTaskRange).
 * - For every file f touched by at least one task commit: refSha(f) = the newest owner commit that touched f,
 *   or `baseSha` if none; f is task-dirty when some task commit touched f AFTER refSha(f) (in `commits` order)
 *   AND `git diff --quiet <refSha(f)> <headRef> -- f` reports a difference (content change, add or delete).
 * Consequence: an Executor change is fixed by any later commit — an Executor rework commit that restores the
 * file, or an owner commit (`arch: fix-frozen T-NNN: restore …`) that takes ownership of the file's state.
 * @param {{ realGit: string, cwd: string, baseSha: string, headRef?: string,
 *   commits: Array<{ sha: string, subject: string, isMerge: boolean, files: string[] }>,
 *   isTaskCommit: (c: { sha: string, subject: string }) => boolean }} opts
 * @returns {Array<{ file: string, refSha: string, lastTaskCommit: { sha: string, subject: string } }>}
 *   task-dirty files sorted by `file` (normalized: forward slashes, no leading `./`); lastTaskCommit is the newest
 *   task commit that touched the file.
 */
export function findTaskDirtyFiles({ realGit, cwd, baseSha, headRef = 'HEAD', commits, isTaskCommit }) {
  const entries = new Map();
  for (const c of commits) {
    if (c.isMerge) continue;
    const task = isTaskCommit(c);
    for (const raw of c.files) {
      const f = normPath(raw);
      if (!entries.has(f)) entries.set(f, { refSha: baseSha, lastTask: null });
      const entry = entries.get(f);
      if (task) {
        entry.lastTask = { sha: c.sha, subject: c.subject };
      } else {
        entry.refSha = c.sha;
        entry.lastTask = null;
      }
    }
  }
  const dirty = [];
  for (const [file, { refSha, lastTask }] of entries) {
    if (lastTask && differs(realGit, cwd, refSha, headRef, file)) dirty.push({ file, refSha, lastTaskCommit: lastTask });
  }
  return dirty.sort(byFile);
}

/**
 * Checks content rules over all commits of task `task.id` in (baseSha, headRef] (C-07, C-08, C-11).
 * Range commits come from `commitsSince(realGit, cwd, baseSha)` (git.mjs). Only headRef === 'HEAD' is supported:
 * any other value throws `checkTaskRange supports only headRef "HEAD"`.
 * Classes: task commits (taskSubjectRe, non-merge); owner commits (non-merge, subject starts with `arch: `);
 * merge commits (skipped); any other non-merge commit is foreign.
 * Violations (one string each, exact templates; <sha7> = first 7 chars, <h7> of headRef, <b7> of baseSha):
 *  - zero task commits: `no task commits found for <id> in task range <b7>..<h7>`;
 *  - foreign commit: `foreign commit <sha7> in task range: "<subject>" is neither <id> nor arch:`;
 *  for each task-dirty file f (findTaskDirtyFiles with isTaskCommit = task commits only), in this priority,
 *  at most one of the first four per file:
 *  1. f is `PLAN.md` or `.architect/PLAN.md` (even when listed in Change — R-7):
 *     `<sha7 of lastTaskCommit> modifies <f>: task commits must not modify PLAN.md`;
 *  2. matchesFrozenPath(f, frozen) or isAlwaysFrozenFile(f, { configPath, workDir: cwd, orchestratorDir }):
 *     `<sha7> touches Frozen — touched Frozen: <f>`;
 *  3. task is not high risk (isHighRisk) and f matches a `protectedConfigFiles` pattern (same matching as
 *     mechanics.mjs matchesProtectedConfig: exact path, basename, or `*` glob):
 *     `<sha7> touches verification config outside high-risk task: <f>`;
 *  4. f is not in task.change (normalized):
 *     `<sha7> touches file outside Change list — outside task "Change" list: <f>`;
 *  5. bypass scan (independent of 1–4): when bypassPatterns and scanPaths are non-empty and f is under a scan path
 *     (`f === p` or `f.startsWith(p + '/')`, p normalized without trailing `/`), run
 *     `git diff -U0 <refSha(f)> <headRef> -- f` and for each line from findBypasses(diff, bypassPatterns, testFilePatterns):
 *     `check bypassing in task range (check bypass): <f>: <line, first 120 chars>`; such f goes to `scannedFiles`.
 * Pure read: never writes files, refs or the index.
 * @param {{ realGit: string, cwd: string, task: { id: string, risk?: string, change?: string[] },
 *   baseSha: string, headRef?: string, frozen?: string[], scanPaths?: string[], bypassPatterns?: RegExp[],
 *   protectedConfigFiles?: string[], testFilePatterns?: string[], configPath?: string, orchestratorDir?: string }} opts
 * @returns {{ ok: boolean, violations: string[], baseSha: string, headSha: string,
 *   taskCommits: Array<{ sha: string, subject: string }>, ownerCommits: Array<{ sha: string, subject: string }>,
 *   dirtyFiles: string[], scannedFiles: string[] }} headSha is the full sha of headRef; arrays keep range order
 *   (dirtyFiles/scannedFiles sorted by path).
 */
export function checkTaskRange(opts) {
  const {
    realGit, cwd, task, baseSha, headRef = 'HEAD', frozen = [], scanPaths = [], bypassPatterns = [],
    protectedConfigFiles = [], testFilePatterns, configPath = '', orchestratorDir,
  } = opts;
  if (headRef !== 'HEAD') throw new Error('checkTaskRange supports only headRef "HEAD"');

  const headSha = git(realGit, cwd, ['rev-parse', headRef]);
  const subjectRe = taskSubjectRe(task.id);
  const isTaskCommit = (c) => subjectRe.test(c.subject);
  const commits = commitsSince(realGit, cwd, baseSha);
  const taskCommits = [];
  const ownerCommits = [];
  const violations = [];
  if (!commits.some((c) => !c.isMerge && isTaskCommit(c))) {
    violations.push(`no task commits found for ${task.id} in task range ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`);
  }
  for (const c of commits) {
    if (c.isMerge) continue;
    const ref = { sha: c.sha, subject: c.subject };
    if (isTaskCommit(c)) taskCommits.push(ref);
    else if (c.subject.startsWith('arch: ')) ownerCommits.push(ref);
    else violations.push(`foreign commit ${c.sha.slice(0, 7)} in task range: "${c.subject}" is neither ${task.id} nor arch:`);
  }

  const highRisk = isHighRisk(task.risk);
  const change = new Set((task.change ?? []).map(normPath));
  const scanDirs = scanPaths.map((p) => normPath(p).replace(/\/+$/, ''));
  const scan = bypassPatterns.length > 0 && scanDirs.length > 0;
  const dirty = findTaskDirtyFiles({ realGit, cwd, baseSha, headRef, commits, isTaskCommit });
  const scannedFiles = [];
  for (const { file: f, refSha, lastTaskCommit } of dirty) {
    const short = lastTaskCommit.sha.slice(0, 7);
    if (isPlanFile(f)) {
      violations.push(`${short} modifies ${f}: task commits must not modify PLAN.md`);
    } else if (matchesFrozenPath(f, frozen) || isAlwaysFrozenFile(f, { configPath, workDir: cwd, orchestratorDir })) {
      violations.push(`${short} touches Frozen — touched Frozen: ${f}`);
    } else if (!highRisk && matchesProtectedConfig(f, protectedConfigFiles)) {
      violations.push(`${short} touches verification config outside high-risk task: ${f}`);
    } else if (!change.has(f)) {
      violations.push(`${short} touches file outside Change list — outside task "Change" list: ${f}`);
    }
    if (scan && scanDirs.some((p) => f === p || f.startsWith(`${p}/`))) {
      scannedFiles.push(f);
      const diff = gitRaw(realGit, cwd, ['diff', '-U0', refSha, headRef, '--', f]);
      for (const added of findBypasses(diff, bypassPatterns, testFilePatterns)) {
        violations.push(`check bypassing in task range (check bypass): ${f}: ${added.slice(0, 120)}`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    baseSha,
    headSha,
    taskCommits,
    ownerCommits,
    dirtyFiles: dirty.map((d) => d.file),
    scannedFiles,
  };
}

/**
 * Reviewer-facing mechanics line for a green range (C-12): names the checked range and never claims a scan
 * that did not happen. Exact format:
 * `task range <b7>..<h7>: commits <list>; files only from Change; Frozen untouched; <bypassPart>; clean tree`
 *  - <list>: task commits as `<sha7> "<subject>"` joined by `, `; if ownerCommits is non-empty, append
 *    ` (owner commits: <sha7> "<subject>", …)` right after the list;
 *  - <bypassPart>:
 *    - bypassPatterns empty or scanPaths empty → `automatic check bypass scan disabled in config — verify manually`;
 *    - scannedFiles empty → `bypass scan skipped: no changed task files under <scanPaths joined by ' '>`;
 *    - otherwise → `no check bypasses (config bypassPatterns) in <scannedFiles joined by ' '>`.
 * @param {ReturnType<typeof checkTaskRange>} range
 * @param {{ scanPaths?: string[], bypassPatterns?: RegExp[] }} opts
 * @returns {string}
 */
export function formatRangeSummary(range, { scanPaths = [], bypassPatterns = [] } = {}) {
  const label = (c) => `${c.sha.slice(0, 7)} "${c.subject}"`;
  let commitList = range.taskCommits.map(label).join(', ');
  if (range.ownerCommits.length > 0) commitList += ` (owner commits: ${range.ownerCommits.map(label).join(', ')})`;
  let bypassPart;
  if (bypassPatterns.length === 0 || scanPaths.length === 0) {
    bypassPart = 'automatic check bypass scan disabled in config — verify manually';
  } else if (range.scannedFiles.length === 0) {
    bypassPart = `bypass scan skipped: no changed task files under ${scanPaths.join(' ')}`;
  } else {
    bypassPart = `no check bypasses (config bypassPatterns) in ${range.scannedFiles.join(' ')}`;
  }
  return `task range ${range.baseSha.slice(0, 7)}..${range.headSha.slice(0, 7)}: commits ${commitList}; files only from Change; Frozen untouched; ${bypassPart}; clean tree`;
}
