# Maintaining the `architect` Skill (`MAINTAINING.md`)

This file is only for authors and agents modifying the rules of the skill itself (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) or the human guides (`README.en.md`, `README.ru.md`). Do not read it during normal project tasks.

## 1. When to Bump Versions and Sync Files

Whenever you change process rules in `SKILL.md`, `EXECUTOR.md`, or `references/*.md`:
1. Bump the version in `SKILL.md` (`# Architect Prompt vX.Y`) and/or in line 1 of `EXECUTOR.md` (`<!-- executor-policy-version: A.B -->`), and record the release in `CHANGELOG.md`.
2. English `SKILL.md`, `EXECUTOR.md`, and `references/*.md` are the single source of truth for skill rules (`ADR-032`). Do not create `*.ru.md` rule copies (`SKILL.ru.md`, `EXECUTOR.ru.md`, `references/*.ru.md`); only `README.ru.md` is maintained in Russian for human operators.
3. The canonical `EXECUTOR.md` lives inside the skill folder (`EXECUTOR.md` next to `SKILL.md`). Edit the canonical file first, then copy it byte-for-byte to the project root (`EXECUTOR.md` in `classic` layout or `.architect/EXECUTOR.md` in `compact` layout).
4. In the same commit, sync both human guides (`README.en.md` and `README.ru.md`, each `<= 25 KB`):
   - update line 1 of both files: `<!-- skill-readme-sync: vX.Y / A.B -->`;
   - keep identical numbered `## N.` sections in both versions.
5. Updating `docs/executor-profiles.md` (or `.architect/executor-profiles.md`) at cycle close does not change skill rules — do not bump `SKILL.md` / `EXECUTOR.md` versions for profile updates.

## 2. Automated Verification

Run the maintenance and structural sync test suites (`maintaining.test.mjs`, `skill-structure.test.mjs`, `skill-packaging.test.mjs`) and verify the full orchestrator test suite on both **Node 22** (minimum supported version) and **Node 24**:
```bash
VERIFY_STEP_A1=1 node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs
npx -y -p node@22 -c 'node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs'
npx -y -p node@24 -c 'node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs'
```
When closing a cycle that modifies the skill or orchestrator, record both Node 22 and Node 24 test runs with exact Node version and pass/total score in the retrospective.

## 3. Rule Growth Control and Behavioral Evals Discipline

- **Rule growth control:** Every rule addition to the `SKILL.md` core must either name in `CHANGELOG.md` the rule that was moved to `references/` or removed, or explicitly justify why the core grew. Every retrospective must include the line `Rules: added N / removed M` and list rules unused for 2–3 cycles.
- **Behavioral evals (`orchestrator/evals.mjs`, `orchestrator/eval-fixtures.mjs`):** Evals and `eval-fixtures.mjs` anchor monotonicity are used only when developing and maintaining the skill itself. Record live eval results in `PLAN.md` and `docs/plans/*.md` strictly in the format `eval <run-id> @ <sha7>: X/Y PASS` backed by `.agent-runs/evals/<run-id>/results.md`. When `< 5` runs exist for a cell, never write "flake", "stochastic noise", or "regression not confirmed" — state only `X/Y PASS`, commit, `run-id`, and `NOT VERIFIED (sample < 5)`.
