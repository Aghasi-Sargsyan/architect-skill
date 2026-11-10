# Architect + Executor Skill (`v3.41 / 1.8`)

A portable workflow skill for AI-assisted engineering with role separation: **Chief Architect** (investigation, ADRs, frozen reference tests, code review) and **Executor** (atomic task execution in isolated change boundaries). Includes a deterministic, zero-dependency Node.js orchestrator.

## System Requirements

- **Skill Core (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** Works with any AI coding agent (Claude Code, Gemini CLI, OpenAI Codex CLI, Antigravity, Cursor, etc.), any tech stack, and any OS (macOS, Linux, Windows).
- **Automated Orchestrator (`orchestrator/run.mjs`):** Node.js 22+ and git 2.31+. Commands `--check`, `--check-task`, and `--self-check` are supported on macOS and Linux (CI/local); the automated agent loop runs on macOS. Supports headless runners `agy` and `claude`.

## Quickstart

1. **Install or update the skill in one command** (or ask your agent: *"Install the skill from https://github.com/Aghasi-Sargsyan/architect-skill into .agents/skills/architect"*):
   - **Antigravity, Gemini CLI, Codex, Cursor (`.agents/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .agents/skills && rm -rf .agents/skills/architect && cp -R "$tmp/.agents/skills/architect" .agents/skills/ && rm -rf "$tmp"
     ```
   - **Claude Code (`.claude/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .claude/skills && rm -rf .claude/skills/architect && cp -R "$tmp/.agents/skills/architect" .claude/skills/ && rm -rf "$tmp"
     ```
2. **Open your agent and write `/architect`** (or read `.agents/skills/architect/SKILL.md`). On first run in a new project, the Architect asks for the Executor model and configures the project safely before any code changes.

## Updating

To update an already installed skill in your project (updates `.agents/skills/architect` or `.claude/skills/architect`, syncs `EXECUTOR.md`, and refreshes `.git/hooks/commit-msg` without touching your `config.json` or `PLAN.md`), write **`/architect update`** in your agent chat, or run in the terminal:
```bash
node .agents/skills/architect/orchestrator/run.mjs --update
# or: npm run agents -- --update
```
`--check`, `--dry-run`, `--self-check`, and loop startup automatically check for new upstream commits once every 24 hours (cached in `.agent-runs/.update-check.json`, non-blocking offline) and print `! skill update available: ...` when an update is ready.

## Manual Installation

1. Copy `.agents/skills/architect/` into a subfolder of your project (never unpack directly into the repository root).
2. Copy `EXECUTOR.md` to the project root:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. Set `executor.model` in `.architect/config.json` (or `.agents/orchestrator.json`), or declare it in your project's `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`.
4. Verify setup and run (or update):
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --check
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --self-check
   node .agents/skills/architect/orchestrator/run.mjs --update
   ```

## Team Use

Initialize team mode (1 Architect / tech lead + N Executors across branches and PRs):
```bash
node .agents/skills/architect/orchestrator/run.mjs --init --team
```
- **Branches:** `cycle/<N>` for plan and frozen tests; developers branch `task/T-NNN` and open PRs into `cycle/<N>` with PR gate `--check-task T-NNN`.
- **Local config:** `.architect/config.local.json` (or `.agents/orchestrator.local.json`, git-ignored) overrides personal runners/models without affecting team policy.
- **GitHub settings:** Use Merge commit only (no squash/rebase). Configure [GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) for `cycle/*` (tech lead in bypass list) and `master` (require CI). See Section 9 of [README.en.md](.agents/skills/architect/README.en.md) / [README.ru.md](.agents/skills/architect/README.ru.md).

## Documentation & License

- Detailed English Guide: [.agents/skills/architect/README.en.md](.agents/skills/architect/README.en.md)
- Detailed Russian Guide: [.agents/skills/architect/README.ru.md](.agents/skills/architect/README.ru.md)
- License: [LICENSE](LICENSE) (MIT)

## Feedback

- Field Report (GitHub Issues): [Submit a Field Report](https://github.com/Aghasi-Sargsyan/architect-skill/issues/new?template=field-report.yml) ([.github/ISSUE_TEMPLATE/field-report.yml](.github/ISSUE_TEMPLATE/field-report.yml))
