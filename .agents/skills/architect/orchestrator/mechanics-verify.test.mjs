import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan.mjs';
import { DEFAULTS, validateConfig, withDefaults } from './config.mjs';
import { agySettingsPath, rulesFor, writeAgyAllowlist } from './permissions.mjs';
import * as mechanicsMod from './mechanics.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();

let root;
let work;
let env;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-verify-s9-')));
  work = path.join(root, 'work');
  mkdirSync(work, { recursive: true });
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'),
  );
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('T-043a: parsePlan extracts verifyCommands only from backticks in Проверка / Verify / Check, and config validates verifyTimeoutMs (default 120000)', () => {
  const planText = `# PLAN

## Frozen
- \`EXECUTOR.md\`

## Задачи

- [ ] T-001: with backticked commands
  - Риск: высокий.
  - Менять: \`src/a.js\`.
  - Проверка: \`node --test tests/a.test.mjs\` и \`npm test\`.

- [ ] T-002: without backticks in Verify
  - Risk: medium.
  - Change: \`src/b.js\`.
  - Verify: git show --stat HEAD.

- [ ] T-003: multiline Check list
  - Risk: high.
  - Change: \`src/c.js\`.
  - Check:
    - \`npx tsc -b\`
    - \`node --test tests/c.test.mjs\`
`;
  const parsed = parsePlan(planText);
  assert.deepEqual(parsed.tasks[0].verifyCommands, ['node --test tests/a.test.mjs', 'npm test']);
  assert.deepEqual(parsed.tasks[1].verifyCommands, [], 'Verify without backticks must produce empty verifyCommands');
  assert.deepEqual(parsed.tasks[2].verifyCommands, ['npx tsc -b', 'node --test tests/c.test.mjs']);

  assert.equal(DEFAULTS.verifyTimeoutMs, 600000);
  assert.deepEqual(validateConfig(DEFAULTS), []);
  assert.match(validateConfig(withDefaults({ verifyTimeoutMs: 0 })).join('\n'), /verifyTimeoutMs/);
  assert.match(validateConfig(withDefaults({ verifyTimeoutMs: 'fast' })).join('\n'), /verifyTimeoutMs/);
});

