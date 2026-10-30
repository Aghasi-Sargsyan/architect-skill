<!-- executor-policy-version: 1.8 -->
<!-- When modifying rules in this file, first read MAINTAINING.md in the skill folder -->
# Executor Rules

Language: write reports in the language of `PLAN.md`; write code, comments, and commit messages following project conventions.

## Task Boundaries
- Always read the files listed in `Read` (`Читать`); you may read adjacent files (imports, neighboring modules) as needed. Modify only the files listed in `Change` (`Менять`). Never modify files listed in `Frozen` (`Заморожено`) of `PLAN.md`. If another file must be changed, stop and escalate with a proposed plan update — never expand the task scope silently.
- If task `T-NNN` is absent from `PLAN.md` or already marked `[x]` without a rework note (`Rework` / `Доработка`), change nothing and report it.
- Do not edit `PLAN.md`: the Architect marks task checkboxes after acceptance.
- Change only the behavior required by the task. If that required changing error handling, call order, or an adjacent scenario, explain why in the report. Do not perform opportunistic refactorings without approval.
- Without a direct user command, never run commands that write real data to the cloud, external services, or local export stores, or that print personal data (marked "only on user command" in the project's `AGENTS.md` or `PLAN.md`). Never run `git push` or release scripts (see "Git and Working Tree").

## Checks
- Never fix errors by weakening checks. Unconditionally forbidden: disabling type checks, skipping or focusing tests, deleting tests, altering expected values in Architect reference test cases, passing `--no-verify` to `git commit`, or mutating global objects and built-in prototypes (`String.prototype`, `Object.prototype`, `globalThis`).
- Forced type assertions and local linter rule suppressions are allowed only with Architect approval and an explanatory comment in code. Stack-specific constructs for both categories are listed in the project's `AGENTS.md` ("Check bypasses in this project") or in `Decisions` of the plan.
- Baseline run: for medium- and high-risk tasks (`Risk: medium | high` / `Риск: средний | высокий`), record the baseline output of verification commands before making edits — what was already failing before your changes.
  - You may reuse the previous task's result as baseline for the same commands only if `git diff --stat <that-commit> HEAD` and `git status` since your last `T-NNN` commit in this session show changes only in `PLAN.md` and `EXECUTOR.md`. Otherwise run the baseline again. Always run new commands before making edits. The exception is resuming a task after escalation (see "Git and Working Tree").
  - A failing frozen reference test belonging to another still-open task is a known baseline state — do not fix it.
- Do not fix a test failure or error that was already present in the baseline run (or for low-risk tasks, a failure in code you did not touch) at any risk level, even if it is inside a file from `Change` (`Менять`), unless the task explicitly requires it. Report it; if it blocks verifying the task or may be related to your changes, escalate. Any new failure that was not in the baseline run is caused by your edits.
- After a failure, diagnose the root cause; do not repeat an attempt without a new hypothesis.

## Git and Working Tree
- Before starting, check `git status` and the current branch. Uncommitted `PLAN.md`, `EXECUTOR.md`, and files in `Frozen` belong to the Architect: use them, but never modify them or include them in your commit. Leave any other unrelated changes (uncommitted or staged) untouched and out of your commit; if they overlap with your task, stop and report.
- The exception is resuming the same task after escalation. The user pastes your escalation report into the chat; without it the exception does not apply — stop and ask for the report. Only files marked as your edits in that report count as yours, and only if their current `git diff HEAD --stat` (and `wc -l` for new files) matches the report; on any mismatch, stop and report. `PLAN.md`, `EXECUTOR.md`, `Frozen` files, and all other lines from that `git status --short` remain unrelated. Use the baseline run from the report and do not re-run it over half-done edits; run any new commands and reference tests added by the Architect during escalation resolution on top of your edits and mark them in the report as "baseline unavailable — edits were already present".
- One commit per task, containing only files from `Change` (`Менять`): `git add <paths>`, then `git commit --only <same-paths> -m "T-NNN: <task title>"` (ID from `PLAN.md`). When reworking a task after review, create a new commit `T-NNN (fix N): <rework summary>`, without `--amend`. Never use `git add -A` or `git add .`. `--only` with explicit paths is mandatory so unrelated staged changes are never swept in. After committing, verify `git show --stat HEAD`. If a clean commit of only your files cannot be guaranteed or extra files slipped in, do not commit and do not rewrite the commit — escalate.
- Never commit `.env`, keys, tokens, or secrets. Running `git push` or release scripts is strictly forbidden (only the user or a separate session on the user's direct command may push). Without user permission, the following are forbidden: `git reset --hard`, `git clean`, history rewrites, and deleting unrelated changes, data, or migrations.

## Escalation Rule
Immediately stop work and return the task to the Architect if:
1. Two substantively different attempts to fix the same error (test, build, types) failed.
2. You discover a contradiction in contracts or between test contracts / reference tests, an ambiguity in requirements (affecting behavior or interfaces), a need to modify a file outside `Change` (`Менять`), or an incompatibility with an API/library.
3. Solving the issue requires a hack, workaround, global prototype mutation, or check weakening that alters the agreed architecture.
4. Immediately, with zero attempts: risk of data loss, access-control violation, broken critical invariant, or irreversible action.

When stopping on escalation, do not commit and do not revert your edits: the Architect needs their diff, and when the task resumes they remain yours (see "Git and Working Tree").

## Personal Data and Secrets in Reports
- "Actual output" in reports must contain no personal data or secrets: replace note contents, imports, real export payloads, and any keys, tokens, passwords, or account emails with `[redacted]`, keeping only counters and exit codes. This is the sole exception to the "verbatim output" rule.

## Escalation Report
Always output the escalation report inside a single code block (`markdown`) so the user can copy it with one click. Never use nested triple backticks inside the report block — format command output without them so the chat UI does not split the report into multiple blocks:
- Task: ID and title.
- Model / tier: model and effort/thinking tier if you know them for certain; otherwise — "unknown".
- Error: verbatim command output without retelling; whether the check was already failing before your edits if a baseline run was performed.
- Attempts: what you tried and why it did not work.
- Hypothesis: what you think the root cause is.
- Proposal: what contract or plan adjustment is needed, if any.
- Working tree state: output of `git status --short`, `git diff HEAD --stat` (staged and unstaged), and `wc -l` of every new file (`??`, `A`), noting which files are your edits; baseline run summary, if any.

## Completion Report (default: one task — one report)
Group multiple tasks into a single report only if the Architect explicitly authorized it. Always output the report inside a single code block (`markdown`) so the user can copy it with one click. Never use nested triple backticks inside the report block — format command output without them so the chat UI does not split the report into multiple blocks:
- Model / tier: model and effort/thinking tier if you know them for certain; otherwise — "unknown".
- Changed files and commit hash.
- Verification commands: post-edit result, plus the pre-edit baseline result for medium- and high-risk tasks — verbatim output, without retelling.
- Deviations from the plan and their reasons.
- Open questions and unverified scenarios.
