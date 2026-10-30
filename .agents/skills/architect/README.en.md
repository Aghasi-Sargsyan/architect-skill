<!-- skill-readme-sync: v3.27 / 1.8 -->
# Architect + Executor Skill (`v3.27 / 1.8`)

A portable **Chief Architect + Executor** workflow skill for AI coding agents (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**) with a deterministic, zero-dependency Node.js orchestrator (`orchestrator/run.mjs`).

- **Active prompts (English, single source of truth):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks}.md`.
- **Human guides (`<= 25 KB` each):** `README.en.md` (English) and `README.ru.md` (Russian).
- **Runtime requirements:** The automated orchestrator (`orchestrator/run.mjs`) requires **Node.js 22+ on macOS or Linux** (and `git 2.31+`). Using the skill rules (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) with manual Executor handoff does not depend on the Node.js version.

---

## 1. Quickstart (5 Minutes)

1. **Copy the skill folder** into your project (e.g. `.agents/skills/architect/`, or `.claude/skills/architect/` for Claude Code).
2. **Copy `EXECUTOR.md`** into the project root (or `.architect/EXECUTOR.md`).
3. **Start a chat with the Architect** (`/architect` or ask the model to read `SKILL.md`):
   - **Phase 1 (Read-Only Brainstorm):** The Architect diagnoses the problem, challenges weak assumptions, and proposes 1–3 options without touching any files.
   - **Phase 2 (Plan & Execution):** After you pick an option, the Architect records ADRs, locks `Frozen` reference tests for high-risk tasks, and commits `PLAN.md`.
4. **Execute tasks (`T-NNN`)** either manually in a separate Executor session (`Read EXECUTOR.md and PLAN.md. Execute task T-001.`) or automatically via the orchestrator:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --background
   node .agents/skills/architect/orchestrator/run.mjs --follow
   ```

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
- **Zero Tolerance for Check Bypassing:** `mechanics.mjs` scans every Executor diff for `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, deleted tests, or silent `catch {}`.

---

## 3. Installation by Runner (Claude Code, Gemini CLI, Codex, Antigravity)

### A. Antigravity (`agy`)
1. Place the skill at `.agents/skills/architect/` in your workspace.
2. Invoke `/architect` in chat.
3. For the automated loop (`runner: "agy"`), configure `.agents/orchestrator.json` and write the one-time allowlist to `~/.gemini/antigravity-cli/settings.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   ```

### B. Claude Code (`claude`)
1. Place the skill at `.agents/skills/architect/` (or symlink/copy to `.claude/skills/architect/`).
2. Set `"executor": { "runner": "claude", "model": "sonnet" }` and `"architect": { "runner": "claude", "model": "opus" }` in `.agents/orchestrator.json`.
3. Write the project-scoped allowlist and filesystem sandbox to `.claude/settings.local.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   ```

### C. Gemini CLI & OpenAI Codex CLI
- **Interactive mode:** Point Gemini CLI (`GEMINI.md`) or Codex (`AGENTS.md`) to `.agents/skills/architect/SKILL.md` for Architect sessions and `EXECUTOR.md` for `T-NNN` Executor sessions using the snippet in Section 4.

---

## 4. Ready Snippet for `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`

Add this block to your project's `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`:

```markdown
### Roles: Chief Architect and Executor
- **Architect session** (when `/architect` is invoked or asked to plan/review/diagnose): first read `.agents/skills/architect/SKILL.md` and follow its Two-Phase Protocol (`[MODE: ... · PHASE 1/2]`).
- **Executor session** (when asked to execute task `T-NNN` from `PLAN.md`): first read `EXECUTOR.md` and `PLAN.md`, modify only files in `Change` of `T-NNN`, never touch `Frozen` or `PLAN.md`, and run `Check` before committing `T-NNN: ...`.
```

---

## 5. `PLAN.md` Structure and File Layout

You can keep working files either in the repository root (`PLAN.md`, `EXECUTOR.md`, `docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`) or cleanly tucked inside `.architect/` (`planPath: ".architect/PLAN.md"`, `executorPath: ".architect/EXECUTOR.md"` in `.agents/orchestrator.json`).

Every task `T-NNN` in `PLAN.md` uses explicit fields parsed by `plan.mjs` (both English and Russian labels are supported):
- `Risk` (`Риск`): `low` | `medium` | `high` (`низкий` | `средний` | `высокий`)
- `Depends on` (`Зависит от`): `—` or `T-NNN`
- `Model` (`Модель`): target Executor model
- `Read` (`Читать`): files to inspect before coding
- `Change` (`Менять`): exact allowlist of files the Executor may create or edit (`<= 3–5` files)
- `Task and invariants` (`Задача и инварианты`), `Edge cases` (`Граничные случаи`), `Test cases` (`Тест-кейсы`), `Done when` (`Готово, когда`), `Check` (`Проверка`).

---

## 6. Orchestrator CLI Reference (`orchestrator/run.mjs`)

Add `"agents": "node .agents/skills/architect/orchestrator/run.mjs"` to `scripts` in `package.json` (or invoke `node .agents/skills/architect/orchestrator/run.mjs` directly):

| Flag | Description |
|---|---|
| `--init` | Interactive wizard to create `.agents/orchestrator.json` |
| `--check` | Verify OS, Node.js, git, `PLAN.md`, runner binaries, model access, and allowlists |
| `--write-permissions` | Write safe command/file allowlists for `agy` or `claude` (only after user confirmation) |
| `--dry-run` | Validate readiness, run `--self-check` (including `red-check`), and preview the next task prompt without calling any LLM |
| `--self-check [--base <ref>]` | Run deterministic Architect self-check (bypasses, empty `catch`, test timers, monotonicity, `fix-frozen`, `eval` evidence, audit coverage, and `red-check`) |
| `--audit-plan` | Run advisory read-only cross-model plan audit (`references/plan-audit.md`) via `config.auditor` (paid live call, max 1 re-run per cycle base) |
| `--background` | Start the detached background loop (`PID` lock in `.agent-runs/active.lock`) |
| `--watch [min] [--since N]` | Wait for a permission prompt (exit `2`), loop stop (exit `3`), or task milestone (exit `4`) |
| `--status` | Print compact current loop status and task progress |
| `--follow` | Live terminal stream of agent thoughts, tool calls, commands, and verdicts (read-only) |
| `--answer <1\|2\|3>` | Answer a pending permission request (`1` exact command, `2` prefix, `3` deny) |
| `--pause` | Gracefully stop the background loop after the current step finishes |
| `--only T-NNN` | Run only the specified task `T-NNN` |

---

## 7. Behavioral Evals and Maintenance (`evals.mjs`, `MAINTAINING.md`)

- **Unit & reference tests (no LLM calls):**
  ```bash
  node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  VERIFY_STEP_A1=1 node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  ```
- **Live behavioral evals (5 scenarios: `phase1_no_write`, `quick_fix_no_adr`, `high_risk_frozen_test`, `escalation_no_touch_change`, `auto_refusal_git_c_retry`):**
  ```bash
  node .agents/skills/architect/orchestrator/evals.mjs --model claude:haiku
  ```
- **Maintaining the skill:** Whenever you update rules in `SKILL.md`, `EXECUTOR.md`, or `references/*.md`, follow `MAINTAINING.md` to keep version headers, root `EXECUTOR.md`, and `<!-- skill-readme-sync: vX.Y / A.B -->` in sync.