test('T-043a: runTaskVerification executes allowed commands with shell:false, rejects disallowed commands and env prefixes, and captures non-zero exit / timeout', () => {
  assert.equal(typeof mechanicsMod.runTaskVerification, 'function');

  writeFileSync(
    path.join(work, 'pass.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => { assert.equal(1, 1); });\n",
  );
  writeFileSync(
    path.join(work, 'fail.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2, 'EXPECTED_FAILURE_MARKER'); });\n",
  );
  writeFileSync(
    path.join(work, 'slow.test.mjs'),
    "import { test } from 'node:test';\ntest('hang', async () => { await new Promise((r) => setTimeout(r, 5000)); });\n",
  );

  const cfg = { ...DEFAULTS, blockedNpmScripts: ['ship'], allowedCommands: ['npm test'] };

  // 1. Passing Verify command
  const passRes = mechanicsMod.runTaskVerification({
    task: { id: 'T-001', verifyCommands: ['node --test pass.test.mjs'] },
    workDir: work,
    env,
    config: cfg,
    timeoutMs: 10000,
  });
  assert.equal(passRes.ok, true);
  assert.equal(passRes.kind, 'passed');
  assert.equal(passRes.results.length, 1);
  assert.equal(passRes.results[0].exitCode, 0);

  // 2. Disallowed commands: shell operators, blocked script, unallowed binary, leading flag, or KEY=VALUE env prefix
  for (const badCmd of [
    'node --test pass.test.mjs && echo pwn',
    'npm run ship',
    'cat pass.test.mjs',
    `git -C ${work} status`,
    'VERIFY_STEP_A1=1 node --test pass.test.mjs',
  ]) {
    const disRes = mechanicsMod.runTaskVerification({
      task: { id: 'T-001', verifyCommands: [badCmd] },
      workDir: work,
      env,
      config: cfg,
      timeoutMs: 10000,
    });
    assert.equal(disRes.ok, false, `expected disallowed command to fail: ${badCmd}`);
    assert.equal(disRes.kind, 'disallowed', `expected kind="disallowed" for: ${badCmd}`);
    assert.equal(disRes.command, badCmd);
  }

  // 3. Failing Verify command (non-zero exit code) stops before running later commands and returns output tail
  const failRes = mechanicsMod.runTaskVerification({
    task: { id: 'T-001', verifyCommands: ['node --test fail.test.mjs', 'node --test pass.test.mjs'] },
    workDir: work,
    env,
    config: cfg,
    timeoutMs: 10000,
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.kind, 'failed');
  assert.equal(failRes.failedCommand, 'node --test fail.test.mjs');
  assert.equal(failRes.results.length, 1, 'must stop on first failing Verify command');
  assert.match(failRes.outputTail, /EXPECTED_FAILURE_MARKER/);

  // 4. Timed-out Verify command returns kind="timeout"
  const timeoutRes = mechanicsMod.runTaskVerification({
    task: { id: 'T-001', verifyCommands: ['node --test slow.test.mjs'] },
    workDir: work,
    env,
    config: cfg,
    timeoutMs: 150,
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.kind, 'timeout');
  assert.equal(timeoutRes.timedOut, true);
  assert.equal(timeoutRes.failedCommand, 'node --test slow.test.mjs');
});

test('T-043a (ADR-031, ADR-064): run.mjs triggers rework on Verify failure without calling Architect, and after a read-only review the orchestrator commits acceptance', () => {
  const g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();
  g('init', '-q', '-b', 'master');

  writeFileSync(path.join(work, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n# Executor\n');
  writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(work, 'a.txt'), 'init\n');
  writeFileSync(
    path.join(work, 'check-a.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('a.txt has expected value', () => {\n  assert.equal(readFileSync('a.txt', 'utf8'), 'expected\\n', 'A_TXT_MISMATCH');\n});\n",
  );
  // ADR-061 R-7 / ADR-064: PLAN.md is never in Change; the fake Architect is read-only and the orchestrator commits acceptance.
  const initialPlan = `# PLAN

## Frozen
- \`EXECUTOR.md\`
- \`check-a.test.mjs\`

## Tasks

- [ ] T-001: update a.txt
  - Risk: high.
  - Change: \`a.txt\`.
  - Verify: \`node --test check-a.test.mjs\`.
`;
  writeFileSync(path.join(work, 'PLAN.md'), initialPlan);

  const agy = path.join(root, 'fake-agy-verify');
  writeFileSync(
    agy,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');
  console.log('gemini-4-argon-high\\tGemini 4 Argon (High)');
  process.exit(0);
}
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : '';
const home = process.env.HOME;
const callsFile = path.join(home, 'calls.json');
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
const isArchitect = prompt.includes('Role: Chief Architect');
calls.push({ role: isArchitect ? 'architect' : 'executor', prompt });
fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2));

const git = (...gArgs) => execFileSync(${JSON.stringify(realGit)}, gArgs, { encoding: 'utf8' }).trim();

if (!isArchitect && calls.filter((c) => c.role === 'executor').length === 1) {
  // Attempt 0: write a wrong value to a.txt, so the pre-turn Verify command fails
  fs.writeFileSync('a.txt', 'wrong\\n');
  git('add', 'a.txt');
  git('commit', '--only', 'a.txt', '-m', 'T-001: attempt 0 with wrong value');
  const sha = git('rev-parse', 'HEAD');
  const ans = JSON.stringify({ task_id: 'T-001', status: 'done', check_passed: true, self_check: true, retry_count: 0, commits: [sha], report_markdown: 'done attempt 0' });
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: 'c-1', response: ans }));
} else if (!isArchitect) {
  // Attempt 1 (rework): fix a.txt
  fs.writeFileSync('a.txt', 'expected\\n');
  git('add', 'a.txt');
  git('commit', '--only', 'a.txt', '-m', 'T-001 (fix 1): set expected value');
  const sha = git('rev-parse', 'HEAD');
  const ans = JSON.stringify({ task_id: 'T-001', status: 'done', check_passed: true, self_check: true, retry_count: 1, commits: [sha], report_markdown: 'done fix 1' });
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: 'c-2', response: ans }));
} else {
  // Architect review after Verify passes: read-only, no commit (the orchestrator commits acceptance)
  const ans = JSON.stringify({ task_id: 'T-001', verdict: 'accepted', issues: [], rework_instructions: '', arch_commits: [], summary: 'accepted after Verify passed' });
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: 'c-3', response: ans }));
}
`,
  );
  chmodSync(agy, 0o755);

  const config = { ...DEFAULTS, agyBin: agy, maxFixRounds: 1, notify: false };
  mkdirSync(path.join(work, '.agents'), { recursive: true });
  writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config, null, 2));

  // 1. Disallowed Verify command is caught in --dry-run AND before Executor is called in run.mjs
  const badPlan = initialPlan.replace('node --test check-a.test.mjs', 'VERIFY_STEP_A1=1 node --test check-a.test.mjs');
  writeFileSync(path.join(work, 'PLAN.md'), badPlan);
  g('add', '.');
  g('commit', '-q', '-m', 'init with disallowed Verify');
  writeAgyAllowlist({ settingsPath: agySettingsPath(env.HOME), ...rulesFor(config, work) });

  const dryBad = spawnSync(process.execPath, [RUN, '--dry-run', '--only', 'T-001'], { cwd: work, env, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(dryBad.status, 0, 'dry-run must exit non-zero when Verify contains a disallowed command');
  assert.match(dryBad.stdout + dryBad.stderr, /Verify|disallowed/i);

  const runBad = spawnSync(process.execPath, [RUN, '--only', 'T-001'], { cwd: work, env, encoding: 'utf8', timeout: 15000 });
  const callsAfterBad = existsSync(path.join(env.HOME, 'calls.json'))
    ? JSON.parse(readFileSync(path.join(env.HOME, 'calls.json'), 'utf8'))
    : [];
  assert.deepEqual(callsAfterBad, [], 'Executor must NOT be called when task.verifyCommands contains a disallowed command');
  assert.match(runBad.stdout + runBad.stderr, /disallowed Verify command/i);

  // 2. Restore valid Verify command and test pre-turn Verify capture, rework on failure, and acceptance
  writeFileSync(path.join(work, 'PLAN.md'), initialPlan);
  g('add', 'PLAN.md');
  g('commit', '-q', '-m', 'restore valid Verify');

  const res = spawnSync(process.execPath, [RUN, '--only', 'T-001'], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);

  const calls = JSON.parse(readFileSync(path.join(env.HOME, 'calls.json'), 'utf8'));
  assert.deepEqual(
    calls.map((c) => c.role),
    ['executor', 'executor', 'architect'],
    'failed Verify on round 0 must trigger Executor rework directly without calling Architect on round 0',
  );
  assert.match(calls[1].prompt, /A_TXT_MISMATCH/, 'rework prompt on round 1 must include Verify failure output tail');
  assert.match(calls[2].prompt, /Verify passed/i, 'Architect prompt on round 1 must confirm Verify passed');
  assert.equal(g('log', '-1', '--format=%s'), 'arch: accept T-001', 'the orchestrator creates the acceptance commit');
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['PLAN.md']);
  assert.equal(parsePlan(readFileSync(path.join(work, 'PLAN.md'), 'utf8')).tasks[0].done, true);
});
