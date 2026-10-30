import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan.mjs';
import { runLiveEvals } from './evals.mjs';
import { which } from './guards.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

test('T-045: parsePlan extracts referenceTests from Test cases / Тест-кейсы only when present in Frozen and never sets testFiles', () => {
  const md = `# PLAN

## Frozen
- \`EXECUTOR.md\`
- \`tests/frozen-a.test.mjs\`
- \`tests/frozen-b.test.mjs\`

## Задачи
- [ ] T-045: High risk with inline and multiline test cases
  - Риск: высокий.
  - Зависит от: —.
  - Менять: \`src/a.mjs\`.
  - Тест-кейсы: \`tests/frozen-a.test.mjs\`, \`tests/not-frozen.test.mjs\` (extra).
    - \`tests/frozen-b.test.mjs\`
    - \`tests/frozen-a.test.mjs\`
  - Проверка: \`npm test\`.

- [ ] T-046: English task with dash test cases
  - Risk: medium.
  - Depends on: T-045.
  - Change: \`src/b.mjs\`.
  - Test cases: —.
  - Verify: \`npm test\`.
`;

  const parsed = parsePlan(md);
  assert.equal(parsed.tasks.length, 2);
  const [t45, t46] = parsed.tasks;

  assert.deepEqual(t45.referenceTests, ['tests/frozen-a.test.mjs', 'tests/frozen-b.test.mjs']);
  assert.equal('testFiles' in t45, false, 'legacy field name testFiles must not be added by parsePlan');

  assert.deepEqual(t46.referenceTests, []);
  assert.equal('testFiles' in t46, false);

  const planLines = readFileSync(path.join(orchDir, 'plan.mjs'), 'utf8').split('\n').length;
  assert.ok(planLines <= 400, `plan.mjs must stay <= 400 lines (got ${planLines})`);
});

test('T-045: runLiveEvals writes host Commit: <sha> into results.md, rejects fail-closed when host becomes dirty during runTurn without writing Commit:, and stays <= 400 lines', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 's10-t045-evals-')));
  try {
    const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(tmp, 'README.md'), '# Host Repo\n');
    writeFileSync(path.join(tmp, '.gitignore'), '.agent-runs/\n');
    g('add', 'README.md', '.gitignore');
    g('commit', '-q', '-m', 'host initial commit');
    const hostSha = g('rev-parse', 'HEAD');

    const cleanRunId = '2026-10-30T10-00-00-000Z';
    await runLiveEvals({
      env: { ...process.env, AGENT_LOOP: '' },
      projectDir: tmp,
      runId: cleanRunId,
      scenarios: ['phase1_no_write'],
      models: [{ runner: 'claude', model: 'haiku' }],
      realGit,
      runTurn: async () => ({
        ok: true,
        denied: false,
        verdict: 'accepted',
        response: '[MODE: FEATURE · PHASE 1]\nSummaryonly.',
      }),
    });

    const cleanResultsPath = path.join(tmp, '.agent-runs', 'evals', cleanRunId, 'results.md');
    assert.ok(existsSync(cleanResultsPath), 'results.md must be created');
    const cleanText = readFileSync(cleanResultsPath, 'utf8');
    assert.match(cleanText, new RegExp(`^Commit: ${hostSha}$`, 'm'));

    // Second run where host working tree becomes dirty during runTurn -> runLiveEvals rejects fail-closed before writing Commit:
    const dirtyRunId = '2026-10-30T10-05-00-000Z';
    await assert.rejects(
      runLiveEvals({
        env: { ...process.env, AGENT_LOOP: '' },
        projectDir: tmp,
        runId: dirtyRunId,
        scenarios: ['phase1_no_write'],
        models: [{ runner: 'claude', model: 'haiku' }],
        realGit,
        runTurn: async () => {
          writeFileSync(path.join(tmp, 'README.md'), '# Host Repo modified during eval\n');
          return {
            ok: true,
            denied: false,
            verdict: 'accepted',
            response: '[MODE: FEATURE · PHASE 1]\nSummary.',
          };
        },
      }),
      /not clean/i,
    );

    const dirtyResultsPath = path.join(tmp, '.agent-runs', 'evals', dirtyRunId, 'results.md');
    const dirtyText = existsSync(dirtyResultsPath) ? readFileSync(dirtyResultsPath, 'utf8') : '';
    assert.doesNotMatch(dirtyText, /^Commit:/m, 'aborted single-cell run on dirty host must not record a Commit: line in results.md');

    const evalsLines = readFileSync(path.join(orchDir, 'evals.mjs'), 'utf8').split('\n').length;
    assert.ok(evalsLines <= 400, `evals.mjs must stay <= 400 lines (got ${evalsLines})`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup: close and remove temporary directory after test
    }
  }
});

test('T-060: runLiveEvals enforces host HEAD invariance across turns (rejects fail-closed when host HEAD changes even if working tree is clean) and rejects when host has no HEAD', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 's14-t060-evals-head-')));
  try {
    const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.invalid');

    // 1. Unborn HEAD (no commits yet) -> rejects before running scenarios
    await assert.rejects(
      runLiveEvals({
        env: { ...process.env, AGENT_LOOP: '' },
        projectDir: tmp,
        runId: '2026-10-31T00-00-00-000Z',
        scenarios: ['phase1_no_write'],
        models: [{ runner: 'claude', model: 'haiku' }],
        realGit,
        runTurn: async () => ({ ok: true, denied: false, verdict: 'accepted', json: { verdict: 'accepted' } }),
      }),
      /rev-parse HEAD|HEAD/i,
    );

    writeFileSync(path.join(tmp, 'README.md'), '# Host Repo\n');
    writeFileSync(path.join(tmp, '.gitignore'), '.agent-runs/\n');
    g('add', 'README.md', '.gitignore');
    g('commit', '-q', '-m', 'host initial commit');

    // 2. Host HEAD shifts during runTurn while keeping working tree clean -> rejects fail-closed without writing Commit:
    const shiftedRunId = '2026-10-31T00-05-00-000Z';
    await assert.rejects(
      runLiveEvals({
        env: { ...process.env, AGENT_LOOP: '' },
        projectDir: tmp,
        runId: shiftedRunId,
        scenarios: ['phase1_no_write'],
        models: [{ runner: 'claude', model: 'haiku' }],
        realGit,
        runTurn: async () => {
          writeFileSync(path.join(tmp, 'README.md'), '# Host Repo committed during eval\n');
          g('add', 'README.md');
          g('commit', '-q', '-m', 'sneaky host commit');
          return { ok: true, denied: false, verdict: 'accepted', json: { verdict: 'accepted' } };
        },
      }),
      /HEAD changed/i,
    );

    const shiftedResultsPath = path.join(tmp, '.agent-runs', 'evals', shiftedRunId, 'results.md');
    const shiftedText = existsSync(shiftedResultsPath) ? readFileSync(shiftedResultsPath, 'utf8') : '';
    assert.doesNotMatch(shiftedText, /^Commit:/m, 'aborted run on shifted host HEAD must not record a Commit: line in results.md');

    const evalsLines = readFileSync(path.join(orchDir, 'evals.mjs'), 'utf8').split('\n').length;
    assert.ok(evalsLines <= 400, `evals.mjs must stay <= 400 lines (got ${evalsLines})`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup: close and remove temporary directory after test
    }
  }
});
