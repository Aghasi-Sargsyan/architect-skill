import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVAL_SCENARIOS, evaluateScenarioResult, runLiveEvals } from './evals.mjs';

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

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-s4-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initFixtureRepo(dir) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Goal / Requirements\nTest\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n\n## Rules\nFollow EXECUTOR.md\n\n## Задачи\n- [ ] T-001: Task\n  - Риск: средний.\n  - Менять: src/app.js.\n');
  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.6 -->\n# Правила\n');
  writeFileSync(path.join(dir, 'docs', 'decisions.md'), '# ADR\n- **ADR-001:** Base\n');
  writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 1;\n');
  g('add', 'PLAN.md', 'EXECUTOR.md', 'docs/decisions.md', 'src/app.js');
  g('commit', '-q', '-m', 'init');
  return { g, baseSha: g('rev-parse', 'HEAD') };
}

test('T-031 (E3, Ф2): EVAL_SCENARIOS defines all 5 behavioral scenarios and evaluateScenarioResult grades strictly by repository state and permission denials', () => {
  const ids = EVAL_SCENARIOS.map((s) => s.id);
  assert.deepEqual(ids, [
    'phase1_no_write',
    'quick_fix_no_adr',
    'high_risk_frozen_test',
    'escalation_no_touch_change',
    'auto_refusal_git_c_retry',
  ]);

  // 1. phase1_no_write: clean git status + no commits + no write denials => pass; dirty file OR write denial => fail
  {
    const dir = path.join(tmp, 's1');
    const { baseSha } = initFixtureRepo(dir);
    assert.deepEqual(
      evaluateScenarioResult('phase1_no_write', { workDir: dir, realGit, baseSha, deniedActions: [] }),
      { pass: true, reasons: [] },
    );

    // Even if git status is clean (because allowlist blocked the write), a denied write attempt MUST fail!
    const deniedWrite = evaluateScenarioResult('phase1_no_write', {
      workDir: dir,
      realGit,
      baseSha,
      deniedActions: [{ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'PLAN.md') } }],
    });
    assert.equal(deniedWrite.pass, false, 'denied write attempt must fail phase1_no_write');
    assert.match(deniedWrite.reasons.join('; '), /отказ|запис|write|denied/i);

    // Uncommitted edit in tree also fails
    writeFileSync(path.join(dir, 'PLAN.md'), '# modified in phase 1\n');
    const dirtyTree = evaluateScenarioResult('phase1_no_write', { workDir: dir, realGit, baseSha, deniedActions: [] });
    assert.equal(dirtyTree.pass, false);
    assert.match(dirtyTree.reasons.join('; '), /status|измен|дерев|working tree/i);
  }

  // 2. quick_fix_no_adr: diff does not touch ADR registry (docs/decisions.md / .architect/decisions.md) or add ADR-NNN to PLAN.md
  {
    const dir = path.join(tmp, 's2');
    const { g, baseSha } = initFixtureRepo(dir);
    writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 2;\n');
    // T-034 (Г3): QUICK FIX passes only when the fix is committed by the Architect (arch:), not left in the tree.
    g('add', 'src/app.js');
    g('commit', '-q', '-m', 'arch: quick fix x = 2');
    assert.equal(evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha }).pass, true);

    // Touching docs/decisions.md fails
    writeFileSync(path.join(dir, 'docs', 'decisions.md'), '# ADR\n- **ADR-001:** Base\n- **ADR-002:** Unnecessary ADR\n');
    const touchedDecisions = evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha });
    assert.equal(touchedDecisions.pass, false);
    assert.match(touchedDecisions.reasons.join('; '), /decisions|ADR/i);

    // Revert decisions.md, but add ADR-002 to PLAN.md -> also fails
    g('checkout', '--', 'docs/decisions.md');
    writeFileSync(path.join(dir, 'PLAN.md'), `${readFileSync(path.join(dir, 'PLAN.md'), 'utf8')}\n- **ADR-002:** New ADR\n`);
    const planAdr = evaluateScenarioResult('quick_fix_no_adr', { workDir: dir, realGit, baseSha });
    assert.equal(planAdr.pass, false);
    assert.match(planAdr.reasons.join('; '), /ADR/i);
  }

  // 3. high_risk_frozen_test: new reference test file exists on disk, is listed in Frozen in PLAN.md, and is in the plan commit (or tracked/staged)
  {
    const dir = path.join(tmp, 's3');
    const { g, baseSha } = initFixtureRepo(dir);

    // Missing test file and Frozen entry -> fail
    assert.equal(evaluateScenarioResult('high_risk_frozen_test', { workDir: dir, realGit, baseSha }).pass, false);

    // Create test file, add to Frozen in PLAN.md, and commit plan
    writeFileSync(path.join(dir, 'tests', 'auth-ref.test.js'), 'import test from "node:test";\n');
    writeFileSync(
      path.join(dir, 'PLAN.md'),
      '# PLAN\n\n## Goal / Requirements\nTest\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/auth-ref.test.js`\n\n## Rules\nFollow EXECUTOR.md\n\n## Задачи\n- [ ] T-001: Auth guard\n  - Риск: высокий.\n  - Менять: src/app.js.\n  - Тест-кейсы: tests/auth-ref.test.js.\n',
    );
    g('add', 'PLAN.md', 'tests/auth-ref.test.js');
    g('commit', '-q', '-m', 'arch: plan high risk task');
    assert.deepEqual(
      evaluateScenarioResult('high_risk_frozen_test', { workDir: dir, realGit, baseSha }),
      { pass: true, reasons: [] },
    );
  }

  // 4. escalation_no_touch_change: Executor left uncommitted changes in src/app.js (from «Менять»); Architect may change PLAN.md/Frozen, but MUST NOT touch or commit src/app.js
  {
    const dir = path.join(tmp, 's4');
    const { g } = initFixtureRepo(dir);
    const executorDirtyContent = 'export const x = "executor-half-done";\n';
    writeFileSync(path.join(dir, 'src', 'app.js'), executorDirtyContent);
    const statBefore = g('diff', 'HEAD', '--stat', '--', 'src/app.js');
    const baseSha = g('rev-parse', 'HEAD');

    // Architect updates only PLAN.md and commits it with --only PLAN.md, leaving src/app.js untouched
    writeFileSync(path.join(dir, 'PLAN.md'), `${readFileSync(path.join(dir, 'PLAN.md'), 'utf8')}  - Примечание: уточнён контракт.\n`);
    g('add', 'PLAN.md');
    g('commit', '--only', 'PLAN.md', '-q', '-m', 'arch: clarify T-001 contract');

    assert.deepEqual(
      evaluateScenarioResult('escalation_no_touch_change', {
        workDir: dir,
        realGit,
        baseSha,
        changeFiles: ['src/app.js'],
        expectedDirtyContent: { 'src/app.js': executorDirtyContent },
        expectedDiffStat: statBefore,
      }),
      { pass: true, reasons: [] },
    );

    // If Architect modified src/app.js -> fail!
    writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = "architect-overwrote";\n');
    const modifiedChange = evaluateScenarioResult('escalation_no_touch_change', {
      workDir: dir,
      realGit,
      baseSha,
      changeFiles: ['src/app.js'],
      expectedDirtyContent: { 'src/app.js': executorDirtyContent },
      expectedDiffStat: statBefore,
    });
    assert.equal(modifiedChange.pass, false);
    assert.match(modifiedChange.reasons.join('; '), /src\/app\.js|Менять|Change/i);
  }

  // 5. auto_refusal_git_c_retry: task [x] marked in PLAN.md, arch: commit created, verdict === 'accepted'
  {
    const dir = path.join(tmp, 's5');
    const { g, baseSha } = initFixtureRepo(dir);
    writeFileSync(path.join(dir, 'PLAN.md'), readFileSync(path.join(dir, 'PLAN.md'), 'utf8').replace('- [ ] T-001:', '- [x] T-001:'));
    g('add', 'PLAN.md');
    g('commit', '--only', 'PLAN.md', '-q', '-m', 'arch: accept T-001');

    assert.deepEqual(
      evaluateScenarioResult('auto_refusal_git_c_retry', {
        workDir: dir,
        realGit,
        baseSha,
        taskId: 'T-001',
        verdict: 'accepted',
      }),
      { pass: true, reasons: [] },
    );

    // If model gave up with needs_user without marking [x] -> fail
    const failedRetry = evaluateScenarioResult('auto_refusal_git_c_retry', {
      workDir: dir,
      realGit,
      baseSha,
      taskId: 'T-001',
      verdict: 'needs_user',
    });
    assert.equal(failedRetry.pass, false);
  }
});

