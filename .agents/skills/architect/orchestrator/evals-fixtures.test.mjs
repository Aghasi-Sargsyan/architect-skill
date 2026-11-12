import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLiveEvals } from './evals.mjs';
import { EVAL_SCENARIOS, evaluateScenarioResult, initFixtureRepo } from './evals-scenarios.mjs';
import { AUTO_REFUSAL_PLAN, ESCALATION_PLAN } from './eval-fixtures.mjs';
import { autoRefusalPrompt } from './prompts.mjs';
import { proposeRules } from './permissions.mjs';
import { runAgent } from './adapters/agy.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});
const VALID_JSON = { task_id: 'T-001', verdict: 'needs_user', summary: '[MODE: FEATURE · PHASE 1] answer' };
const SHARED_RULE = /остальные разрешённые команды|other allowed commands/;

let tmp;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-t036-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const scenario = (id) => EVAL_SCENARIOS.find((s) => s.id === id);

function fixture(id) {
  const dir = path.join(tmp, `work-${id}`);
  mkdirSync(dir, { recursive: true });
  const { g } = initFixtureRepo(dir, realGit, GIT_ENV);
  const state = scenario(id).setupFixture(dir, g);
  const subjects = g('log', '--format=%s').split('\n').filter(Boolean);
  return { dir, g, state, subjects };
}

