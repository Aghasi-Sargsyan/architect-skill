import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as evalsMod from './evals.mjs';
import { runLiveEvals } from './evals.mjs';
import { installGuards, writeGitShim } from './guards.mjs';

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
const VALID_JSON = { task_id: 'T-001', verdict: 'needs_user', summary: 'answer' };

let tmp;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-t035-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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
  return { hostDir, home, agySettings };
}

test('T-035 (П1, П2): writeGitShim and installGuards throw on non-absolute realGit; runLiveEvals defaults realGit to which("git") so git status inside turn env finishes with exit 0', async () => {
  const fx = hostFixture();
  const shimDir = path.join(tmp, 'bad-shims');
  const sandboxRoot = path.join(tmp, 'bad-sandbox');

  assert.throws(
    () => writeGitShim({ shimDir, realGit: 'git', sandboxRoot, workDir: fx.hostDir }),
    /realGit|абсолютн|absolute/i,
  );
  assert.throws(
    () => installGuards({ workDir: fx.hostDir, shimDir, blockedScripts: [], sandboxRoot, realGit: 'git' }),
    /realGit|абсолютн|absolute/i,
  );

  // Call runLiveEvals WITHOUT passing realGit: must default to which('git') and never recursively exec shims/git
  let gitCmdResult = null;
  const res = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    maxErrorRetries: 0,
    runTurn: async ({ workDir, env }) => {
      gitCmdResult = spawnSync('/bin/sh', ['-c', 'git status --short'], {
        cwd: workDir,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  });

  assert.ok(gitCmdResult, 'runTurn must have executed');
  assert.equal(gitCmdResult.status, 0, `git status --short must exit 0 (got status=${gitCmdResult.status}, signal=${gitCmdResult.signal}, stderr=${gitCmdResult.stderr})`);
  assert.equal(res.passed, 1);
});

test('T-035 (П4): permission denials continue the same session via proposeRules + resumePrompt (auto-refusal with suggestedCommand and deterministic "пользователь не разрешил"); exhausted maxPermissionPrompts is FAIL, not ERROR', async () => {
  const fx = hostFixture();
  const seenTurns = [];

  const res = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['auto_refusal_git_c_retry'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxPermissionPrompts: 3,
    maxErrorRetries: 1,
    runTurn: async ({ workDir, prompt, conversationId, turn }) => {
      seenTurns.push({ turn, conversationId, prompt });
      if (turn === 0) {
        return {
          ok: false,
          denied: true,
          conversationId: 'conv-session-1',
          deniedActions: [{ tool_name: 'Bash', tool_input: { command: `git -C ${workDir} show --stat HEAD` } }],
        };
      }
      if (turn === 1) {
        return {
          ok: false,
          denied: true,
          conversationId: 'conv-session-1',
          deniedActions: [{ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }],
        };
      }
      // ADR-064: the review is read-only — the mock Architect accepts without editing PLAN.md or committing.
      return {
        ok: true,
        conversationId: 'conv-session-1',
        json: { task_id: 'T-001', verdict: 'accepted', summary: 'accepted after continuations' },
        verdict: 'accepted',
        deniedActions: [],
      };
    },
  });

  assert.equal(res.passed, 1, JSON.stringify(res.results));
  assert.equal(seenTurns.length, 3);
  assert.equal(seenTurns[0].conversationId, null);
  assert.equal(seenTurns[1].conversationId, 'conv-session-1');
  assert.match(seenTurns[1].prompt, /git show --stat HEAD/, 'auto-refusal for git -C <workDir> must suggest git show --stat HEAD');
  assert.equal(seenTurns[2].conversationId, 'conv-session-1');
  assert.match(seenTurns[2].prompt, /пользователь не разрешил|user denied permission/i, 'non-auto command must deterministically answer that user denied permission');
  assert.equal(res.results[0].attempts, 1);
  assert.deepEqual(res.results[0].attemptStatuses, ['PASS']);

  // Exhausting maxPermissionPrompts must be graded FAIL (model behavior), not ERROR, and must not retry the cell
  let exhaustedCalls = 0;
  const exhausted = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxPermissionPrompts: 2,
    maxErrorRetries: 2,
    runTurn: async () => {
      exhaustedCalls++;
      return {
        ok: false,
        denied: true,
        conversationId: 'conv-loop',
        deniedActions: [{ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }],
      };
    },
  });

  assert.equal(exhaustedCalls, 3, 'turn 0 + 2 continuations = 3 calls, no cell retry');
  assert.equal(exhausted.failed, 1);
  assert.equal(exhausted.errors, 0);
  assert.equal(exhausted.results[0].status, 'FAIL');
  assert.equal(exhausted.results[0].attempts, 1);
  assert.deepEqual(exhausted.results[0].attemptStatuses, ['FAIL']);
  assert.match(exhausted.results[0].reasons.join('; '), /исчерпаны продолжения|permission continuations exhausted/i);
});

