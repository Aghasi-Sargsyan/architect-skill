---
name: architect
description: One-model design pass before a sizeable change. Use on `/architect`, or when the user asks to design a feature, choose between approaches, or plan a change that touches a data model, access control, money, migrations, or a public interface. Do not use for prototypes, small fixes, or purely visual work.
---

# Architect v0.3

You design the change and you write it. There is no second model, no task cards, and no orchestrator. This page keeps the four habits that still pay off when one capable model does both jobs: agree before writing, record what was decided, treat risky code differently, and report honestly what was checked.

If the request is a throwaway prototype, a small fix, or purely visual work, say that this skill is overkill and just do the work.

Communicate in the user's language. Write code, comments, and commit messages in the language the project already uses.

## 1. Read first

- The decision log (`docs/decisions.md`, or wherever the project keeps one). It tells you what was already chosen and why, so you do not re-open or silently contradict it.
- The project's instruction file (`AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`): its risk areas and verification commands.
- The code the change will touch, just enough to rule out a design that clashes with the system. For external libraries, the installed version and its types are the truth, not memory; label anything you could not check.

Then look in the instruction file for the block from `templates/agents-block.md` (next to this file). That block is what keeps the rules below active in sessions where this skill is not invoked.

- **No block:** offer it in step 2 with both placeholders filled in from what you read: the project's risk areas (paths or topics where a mistake does damage that a revert does not undo) and the verification commands the project actually has. Add it in step 3 after a yes.
- **A block with no version line, or an older one than the template's:** offer in step 2 to bring its rules up to the template. Keep the project's own risk areas and verification command.

## 2. Agree before writing

Change no files in this step.

- State who the change is for, what problem it solves, and how you will know it works. For a new project, add the core loop and the smallest version that proves it. Ask a question only when the answer changes the design; otherwise state your assumption and move on.
- Offer two or three approaches with what each costs to build and to live with, and recommend one. If an approach conflicts with a recorded decision, say which decision.
- If the idea is larger than the goal needs, say so once. After that the choice is the user's.
- List the steps you would take, one line each, and mark the ones that touch a risk area.
- Ask once whether to lock this and build. A direct instruction to build is already a yes.
- **If nobody can answer, do not wait.** This applies only on an explicit signal: the user said they will not be answering, the project's or the run's instructions say the run is unattended, or the session has no way to ask a question. Without one of these, ask as above. When the choice is reversible, build the approach you recommended and mark its line in the decision log `unconfirmed` until the user confirms it. Do not start anything that is expensive to undo: leave it as a question with your recommendation in the final report, and do the work that does not depend on it. The rules block and irreversible actions still wait for a person.

## 3. Build

- **Record the decision first.** A reversible choice is one line in the decision log: date, what, why. A choice that is expensive to undo (data model, public interface, security, anything that needs a migration) gets a short entry: what was chosen, what was rejected, why, and what would make you revisit it. A new session must be able to continue from the log without this chat.
- **Risk-area code: expectations before implementation.** Write the tests first, as "input and state lead to this outcome", including a negative case where bypassing the restriction must fail. Run them and confirm they fail for the right reason. Then implement. If a test fails afterwards, fix the code; if you believe the expected value itself is wrong, stop and tell the user instead of editing it.
- **Everything else:** follow the project's conventions, reuse what exists, and do not add an abstraction just to avoid minor repetition.
- **No check bypasses:** do not skip, focus, or delete tests, disable type checks, or commit with `--no-verify`.
- **Irreversible actions** (deleting data, pushing, releasing, migrating real data): state the consequence and wait for confirmation of that specific action.

## 4. Finish

- Run the project's verification commands. Done means the command ran and passed.
- Report in a few lines: what changed, what was verified and how, what is `NOT VERIFIED`, which decisions were recorded, and which choices are `unconfirmed` or still waiting for the user. Never describe a check you did not run as passed.
- If the change moved modules, commands, or risk areas, update the instruction file in the same change.

## When this is not enough

This page trusts you to follow it; nothing checks you mechanically. Tell the user it is not enough when the code is written by a cheaper or weaker model, when a loop runs unattended for hours, or when a team needs a review trail. Those cases need task contracts, frozen tests, and guards that this skill does not have.
