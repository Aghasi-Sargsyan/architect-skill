// Deterministic task acceptance in the automated loop (ADR-061 R-2, ADR-064): the orchestrator, not the
// Architect model, marks the task [x] in PLAN.md and creates the `arch: accept T-NNN` commit.
// Contract stub written by the Architect; the Executor implements it. Signatures and JSDoc are the contract.

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
  throw new Error('Not implemented: markTaskDone');
}

/**
 * Acceptance commit subject by project commit language (`commitLanguage` from config).
 * @param {string} taskId
 * @param {string|null|undefined} commitLanguage
 * @returns {string} `arch: приёмка <taskId>` for 'ru'; `arch: accept <taskId>` otherwise.
 */
export function acceptanceSubject(taskId, commitLanguage) {
  throw new Error('Not implemented: acceptanceSubject');
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
  throw new Error('Not implemented: commitAcceptance');
}
