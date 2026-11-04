<!-- When modifying rules in this file, read MAINTAINING.md in the skill folder first -->
# Task Acceptance Procedure (`[MODE: REVIEW / ESCALATION]`)

Single source of truth for Architect task acceptance rules (in an interactive session and during automatic acceptance in the orchestrator).

## 1. Review Depth by Risk Level

The Executor report is testimony, not proof. By default, the Executor runs typecheck, lint, tests, and build.

- **Low risk (`низкий`):** check the report, the combined diff of all task commits (`T-NNN` and `T-NNN (fix N)`), and the acceptance criteria.
- **Medium risk (`средний`):** plus the results of targeted tests and changes to affected interfaces. When in specific doubt, re-run the main verification command.
- **High risk (`высокий`):** run the key verification commands yourself or take the CI result. The report alone is not enough. CI counts only when the run is finished, green, triggered on the hash of the commit being reviewed, and includes the required checks.

If a result could not be confirmed, mark it `NOT VERIFIED` and do not call the check passed.

## 2. Matching the Four Sources During Acceptance

1. **Goal / Requirements** from `PLAN.md` (or `.architect/PLAN.md`).
2. **Contracts, invariants, and test cases.** Match every required case to a concrete test and its assertions: a green run alone is not enough.
3. **Actual changes:** the combined diff of task `T-NNN` across all its commits (including `T-NNN (fix N)` and new files).
   - Check that no files outside the "Change" (`Менять`) list and none from `Frozen` (`Заморожено`) were touched.
   - Check that there are no check bypasses (Category 1 is unconditionally forbidden: disabling type checking, skipping/focusing tests, deleting tests, substituting expected values in reference test cases, passing `--no-verify` to `git commit`, mutating global objects and built-in prototypes (`String.prototype`, `Object.prototype`, `globalThis`); Category 2 — forced type casting and local linter rule suppression — is allowed only with prior approval, a justification comment in the code, and a justification line recorded in `PLAN.md`).
   - For refactoring and decomposition, do not read the full diff — cross-check side effects: in the original and new versions, find subscriptions and their cleanup (`useEffect` with cleanup function, `addEventListener`/`removeEventListener`), timers, event handlers and lifecycle callbacks, network and API calls, and writes to storage. Every discrepancy is either declared in the Executor report or receives verdict "Rework" (`Доработать`). Before calling a discrepancy a regression, trace the entire handling chain in the source: it is a regression only if user-visible behavior actually changed. A regression-fix task restores the original behavior and nothing beyond it; file incidental UX improvements as a separate task marked "behavior change". Mark checklist items that are verified neither by a command nor by this cross-check as `NOT VERIFIED`.
4. **Executor report** with verification output (for medium and high risk — including the baseline result before edits), formatted as a single `markdown` block without nested triple backticks.

**Executor Model.** The model and reasoning effort tier are reported by the user or the orchestrator, not by the Executor: a model cannot see its own reasoning effort tier and may be mistaken about its own version. The Executor writes the "Model / tier" field in the report ("unknown" if unsure). During manual acceptance, the pair is confirmed if what is stated in the report matches the task's "Model" (`Модель`) field or the default Executor model from the project's `AGENTS.md`; ask the user only if the report says "unknown", the field is omitted, or it differs from what was expected. In subagent mode, the pair is confirmed by the invocation parameters rather than the Executor's self-report: if the environment provides only a model alias without an effort tier, record the pair as `<alias> (subagent)` (or `<alias> (subagent, tier unknown)`); if a subagent was launched with `inherit`, record the task in the Architect model's profile and never attribute its results to another model. In automated mode, the orchestrator passes and confirms the pair.

## 3. Resolving an Executor Escalation

If the Executor stopped under the escalation rule, choose one of three paths:
1. Fix the implementation within the contract (including expanding the "Change" (`Менять`) list if invariants do not change).
2. Fix the flawed contract (contradiction, mismatch with the real API) while preserving invariants.
3. Revisit the decision with the user (in automated mode — return `verdict: "needs_user"`).

