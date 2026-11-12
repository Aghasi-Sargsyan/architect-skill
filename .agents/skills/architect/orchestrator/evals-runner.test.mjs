import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVAL_SCENARIOS, buildClaudeEvalSettings, evaluateScenarioResult, runLiveEvals } from './evals.mjs';

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

let tmp;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-t034-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initRepo(dir) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Задачи\n- [ ] T-001: Task\n  - Риск: средний.\n  - Менять: src/app.js.\n');
  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.6 -->\n');
  writeFileSync(path.join(dir, 'docs', 'decisions.md'), '# ADR\n- **ADR-001:** Base\n');
  writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 1;\n');
  g('add', 'PLAN.md', 'EXECUTOR.md', 'docs/decisions.md', 'src/app.js');
  g('commit', '-q', '-m', 'init');
  return { g, baseSha: g('rev-parse', 'HEAD') };
}

/** Clean host repo + fake home with an agy settings file: what runLiveEvals must leave untouched. */
function hostFixture() {
  const hostDir = path.join(tmp, 'host');
  initRepo(hostDir);
  const home = path.join(tmp, 'home');
  const agySettings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(path.dirname(agySettings), { recursive: true });
  writeFileSync(agySettings, '{"permissions":{"allow":[],"deny":[]}}\n');
  return { hostDir, home, agySettings };
}

const baseOpts = (fx) => ({
  env: { ...GIT_ENV, AGENT_LOOP: '' },
  home: fx.home,
  projectDir: fx.hostDir,
  models: [{ runner: 'claude', model: 'haiku' }],
  realGit,
  maxErrorRetries: 1,
});

test('T-034 (Г1, Г2): buildClaudeEvalSettings writes valid claude settings OUTSIDE the eval work tree; phase1 gets no Edit/Write allow rules', () => {
  const root = path.join(tmp, 'eval-root');
  const workDir = path.join(root, 'work');
  initRepo(workDir);
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });

  for (const scenario of EVAL_SCENARIOS) {
    const settingsPath = path.join(root, 'cfg', `${scenario.id}.json`);
    assert.doesNotThrow(() => buildClaudeEvalSettings({ workDir, settingsPath, home, scenarioId: scenario.id }), scenario.id);
    assert.ok(existsSync(settingsPath), `settings file must exist for ${scenario.id}`);
    assert.ok(!settingsPath.startsWith(`${workDir}${path.sep}`), 'settings file must live outside the eval work tree');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(settings.permissions.allow), scenario.id);
    const writeRules = settings.permissions.allow.filter((r) => r.startsWith('Edit(') || r.startsWith('Write('));
    if (scenario.id === 'phase1_no_write') assert.deepEqual(writeRules, [], 'phase1 must not allow Edit/Write');
    else assert.ok(writeRules.some((r) => r.includes(workDir.replace(/^\/+/, ''))), `${scenario.id} must allow writes into the work tree`);
  }
  const status = execFileSync(realGit, ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8', env: GIT_ENV }).trim();
  assert.equal(status, '', 'building settings must not dirty the eval work tree');
});

test('T-034 (Г3): a turn without a valid JSON answer is ERROR (neither PASS nor FAIL) and is retried; success on retry counts', async () => {
  const fx = hostFixture();
  let calls = 0;
  const failing = await runLiveEvals({
    ...baseOpts(fx),
    scenarios: EVAL_SCENARIOS.map((s) => s.id),
    runTurn: async () => {
      calls++;
      if (calls % 3 === 0) throw new Error('boom');
      return calls % 3 === 1 ? { ok: false, error: 'status ERROR' } : { ok: true, deniedActions: [] };
    },
  });
  assert.equal(failing.total, 6);
  assert.equal(failing.passed, 0, 'a failed model turn must never be graded PASS');
  assert.equal(failing.failed, 0, 'a failed model turn is ERROR, not FAIL');
  assert.equal(failing.errors, 6);
  assert.ok(failing.results.every((r) => r.status === 'ERROR' && r.pass === false), JSON.stringify(failing.results));
  assert.equal(calls, 12, 'each ERROR is retried maxErrorRetries (1) more time');

  let attempt = 0;
  const flaky = await runLiveEvals({
    ...baseOpts(fx),
    scenarios: ['phase1_no_write'],
    runTurn: async () => (++attempt === 1 ? { ok: false, error: 'transient' } : { ok: true, json: VALID_JSON, deniedActions: [] }),
  });
  assert.equal(flaky.passed, 1);
  assert.equal(flaky.errors, 0);
  assert.equal(flaky.results[0].status, 'PASS');
  assert.equal(flaky.results[0].attempts, 2);
});

