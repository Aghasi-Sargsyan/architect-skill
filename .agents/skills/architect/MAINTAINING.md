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

Run the maintenance and structural sync test suites (`maintaining-s2.test.mjs`, `skill-s4.test.mjs`, `skill-s5.test.mjs`) and verify the full orchestrator test suite on both **Node 22** (minimum supported version) and **Node 24**:
```bash
VERIFY_STEP_A1=1 node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs
npx -y -p node@22 -c 'node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs'
npx -y -p node@24 -c 'node --test <path-to-skill>/orchestrator/*.test.mjs <path-to-skill>/orchestrator/adapters/*.test.mjs'
```
