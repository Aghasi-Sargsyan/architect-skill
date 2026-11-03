# Architect + Executor Skill (`v3.28 / 1.8`)

A portable workflow skill for AI-assisted engineering with role separation: **Chief Architect** (investigation, ADRs, frozen reference tests, code review) and **Executor** (atomic task execution in isolated change boundaries). Includes a deterministic, zero-dependency Node.js orchestrator.

## System Requirements

- **Skill Core (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** Works with any AI coding agent (Claude Code, Gemini CLI, OpenAI Codex CLI, Antigravity, Cursor, etc.), any tech stack, and any OS (macOS, Linux, Windows).
- **Automated Orchestrator (`orchestrator/run.mjs`):** Node.js 22+ and git 2.31+ on macOS (Linux/WSL2 untested, Windows unsupported). Supports headless runners `agy` and `claude`.

## Quickstart

1. **Install skill folder:** Copy `.agents/skills/architect/` into a subfolder of your project (e.g. `.agents/skills/architect/`). Never unpack directly into the repository root.
2. **Install executor rules:** Copy `EXECUTOR.md` to the project root:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. **Configure Executor model:** Set `executor.model` in `.architect/config.json` (or `.agents/orchestrator.json`), or declare it in your project's `AGENTS.md`.
4. **Verify setup and run:**
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --check
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --self-check
   ```

## Documentation & License

- Detailed English Guide: [.agents/skills/architect/README.en.md](.agents/skills/architect/README.en.md)
- Detailed Russian Guide: [.agents/skills/architect/README.ru.md](.agents/skills/architect/README.ru.md)
- License: [LICENSE](LICENSE) (MIT)

## Feedback

- Field Report (GitHub Issues): [Submit a Field Report](https://github.com/Aghasi-Sargsyan/architect-skill/issues/new?template=field-report.yml) ([.github/ISSUE_TEMPLATE/field-report.yml](.github/ISSUE_TEMPLATE/field-report.yml))
