import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGuards } from './guards.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(BASE_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let root;
const rg = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', env: BASE_ENV }).trim();

function makeRepo(parent) {
  mkdirSync(parent, { recursive: true });
  rg(parent, 'init', '-q', '--bare', '-b', 'master', 'remote.git');
  rg(parent, 'clone', '-q', 'remote.git', 'work');
  const work = path.join(parent, 'work');
  writeFileSync(path.join(work, 'a.txt'), '1\n');
  rg(work, 'add', 'a.txt');
  rg(work, 'commit', '-q', '-m', 'init');
  rg(work, 'push', '-q', 'origin', 'master');
  writeFileSync(path.join(work, 'a.txt'), '2\n');
  rg(work, 'commit', '-q', '-am', 'local');
  rg(work, 'branch', 'feature');
  return { work, remote: path.join(parent, 'remote.git') };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-s1-')));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const outside = makeRepo(path.join(root, 'outside'));
  const g = installGuards({
    workDir: outside.work,
    shimDir: path.join(root, 'shims'),
    blockedNpmScripts: ['ship'],
    sandboxRoot: path.join(root, 'sandbox'),
    realGit,
    realNpm: '/usr/bin/true',
  });
  const env = { ...BASE_ENV, AGENT_LOOP: '1', PATH: g.env.PATH };
  const sh = (cwd, cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
  return { outside, g, sh };
}

test('A1 (git shim): blocks --output=<file> and --output <file> for git log, diff and show while AGENT_LOOP=1', () => {
  const { outside, g, sh } = setup();
  const outFile = path.join(root, 'pwn.json');
  for (const cmd of [
    `git log -1 --format='tformat:{"x":1}' --output='${outFile}'`,
    `git log -1 --format='tformat:{"x":1}' --output '${outFile}'`,
    `git diff HEAD~1 --output='${outFile}'`,
    `git diff HEAD~1 --output '${outFile}'`,
    `git show HEAD --output='${outFile}'`,
    `git show --output '${outFile}' HEAD`,
    `git -C '${outside.work}' log -1 --output='${outFile}'`,
  ]) {
    const r = sh(outside.work, cmd);
    assert.equal(r.status, 97, `expected exit 97 for: ${cmd}`);
    assert.match(r.stderr, /--output.*blocked|is blocked/i, cmd);
    assert.equal(existsSync(outFile), false, `file must not be created by: ${cmd}`);
  }

  for (const okCmd of ['git log -1 --format=%s', 'git diff HEAD~1 --stat', 'git show --stat HEAD']) {
    const r = sh(outside.work, okCmd);
    assert.equal(r.status, 0, `${okCmd}: ${r.stderr}`);
  }
  g.restore();
});

test('B5 (git shim): allows git branch --show-current and blocks branch deletion, rename, creation or listing while AGENT_LOOP=1', () => {
  const { outside, g, sh } = setup();
  const cur = sh(outside.work, 'git branch --show-current');
  assert.equal(cur.status, 0, cur.stderr);
  assert.equal(cur.stdout.trim(), 'master');

  const curWithC = sh(root, `git -C '${outside.work}' branch --show-current`);
  assert.equal(curWithC.status, 0, curWithC.stderr);
  assert.equal(curWithC.stdout.trim(), 'master');

  for (const blocked of [
    'git branch -D feature',
    'git branch -d feature',
    'git branch -M renamed',
    'git branch -m master renamed',
    'git branch -f feature HEAD~1',
    'git branch new-branch',
    'git branch -a',
    'git branch',
  ]) {
    const r = sh(outside.work, blocked);
    assert.equal(r.status, 97, `expected exit 97 for: ${blocked}`);
    assert.match(r.stderr, /branch.*blocked|is blocked/i, blocked);
  }
  const branches = rg(outside.work, 'branch', '--list').split('\n').map((s) => s.replace('*', '').trim());
  assert.ok(branches.includes('master') && branches.includes('feature'), 'branches must remain intact');
  g.restore();
});

test('A3 (git shim): blocks explicit-URL push and -c config/alias overrides while AGENT_LOOP=1', () => {
  const { outside, g, sh } = setup();
  const before = rg(outside.remote, 'rev-parse', 'master');
  for (const cmd of [
    `git push --no-verify '${outside.remote}' HEAD:master`,
    `git push --no-verify 'file://${outside.remote}' HEAD:master`,
    'git push --no-verify https://example.invalid/repo.git HEAD:master',
    `git -c alias.p=push p --no-verify '${outside.remote}' HEAD:master`,
    'git -c core.hooksPath=/dev/null status',
    'git --config-env=core.hooksPath=HOME status',
  ]) {
    const r = sh(outside.work, cmd);
    assert.equal(r.status, 97, `expected exit 97 for: ${cmd}`);
    assert.match(r.stderr, /blocked/i, cmd);
  }
  assert.equal(rg(outside.remote, 'rev-parse', 'master'), before, 'remote master must not move');
  g.restore();
});