test('T-035 (П5): deniedActions accumulate across continuations and retries; a forbidden write in an ERROR attempt makes phase1_no_write FAIL without retry; attemptStatuses and formatEvalCellLine report all attempts', async () => {
  const fx = hostFixture();

  // 1. Forbidden write in attempt 1 that ends in ERROR -> immediately FAIL, retry does not wash it away
  let calls1 = 0;
  const writeInError = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxErrorRetries: 2,
    runTurn: async () => {
      calls1++;
      if (calls1 === 1) {
        return {
          ok: false,
          error: 'process timed out after attempting write',
          deniedActions: [{ tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }],
        };
      }
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  });

  assert.equal(calls1, 1, 'must not retry when a forbidden write denial already occurred in phase1_no_write');
  assert.equal(writeInError.failed, 1);
  assert.equal(writeInError.passed, 0);
  assert.equal(writeInError.errors, 0);
  assert.equal(writeInError.results[0].status, 'FAIL');
  assert.deepEqual(writeInError.results[0].attemptStatuses, ['FAIL']);
  assert.match(writeInError.results[0].reasons.join('; '), /write denial|запись/i);

  // 2. Forbidden write in turn 0 continuation, followed by clean turn 1 answer -> still FAIL
  const writeInCont = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxErrorRetries: 1,
    runTurn: async ({ turn }) => {
      if (turn === 0) {
        return {
          ok: false,
          denied: true,
          conversationId: 'conv-write-cont',
          deniedStep: { kind: 'other', text: 'Write: src/app.js' },
          deniedActions: [{ tool_name: 'Write', tool_input: { file_path: 'src/app.js' } }],
        };
      }
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  });

  assert.equal(writeInCont.failed, 1);
  assert.equal(writeInCont.results[0].status, 'FAIL');
  assert.match(writeInCont.results[0].reasons.join('; '), /write denial|запись/i);

  // 3. Transient ERROR on attempt 1, PASS on attempt 2 -> attemptStatuses is ['ERROR', 'PASS'] and visible in formatEvalCellLine
  let calls3 = 0;
  const passOnSecond = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxErrorRetries: 2,
    runTurn: async () => {
      calls3++;
      if (calls3 === 1) return { ok: false, error: 'transient crash', deniedActions: [] };
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  });

  assert.equal(passOnSecond.passed, 1);
  const cell = passOnSecond.results[0];
  assert.equal(cell.attempts, 2);
  assert.deepEqual(cell.attemptStatuses, ['ERROR', 'PASS']);
  assert.equal(typeof evalsMod.formatEvalCellLine, 'function', 'formatEvalCellLine must be exported from evals.mjs');
  const line = evalsMod.formatEvalCellLine(cell);
  assert.match(line, /attempts=2:\s*ERROR\s*->\s*PASS/);
});

test('T-035 (П6): per-turn logs are written to <projectDir>/.agent-runs/evals/<runId>/ while keeping host git status clean', async () => {
  const fx = hostFixture();
  const res = await runLiveEvals({
    env: { ...GIT_ENV, AGENT_LOOP: '' },
    home: fx.home,
    projectDir: fx.hostDir,
    runId: 'test-run-p6',
    scenarios: ['phase1_no_write'],
    models: [{ runner: 'claude', model: 'haiku' }],
    realGit,
    maxErrorRetries: 0,
    runTurn: async () => ({
      ok: true,
      conversationId: 'conv-log-test',
      transcript: '~/.claude/projects/slug/conv-log-test.jsonl',
      stdout: 'some stdout tail',
      stderr: 'some stderr tail',
      json: VALID_JSON,
      deniedActions: [{ tool_name: 'Bash', tool_input: { command: 'echo hi' } }],
    }),
  });

  assert.equal(res.passed, 1);
  assert.ok(res.runDir && res.runDir.startsWith(path.join(fx.hostDir, '.agent-runs', 'evals')), `expected runDir inside .agent-runs/evals, got ${res.runDir}`);
  assert.ok(existsSync(res.runDir), 'evals runDir must exist after the run');
  const files = readdirSync(res.runDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const logEntry = JSON.parse(readFileSync(path.join(res.runDir, files[0]), 'utf8'));
  assert.equal(logEntry.conversationId, 'conv-log-test');
  assert.equal(logEntry.transcript, '~/.claude/projects/slug/conv-log-test.jsonl');
  assert.equal(logEntry.deniedActions.length, 1);
  assert.match(logEntry.stdoutTail, /some stdout tail/);
  assert.match(logEntry.stderrTail, /some stderr tail/);

  const hostStatus = execFileSync(realGit, ['status', '--porcelain'], { cwd: fx.hostDir, encoding: 'utf8', env: GIT_ENV }).trim();
  assert.equal(hostStatus, '', 'host git status must stay clean when logs are written to .agent-runs/evals/');
});