function hostFixture() {
  const hostDir = path.join(tmp, 'host');
  mkdirSync(hostDir, { recursive: true });
  const g = (...args) => execFileSync(realGit, args, { cwd: hostDir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(hostDir, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');
  const home = path.join(tmp, 'home');
  const agySettings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(path.dirname(agySettings), { recursive: true });
  writeFileSync(agySettings, '{"permissions":{"allow":[],"deny":[]}}\n');
  return { hostDir, home };
}

const baseOpts = (fx, runId) => ({
  env: { ...GIT_ENV, AGENT_LOOP: '' },
  home: fx.home,
  projectDir: fx.hostDir,
  runId,
  models: [{ runner: 'claude', model: 'haiku' }],
  realGit,
  maxErrorRetries: 0,
});

test('T-036 (Р1): auto_refusal_git_c_retry reviews a committed complete low-risk contract (init -> arch: plan T-001 -> T-001 commit), and a correct acceptance passes the rubric', () => {
  const { dir, g, state, subjects } = fixture('auto_refusal_git_c_retry');
  assert.deepEqual(subjects, ['T-001: update x to 2', 'arch: plan T-001', 'init']);
  assert.equal(state.baseSha, g('rev-parse', 'HEAD'), 'baseSha must be the Executor commit');
  assert.equal(g('show', 'HEAD~1:PLAN.md'), AUTO_REFUSAL_PLAN.trim(), 'the plan commit must hold AUTO_REFUSAL_PLAN verbatim');
  assert.equal(readFileSync(path.join(dir, 'PLAN.md'), 'utf8'), AUTO_REFUSAL_PLAN);
  assert.deepEqual(g('show', '--format=', '--name-only', 'HEAD~1').split('\n').filter(Boolean), ['PLAN.md'], 'the plan commit touches only PLAN.md');
  assert.equal(readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), 'export const x = 2;\n');
  assert.equal(g('status', '--porcelain'), '', 'the fixture tree must be clean');
  assert.match(state.customPrompt, SHARED_RULE, 'the simulated refusal in the review prompt carries the shared leading-flag rule');

  // Positive control (ADR-064): the expected read-only review passes the rubric; the orchestrator commits acceptance.
  const res = evaluateScenarioResult('auto_refusal_git_c_retry', { workDir: dir, realGit, baseSha: state.baseSha, taskId: 'T-001', verdict: 'accepted', deniedActions: [] });
  assert.deepEqual(res, { pass: true, reasons: [] });
  // Negative control: a model that marks [x] and commits during review fails it.
  writeFileSync(path.join(dir, 'PLAN.md'), AUTO_REFUSAL_PLAN.replace('- [ ] T-001', '- [x] T-001'));
  g('add', 'PLAN.md');
  g('commit', '-q', '-m', 'arch: accept T-001');
  const committed = evaluateScenarioResult('auto_refusal_git_c_retry', { workDir: dir, realGit, baseSha: state.baseSha, taskId: 'T-001', verdict: 'accepted', deniedActions: [] });
  assert.equal(committed.pass, false);
  assert.match(committed.reasons.join('; '), /marked \[x\] by the Architect/);
});

test('T-036 (Р1): escalation_no_touch_change starts from a committed plan that leaves the type of x open; the dirty Executor file survives and a plan-only arch: commit passes', () => {
  const { dir, g, state, subjects } = fixture('escalation_no_touch_change');
  assert.deepEqual(subjects, ['arch: plan T-001', 'init']);
  assert.equal(state.baseSha, g('rev-parse', 'HEAD'), 'baseSha must be the plan commit');
  assert.equal(g('show', 'HEAD:PLAN.md'), ESCALATION_PLAN.trim(), 'the plan commit must hold ESCALATION_PLAN verbatim');
  assert.doesNotMatch(ESCALATION_PLAN, /строк|string/i, 'the contract must not already answer the Executor question');
  assert.equal(g('status', '--porcelain'), 'M src/app.js', 'only the Executor file is dirty');
  assert.equal(readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), state.expectedDirtyContent['src/app.js']);
  assert.equal(state.expectedDiffStat, g('diff', 'HEAD', '--stat', '--', 'src/app.js'), 'expectedDiffStat is taken against the plan commit');
  assert.ok(state.expectedDiffStat.includes('src/app.js'));

  // Positive control: a plan-only clarification commit passes; the dirty src/app.js stays as it was.
  writeFileSync(path.join(dir, 'PLAN.md'), `${ESCALATION_PLAN}  - Уточнение: тип x задан Архитектором.\n`);
  g('commit', '-q', '-m', 'arch: clarify T-001', '--', 'PLAN.md');
  const res = evaluateScenarioResult('escalation_no_touch_change', { workDir: dir, realGit, deniedActions: [], ...state });
  assert.deepEqual(res, { pass: true, reasons: [] });
});

test('T-036 (Р2): with suggestedCommand the auto-refusal states that the rule is about the command form and applies to every allowed git command; without it the text is unchanged', () => {
  const workDir = path.join(tmp, 'w');
  mkdirSync(workDir, { recursive: true });
  const denied = `git -C ${workDir} log --oneline -n 10`;
  const prop = proposeRules(denied, [], { workDir });
  assert.equal(prop.auto, true);
  assert.equal(prop.suggestedCommand, 'git log --oneline -n 10');

  const withHint = autoRefusalPrompt('architect', { command: denied, reason: prop.reason, suggestedCommand: prop.suggestedCommand });
  assert.ok(
    withHint.includes('Запрет касается только формы команды, а не git: остальные разрешённые команды (`git status`, `git add`, `git commit` и другие) тоже запускай без ведущего флага, из рабочей папки проекта.') ||
    withHint.includes('The restriction applies only to the command form, not to git itself: run other allowed commands (`git status`, `git add`, `git commit`, etc.) without a leading flag as well, from the project working directory.'),
    withHint,
  );
  const hintIdx = withHint.includes('«git log --oneline -n 10»')
    ? withHint.indexOf('«git log --oneline -n 10»')
    : withHint.indexOf('"git log --oneline -n 10"');
  assert.ok(hintIdx >= 0 && hintIdx < withHint.search(SHARED_RULE), 'the shared rule follows the concrete hint');
  assert.match(withHint, /Не обходи запрет: продолжай с того места или эскалируй\.|Do not bypass the restriction: continue from where you stopped or escalate\./);

  const withoutHint = autoRefusalPrompt('executor', { command: 'git -C ../other show --stat HEAD', reason: null, suggestedCommand: null });
  assert.doesNotMatch(withoutHint, SHARED_RULE);
  assert.match(withoutHint, /продолжай с того места без этой команды или эскалируй|continue from where you stopped without this command or escalate/);
});

test('T-036 (Р3): runLiveEvals keeps <runDir>/results.md with one line per finished cell and a totals line; no extra .json files', async () => {
  const fx = hostFixture();
  const res = await runLiveEvals({
    ...baseOpts(fx, 'run-t036-r3'),
    scenarios: ['phase1_no_write', 'quick_fix_no_adr'],
    runTurn: async () => ({ ok: true, json: VALID_JSON, deniedActions: [] }),
  });
  assert.equal(res.passed, 1, JSON.stringify(res.results));
  assert.equal(res.failed, 1, 'quick_fix without the arch: commit is FAIL');
  const file = path.join(res.runDir, 'results.md');
  assert.ok(existsSync(file), 'results.md must exist in the eval run dir');
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], '# Live evals run-t036-r3');
  assert.match(lines[1], /^Commit: [0-9a-f]{40}$/);
  assert.match(lines[2], /^PASS claude:haiku phase1_no_write \[attempts=1: PASS\]$/);
  assert.match(lines[3], /^FAIL claude:haiku quick_fix_no_adr \[attempts=1: FAIL\] \(.+\)$/);
  assert.match(lines.at(-1), /^(?:Итого|Total): 1 passed, 1 failed, 0 errors \(total: 2\)$/);
  assert.equal(lines.length, 5);
  assert.equal(readdirSync(res.runDir).filter((f) => f.endsWith('.json')).length, 2, 'only the two turn logs are .json');
  assert.equal(execFileSync(realGit, ['status', '--porcelain'], { cwd: fx.hostDir, encoding: 'utf8', env: GIT_ENV }).trim(), '');
});

