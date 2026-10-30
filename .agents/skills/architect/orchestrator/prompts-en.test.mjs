import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOOLS_RULE,
  ANSWER_FORMAT,
  autoRefusalPrompt,
  resumePrompt,
  executorPrompt,
  architectPrompt,
} from './prompts.mjs';
import { checkExecutorRun, inspectFailedExecutorTurn, formatMechanicsReport } from './mechanics.mjs';
import { EVAL_SCENARIOS, evaluateScenarioResult, runLiveEvals, formatEvalCellLine } from './evals.mjs';

const CYRILLIC_RE = /[А-Яа-яЁё]/;
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();

test('T-037 (D5, S5): prompts.mjs generates English prompts without Cyrillic', () => {
  assert.doesNotMatch(TOOLS_RULE, CYRILLIC_RE);
  assert.equal(typeof ANSWER_FORMAT, 'object');
  assert.equal(typeof ANSWER_FORMAT.executor, 'function');
  assert.equal(typeof ANSWER_FORMAT.architect, 'string');
  assert.equal('executor' in String.prototype, false, 'String.prototype must not be polluted');
  assert.equal('architect' in String.prototype, false, 'String.prototype must not be polluted');
  assert.doesNotMatch(ANSWER_FORMAT.executor('EXECUTOR.md'), CYRILLIC_RE);
  assert.doesNotMatch(ANSWER_FORMAT.architect, CYRILLIC_RE);
  assert.match(TOOLS_RULE, /Do NOT call ask_user/i);
  assert.match(ANSWER_FORMAT.executor('EXECUTOR.md'), /FINAL ANSWER FORMAT/i);
  assert.match(ANSWER_FORMAT.architect, /FINAL ANSWER FORMAT/i);

  const autoRefusal = autoRefusalPrompt('executor', {
    command: 'git -C /tmp/work status',
    reason: 'leading flag "-C" before git subcommand is not allowed',
    suggestedCommand: 'git status',
  });
  assert.doesNotMatch(autoRefusal, CYRILLIC_RE);
  assert.match(autoRefusal, /automatically rejected/i);
  assert.match(autoRefusal, /without the leading flag: git status/i);
  assert.match(autoRefusal, /form of the command, not git itself/i);

  const resumedAllowed = resumePrompt('executor', {
    command: 'git status',
    ruleText: 'command(git status)',
  });
  assert.doesNotMatch(resumedAllowed, CYRILLIC_RE);
  assert.match(resumedAllowed, /The user allowed the command/i);

  const execPrompt = executorPrompt(
    { id: 'T-001', title: 'Sample', change: '`src/a.js`' },
    { planPath: 'PLAN.md', executorPath: 'EXECUTOR.md' },
  );
  assert.doesNotMatch(execPrompt, CYRILLIC_RE);
  assert.match(execPrompt, /Role: Executor\. Follow EXECUTOR\.md/i);
  assert.match(execPrompt, /Execute ONLY task T-001/i);

  const archPrompt = architectPrompt(
    { id: 'T-001', title: 'Sample' },
    { status: 'done', commit: '1234567', summary: 'ok', check_command: 'npm test', check_passed: true },
    '=== Mechanics check ===\nPassed: YES',
    'gemini-3.8-flash-high',
    {
      planPath: 'PLAN.md',
      reviewPath: '.agents/skills/architect/references/auto-review.md',
      skillPath: '.agents/skills/architect/SKILL.md',
    },
  );
  assert.doesNotMatch(archPrompt, CYRILLIC_RE);
  assert.match(archPrompt, /Role: Chief Architect/i);
  assert.match(archPrompt, /Step 1: Read ONLY \.agents\/skills\/architect\/references\/auto-review\.md/i);
  assert.match(archPrompt, /Step 2: Only if escalation is returned/i);
});

test('T-037 (D5, S5): mechanics.mjs outputs English diagnostics and reports while keeping bilingual risk support', () => {
  const report = formatMechanicsReport({
    ok: false,
    headSha: 'abcdef0',
    headSubject: 'T-001: sample',
    changedFiles: ['src/a.js'],
    violations: ['touched Frozen: PLAN.md'],
  });
  assert.doesNotMatch(report, CYRILLIC_RE);
  assert.match(report, /=== Mechanics check \(deterministic, outside LLM\) ===/);
  assert.match(report, /Passed: NO/);
  assert.match(report, /Violations:/);

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t037-')));
  try {
    const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 't');
    g('config', 'user.email', 't@example.invalid');
    writeFileSync(path.join(tmp, 'a.js'), 'export const a = 1;\n');
    g('add', 'a.js');
    g('commit', '-q', '-m', 'init');
    const baseSha = g('rev-parse', 'HEAD');

    const mech = checkExecutorRun({
      baseSha,
      task: { id: 'T-001', risk: 'высокий', changeFiles: ['a.js'], testFiles: [] },
      frozen: ['EXECUTOR.md'],
      report: { status: 'escalated', check_passed: false, self_check: false, retry_count: 3 },
      codePaths: ['a.js'],
      cwd: tmp,
    });
    assert.equal(mech.ok, false);
    assert.doesNotMatch(mech.violations.join('\n'), CYRILLIC_RE);
    assert.match(mech.violations.join('\n'), /Executor status "escalated" !== "done"/);
    assert.match(mech.violations.join('\n'), /no new commit on HEAD/);

    writeFileSync(path.join(tmp, 'a.js'), 'export const a = 2;\n');
    const failedTurn = inspectFailedExecutorTurn({
      baseSha,
      task: { id: 'T-001', changeFiles: ['a.js'] },
      frozen: ['EXECUTOR.md'],
      cwd: tmp,
    });
    assert.equal(failedTurn.clean, false);
    assert.doesNotMatch(failedTurn.issues.join('\n'), CYRILLIC_RE);
    assert.match(failedTurn.issues.join('\n'), /uncommitted changes in working tree/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-037 (D5, S5): evals.mjs and evals-scenarios.mjs use English prompts and diagnostics', async () => {
  for (const s of EVAL_SCENARIOS) {
    assert.doesNotMatch(s.description, CYRILLIC_RE, `scenario ${s.id} description must be English`);
    assert.doesNotMatch(s.prompt, CYRILLIC_RE, `scenario ${s.id} prompt must be English`);
  }

  await assert.rejects(
    () => runLiveEvals({ env: { ...process.env, AGENT_LOOP: '1' } }),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /AGENT_LOOP=1/);
      return true;
    },
  );

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t037-evals-')));
  try {
    mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 't');
    g('config', 'user.email', 't@example.invalid');
    writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: Task\n  - Risk: medium.\n  - Change: src/app.js.\n');
    writeFileSync(path.join(tmp, 'src', 'app.js'), 'export const x = 1;\n');
    g('add', 'PLAN.md', 'src/app.js');
    g('commit', '-q', '-m', 'init');
    const baseSha = g('rev-parse', 'HEAD');

    writeFileSync(path.join(tmp, 'PLAN.md'), '# dirty\n');
    const r1 = evaluateScenarioResult('phase1_no_write', {
      workDir: tmp,
      realGit,
      baseSha,
      deniedActions: [{ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'PLAN.md') } }],
    });
    assert.equal(r1.pass, false);
    assert.doesNotMatch(r1.reasons.join('; '), CYRILLIC_RE);

    const line = formatEvalCellLine({
      status: 'FAIL',
      model: 'claude:haiku',
      scenarioId: 'phase1_no_write',
      reasons: r1.reasons,
      attempts: 1,
      attemptStatuses: ['FAIL'],
    });
    assert.doesNotMatch(line, CYRILLIC_RE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
