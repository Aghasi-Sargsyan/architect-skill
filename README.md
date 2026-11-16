# Architect Lite (`v0.2`)

A one-page version of the Architect skill for the case where one capable model both designs and writes the code. It has no Executor role, no `PLAN.md` task cards, and no orchestrator. Russian guide: [README.ru.md](README.ru.md).

The repository ships two independent skills: the full [`architect`](https://github.com/Aghasi-Sargsyan/architect-skill) and this one. Install either one or both; each has its own install and update command.

## What it does

1. **Agreement before code.** The model reads the decision log and the relevant code, offers two or three approaches with their cost, and changes no files until you approve one. When nobody can answer (you said so, the instructions say the run is unattended, or the session cannot ask questions), it does not wait: it builds reversible choices, marks them `unconfirmed` in the log, and leaves the expensive-to-undo ones as questions in its report.
2. **Decision log.** Every design decision goes to `docs/decisions.md`: one line if it is reversible, a short entry (chosen, rejected, why, revisit trigger) if it is expensive to undo.
3. **Risk areas.** Where a mistake does damage that a revert does not undo (money, access control, stored data and migrations, formats and interfaces others rely on, concurrency, personal data), tests with expected outcomes are written before the implementation and are not edited to pass.
4. **Honest finish.** Work is done when the verification command ran and passed. Anything else is reported as `NOT VERIFIED`.

## Install

Run in the root of your project. The commands are safe to repeat; a repeat run updates the skill.

- **Claude Code (`.claude/skills/`):**
  ```bash
  tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .claude/skills && rm -rf .claude/skills/architect-lite && cp -R "$tmp/lite/architect-lite" .claude/skills/ && rm -rf "$tmp"
  ```
- **Codex, Cursor, Gemini CLI, Antigravity (`.agents/skills/`):**
  ```bash
  tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .agents/skills && rm -rf .agents/skills/architect-lite && cp -R "$tmp/lite/architect-lite" .agents/skills/ && rm -rf "$tmp"
  ```

## Update

Re-run the install command for your agent. It replaces the skill folder with the latest version from the repository and touches nothing else: the rules block in your `AGENTS.md` and your `docs/decisions.md` stay as they are. The block carries a version line. On its next run the skill compares that line with `templates/agents-block.md` and, if your block is older, offers to update its rules while keeping your risk areas and verification command.

The full skill's `/architect update` and `--update` do not update this skill, and this command does not update the full one. To remove the skill, delete its folder.

## Use

1. Write `/architect-lite <what you want to build>` (or ask the agent to read `SKILL.md` in the skill folder).
2. On the first run the model offers to add the block from [templates/agents-block.md](templates/agents-block.md) to your `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`, with your project's risk areas and verification command already filled in from the code. Check both before you agree. This block keeps the rules active in every session, including the ones where you do not call the skill.

## When to use it

- **Use it** when the project will live longer than a couple of weeks, when a feature touches data, access, or money, or when earlier decisions start to conflict.
- **Skip it** for a prototype, an MVP built from a ready reference, a small fix, or purely visual work.
- **Use the full [`architect`](https://github.com/Aghasi-Sargsyan/architect-skill) skill instead** when a cheaper model writes the code, when a loop runs unattended, or when a team needs a review trail. Both skills can be installed side by side.

## Changes

- **v0.2:** an unattended run no longer stalls on the agreement step; the model fills in the block's risk areas and verification command from the project; the block has a version line, and the skill offers to update an older block.
- **v0.1:** first version.
