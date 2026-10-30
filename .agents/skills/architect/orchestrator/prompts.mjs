// Orchestrator prompts, auto-refusal hints, and review prompt routing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillFilePath } from './layout.mjs';
import { suggestAllowedCommand } from './permissions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export { suggestAllowedCommand };

export const TOOLS_RULE = 'Do NOT call ask_user, AskUserQuestion, or attempt user dialogue (the orchestrator runs without user interaction; return final JSON with status "escalation" or verdict "needs_user" if blocked). Read, create, and modify files using built-in file tools, not terminal commands (cat, head, sed, etc.); the terminal is only for git and verification commands, one simple command at a time, without &&, ;, or |. Do not run inline scripts such as node -e or python -c in the terminal; run a single targeted test file during work and run the task\'s Verify check once before commit. If a command is rejected, do not attempt to bypass the restriction.';

const ANSWER_HEADER = 'FINAL ANSWER FORMAT (required — the orchestrator parses the last JSON block in your response):';

export const ANSWER_FORMAT = {
  executor: (p = 'EXECUTOR.md') => `${ANSWER_HEADER}\nStrict JSON schema: task_id; status ("done" or "escalation"); commits — hashes of your commits; report_markdown — full text of the completion or escalation report according to ${p}.`,
  architect: `${ANSWER_HEADER}\nStrict JSON schema: task_id; verdict ("accepted", "rework", or "needs_user"); issues; rework_instructions; arch_commits; summary.`,
};

export function autoRefusalPrompt(role, { command, reason = null, suggestedCommand = null }) {
  const roleLabel = role === 'architect' ? 'review' : 'executor';
  const why = reason || 'action is outside project permissions';
  let hint = '';
  let extra = '';
  let cont = '';

  if (suggestedCommand) {
    hint = ` In the project working directory, run the allowed form without the leading flag: ${suggestedCommand} ("${suggestedCommand}").`;
    extra = ' The restriction applies only to the command form, not to git itself: run other allowed commands (`git status`, `git add`, `git commit`, etc.) without a leading flag as well, from the project working directory. The restriction applies only to the form of the command, not git itself: other allowed commands also work without the leading path flag.';
    cont = ` Do not bypass the restriction: continue from where you stopped or escalate. Do not repeat the rejected command. Continue the task (${roleLabel}) using allowed commands and return the final JSON block.`;
  } else {
    hint = ' Use built-in file tools to read, create, and edit files, rather than the terminal. For other operations, use allowed verification commands and git, one simple command at a time.';
    cont = ` Do not bypass the restriction: continue from where you stopped without this command or escalate. Do not repeat the rejected command. Continue the task (${roleLabel}) using allowed commands and return the final JSON block.`;
  }

  const head = `Command "${command}" was automatically rejected (${why}): Terminal command "${command}" is denied.${hint}${extra}${cont}`;
  const tail = typeof ANSWER_FORMAT[role] === 'function' ? ANSWER_FORMAT[role]() : (ANSWER_FORMAT[role] ?? '');
  return tail ? `${head}\n\n${tail}` : head;
}

export function resumePrompt(role, { command, rule = null, ruleText = null, reason = null, suggestedCommand = null }) {
  if (rule || ruleText) {
    const roleLabel = role === 'architect' ? 'review' : 'executor';
    const added = ruleText ?? `command(${rule})`;
    const head = `The user allowed the command (added rule: ${added}) — was allowed (rule ${added}). Execute the needed action and finish the task (${roleLabel}), returning the final JSON block.`;
    const tail = typeof ANSWER_FORMAT[role] === 'function' ? ANSWER_FORMAT[role]() : (ANSWER_FORMAT[role] ?? '');
    return tail ? `${head}\n\n${tail}` : head;
  }
  return autoRefusalPrompt(role, { command, reason, suggestedCommand });
}

