<!-- When modifying rules in this file, read MAINTAINING.md in the skill folder first -->
# Advisory Plan Audit Checklist (`--audit-plan`)

Reference guide for the `SKILL.md` core and the advisory auditor model invoked by `node <skill-folder>/orchestrator/run.mjs --audit-plan`.

The auditor runs in strict read-only mode (`Read`, `Grep`, `Glob` only) using a model from a different family than the plan author. Its goal is to catch blind spots in `PLAN.md`, contracts, and `Frozen` reference tests **before** the plan is committed and handed off to the Executor.

## 1. Audit Scope (Three Mandatory Dimensions)

Inspect `PLAN.md` (or `.architect/PLAN.md`), all files listed under `## Frozen`, and the target modules referenced in `Read` / `Change`:

1. **Completeness of Invariants and Negative Cases in `Frozen` Reference Tests (`frozen_tests`):**
   - Every invariant and edge case stated in a high-risk task (`Risk: high` / `Риск: высокий`) is directly asserted by a test in `Frozen` (`Test cases` / `Тест-кейсы`).
   - Negative cases verify that invalid inputs, unauthorized actions, or check bypasses fail closed (not just the happy path).
   - System state after the operation is asserted rather than mock calls alone.
   - Reference tests contain no silent `catch {}` blocks, no wall-clock timing assertions (`performance.now(`, `process.hrtime`, `console.time(`, `Date.now(` — speed must be checked structurally via call/read counters or byte/line budgets), and no contradictions with existing tests.
2. **Holes in Regular Expressions and Contracts (`regex_contracts`):**
   - Regular expressions for security guards, check bypasses, command validation, or parsers cannot be trivially bypassed via whitespace variations, multiline input, quotes, aliases, or prototype/global mutations.
   - Exported function signatures, parameter types, return structures, and error conditions in task contracts leave no ambiguity that would force the Executor to guess or improvise architecture.
3. **Hidden Overlaps of `Change` and `Frozen` Across Tasks (`change_frozen_overlap`):**
   - Each task can be completed by modifying **only** the files in its `Change` (`Менять`) list without touching any `Frozen` file or uninscribed registration/config file.
   - Tasks that modify the same file (such as `run.mjs` or `AGENTS.md`) are strictly ordered via `Depends on` (`Зависит от`).
   - Every created or modified module respects the `<= 400` line budget (`wc -l`).

**Explicit exclusion:** Do **not** audit whether `Verify` (`Проверка`) commands are syntactically valid or executable — `validateOnly` and `red-check` already verify them deterministically.

## 2. Output Format and Resolution Rules

Return a JSON object matching `<skill-folder>/orchestrator/schemas/audit.json`:
- `findings`: array of `{ id, severity, category, file, summary, recommendation }` where `id` is `A-1`, `A-2`, …, `severity` is `"blocker" | "important" | "minor"`, and `category` is `"frozen_tests" | "regex_contracts" | "change_frozen_overlap"`.
- `summary`: concise overall assessment (1–3 sentences).

For every `blocker` and `important` finding in the latest audit for the current cycle base, the Architect must either fix the plan/tests before committing or record a resolution bullet in `PLAN.md` (`Decisions`):
- `- A-N [blocker|important]: принято` (or `accepted`)
- `- A-N [blocker|important]: отклонено: <reason>` (or `rejected: <reason>`)
