import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateScenarioResult, runLiveEvals } from './evals.mjs';

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
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-t034-fix1-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cleanHost() {
  const hostDir = path.join(tmp, 'host');
  mkdirSync(hostDir, { recursive: true });
  const g = (...args) => execFileSync(realGit, args, { cwd: hostDir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(hostDir, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  return { hostDir, home };
}

const opts = (fx, extra = {}) => ({
  env: { ...GIT_ENV, AGENT_LOOP: '' },
  home: fx.home,
  projectDir: fx.hostDir,
  models: [{ runner: 'claude', model: 'haiku' }],
  scenarios: ['phase1_no_write'],
  realGit,
  maxErrorRetries: 0,
  ...extra,
});

test('T-034 fix 1: host integrity is fail-closed — a host where git status cannot run refuses the run, before and after the turn', async () => {
  const fx = cleanHost();

  const notRepo = path.join(tmp, 'not-a-repo');
  mkdirSync(notRepo, { recursive: true });
  let called = 0;
  await assert.rejects(
    () => runLiveEvals(opts({ ...fx, hostDir: notRepo }, { runTurn: async () => { called++; return { ok: true, json: VALID_JSON }; } })),
    /git status/,
    'a host that is not a git repository must not count as clean',
  );
  assert.equal(called, 0);

  await assert.rejects(
    () => runLiveEvals(opts(fx, {
      runTurn: async () => {
        renameSync(path.join(fx.hostDir, '.git'), path.join(fx.hostDir, '.git-moved'));
        return { ok: true, json: VALID_JSON, deniedActions: [] };
      },
    })),
    /git status/,
    'a host whose git status fails after the turn must abort the run',
  );
  renameSync(path.join(fx.hostDir, '.git-moved'), path.join(fx.hostDir, '.git'));
});

test('T-034 fix 1: the rubric is fail-closed — git errors in the eval repo are FAIL reasons, never a clean state', () => {
  const notRepo = path.join(tmp, 'plain');
  mkdirSync(notRepo, { recursive: true });
  const plain = evaluateScenarioResult('phase1_no_write', { workDir: notRepo, realGit, baseSha: 'deadbeef', deniedActions: [] });
  assert.equal(plain.pass, false, 'a work dir where git fails is not a clean phase 1');
  assert.match(plain.reasons.join('; '), /git/);

  const fx = cleanHost();
  const noGit = evaluateScenarioResult('phase1_no_write', { workDir: fx.hostDir, realGit: path.join(tmp, 'no-such-git'), baseSha: 'deadbeef', deniedActions: [] });
  assert.equal(noGit.pass, false, 'a missing git binary is not a clean phase 1');
});

test('T-034 fix 1: the whole temporary root of every run (work, cfg, shims, sandbox) is removed right after the cell', async () => {
  const fx = cleanHost();
  const roots = [];
  const res = await runLiveEvals(opts(fx, {
    runTurn: async ({ workDir }) => {
      roots.push(path.dirname(workDir));
      return { ok: true, json: VALID_JSON, deniedActions: [] };
    },
  }));
  assert.equal(res.passed, 1, JSON.stringify(res.results));
  assert.equal(roots.length, 1);
  assert.equal(existsSync(roots[0]), false, `temporary root ${roots[0]} must be removed after the cell, not at process exit`);
});