export function executorPrompt(task, reworkOrLayout, modelOrLayout, layoutArg) {
  let rework = null;
  let model = 'unknown';
  let layout = { planPath: 'PLAN.md', executorPath: 'EXECUTOR.md' };

  if (reworkOrLayout && (reworkOrLayout.planPath || reworkOrLayout.executorPath)) {
    layout = reworkOrLayout;
  } else {
    rework = reworkOrLayout;
    if (typeof modelOrLayout === 'string') model = modelOrLayout;
    else if (modelOrLayout && (modelOrLayout.planPath || modelOrLayout.executorPath)) layout = modelOrLayout;
    if (layoutArg && (layoutArg.planPath || layoutArg.executorPath)) layout = layoutArg;
  }

  const planPath = layout?.planPath ?? 'PLAN.md';
  const executorPath = layout?.executorPath ?? 'EXECUTOR.md';
  const taskTitle = task.title ? ` (${task.title})` : '';

  const intro = rework
    ? `Role: Executor. Follow ${executorPath} and the project rules (if AGENTS.md / CLAUDE.md / GEMINI.md is present in the root).\nRead ${executorPath} and the updated ${planPath}. Execute rework for task ${task.id}${taskTitle} based on the Architect review (commit "${task.id} (fix ${rework.round}): ..."). Rework instructions:\n${rework.instructions}`
    : `Role: Executor. Follow ${executorPath} and the project rules (if AGENTS.md / CLAUDE.md / GEMINI.md is present in the root).\nExecute ONLY task ${task.id}${taskTitle} from ${planPath} strictly following the rules in ${executorPath}.`;

  return `${intro}

You were launched by the orchestrator without user interaction: do not ask questions. If escalation is needed according to ${executorPath}, stop and return status "escalation".
${TOOLS_RULE}
You are running on model ${model} (selected and passed by orchestrator): specify it in the "Model / tier" field of your report.
${ANSWER_FORMAT.executor(executorPath)}`;
}

export function architectPrompt(
  task,
  report,
  mechText,
  executorModel,
  { planPath = 'PLAN.md', reviewPath = null, skillPath = null, workDir = process.cwd(), orchestratorDir = here } = {},
) {
  const effectiveSkillPath = skillPath ?? skillFilePath(workDir, orchestratorDir);
  const effectiveReviewPath = reviewPath ?? path.posix.join(path.posix.dirname(String(effectiveSkillPath).replace(/\\/g, '/')), 'references', 'auto-review.md');
  const taskTitle = task.title ? ` (${task.title})` : '';
  const reportText = typeof report === 'object' && report !== null ? JSON.stringify(report, null, 2) : String(report ?? '');

  return `Role: Chief Architect — automatic acceptance of task ${task.id}${taskTitle}.
Step 1: Read ONLY ${effectiveReviewPath} and follow its acceptance checklist step by step.
Step 2: Only if escalation is returned or you need to revise the plan/contract, additionally consult ${effectiveSkillPath}.

You were launched by the orchestrator without user interaction: do not ask questions. If a user decision is required, return verdict "needs_user". Do NOT push.
${TOOLS_RULE}
Perform acceptance according to ${effectiveReviewPath}. On verdict "accepted", mark ${task.id} [x] in ${planPath} and commit acceptance of ${task.id} according to skill rules; on "rework", formulate exact instructions for the Executor in rework_instructions.
Even if no open tasks [ ] remain in ${planPath}, do NOT perform "Cycle Closure" (retro and archiving of ${planPath}) — stop after committing acceptance of ${task.id}.

Executor of this task: model ${executorModel} — passed and confirmed by orchestrator (Executor profile corresponds to this model + tier pair).
Orchestrator mechanics check (already completed):
${mechText}
Do not re-run Verify commands already verified in Orchestrator mechanics check unless an unverified high-risk check is in doubt.

Executor report:
${reportText}

${ANSWER_FORMAT.architect}`;
}