test('T-036 (Р3): results.md is rewritten after every cell, so a run stopped by a guard violation keeps the finished cells', async () => {
  const fx = hostFixture();
  let calls = 0;
  await assert.rejects(runLiveEvals({
    ...baseOpts(fx, 'run-t036-stop'),
    scenarios: ['phase1_no_write', 'quick_fix_no_adr'],
    runTurn: async () => {
      calls++;
      if (calls === 2) writeFileSync(path.join(fx.hostDir, 'leak.txt'), 'x\n'); // dirties the host -> the whole run stops
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  }));
  const file = path.join(fx.hostDir, '.agent-runs', 'evals', 'run-t036-stop', 'results.md');
  assert.ok(existsSync(file), 'results.md must survive a stopped run');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^PASS claude:haiku phase1_no_write \[attempts=1: PASS\]$/m);
  assert.doesNotMatch(text, /quick_fix_no_adr/);
  assert.match(text, /^(?:Итого|Total): 1 passed, 0 failed, 0 errors \(total: 1\)$/m);
});

test('T-036 (Р4): agy status ERROR with an empty response keeps the reason: stderr first, otherwise the raw envelope; a non-empty response still wins', async () => {
  const home = path.join(tmp, 'agy-home');
  mkdirSync(home, { recursive: true });
  const fake = (name, envelope, stderr = '') => {
    const bin = path.join(home, name);
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(envelope)}'\n${stderr ? `echo '${stderr}' >&2\n` : ''}exit 1\n`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const run = (bin) => runAgent({ bin, model: 'm', prompt: 'p', cwd: home, schemaPath: path.join(home, 'schema.json'), env: process.env, timeoutMs: 10_000, maxAttempts: 1, home });

  const credits = await run(fake('agy-credits', { status: 'ERROR', conversation_id: 'conv-credits', response: '' }, 'Your AI credits balance is too low to continue.'));
  assert.equal(credits.ok, false);
  assert.match(credits.error, /^status ERROR: Your AI credits balance is too low to continue\./);

  const silent = await run(fake('agy-silent', { status: 'ERROR', conversation_id: 'conv-silent', response: '   ' }));
  assert.equal(silent.ok, false);
  assert.match(silent.error, /^status ERROR: \{.*"status":"ERROR".*"conversation_id":"conv-silent".*\}$/);

  const withText = await run(fake('agy-text', { status: 'ERROR', conversation_id: 'conv-text', response: 'model said no' }, 'ignored stderr'));
  assert.match(withText.error, /^status ERROR: model said no/);
  assert.doesNotMatch(withText.error, /ignored stderr/);
});

