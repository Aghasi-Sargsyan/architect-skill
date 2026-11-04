<!-- When modifying rules in this file, read MAINTAINING.md in the skill folder first -->
# Cycle Closure, Retrospective, and Executor Profiles

Reference guide for the `SKILL.md` core. Read it in an interactive session when no open tasks `[ ]` remain in `PLAN.md` after acceptance: perform cycle closure in the same response without asking the user for confirmation. In the automated orchestrator mode, cycle closure is not performed.

`NOT VERIFIED` items and open questions do not block closure: list them in your response and carry them over to Goal / Requirements of the new `PLAN.md` as "Carried over from the previous cycle".

## 1. Cycle Closure

When all tasks of the cycle are accepted, `PLAN.md` must not grow further. If the skill folder includes the orchestrator (`<skill-folder>/orchestrator/run.mjs`), run `node <skill-folder>/orchestrator/run.mjs --self-check` before closing the cycle and before any `git push` (and `--self-check --base @{u}` when checking all unpushed commits before `git push`):

1. **Cycle retrospective.** Before drafting, read only the retro table at the end of the latest archive in `docs/plans/` or `.architect/plans/` (if one exists) to see recurring issues and unused rules over time. Build a table "dimension → OK or issue with example (commit, task)":
   - Boundaries (via `git log --oneline` and `git show --stat`): `T-NNN` commits touch only files from "Change" (`Менять`), and `Frozen` (`Заморожено`) is untouched.
   - Git (via `git log --oneline` and `git show --stat`): `arch:` and `T-NNN` commits are not mixed, there are no amends, and rework commits are formatted as `T-NNN (fix N)`. Other commits (ad-hoc sessions, release) form a separate category: list them (`git log --format='%h %s' <base>..HEAD | grep -vE '^[0-9a-f]+ (arch:|T-[0-9]+)'`, where `<base>` is as in "Bypasses") and do not count them against the Executor.
   - Bypasses (independent grep across added lines of the cycle, where `<base>` is the previous cycle's closure commit, or if none exists, the cycle's plan commit (`arch: план …` or `arch: plan …`): `git log -p --format='commit %h %s' <base>..HEAD -- <code paths> | grep -nE '^commit |^\+.*(<bypass regex>)'`, where code paths and regex come from the project's check-bypass list (Section 1 of the core; stack examples are in `references/stacks.md`); the `commit` line above a match shows its commit): cycle commits contain no check bypasses; for moved code, compare against the original — inherited matches are debt rather than a violation, so note them separately. Note bypasses from commits outside `arch:` and `T-NNN` separately as well.
   - Escalations (from reports and reviews): whether any occurred and whether they were warranted; whether there were any silent deviations from the plan.
   - Acceptance (from review verdicts): how many "Rework" (`Доработать`) rounds occurred; for every bug found after "Accepted" (`Принято`), identify which step of the skill should have caught it.
   - Context: whether `PLAN.md` alone was sufficient without chat history.

   Show the table to the user, followed by a `- **Label:** value` bullet summary (one per line: **Closure commit**, **Rules** with the mandatory line `Rules: added N / removed M` and the list of skill rules that have gone unused for 2–3 cycles, **Tests**, and **NOT VERIFIED**). Update Executor profiles per Section 2 of this file — in the sections for the confirmed "model + tier" pairs of the cycle's tasks (do not change the skill version or `README.ru.md` / `README.en.md` when updating profiles). If an issue points to a specific skill rule — name it and propose a fix; if a rule has gone unused for 2–3 cycles and does not guard against a critical hazard, propose removing it. Never change skill rules without user consent; whenever process rules in `SKILL.md`, `EXECUTOR.md`, or `references/` change, follow `MAINTAINING.md` in the skill folder. On every retro, check only the first line of `README.ru.md` and `README.en.md` in the skill folder (do not read the full files): if the sync tag lags behind the current version of `SKILL.md` or `EXECUTOR.md` (because another agent or the user edited the rules), check `git diff` of the skill and update both guides per `MAINTAINING.md`.
2. Move `PLAN.md` in full to the archive `docs/plans/<YYYY-MM-DD>-<slug>.md` (or `.architect/plans/<YYYY-MM-DD>-<slug>.md`) and append the retro table to the end of the archive.
3. Append durable decisions from Decisions to `docs/decisions.md` (or `.architect/decisions.md`): one line per decision (ID, summary, link to the cycle archive).
4. Start `PLAN.md` fresh: new Goal, empty Frozen (except `EXECUTOR.md` / `.architect/EXECUTOR.md`), and tasks. Continue `T-` and `ADR-` numbering rather than restarting from `001`.
5. Commit the closure changes in a single commit `arch: закрытие цикла <slug>`: stage new files via `git add <path>`, then run `git commit --only <paths>` (`PLAN.md`, archive, `decisions.md`, plus Executor profiles, `SKILL.md`, `references/`, `README.ru.md`, `README.en.md`, and both copies of `EXECUTOR.md` if modified) and verify `git show --stat HEAD`.

## 2. Executor Profiles

Profiles live in `docs/executor-profiles.md` (or `.architect/executor-profiles.md` in the `compact` layout): one section per "model + reasoning effort tier" pair. Section structure — heading `## <Model> / <Tier>` and three bullet groups: "Confirmed strengths", "Candidate strengths", and "Weaknesses", with task references on every line. If the file does not exist, create it during the retro using this structure.

- Update profiles yourself during the cycle retro without asking for user consent: add a weakness immediately; add a strength only once confirmed across at least two cycles for the same pair (until then, keep it under "Candidates"); list profile updates in the retro table.
- Record an observation only under the section of a pair confirmed per the "Executor Model" rule in `references/auto-review.md`; if a task's pair remains unconfirmed, record nothing until clarified with the user.
- A section for a new pair appears after the first retrospective with that model. In a new project, profiles start from scratch; observations copied manually from another project are marked only as "candidate, from project <name>".
