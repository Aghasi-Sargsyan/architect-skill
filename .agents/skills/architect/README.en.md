<!-- skill-readme-sync: v3.53 / 1.9 -->
# Architect + Executor Skill (`v3.53 / 1.9`)

A portable **Chief Architect + Executor** workflow skill with two independent installation levels:
1. **Skill Core (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** works with **any AI coding agent** (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**, **Cursor**, Windsurf, etc.), **any tech stack**, and **any OS** (macOS, Linux, Windows) via manual chat or subagent handoff.
2. **Automated Orchestrator (`orchestrator/run.mjs`):** zero-dependency Node.js CLI requiring **Node.js 22+** and **git 2.31+**. **Deterministic checks (`--check`, `--check-task`, `--self-check`) are officially supported on macOS and Linux (`ubuntu-latest`); the headless agent loop supports macOS only (Windows is not supported).** Supports headless runners **`agy`** (Antigravity) and **`claude`** (Claude Code); native desktop notifications work on **macOS** (`osascript`), and `AGENT_LOOP_WEBHOOK_URL` webhook notifications are also supported.

- **Active prompts (English, single source of truth):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks,team}.md`.
- **Human guides (`<= 25 KB` each):** `README.en.md` (English) and `README.ru.md` (Russian).

---

## 1. Quickstart (2 Steps)

1. **Install or update the skill in one command** (or ask your agent: *"Install the `architect` skill from `https://github.com/Aghasi-Sargsyan/architect-skill` into `.agents/skills/architect`"*):
   - **Antigravity, Gemini CLI, Codex, Cursor (`.agents/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .agents/skills && rm -rf .agents/skills/architect && cp -R "$tmp/.agents/skills/architect" .agents/skills/ && rm -rf "$tmp"
     ```
   - **Claude Code (`.claude/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .claude/skills && rm -rf .claude/skills/architect && cp -R "$tmp/.agents/skills/architect" .claude/skills/ && rm -rf "$tmp"
     ```
   - **Updating an already installed skill (in 1 command):** write **`/architect update`** in your agent chat, or run:
     ```bash
     node .agents/skills/architect/orchestrator/run.mjs --update
     # or: npm run agents -- --update
     ```
2. **Open your agent and write `/architect`** (or *"Read `.agents/skills/architect/SKILL.md`"*):
   - **First run in a new project:** in Phase 1 (read-only), the Architect touches no files before your approval, asks in a single question for the **Executor model** (proposing options available in your current environment without picking a model itself), and offers to add the roles block to `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`). After you approve the plan in Phase 2, the Architect uses the `.architect/` (`compact`) layout by default: it copies `.architect/EXECUTOR.md` and commits the chosen model, roles block, `.architect/EXECUTOR.md`, and `.architect/PLAN.md` together in `arch: plan ...` (for the orchestrator, it runs `--init`, `--check`, and `--dry-run` itself, asking `"yes"` only before `--write-permissions`; to migrate an existing `classic` project into `.architect/`, write **`/architect compact`** or run `--compact`).

---

## 2. How the Two-Model Workflow Works

| Role | Responsibility | Rules File | Commit Prefix |
|---|---|---|---|
| **Chief Architect** | Investigates context, challenges ideas, records ADRs, writes `PLAN.md` and `Frozen` reference tests, reviews diffs (`REVIEW`), resolves escalations, closes cycles | `SKILL.md` + `references/*.md` | `arch: ...` |
| **Executor** | Implements a single atomic task `T-NNN` strictly within the files listed in `Change`, runs `Check`, commits, and returns a structured report (or stops on escalation) | `EXECUTOR.md` | `T-NNN: ...` / `T-NNN (fix K): ...` |

### Key Guardrails
- **Two-Phase Protocol (`§2.5`):** Phase 1 is strictly read-only. No files or commits are created until you explicitly approve an option.
- **Frozen Files (`## Frozen`):** Top-level backticked paths (`- \`path\`` or globs `dir/*`, `dir/**`), reference tests (`*.test.*`) for high-risk code tasks, `EXECUTOR.md`, and the skill's own markdown files (`SKILL*.md`, `references/**`) cannot be modified by the Executor — enforced by prompt rules, `plan-validate.mjs`, and `mechanics.mjs`.
- **Four-Layer Push & Path Guards (`guards.mjs`, `runners.mjs`):** While `AGENT_LOOP=1`, `PATH` shims, `.git/hooks/pre-push`, and `remote.<name>.pushurl` block `git push`, forbidden scripts, history rewrites, and direct reads outside `workDir` by the wrapped tools; the shims and the permission question live outside the project (`~/.config/architect/runs/<project>/`, mode `0700`) and a changed shim stops the loop.
- **Zero Tolerance for Check Bypassing:** `mechanics.mjs` and `--self-check` scan diffs for `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, deleted tests, `git commit --no-verify`, global prototype mutations, or silent `catch {}`.
- **Whole-Task Checks & Orchestrator Acceptance (`task-range.mjs`, `accept.mjs`):** Checks cover every commit of a task since its base, so a restart never hides an earlier violation; in the loop the Architect review is read-only, and the orchestrator itself marks `[x]` and commits `arch: accept T-NNN`.

### Threat Model
- **Guardrails, not a security boundary:** the checks above stop model mistakes and rule bypasses. Only the runner's OS sandbox is a security boundary: the `claude` runner runs with it enabled, the `agy` runner runs without one.
- **Untrusted content** (third-party code, issue text, web data): run the loop in a container, a VM, or a separate clone without network access or cloud keys.
- **Data, not instructions:** the rules of both agents treat file contents, command output, and reports as data (`EXECUTOR.md` `1.9`, `SKILL.md` `v3.53`).
- **Known limits:** `Verify` commands run with the orchestrator's own rights outside the runner sandbox; changes to git-ignored files (e.g. `node_modules/`) are invisible to the clean-tree check; a background process that outlives an agent turn is not tracked; a `Verify` timeout (default 600 s) stops the loop as an environment problem instead of spending a rework round.

---

## 3. Manual Installation and Updating by Environment

### Manual Installation (Step by Step)
1. **Copy the skill folder into a subfolder of your project** (e.g. `.agents/skills/architect/`, or for Claude Code a `.claude/skills/architect` copy or link to it). Never unpack the skill directly into the repository root (`--check` rejects root-level installation).
2. **Copy `EXECUTOR.md`** into the project root (`cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md`, or `.architect/EXECUTOR.md` in compact layout).
3. **Set the Executor model once for your project:**
   - **With the orchestrator (`agy` or `claude`):** set `executor.model` in `.architect/config.json` or `.agents/orchestrator.json`.
   - **Without the orchestrator:** add `Executor model: <Model / Tier>` to your project's `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` (see Section 4 snippet). For Claude Code subagents, see B below.
4. **Verify setup and run tasks (`T-NNN`):**
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --check
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --self-check
   node .agents/skills/architect/orchestrator/run.mjs --background
   node .agents/skills/architect/orchestrator/run.mjs --follow
   ```

### A. Antigravity (`agy`) — Core + Orchestrator
1. Place the skill in a subfolder: `.agents/skills/architect/`.
2. Copy `.agents/skills/architect/EXECUTOR.md` to `EXECUTOR.md` in the project root.
3. For the automated loop (`runner: "agy"`, macOS only, Node 22+), run `--init` to create `.architect/config.json` (or `.agents/orchestrator.json`), then after reviewing the rules write the allowlist to `~/.gemini/antigravity-cli/settings.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### B. Claude Code (`claude`) — Core + Orchestrator or Subagent
1. Place the skill at `.agents/skills/architect/` and link `.claude/skills/architect` to it (`--init` does it), or copy it there; copy `EXECUTOR.md` to the project root.
2. **Subagent mode:** copy `.agents/skills/architect/templates/claude-agent-executor.md` to `.claude/agents/executor.md` and verify `model:` is set explicitly (`model: sonnet`, never `inherit`; optional `effort:`).
3. **Orchestrator mode (macOS only, Node 22+):** set `"runner": "claude"`, `"executor": { "model": "sonnet-high" }`, and `"architect": { "model": "opus" }` (`-<effort>` adds `--effort`) in `.architect/config.json` (or `.agents/orchestrator.json`), then run:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### C. Gemini CLI, OpenAI Codex CLI, Cursor, and Other Agents — Core Only
- Place the skill in `.agents/skills/architect/`, copy `EXECUTOR.md` to the project root, and add the Section 4 snippet (including `Executor model: …`) to `GEMINI.md`, `AGENTS.md`, or `.cursorrules`. Run Architect and Executor sessions in separate chats.

### D. Updating the Skill in an Existing Project
1. **With the orchestrator (one-command update):**
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --update
   # or: npm run agents -- --update
   ```
   This automatically clones the latest commit into a temporary directory, atomically updates installed skill folders (`.agents/skills/architect` / `.claude/skills/architect`), records the commit SHA in `.version`, synchronizes root `EXECUTOR.md`, and refreshes git hooks without touching your project configs (`config.json`, `config.local.json`) or history. `--check`, `--dry-run`, `--self-check`, and loop startup check for new upstream commits once per 24h (cached in `.agent-runs/.update-check.json`) and emit an informational `! skill update available:` line when a newer commit exists.
2. **Without Node.js / orchestrator:** re-run the same idempotent one-line install command from Section 1 (`Quickstart`) for `.agents/skills/` or `.claude/skills/` using `mktemp -d` (`rm -rf` of the old skill folder before `cp -R`), then refresh the project copy of `EXECUTOR.md`:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. Run `node .agents/skills/architect/orchestrator/run.mjs --check` to verify installation parity and base allowlist commands.

---

## 4. Ready Snippet for `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`

Add this block to your project's `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`:

```markdown
### Roles: Chief Architect and Executor
- **Architect session** (when `/architect` is invoked or asked to plan/review/diagnose): first read `.agents/skills/architect/SKILL.md` and follow its Two-Phase Protocol (`[MODE: ... · PHASE 1/2]`).
- **Executor session** (when asked to execute task `T-NNN` from `PLAN.md`): first read `EXECUTOR.md` and `PLAN.md`, modify only files in `Change` of `T-NNN`, never touch `Frozen` or `PLAN.md`, and run `Check` before committing `T-NNN: ...`.
- **Executor model:** `<Model / Tier>` (used for all `T-NNN` tasks unless overridden in the task's `Model` field).
- **Commit language:** English (`T-NNN: ...`, `arch: ...`).
```

---

## 5. `PLAN.md` Structure and File Layout

You can keep working files either in the repository root (`PLAN.md`, `EXECUTOR.md`, `docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`) or inside `.architect/` (`planPath: ".architect/PLAN.md"`, `executorPath: ".architect/EXECUTOR.md"`).

Every task `T-NNN` in `PLAN.md` uses explicit fields parsed by `plan.mjs` (both English and Russian labels are supported):
- `Risk` (`Риск`): `low` | `medium` | `high` (`низкий` | `средний` | `высокий`)
- `Depends on` (`Зависит от`): `—` or `T-NNN`
- `Model` (`Модель`): target Executor model
- `Read` (`Читать`): files to inspect before coding
- `Change` (`Менять`): exact allowlist of files the Executor may create or edit (`<= 3–5` files)
- `Task and invariants` (`Задача и инварианты`), `Edge cases` (`Граничные случаи`), `Test cases` (`Тест-кейсы`), `Done when` (`Готово, когда`), `Check` (`Проверка`).

### Multi-Stack Configuration (`config.json` / `orchestrator.json`)
For non-Node stacks (Python/`pytest`, Go/`go test`, Rust/`cargo test`, Vitest/Jest), configure `testFilePatterns`, `testPatterns`, `assertPatterns` (`assert.` and `expect(` are included by default), and `redCheckCommand` (e.g. `"pytest {file}"` or `"npx vitest run {file}"`). If a `Frozen` reference test has no matching `redCheckCommand` or a test file has `0` recognized assertions, `--self-check` reports a loud `NOT VERIFIED` with the file name instead of passing silently.

---

## 6. Orchestrator CLI Reference (`orchestrator/run.mjs`)

Add `"agents": "node .agents/skills/architect/orchestrator/run.mjs"` to `scripts` in `package.json` (or invoke `node .agents/skills/architect/orchestrator/run.mjs` directly):

| Flag | Description |
|---|---|
| `--init [--team]` | Create `.architect/config.json` (or `.agents/orchestrator.json`), install `.git/hooks/commit-msg`, add `.agent-runs/` and `*.local.json` to `.gitignore`; with `--team`, set `"team": true` and create `.github/workflows/team-ci.yml` |
| `--install-hooks` | Install the zero-dependency Node `.git/hooks/commit-msg` hook (without overwriting an existing custom hook or `core.hooksPath`) |
| `--update [--force]` | Fetch latest commit, atomically update installed skill folder, write commit SHA to `.version`, sync `EXECUTOR.md`, and refresh git hooks |
| `--compact` | Migrate an existing `classic` project (root `PLAN.md`/`EXECUTOR.md`/`docs/`) into the `.architect/` compact layout (`/architect compact`) |
| `--repair` | Restore leftover `remote.<name>.pushurl`, `.git/hooks/pre-push`, and stale `.agent-runs/.lock` after a crashed run (`/architect repair`) |
| `--models` / `--set-model <executor\|architect> <id> [--local]` | List current `executor` / `architect` models and all available environment models with effort tiers (`--models`), or set the chosen role model in shared/local config and sync `AGENTS.md` / `.claude/agents/executor.md` (`--set-model`, `/architect model`) |
| `--check` | Verify OS, Node.js 22+, git 2.31+, skill subfolder layout, `EXECUTOR.md` parity, `commit-msg` hook, resolved Executor model and its source, `PLAN.md`, parallel task boundaries, runner binaries, and allowlists; no live model call unless `--probe` is passed (end-to-end permission probe) |
| `--check-task T-NNN [--base <ref>]` | Mechanically verify task `T-NNN` against `<base>:PLAN.md` and `git merge-base <base> HEAD` (`Change` boundaries, `Frozen`, bypasses, commit messages, no-squash, and task `Verify` commands) |
| `--write-permissions` | Write safe command/file allowlists: `claude` prunes unsafe `allow` rules (archived to `*.pruned.json`); the shared `agy` file is only added to, unsafe rules stay and keep `--check` red (only after explicit user confirmation) |
| `--dry-run` | Validate readiness, run `--self-check` (including `red-check`), and preview the next task prompt without calling any LLM |
| `--self-check [--base <ref>]` | Run deterministic Architect self-check (bypasses, empty `catch`, test timers, monotonicity, `fix-frozen`, `eval` evidence, audit coverage, parallel task overlaps, and `red-check`) |
| `--audit-plan` | Run advisory read-only cross-model plan audit (`references/plan-audit.md`) via `config.auditor` (paid live call, max 1 re-run per cycle base) |
| `--background` | Start the detached background loop; returns once it holds `.agent-runs/.lock` and prints the next `--watch` (exit `1` if the start fails) |
| `--stop` | Stop a running loop: the agent first, then guards, then the lock (exit `0`; `1` when no loop is running) |
| `--watch [min] [--since N]` | Wait for a permission prompt (exit `2`), loop stop (exit `3`), or task milestone (exit `4`); the output ends with `(milestones: N)` |
| `--status` | Print compact current loop status (with `(milestones: N)` while running) and task progress |
| `--follow` | Live terminal stream of agent thoughts, tool calls, commands, and verdicts (read-only) |
| `--answer <1\|2\|3>` | Answer a pending permission request (`1` prefix, `2` exact command, `3` deny) |
| `--pause` | Stop after each accepted task for interactive confirmation |
| `--only T-NNN` | Run only the specified task `T-NNN` |

---

## 7. Behavioral Evals and Maintenance (`evals.mjs`, `MAINTAINING.md`)

- **Unit & reference tests (no LLM calls, runs in an isolated temp repo too):**
  ```bash
  node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  VERIFY_STEP_A1=1 node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  ```
- **Live behavioral evals (for skill contributors; see `MAINTAINING.md`):**
  ```bash
  node .agents/skills/architect/orchestrator/evals.mjs --model claude:haiku
  ```

---

## 8. When to Use and When Not to Use the Skill

- **Full skill (Core + Orchestrator):** long-lived products with critical risk areas (authentication, access control, billing, database migrations, concurrency, data invariants) on macOS using `agy` or `claude`.
- **Core only (`SKILL.md` + `EXECUTOR.md`):** medium-sized projects, other agents (`Gemini CLI`, `Codex`, `Cursor`), Linux/WSL2, or Windows environments where Two-Phase planning, `Frozen` contracts, and context-isolated tasks pay off without the headless Node.js runner.
- **Do not use:** throwaway prototypes, quick hypothesis validation, game jams, one-off scripts, or tasks where acceptance is purely visual.
- **Team repositories with existing PR review and CI:** either enable full Team Mode (`--init --team`, Section 9) or adopt only the core practices (read-only Phase 1 brainstorm, `Frozen` reference tests, context-isolated Executor).

---

## 9. Team Use and GitHub Repository Settings

In Team Mode (1 Chief Architect / tech lead + N Executors across Antigravity, Claude Code, Codex), initialize the repository with:
```bash
node .agents/skills/architect/orchestrator/run.mjs --init --team
```
This sets `"team": true` and `"fullTestCommand": "npm test"` in the shared config, adds `.architect/config.local.json` and `.agents/orchestrator.local.json` to `.gitignore`, and writes `.github/workflows/team-ci.yml` (copied from `templates/github-team-ci.yml`).

### Personal Local Config vs Shared Project Policy
- **Shared config (`.architect/config.json` or `.agents/orchestrator.json`, committed):** stores project policy (`team`, `commitLanguage`, `permissions`, `allowedCommands`, `blockedScripts`, `protectedConfigFiles`, `bypassScanPaths`, `bypassPatterns`, `fullTestCommand`).
- **Personal local config (`.architect/config.local.json` or `.agents/orchestrator.local.json`, git-ignored):** overrides only personal environment settings (`executor`, `architect`, `auditor`, `runner`, `runnerBin`, `agyBin`, `notify`). Policy fields in `.local.json` are rejected fail-closed.
- **Model resolution chain (`--check` shows the resolved model and its source):** `.local.json` → shared config → agent file (`.claude/agents/executor.md` / `AGENTS.md`). Task cards use `Executor: @<github-handle> · <Environment> · <Model (\`id\`)>` for assignment and `Parallel with: T-MMM` for concurrent tasks; the model in `Executor` never overrides `.local.json`, and the orchestrator refuses a task whose assigned environment does not match the local `runner`.

### Branch Flow (`cycle/<N>`, `task/T-NNN`, `master`)
1. **Start cycle:** Architect creates `cycle/<N>` from `master`, commits `arch: plan ...` with `PLAN.md` and red `Frozen` reference tests, and the human tech lead pushes `cycle/<N>`.
2. **Execute task:** A developer branches `task/T-NNN` from `cycle/<N>`, runs the Executor agent locally (the agent commits `T-NNN: ...` and never pushes), pushes `task/T-NNN`, and opens PR `task/T-NNN → cycle/<N>` with the Executor Completion Report in the PR description.
3. **PR Gate & Acceptance:** On PRs targeting `cycle/*`, CI runs `run.mjs --check-task T-NNN --base origin/cycle/<N>` (reads `PLAN.md` from `<base>`, diffs from `git merge-base <base> HEAD`, rejects `PLAN.md` / `.github/workflows/**` / `CODEOWNERS` edits, enforces commit rules and no-squash, and runs only the task's `Verify` commands). After review per `references/auto-review.md`, the tech lead merges the PR into `cycle/<N>` using **Create a merge commit** (`--no-ff`), then commits `arch: accept T-NNN` (`- [x] T-NNN:` in `PLAN.md`) and pushes directly to `cycle/<N>`.
4. **Close cycle:** Once all tasks are `[x]`, the Architect commits `arch: close cycle <N>` on `cycle/<N>` and opens PR `cycle/<N> → master`. CI runs the full `fullTestCommand` suite and `--self-check --base origin/master`; the tech lead merges `cycle/<N> → master` using **Create a merge commit**.

### Exact GitHub Repository Settings
1. **Pull Request merge methods ([Configuring commit merging for pull requests](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-merging-for-pull-requests)):**
   - Enable **Allow merge commits** (default commit message).
   - **Disable Allow squash merging** and **Disable Allow rebase merging** so `T-NNN:` and `arch:` commit granularity is preserved for `--check-task` and `--self-check`.
2. **Ruleset for `cycle/*` ([About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)):**
   - **Target branches:** `cycle/*`.
   - **Bypass list:** Add the **Tech Lead / Architect** role or user (so the Architect can push `arch: plan`, `arch: accept T-NNN`, and `arch: close cycle <N>` directly to `cycle/<N>` while Executors must use PRs).
   - **Rules:** enable *Require a pull request before merging* (Allow **Merge** only), *Require status checks to pass* (`Task PR Gate (task/T-NNN -> cycle/*)`), and *Block force pushes*.
3. **Ruleset / Branch Protection for `master` / `main` ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)):**
   - **Target branches:** Default branch (`master` or `main`), no direct push bypass.
   - **Rules:** enable *Require a pull request before merging* (Allow **Merge** only), *Require status checks to pass* (`Full Test Suite & Self-Check (master/main)`), and *Block force pushes*.