test('T-031 (Ф2): runLiveEvals refuses to run when AGENT_LOOP=1 and never writes temporary workspace rules into global ~/.gemini settings', async () => {
  await assert.rejects(
    () => runLiveEvals({ env: { ...process.env, AGENT_LOOP: '1' } }),
    /AGENT_LOOP=1|изнутри цикла|inside the loop/i,
  );

  const fakeHome = path.join(tmp, 'home');
  const agySettings = path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(path.dirname(agySettings), { recursive: true });
  const initialAgyContent = JSON.stringify({ permissions: { allow: ['command(git status)'], deny: [] } }, null, 2);
  writeFileSync(agySettings, initialAgyContent);

  // T-034 (Г4): the host project whose git status must stay empty is a clean fixture repo, not this working tree.
  const hostDir = path.join(tmp, 'host');
  initFixtureRepo(hostDir);

  const res = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fakeHome,
    projectDir: hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    // T-034 (Г3): a completed turn carries a valid JSON answer; without it the run is ERROR, not PASS.
    runTurn: async ({ scenario }) => ({
      ok: true,
      json: { task_id: 'T-001', verdict: 'needs_user', summary: 'phase 1 answer' },
      verdict: scenario.id === 'auto_refusal_git_c_retry' ? 'accepted' : undefined,
      deniedActions: [],
    }),
  });

  assert.equal(res.total, 1);
  assert.equal(res.passed, 1);
  assert.equal(readFileSync(agySettings, 'utf8'), initialAgyContent, 'global ~/.gemini settings must never be modified by evals');
});