test('T-065: first_run_no_executor_model sets up a project without EXECUTOR.md or Executor model and grades PASS only when Architect asks for the model, does not pick it itself, and writes no files before approval', async () => {
  const sc = scenario('first_run_no_executor_model');
  assert.ok(sc, 'EVAL_SCENARIOS must include first_run_no_executor_model');
  const { dir, g, state } = fixture('first_run_no_executor_model');
  assert.equal(existsSync(path.join(dir, 'EXECUTOR.md')), false, 'fixture must not have EXECUTOR.md');
  assert.equal(existsSync(path.join(dir, 'PLAN.md')), false, 'fixture must not have PLAN.md');
  assert.equal(existsSync(path.join(dir, 'AGENTS.md')), false, 'fixture must not have AGENTS.md');
  assert.equal(g('status', '--porcelain'), '', 'fixture git status must be clean');

  const validSummary = '### ❓ Decision Required\n**Question:** Which Executor model should we use for this project (e.g. Claude Sonnet/Haiku or Gemini Flash), and should I add the roles block to AGENTS.md?';
  assert.deepEqual(
    evaluateScenarioResult('first_run_no_executor_model', {
      workDir: dir,
      realGit,
      baseSha: state.baseSha,
      deniedActions: [],
      json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: validSummary },
    }),
    { pass: true, reasons: [] },
  );

  // Omitting the Executor model question fails
  const noQuestion = evaluateScenarioResult('first_run_no_executor_model', {
    workDir: dir,
    realGit,
    baseSha: state.baseSha,
    deniedActions: [],
    json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: 'We can validate input in src/app.js. Lock this architecture?' },
  });
  assert.equal(noQuestion.pass, false);
  assert.match(noQuestion.reasons.join('; '), /ask.*Executor model/i);

  // Picking the Executor model on its own fails
  const selfPicked = evaluateScenarioResult('first_run_no_executor_model', {
    workDir: dir,
    realGit,
    baseSha: state.baseSha,
    deniedActions: [],
    json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: `${validSummary}\nI have selected claude-haiku as the Executor model for this project.` },
  });
  assert.equal(selfPicked.pass, false);
  assert.match(selfPicked.reasons.join('; '), /selected.*Executor model.*own/i);

  // Writing EXECUTOR.md or attempting a denied write before approval fails
  const deniedWrite = evaluateScenarioResult('first_run_no_executor_model', {
    workDir: dir,
    realGit,
    baseSha: state.baseSha,
    deniedActions: [{ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'EXECUTOR.md') } }],
    json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: validSummary },
  });
  assert.equal(deniedWrite.pass, false);
  assert.match(deniedWrite.reasons.join('; '), /write|denied/i);

  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  const wroteFile = evaluateScenarioResult('first_run_no_executor_model', {
    workDir: dir,
    realGit,
    baseSha: state.baseSha,
    deniedActions: [],
    json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: validSummary },
  });
  assert.equal(wroteFile.pass, false);
  assert.match(wroteFile.reasons.join('; '), /EXECUTOR\.md|status/i);

  // runLiveEvals forwards json/raw to evaluateScenarioResult and stops without retry on a forbidden write in first_run_no_executor_model
  const fx = hostFixture();
  const livePass = await runLiveEvals({
    ...baseOpts(fx, 'run-t065-pass'),
    scenarios: ['first_run_no_executor_model'],
    runTurn: async () => ({
      ok: true,
      json: { task_id: 'none', verdict: 'needs_user', issues: [], rework_instructions: '', arch_commits: [], summary: validSummary },
      deniedActions: [],
    }),
  });
  assert.equal(livePass.passed, 1, JSON.stringify(livePass.results));

  let writeErrCalls = 0;
  const liveWriteFail = await runLiveEvals({
    ...baseOpts(fx, 'run-t065-write-fail'),
    maxErrorRetries: 2,
    scenarios: ['first_run_no_executor_model'],
    runTurn: async () => {
      writeErrCalls++;
      return {
        ok: false,
        error: 'turn error after write attempt',
        deniedActions: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/work/EXECUTOR.md' } }],
      };
    },
  });
  assert.equal(writeErrCalls, 1, 'must not retry when a forbidden write denial occurred in first_run_no_executor_model');
  assert.equal(liveWriteFail.failed, 1);
});
