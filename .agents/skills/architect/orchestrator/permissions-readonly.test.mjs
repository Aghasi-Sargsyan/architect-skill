import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_COMMANDS, commandProblem, proposeRules } from './permissions.mjs';
import { installGuards } from './guards.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const BLOCKED = ['ship', 'deploy'];

test('T-055: BASE_COMMANDS includes all 30 stack-neutral read-only and local verification commands', () => {
  const expected = [
    'git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git branch --show-current',
    'git ls-files', 'git grep', 'git blame', 'git ls-tree', 'git merge-base', 'git rev-list',
    'git describe', 'git shortlog', 'git stash list', 'git tag -l', 'git branch -a', 'git branch -r',
    'git branch --list', 'git check-ignore', 'git add', 'git commit',
    'node --test', 'node --version', 'npm ls', 'wc -l', 'grep', 'ls', 'pwd', 'which',
  ];
  for (const cmd of expected) {
    assert.ok(BASE_COMMANDS.includes(cmd), `BASE_COMMANDS must include "${cmd}"`);
    assert.equal(commandProblem(cmd, BLOCKED), null, `commandProblem must allow base command "${cmd}"`);
  }
  assert.equal(BASE_COMMANDS.length, expected.length);
});

test('T-055: commandProblem allows read-only git grep, branch, tag, stash, node --version, pwd, which, npm ls and rejects mutating or pager-exec forms', () => {
  for (const okCmd of [
    'git grep -n pattern src/',
    'git branch --show-current',
    'git branch -a',
    'git branch -r',
    'git branch --list',
    'git branch --list feat*',
    'git tag -l',
    'git tag --list v1*',
    'git stash list',
    'git check-ignore -v a.txt',
    'node --version',
    'node -v',
    'pwd',
    'which git',
    'npm ls --depth=0',
  ]) {
    assert.equal(commandProblem(okCmd, BLOCKED), null, `expected commandProblem to allow: ${okCmd}`);
  }

  for (const badCmd of [
    'git grep -O vim pattern',
    'git grep -Ovim pattern',
    'git grep --open-files-in-pager pattern',
    'git grep --open-files-in-pager=vim pattern',
    'git branch',
    'git branch new-branch',
    'git branch -d feat',
    'git branch -D feat',
    'git branch -m old new',
    'git branch -M main',
    'git branch -a new-branch',
    'git branch --list -D feat',
    'git tag',
    'git tag v1.0',
    'git tag -d v1.0',
    'git tag -l -d v1.0',
    'git tag -a v1.0 -m msg',
    'git tag -f v1.0',
    'git tag --delete v1.0',
    'git tag --annotate v1.0',
    'git tag --sign v1.0',
    'git tag --force v1.0',
    'node -e 1',
    'node script.js',
    'node --version script.js',
  ]) {
    assert.ok(commandProblem(badCmd, BLOCKED), `expected commandProblem to reject: ${badCmd}`);
    assert.equal(proposeRules(badCmd, BLOCKED).auto, true, `expected auto-refusal for: ${badCmd}`);
  }
  assert.ok(!BASE_COMMANDS.includes('git stash'), 'bare git stash must not be in BASE_COMMANDS');
  assert.deepEqual(proposeRules('git stash list', BLOCKED).options.map((o) => o.rule), ['git stash', 'git stash list']);
});

test('T-055: git shim allows read-only git branch (-a, -r, --list, --show-current) and blocks branch mutation and git grep -O while AGENT_LOOP=1', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t055-')));
  try {
    const work = path.join(root, 'work');
    mkdirSync(work, { recursive: true });
    const gitEnv = {
      ...process.env,
      AGENT_LOOP: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
    const rg = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env: gitEnv }).trim();
    rg('init', '-q', '-b', 'master');
    writeFileSync(path.join(work, 'a.txt'), 'hello\n');
    rg('add', 'a.txt');
    rg('commit', '-q', '-m', 'init');
    rg('branch', 'feature');

    const g = installGuards({ workDir: work, shimDir: path.join(root, 'shims'), blockedNpmScripts: BLOCKED, realGit });
    try {
      const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: work, env: g.env, encoding: 'utf8' });
      for (const allowed of ['git branch --show-current', 'git branch -a', 'git branch -r', 'git branch --list', 'git branch --list feat*']) {
        const r = sh(allowed);
        assert.equal(r.status, 0, `expected exit 0 for "${allowed}", got ${r.status}: ${r.stderr}`);
      }
      for (const blocked of [
        'git branch',
        'git branch new-branch',
        'git branch -D feature',
        'git branch --list -D feature',
        'git grep -O vim hello',
        'git grep --open-files-in-pager hello',
      ]) {
        const r = sh(blocked);
        assert.equal(r.status, 97, `expected exit 97 for "${blocked}", got ${r.status}: ${r.stderr}`);
      }
    } finally {
      g.restore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const modName of ['permissions.mjs', 'guards.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
