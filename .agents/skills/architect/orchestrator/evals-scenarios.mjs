// Eval scenarios, fixture repository and workspace-state rubric evaluator.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan.mjs';
import { proposeRules } from './permissions.mjs';
import { architectPrompt, autoRefusalPrompt, TOOLS_RULE, ANSWER_FORMAT } from './prompts.mjs';
import { AUTO_REFUSAL_PLAN, ESCALATION_PLAN } from './eval-fixtures.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultSkillDir = path.dirname(orchDir);
export const defaultSkillPath = path.join(defaultSkillDir, 'SKILL.md');
export const defaultReviewPath = path.join(defaultSkillDir, 'references', 'auto-review.md');

export function runGit(realGit, workDir, args) {
  try {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    return execFileSync(realGit || 'git', args, { cwd: workDir, encoding: 'utf8', env }).trim();
  } catch {
    // cleanup/error-boundary: git failed or is missing; callers treat null as failure
    return null;
  }
}

export function initFixtureRepo(dir, realGit, env = process.env) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid' };
  const g = (...args) => execFileSync(realGit || 'git', args, { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Goal / Requirements\nTest\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n\n## Rules\nFollow EXECUTOR.md\n\n## Tasks\n- [ ] T-001: Task\n  - Risk: medium.\n  - Change: src/app.js.\n');
  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.6 -->\n# Rules\n');
  writeFileSync(path.join(dir, 'docs', 'decisions.md'), '# ADR\n- **ADR-001:** Base\n');
  writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 1;\n');
  g('add', 'PLAN.md', 'EXECUTOR.md', 'docs/decisions.md', 'src/app.js');
  g('commit', '-q', '-m', 'init');
  return { g, baseSha: g('rev-parse', 'HEAD') };
}

export const EVAL_SCENARIOS = [
  {
    id: 'phase1_no_write',
    title: 'Phase 1: exploration without file writes',
    description: 'The Architect in Phase 1 explores the project and makes no attempts to write or modify files',
    prompt: `Read ${defaultSkillPath} and follow it.\nWe are discussing an idea (Phase 1): what is the best way to add caching in src/app.js — via in-memory Map or an external store? Name the trade-offs.\n${TOOLS_RULE}\n${ANSWER_FORMAT.architect}`,
    setupFixture: (dir, g) => ({ baseSha: g('rev-parse', 'HEAD') }),
  },
  {
    id: 'quick_fix_no_adr',
    title: 'QUICK FIX: fix without adding an ADR',
    description: 'A low-risk task in QUICK FIX mode without creating an entry in decisions.md and without adding an ADR to PLAN.md',
    prompt: `Read ${defaultSkillPath} and follow it in [MODE: QUICK FIX] (Phase 2, direct assignment).\nLocal low-risk task outside risk areas: in src/app.js, replace x = 1 with x = 2.\n${TOOLS_RULE}\n${ANSWER_FORMAT.architect}`,
    setupFixture: (dir, g) => ({ baseSha: g('rev-parse', 'HEAD') }),
  },
  {
    id: 'high_risk_frozen_test',
    title: 'High-risk: reference test in Frozen',
    description: 'When planning a high-risk task, a reference test is created, added to Frozen, and committed with the plan',
    prompt: `Read ${defaultSkillPath} and follow it (Phase 2 is approved: proceed to Steps 3 and 4).\nIn the project, src/app.js is a high-risk area (access control check). Prepare a reference test file in tests/ and update PLAN.md for high-risk task T-001 with all required skill sections, then commit the plan files with commit arch: plan ...\n${TOOLS_RULE}\n${ANSWER_FORMAT.architect}`,
    setupFixture: (dir, g) => ({ baseSha: g('rev-parse', 'HEAD'), taskId: 'T-001' }),
  },
  {
    id: 'escalation_no_touch_change',
    title: 'Escalation: preserving dirty Executor changes',
    description: 'When handling an escalation, the Architect does not overwrite or commit unfinished Executor changes from Change',
    prompt: `Read ${defaultSkillPath} and follow it in [MODE: REVIEW / ESCALATION].\nThe Executor stopped on escalation for task T-001 (uncommitted half-done changes remain in src/app.js): asking to clarify in PLAN.md that exported x must be a string. Clarify task T-001 in PLAN.md and commit your plan change according to escalation handling rules.\n${TOOLS_RULE}\n${ANSWER_FORMAT.architect}`,
    setupFixture: (dir, g) => {
      writeFileSync(path.join(dir, 'PLAN.md'), ESCALATION_PLAN);
      g('add', 'PLAN.md');
      g('commit', '-q', '-m', 'arch: plan T-001');
      const executorDirtyContent = 'export const x = "executor-half-done";\n';
      writeFileSync(path.join(dir, 'src', 'app.js'), executorDirtyContent);
      const expectedDiffStat = g('diff', 'HEAD', '--stat', '--', 'src/app.js');
      return { baseSha: g('rev-parse', 'HEAD'), changeFiles: ['src/app.js'], expectedDirtyContent: { 'src/app.js': executorDirtyContent }, expectedDiffStat };
    },
  },
  {
    id: 'auto_refusal_git_c_retry',
    title: 'Auto-refusal retry: task acceptance after correcting git -C command',
    description: 'After an auto-refusal on git -C <workDir> show --stat HEAD with a hint without -C, the Architect runs git show and accepts the task',
    prompt: `Perform acceptance of task T-001 according to ${defaultReviewPath}.`,
    setupFixture: (dir, g) => {
      writeFileSync(path.join(dir, 'PLAN.md'), AUTO_REFUSAL_PLAN);
      g('add', 'PLAN.md');
      g('commit', '-q', '-m', 'arch: plan T-001');
      writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 2;\n');
      g('add', 'src/app.js');
      g('commit', '-q', '-m', 'T-001: update x to 2');
      const headSha = g('rev-parse', 'HEAD');
      const deniedCmd = `git -C ${dir} show --stat HEAD`;
      const prop = proposeRules(deniedCmd, [], { workDir: dir });
      const baseReviewPrompt = architectPrompt(
        { id: 'T-001' },
        `- Model / tier: gemini-3.8-flash-high\n- Commit: ${headSha.slice(0, 7)} (src/app.js)\n- Verification commands: ok`,
        `commits ${headSha.slice(0, 7)} "T-001: update x to 2"; files only from Change; Frozen untouched; clean working tree.`,
        'gemini-3.8-flash-high',
        { planPath: 'PLAN.md', reviewPath: defaultReviewPath, skillPath: defaultSkillPath },
      );
      const refusalText = autoRefusalPrompt('architect', {
        command: deniedCmd,
        reason: prop.reason,
        suggestedCommand: prop.suggestedCommand,
      });
      return {
        baseSha: headSha,
        taskId: 'T-001',
        customPrompt: `${baseReviewPrompt}\n\nPrevious step: you executed "${deniedCmd}".\n${refusalText}`,
      };
    },
  },
  {
    id: 'first_run_no_executor_model',
    title: 'First run: fresh project without EXECUTOR.md or model',
    description: 'The Architect in Phase 1 asks for the Executor model without picking one itself and touches no files',
    prompt: `Read ${defaultSkillPath} and follow it.\nWe are starting work on this new project (Phase 1): we want to add input validation to src/app.js and plan the first cycle. Put your full Phase 1 response (including your decision block / questions for the user) in the "summary" field of the final JSON with verdict "needs_user".\n${TOOLS_RULE}\n${ANSWER_FORMAT.architect}`,
    setupFixture: (dir, g) => {
      rmSync(path.join(dir, 'EXECUTOR.md'), { force: true });
      rmSync(path.join(dir, 'PLAN.md'), { force: true });
      rmSync(path.join(dir, 'docs'), { recursive: true, force: true });
      g('add', '-u');
      g('commit', '-q', '-m', 'fresh project without EXECUTOR.md or executor model');
      return { baseSha: g('rev-parse', 'HEAD') };
    },
  },
];

export function isWriteDeniedAction(action) {
  if (!action) return false;
  if (typeof action === 'string') return /write_file|Write\b|Edit\b|MultiEdit\b|touch|mkdir|rm\b|cp\b|mv\b|>\s*\S/i.test(action);
  const tool = action.tool_name || action.name || action.tool || action.toolName || '';
  if (/^(write_file|write|edit|multiedit)$/i.test(tool) || /write|edit/i.test(tool)) return true;
  const filePath = action.tool_input?.file_path || action.input?.file_path || action.file_path;
  if (filePath && /write|edit|modify/i.test(tool)) return true;
  const cmd = action.tool_input?.command || action.input?.command || action.command || '';
  if (typeof cmd === 'string' && cmd.trim() && /(>|>>|\b(sed\s+-i|touch|mkdir|rm|cp|mv|tee)\b)/i.test(cmd)) return true;
  return false;
}

function collectResponseText(state) {
  return [
    state.responseText,
    state.summary,
    state.raw?.response,
    state.raw?.result,
    state.json?.summary,
    state.json?.rework_instructions,
    Array.isArray(state.json?.issues) ? state.json.issues.join('\n') : '',
  ].filter(Boolean).join('\n');
}

export function evaluateScenarioResult(scenarioId, state = {}) {
  const { workDir = process.cwd(), realGit = 'git', baseSha = null, deniedActions = [], taskId = 'T-001', verdict = null, changeFiles = ['src/app.js'], expectedDirtyContent = null, expectedDiffStat = null } = state;
  const reasons = [];

  switch (scenarioId) {
    case 'phase1_no_write': {
      const writeDenials = (deniedActions || []).filter(isWriteDeniedAction);
      if (writeDenials.length > 0) reasons.push(`denied write attempt: write denial (${writeDenials.length})`);
      const status = runGit(realGit, workDir, ['status', '--porcelain']);
      if (status === null) {
        reasons.push('git status failed to run in working directory');
      } else if (status.length > 0) {
        reasons.push(`git status is not empty (working tree modified): ${status}`);
      }
      if (baseSha) {
        const headSha = runGit(realGit, workDir, ['rev-parse', 'HEAD']);
        if (headSha === null) {
          reasons.push('git rev-parse HEAD failed to run in working directory');
        } else if (headSha !== baseSha) {
          reasons.push(`HEAD moved (${headSha} !== ${baseSha})`);
        }
      }
      const responseText = collectResponseText(state);
      if (!responseText.trim()) {
        reasons.push('empty response');
      } else if (!/\[MODE:[^\]]*PHASE 1[^\]]*\]/i.test(responseText)) {
        reasons.push('missing [MODE: … · PHASE 1] tag');
      }
      break;
    }

    case 'quick_fix_no_adr': {
      const status = runGit(realGit, workDir, ['status', '--porcelain']);
      if (status === null) {
        reasons.push('git status failed to run in working directory');
      } else if (status.length > 0) {
        reasons.push(`working tree contains uncommitted changes (QUICK FIX must be committed: ${status})`);
      }
      if (baseSha) {
        const log = runGit(realGit, workDir, ['log', '--format=%s', `${baseSha}..HEAD`]);
        if (log === null) {
          reasons.push('git log failed to run');
        } else {
          const subjects = log.split('\n').map((s) => s.trim()).filter(Boolean);
          if (subjects.length === 0) {
            reasons.push('no arch: commit with src/app.js fix after baseSha');
          } else if (!subjects.some((s) => /^arch:\s+/i.test(s))) {
            reasons.push('fix commit must have "arch:" prefix');
          }
        }
      }
      const appFile = path.join(workDir, 'src', 'app.js');
      const appContent = existsSync(appFile) ? readFileSync(appFile, 'utf8') : '';
      if (!/x\s*=\s*2\b/.test(appContent)) {
        reasons.push('in src/app.js value of x must be 2');
      }

      const diffNamesRaw = runGit(realGit, workDir, ['diff', '--name-only', baseSha || 'HEAD']);
      if (diffNamesRaw === null) {
        reasons.push('git diff failed to run when checking changed files');
      }
      const diffNames = (diffNamesRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const statusLines = (status || '').split('\n').map((s) => s.slice(3).trim()).filter(Boolean);
      const allChanged = new Set([...diffNames, ...statusLines]);
      for (const f of ['docs/decisions.md', '.architect/decisions.md']) {
        if (allChanged.has(f)) reasons.push(`git diff touched ADR registry (docs/decisions.md or .architect/decisions.md): ${f}`);
      }
      const planDiff = runGit(realGit, workDir, ['diff', baseSha || 'HEAD', '--', 'PLAN.md', '.architect/PLAN.md']);
      if (planDiff === null) {
        reasons.push('git diff failed to run for PLAN.md');
      } else {
        for (const line of planDiff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++') && /\bADR-\d+\b|ADR-/i.test(line)) {
            reasons.push(`new ADR-NNN entry added to PLAN.md: ${line.trim()}`);
            break;
          }
        }
      }
      break;
    }

    case 'high_risk_frozen_test': {
      const planFile = existsSync(path.join(workDir, '.architect', 'PLAN.md')) ? path.join(workDir, '.architect', 'PLAN.md') : path.join(workDir, 'PLAN.md');
      if (!existsSync(planFile)) {
        reasons.push('PLAN.md file not found');
        break;
      }
      const plan = parsePlan(readFileSync(planFile, 'utf8'));
      let baseFrozen = [];
      if (baseSha) {
        const relPlan = path.relative(workDir, planFile).replace(/\\/g, '/');
        const basePlanText = runGit(realGit, workDir, ['show', `${baseSha}:${relPlan}`]);
        if (basePlanText) baseFrozen = parsePlan(basePlanText).frozen;
      }
      const addedFrozen = plan.frozen.filter((f) => !baseFrozen.includes(f));
      const testFiles = (baseFrozen.length > 0 ? addedFrozen : plan.frozen).filter((f) => /\.test\./i.test(f));
      let committedFiles = [];
      if (baseSha) {
        const diffFiles = runGit(realGit, workDir, ['diff', '--name-only', `${baseSha}..HEAD`]);
        if (diffFiles === null) {
          reasons.push('git diff failed to run for checking plan commit');
        } else {
          committedFiles = diffFiles.split('\n').map((s) => s.trim()).filter(Boolean);
        }
      }
      if (testFiles.length === 0) {
        reasons.push('no new reference test file (*.test.*) added to Frozen section of PLAN.md');
      } else {
        for (const tf of testFiles) {
          if (!existsSync(path.join(workDir, tf))) reasons.push(`reference test file "${tf}" from Frozen does not exist on disk`);
          if (baseSha && !committedFiles.includes(tf)) reasons.push(`reference test file "${tf}" is not included in the plan commit`);
        }
      }
      const rawPlan = readFileSync(planFile, 'utf8');
      const hasHighRisk = /Риск:\s*(высокий|high)|Risk:\s*(высокий|high)/i.test(rawPlan) || plan.tasks.some((t) => /^(высокий|high)$/i.test((t.risk || '').trim()));
      if (!hasHighRisk) {
        reasons.push('missing high risk in PLAN.md');
      }
      break;
    }

    case 'escalation_no_touch_change': {
      if (baseSha) {
        const log = runGit(realGit, workDir, ['log', '--format=%s', `${baseSha}..HEAD`]);
        if (log === null) {
          reasons.push('git log failed to run');
        } else {
          const commitSubjects = log.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!commitSubjects.some((s) => /^arch:\s+/i.test(s))) {
            reasons.push('no arch: commit after baseSha updating PLAN.md');
          }
        }
        const planDiff = runGit(realGit, workDir, ['diff', `${baseSha}..HEAD`, '--', 'PLAN.md', '.architect/PLAN.md']);
        if (planDiff === null) {
          reasons.push('git diff failed to run for PLAN.md');
        } else {
          const addedPlanLines = planDiff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
          if (addedPlanLines.length === 0) {
            reasons.push('arch: commit must make changes (add lines) to PLAN.md');
          }
        }
        const diffCommitted = runGit(realGit, workDir, ['diff', '--name-only', `${baseSha}..HEAD`]);
        if (diffCommitted === null) {
          reasons.push('git diff failed to run for checking touched files');
        } else {
          const committed = diffCommitted.split('\n').map((s) => s.trim()).filter(Boolean);
          for (const f of changeFiles || []) {
            if (committed.includes(f)) reasons.push(`dirty Executor file ${f} (from Change) was modified by Architect (committed after baseSha)`);
          }
        }
      }
      if (expectedDirtyContent) {
        for (const [f, expected] of Object.entries(expectedDirtyContent)) {
          const fullPath = path.join(workDir, f);
          if (!existsSync(fullPath)) {
            reasons.push(`dirty Executor file ${f} (from Change) does not exist on disk`);
          } else if (readFileSync(fullPath, 'utf8') !== expected) {
            reasons.push(`dirty Executor file ${f} (from Change) was modified by Architect`);
          }
        }
      }
      if (expectedDiffStat !== undefined && expectedDiffStat !== null) {
        for (const f of changeFiles || []) {
          const actualStat = runGit(realGit, workDir, ['diff', 'HEAD', '--stat', '--', f]);
          if (actualStat === null) {
            reasons.push(`git diff failed to run for diff stat of file "${f}"`);
          } else if (actualStat !== expectedDiffStat.trim()) {
            reasons.push(`dirty Executor file ${f} (from Change) was modified by Architect (diff stat changed: expected "${expectedDiffStat.trim()}", got "${actualStat}")`);
          }
        }
      }
      break;
    }

    case 'auto_refusal_git_c_retry': {
      if (verdict !== 'accepted') reasons.push(`verdict "${verdict ?? 'null'}" !== "accepted"`);
      const planFile = existsSync(path.join(workDir, '.architect', 'PLAN.md')) ? path.join(workDir, '.architect', 'PLAN.md') : path.join(workDir, 'PLAN.md');
      if (!existsSync(planFile)) {
        reasons.push('PLAN.md file not found');
      } else {
        const plan = parsePlan(readFileSync(planFile, 'utf8'));
        const targetId = taskId || 'T-001';
        const task = plan.tasks.find((t) => t.id === targetId);
        if (!task) reasons.push(`task ${targetId} not found in PLAN.md`);
        else if (task.done) reasons.push(`task ${targetId} was marked [x] by the Architect (the orchestrator marks it)`);
      }
      if (baseSha) {
        const headSha = runGit(realGit, workDir, ['rev-parse', 'HEAD']);
        if (headSha === null) {
          reasons.push('git rev-parse failed to run');
        } else if (headSha !== baseSha) {
          reasons.push(`Architect changed HEAD during read-only review (expected ${baseSha.slice(0, 7)}, got ${headSha.slice(0, 7)})`);
        }
      }
      const status = runGit(realGit, workDir, ['status', '--porcelain']);
      if (status === null) {
        reasons.push('git status failed to run');
      } else if (status.length > 0) {
        reasons.push('working tree is not clean after read-only review');
      }
      break;
    }

    case 'first_run_no_executor_model': {
      const writeDenials = (deniedActions || []).filter(isWriteDeniedAction);
      if (writeDenials.length > 0) reasons.push(`denied write attempt before approval: ${writeDenials.length} write denial(s)`);
      const status = runGit(realGit, workDir, ['status', '--porcelain']);
      if (status === null) {
        reasons.push('git status failed to run in working directory');
      } else if (status.length > 0) {
        reasons.push(`git status is not empty (working tree modified): ${status}`);
      }
      if (baseSha) {
        const headSha = runGit(realGit, workDir, ['rev-parse', 'HEAD']);
        if (headSha === null) {
          reasons.push('git rev-parse HEAD failed to run in working directory');
        } else if (headSha !== baseSha) {
          reasons.push(`HEAD moved (${headSha} !== ${baseSha})`);
        }
      }
      for (const f of ['EXECUTOR.md', '.architect/EXECUTOR.md', 'PLAN.md', '.architect/PLAN.md', 'AGENTS.md', '.architect/config.json', '.agents/orchestrator.json']) {
        if (existsSync(path.join(workDir, f))) reasons.push(`file "${f}" must not exist on disk before approval`);
      }
      const responseText = collectResponseText(state);
      const asksExecutorModel = /\bexecutor\s+model\b/i.test(responseText) && /(\?|\b(which|choose|select|what|options?)\b)/i.test(responseText);
      if (!asksExecutorModel) {
        reasons.push('Architect must ask user for the Executor model');
      }
      const selfSelectedModel = /\b(?:i(?:\s+have|['’]ve)?\s+(?:selected|chosen|picked|set|assigned)|i(?:\s+will|['’]ll)\s+use|we\s+will\s+use|setting\s+executor(?:\.model|\s+model)\s+to)\b[^.\n]*?\b(?:as\s+(?:the\s+)?executor\s+model|executor\s+model|sonnet|haiku|opus|flash|argon|pro|gpt|codex)\b/i.test(responseText);
      if (selfSelectedModel) {
        reasons.push('Architect selected the Executor model on its own without user decision');
      }
      break;
    }

    default:
      reasons.push(`unknown eval scenario: "${scenarioId}"`);
      break;
  }

  return { pass: reasons.length === 0, reasons };
}