Rules when resolving an escalation:
- The Executor's hypothesis in the report is not a fact: before editing the contract or plan, re-verify the real API signature, package version, and error output.
- Weakening an invariant, changing expected values in reference test cases, or altering a recorded decision (ADR) is allowed only with user consent and must be recorded in `Decisions`.
- (a) If a requirement is unreachable because of an existing invariant, propose removing or changing the requirement rather than simulating or faking state in a test.
- (b) Do not use mocks tied to the number or order of internal calls in business logic; structural call/read counters for speed verification (`SKILL.md` Step 3) remain allowed.
- (c) An `arch: fix-frozen` commit must never reduce the number of checks (tests or assertions) — replace an obsolete check rather than deleting it.
- (d) In a user decision block (`### ❓ Decision Required`), state for each option which invariants and rules it preserves or violates, and include one concrete strength of each non-recommended option.
- **Do not edit or commit files from "Change" (`Менять`) with uncommitted Executor edits** — edit only `PLAN.md` and files from `Frozen` (with a commit `arch: <what was adjusted>` using explicit paths), otherwise `git diff HEAD --stat` verification will not match on resume.
- **Post-plan `Frozen` integrity and `WAIVER` ban:** Modifying or deleting `Frozen` test files or orchestrator configs after the `arch: plan …` commit is allowed only in a commit with prefix `arch: fix-frozen <T-NNN|audit>: ` and must preserve monotonicity (test/assert counts and config arrays). Adding `- WAIVER` lines to `PLAN.md` inside the automated loop is strictly forbidden (`WAIVER` requires an explicit user decision in an interactive session).

## 4. Result Format and Acceptance Commit

- **Verdict for each task:** "Accepted" (`accepted` / `Принято`), "Rework" (`rework` / `Доработать`), or "Needs user decision" (`needs_user`).
  - Do not accept a high-risk task with an unverified key check (`NOT VERIFIED`).
  - Do not accept a task without its own `T-NNN` commit (verdict "Rework" / `Доработать`). Exception in an interactive session: if the Executor session was cut short before committing (timeout or CLI crash), and the changes in the index/working tree fit within "Change" (`Менять`), `Frozen` is untouched, there are no bypasses, and tests are green — commit them with the task commit message and a note in the body (`committed by the Architect: the Executor's run was interrupted before commit; staged diff unchanged`), accept the task, and continue (in the retro, record this as an environment failure rather than an Executor mistake).
- **Issues:** a list with severity (blocker / important / nit), file, and line. If an approved Category 2 bypass is accepted, record a one-line justification in `PLAN.md` (`Decisions` or a task sub-bullet).
- **Rework:** for blockers and important issues — exact instructions in `rework_instructions` (or a sub-bullet "Rework N: …" / «Доработка N: …» with `[x]` unchecked if the task is returned to `PLAN.md`).
- **On verdict "Accepted" (`Принято`):** mark the task `[x]` in `PLAN.md` (or `.architect/PLAN.md`), commit only the plan file via `git add <path to PLAN.md>` and `git commit --only <path to PLAN.md> -m "arch: приёмка T-NNN"` (or `"arch: accept T-NNN"`), then verify `git show --stat HEAD` (without the `-C` flag, since the process is already running in the project working directory).
- **Chat summary format (interactive sessions):** Format the review/acceptance reply as `- **Label:** value` bullets (one per line): **Verdict** (`T-NNN` — `Accepted` / `Rework` / `Needs user decision`), **Executor & duration** (confirmed `<Model / Tier>` and elapsed execution time from subagent `Created At` → `Completed At`, run log, or git timestamps, e.g. `1 min 18 s`), **Commit** (task commit SHA and `arch: accept T-NNN` SHA), **Checks** (verified commands and status), and **Issues / Next step**.
- **Cycle completion:**
  - In the automated orchestrator mode: even if no open tasks `[ ]` remain, stop immediately after the task acceptance commit — cycle closure and retrospective are performed in an interactive session.
  - In an interactive session: if no open tasks `[ ]` remain, read `<skill-folder>/references/retro.md` and perform "Cycle Closure" (`закрытие цикла`) in the same response.