test('T-034 (Г3): positive checks — QUICK FIX needs x = 2 committed by arch:, escalation needs T-001 clarified by an arch: commit of PLAN.md', () => {
  {
    const dir = path.join(tmp, 'qf');
    const { g, baseSha } = initRepo(dir);
    assert.equal(evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha }).pass, false, 'doing nothing is not a QUICK FIX');
    writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 2;\n');
    const uncommitted = evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha });
    assert.equal(uncommitted.pass, false, 'an uncommitted fix is not a QUICK FIX by the rules');
    assert.match(uncommitted.reasons.join('; '), /коммит|arch/i);
    g('add', 'src/app.js');
    g('commit', '-q', '-m', 'fix x');
    assert.equal(evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha }).pass, false, 'the QUICK FIX commit must be arch:');
  }
  {
    const dir = path.join(tmp, 'qf-ok');
    const { g, baseSha } = initRepo(dir);
    writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 3;\n');
    g('add', 'src/app.js');
    g('commit', '-q', '-m', 'arch: quick fix x');
    assert.equal(evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha }).pass, false, 'x must become 2');
  }
  {
    const dir = path.join(tmp, 'esc');
    const { g } = initRepo(dir);
    const dirty = 'export const x = "executor-half-done";\n';
    writeFileSync(path.join(dir, 'src', 'app.js'), dirty);
    const expectedDiffStat = g('diff', 'HEAD', '--stat', '--', 'src/app.js');
    const baseSha = g('rev-parse', 'HEAD');
    const state = { workDir: dir, realGit, baseSha, changeFiles: ['src/app.js'], expectedDirtyContent: { 'src/app.js': dirty }, expectedDiffStat };

    const idle = evaluateScenarioResult('escalation_no_touch_change', state);
    assert.equal(idle.pass, false, 'an Architect who did nothing has not resolved the escalation');
    assert.match(idle.reasons.join('; '), /arch|PLAN/i);

    writeFileSync(path.join(dir, 'NOTES.md'), 'note\n');
    g('add', 'NOTES.md');
    g('commit', '--only', 'NOTES.md', '-q', '-m', 'arch: notes');
    assert.equal(evaluateScenarioResult('escalation_no_touch_change', state).pass, false, 'the arch: commit must clarify PLAN.md');

    writeFileSync(path.join(dir, 'PLAN.md'), `${readFileSync(path.join(dir, 'PLAN.md'), 'utf8')}  - Уточнение: x — строка.\n`);
    g('add', 'PLAN.md');
    g('commit', '--only', 'PLAN.md', '-q', '-m', 'arch: clarify T-001');
    assert.deepEqual(evaluateScenarioResult('escalation_no_touch_change', state), { pass: true, reasons: [] });
  }
});

test('T-034 (Г4): every turn runs with guards (AGENT_LOOP=1, PATH shims) and settings outside the work tree; host repo or agy settings changes abort the run', async () => {
  const fx = hostFixture();
  const seen = [];
  const shimHeads = [];
  const ok = await runLiveEvals({
    ...baseOpts(fx),
    scenarios: ['phase1_no_write'],
    runTurn: async (args) => {
      seen.push(args);
      // Read the shim while the cell is alive: the whole temporary root is removed right after it (T-034 fix 1).
      shimHeads.push(readFileSync(path.join(args.env.PATH.split(path.delimiter)[0], 'git'), 'utf8'));
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  });
  assert.equal(ok.passed, 1, JSON.stringify(ok.results));
  const [args] = seen;
  assert.equal(args.env.AGENT_LOOP, '1', 'the agent environment must carry AGENT_LOOP=1');
  assert.match(shimHeads[0], /agent-loop guard/, 'PATH must start with the guard shims');
  assert.ok(args.settingsPath && !args.settingsPath.startsWith(`${args.workDir}${path.sep}`), 'claude settings must live outside the work tree');
  assert.equal(existsSync(args.workDir), false, 'temporary eval folders are removed after the run');

  await assert.rejects(
    () => runLiveEvals({
      ...baseOpts(fx),
      scenarios: ['phase1_no_write'],
      runTurn: async () => {
        writeFileSync(path.join(fx.hostDir, 'leak.txt'), 'x\n');
        return { ok: true, json: VALID_JSON, deniedActions: [] };
      },
    }),
    /git status|projectDir|хост|проект/i,
  );
  rmSync(path.join(fx.hostDir, 'leak.txt'), { force: true });

  await assert.rejects(
    () => runLiveEvals({
      ...baseOpts(fx),
      scenarios: ['phase1_no_write'],
      runTurn: async () => {
        writeFileSync(fx.agySettings, '{"permissions":{"allow":["command(rm)"],"deny":[]}}\n');
        return { ok: true, json: VALID_JSON, deniedActions: [] };
      },
    }),
    /settings\.json/,
  );
  writeFileSync(fx.agySettings, '{"permissions":{"allow":[],"deny":[]}}\n');

  writeFileSync(path.join(fx.hostDir, 'dirty-before.txt'), 'x\n');
  let called = 0;
  await assert.rejects(
    () => runLiveEvals({ ...baseOpts(fx), scenarios: ['phase1_no_write'], runTurn: async () => { called++; return { ok: true, json: VALID_JSON }; } }),
    /git status|projectDir|хост|проект/i,
  );
  assert.equal(called, 0, 'a dirty host repo must refuse the run before any model turn');
});
