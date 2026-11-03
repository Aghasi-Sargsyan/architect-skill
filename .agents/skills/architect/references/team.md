<!-- When modifying rules in this file, read MAINTAINING.md in the skill folder first -->
# Team Mode Workflow (`"team": true`)

Read this guide only when `"team": true` is enabled in the shared project config (`.architect/config.json` or `.agents/orchestrator.json`, initialized via `run.mjs --init --team`). Solo projects do not use these rules.

## 1. Branch Topology and Git Roles

1. **Cycle branch (`cycle/<N>`):**
   - The Architect creates `cycle/<N>` from `master` (or `main`) and commits `arch: plan <summary>` containing `PLAN.md` and `Frozen` reference tests (which are expected to be red for open tasks).
   - Only the human Architect (tech lead) pushes `arch: plan`, `arch: accept T-NNN`, `arch: fix-frozen`, and `arch: close cycle <N>` directly to `cycle/<N>`.
2. **Task branch (`task/T-NNN`):**
   - Each Executor works on an isolated branch `task/T-NNN` (or `task/T-NNN-<slug>`) branched from `cycle/<N>`.
   - The Executor agent never runs `git push` (`EXECUTOR.md`), never modifies `PLAN.md`, `.github/workflows/**`, or `CODEOWNERS`, and commits `T-NNN: <title>` (plus `T-NNN (fix M): <summary>` on rework).
   - The human developer pushes `task/T-NNN` and opens a Pull Request `task/T-NNN → cycle/<N>`, pasting the Executor Completion Report into the PR description.
3. **Acceptance and Merge (`task/T-NNN → cycle/<N>`):**
   - GitHub Actions runs the narrow PR gate (`run.mjs --check-task T-NNN --base origin/cycle/<N>`), which reads `PLAN.md` from `<base>` (`git show <base>:PLAN.md`), verifies `Change` and `Frozen` boundaries and check bypasses from `git merge-base <base> HEAD`, rejects any `PLAN.md` modification on the task branch, enforces commit format/language and no-squash rules, and runs the task's `Verify` (`Check`) commands from `<base>:PLAN.md`.
   - After the PR gate is green and the Architect accepts the task per `references/auto-review.md`, the human Architect merges the PR into `cycle/<N>` using **Create a merge commit** (`git merge --no-ff`). **Squash and merge is strictly forbidden.**
   - Immediately after merging the PR, the Architect marks `- [x] T-NNN:` in `PLAN.md` directly on `cycle/<N>` with `arch: accept T-NNN` (`arch: приёмка T-NNN`) and the human Architect pushes `cycle/<N>`.
4. **Cycle Closure (`cycle/<N> → master`):**
   - Once all tasks in `cycle/<N>` are marked `[x]`, the Architect runs `--self-check`, performs Cycle Closure (`arch: close cycle <N>`) on `cycle/<N>`, and opens a PR `cycle/<N> → master` (or `main`).
   - CI on `master` requires the full project test suite (`fullTestCommand`) and `run.mjs --self-check --base origin/master` to pass. Merge `cycle/<N> → master` using **Create a merge commit** (`--no-ff`, never Squash).

## 2. Parallel Task Fields and Config Overlay

In team mode, task cards in `PLAN.md` may include two additional fields:
- `Executor: @<github-handle> · <Environment> · <Model / Tier> (\`<model-id>\`)` — assigns the task to a developer and their environment (`Antigravity`, `Claude Code`, `Codex`). The model in `Executor` is informational for that assignee's environment and never overrides a developer's local config. If the assigned environment does not match the local `runner`, the orchestrator refuses to run the task.
- `Parallel with: T-MMM, T-KKK` (or `(parallel with T-MMM)` in `Depends on`) — declares tasks that execute concurrently. Parallel tasks must not depend on each other, must have disjoint `Change` file lists, must not include `Frozen` files in `Change`, and must have disjoint `referenceTests`.

Each developer configures their personal runner, binary paths, and model in a git-ignored local overlay (`.architect/config.local.json` or `.agents/orchestrator.local.json`). The model resolution chain is: `.local.json` → shared config → agent file (`.claude/agents/executor.md` / `AGENTS.md`). Project policy fields (`permissions`, `allowedCommands`, `blockedScripts`, `protectedConfigFiles`, `bypassScanPaths`, `bypassPatterns`, `commitLanguage`, `team`) are allowed only in the shared config.
