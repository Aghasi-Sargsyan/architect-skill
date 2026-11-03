<!-- skill-readme-sync: v3.29 / 1.8 -->
# Architect + Executor Skill (`v3.29 / 1.8`)

A portable **Chief Architect + Executor** workflow skill with two independent installation levels:
1. **Skill Core (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** works with **any AI coding agent** (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**, **Cursor**, Windsurf, etc.), **any tech stack**, and **any OS** (macOS, Linux, Windows) via manual chat or subagent handoff.
2. **Automated Orchestrator (`orchestrator/run.mjs`):** zero-dependency Node.js loop requiring **Node.js 22+** and **git 2.31+**. **The orchestrator officially supports macOS only. Linux and WSL2 are untested, Windows is not supported. The core rules work on any OS.** Supports only headless runners **`agy`** (Antigravity) and **`claude`** (Claude Code); native desktop notifications work on **macOS** (`osascript`), and `AGENT_LOOP_WEBHOOK_URL` webhook notifications are also supported.

- **Active prompts (English, single source of truth):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks}.md`.
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
2. **Open your agent and write `/architect`** (or *"Read `.agents/skills/architect/SKILL.md`"*):
   - **First run in a new project:** in Phase 1 (read-only), the Architect touches no files before your approval, asks in a single question for the **Executor model** (proposing options available in your current environment without picking a model itself), and offers to add the roles block to `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`). After you approve the plan in Phase 2, the Architect copies `EXECUTOR.md` itself and records the chosen model, roles block, `EXECUTOR.md`, and `PLAN.md` together in the first `arch: plan ...` commit. If you want the automated orchestrator, the Architect runs `--init`, `--check`, and `--dry-run` itself, asking `"yes"` only before `--write-permissions`.

---

## 2. How the Two-Model Workflow Works

| Role | Responsibility | Rules File | Commit Prefix |
|---|---|---|---|
| **Chief Architect** | Investigates context, challenges ideas, records ADRs, writes `PLAN.md` and `Frozen` reference tests, reviews diffs (`REVIEW`), resolves escalations, closes cycles | `SKILL.md` + `references/*.md` | `arch: ...` |
| **Executor** | Implements a single atomic task `T-NNN` strictly within the files listed in `Change`, runs `Check`, commits, and returns a structured report (or stops on escalation) | `EXECUTOR.md` | `T-NNN: ...` / `T-NNN (fix K): ...` |

### Key Safety Invariants
- **Two-Phase Protocol (`§2.5`):** Phase 1 is strictly read-only. No files or commits are created until you explicitly approve an option.
- **Frozen Files (`## Frozen`):** Reference tests (`*.test.*`) for high-risk tasks, `EXECUTOR.md`, and the skill's own markdown files (`SKILL*.md`, `references/**`) cannot be modified by the Executor — enforced both by prompt rules and deterministically by `mechanics.mjs`.
- **Four-Layer Push & Path Guards (`guards.mjs`, `runners.mjs`):** While `AGENT_LOOP=1`, `PATH` shims, `.git/hooks/pre-push`, and `remote.<name>.pushurl` block `git push`, forbidden scripts, history rewrites, and reading files outside `workDir`.
- **Zero Tolerance for Check Bypassing:** `mechanics.mjs` and `--self-check` scan diffs for `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, deleted tests, `git commit --no-verify`, global prototype mutations, or silent `catch {}`.

---

## 3. Manual Installation and Updating by Environment

### Manual Installation (Step by Step)
1. **Copy the skill folder into a subfolder of your project** (e.g. `.agents/skills/architect/`, or `.claude/skills/architect/` for Claude Code). Never unpack the skill directly into the repository root (`--check` rejects root-level installation).
2. **Copy `EXECUTOR.md`** into the project root (`cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md`, or `.architect/EXECUTOR.md` in compact layout).
3. **Set the Executor model once for your project:**
   - **With the orchestrator (`agy` or `claude`):** set `executor.model` in `.architect/config.json` or `.agents/orchestrator.json`.
   - **Without the orchestrator:** add `Executor model: <Model / Tier>` to your project's `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` (see Section 4 snippet). For Claude Code subagents, copy `.agents/skills/architect/templates/claude-agent-executor.md` to `.claude/agents/executor.md` and set an explicit `model:` field (never leave `inherit` or omit `model`).
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
1. Place the skill at `.agents/skills/architect/` or `.claude/skills/architect/` and copy `EXECUTOR.md` to the project root.
2. **Subagent mode:** copy `.agents/skills/architect/templates/claude-agent-executor.md` to `.claude/agents/executor.md` and verify `model:` is set explicitly (e.g. `model: sonnet`, never `inherit`).
3. **Orchestrator mode (macOS only, Node 22+):** set `"runner": "claude"`, `"executor": { "model": "sonnet" }`, and `"architect": { "model": "opus" }` in `.architect/config.json` (or `.agents/orchestrator.json`), then run:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### C. Gemini CLI, OpenAI Codex CLI, Cursor, and Other Agents — Core Only
- Place the skill in `.agents/skills/architect/`, copy `EXECUTOR.md` to the project root, and add the Section 4 snippet (including `Executor model: …`) to `GEMINI.md`, `AGENTS.md`, or `.cursorrules`. Run Architect and Executor sessions in separate chats.

### D. Updating the Skill in an Existing Project
1. Re-run the same one-line install command from Section 1 (`Quickstart`) for `.agents/skills/` or `.claude/skills/` — it is idempotent (`mktemp -d`, `rm -rf` of the old skill folder before `cp -R`). Your project config (`.architect/config.json` or `.agents/orchestrator.json`) and history (`docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`) live outside the skill folder and are untouched.
2. Refresh the project copy of `EXECUTOR.md`:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. If using the orchestrator, run `node .agents/skills/architect/orchestrator/run.mjs --check` to verify installation parity and base allowlist commands.

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
| `--init` | Create `.architect/config.json` (or `.agents/orchestrator.json`), install `.git/hooks/commit-msg`, add `.agent-runs/` to `.gitignore`, and print the allowlist block |
| `--install-hooks` | Install the zero-dependency Node `.git/hooks/commit-msg` hook (without overwriting an existing custom hook or `core.hooksPath`) |
| `--check` | Verify OS, Node.js 22+, git 2.31+, skill subfolder layout, `EXECUTOR.md` parity, `commit-msg` hook, Executor model config, `PLAN.md`, runner binaries, and allowlists |
| `--check-task T-NNN [--base <ref>]` | Mechanically verify Executor commits for `T-NNN` outside the automated loop (`Change` boundaries, `Frozen`, check bypasses) |
| `--write-permissions` | Write safe command/file allowlists for `agy` or `claude` (only after explicit user confirmation) |
| `--dry-run` | Validate readiness, run `--self-check` (including `red-check`), and preview the next task prompt without calling any LLM |
| `--self-check [--base <ref>]` | Run deterministic Architect self-check (bypasses, empty `catch`, test timers, monotonicity, `fix-frozen`, `eval` evidence, audit coverage, and `red-check`) |
| `--audit-plan` | Run advisory read-only cross-model plan audit (`references/plan-audit.md`) via `config.auditor` (paid live call, max 1 re-run per cycle base) |
| `--background` | Start the detached background loop (`PID` lock in `.agent-runs/.lock`) |
| `--watch [min] [--since N]` | Wait for a permission prompt (exit `2`), loop stop (exit `3`), or task milestone (exit `4`) |
| `--status` | Print compact current loop status and task progress |
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
- **Team repositories with existing PR review and CI:** adopt the core practices (read-only Phase 1 brainstorm, `Frozen` reference tests written before implementation, context-isolated Executor) without enforcing the `arch:` / `T-NNN:` commit message conventions.
