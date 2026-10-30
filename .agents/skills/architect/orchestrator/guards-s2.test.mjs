import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNNER_TOOLS, blockedRunnerCommands, effectiveBlockedScripts, writeRunnerShims } from './runners.mjs';
import { commandProblem, proposeRules } from './permissions.mjs';
import { loadConfig } from './config.mjs';
import { installGuards } from './guards.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let root;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-s2-')));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('T-023 (D9): effectiveBlockedScripts merges blockedScripts and blockedNpmScripts in config.mjs', () => {
  assert.deepEqual(RUNNER_TOOLS, ['npm', 'pnpm', 'yarn', 'bun', 'make', 'just']);
  assert.deepEqual(
    effectiveBlockedScripts({ blockedScripts: ['deploy', 'ship'], blockedNpmScripts: ['ship', 'release'] }),
    ['deploy', 'ship', 'release'],
  );

  const cfgFile = path.join(root, 'orchestrator.json');
  writeFileSync(cfgFile, JSON.stringify({ blockedScripts: ['deploy'], allowedCommands: ['pnpm test', 'make test'] }));
  const loaded = loadConfig(cfgFile);
  assert.deepEqual(loaded.blockedScripts, ['deploy']);
  assert.deepEqual(loaded.blockedNpmScripts, ['deploy']);

  writeFileSync(cfgFile, JSON.stringify({ blockedScripts: ['deploy'], allowedCommands: ['pnpm run deploy'] }));
  assert.throws(() => loadConfig(cfgFile), /pnpm run deploy/);
});

test('T-023 (D9): commandProblem and proposeRules block forbidden scripts/targets across npm, pnpm, yarn, bun, make and just', () => {
  const blocked = ['ship', 'deploy'];
  const list = blockedRunnerCommands(blocked);
  for (const expected of [
    'npm run ship',
    'npm ship',
    'pnpm run ship',
    'pnpm ship',
    'yarn run ship',
    'yarn ship',
    'bun run ship',
    'bun ship',
    'make ship',
    'just ship',
  ]) {
    assert.ok(list.includes(expected), `blockedRunnerCommands must include "${expected}"`);
  }

  for (const forbidden of [
    'npm run ship',
    'pnpm run ship',
    'pnpm ship',
    'yarn run deploy',
    'yarn deploy',
    'bun run ship',
    'bun ship',
    'make ship',
    'make deploy',
    'just ship',
    'just deploy',
  ]) {
    assert.match(String(commandProblem(forbidden, blocked)), /запрещённую команду|covers forbidden command/, forbidden);
    assert.equal(proposeRules(forbidden, blocked).auto, true, forbidden);
  }

  // Broad bare rules and leading flags before subcommand/target are rejected for all 6 runners
  for (const broad of [
    'pnpm',
    'pnpm run',
    'yarn',
    'yarn run',
    'bun',
    'bun run',
    'make',
    'just',
    'pnpm --dir app ship',
    'yarn --cwd app deploy',
    'bun --cwd app ship',
    'make -C app ship',
    'just --justfile Justfile ship',
  ]) {
    assert.match(String(commandProblem(broad, blocked)), /слишком широкое|rule is too broad/, broad);
  }

  // Safe test/lint commands across all runners are allowed
  for (const safe of ['pnpm test', 'pnpm run lint', 'yarn test', 'bun test', 'make test', 'just test']) {
    assert.equal(commandProblem(safe, blocked), null, safe);
  }
});

test('T-023 (D9): PATH shims block forbidden scripts/targets with exit 97 across npm, pnpm, yarn, bun, make and just while AGENT_LOOP=1', () => {
  const realBinsDir = path.join(root, 'real-bins');
  const shimDir = path.join(root, 'shims');
  mkdirSync(realBinsDir, { recursive: true });

  const realBins = {};
  for (const tool of RUNNER_TOOLS) {
    const f = path.join(realBinsDir, tool);
    writeFileSync(f, `#!/bin/sh\necho "real-${tool}: $*"\nexit 0\n`);
    chmodSync(f, 0o755);
    realBins[tool] = f;
  }

  writeRunnerShims({ shimDir, blockedScripts: ['ship', 'deploy'], realBins });
  const envLoop = { ...process.env, AGENT_LOOP: '1', PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };
  const envNormal = { ...process.env, AGENT_LOOP: '', PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };
  const sh = (cmd, env = envLoop) => spawnSync('/bin/sh', ['-c', cmd], { cwd: root, env, encoding: 'utf8' });

  for (const blockedCmd of [
    'npm run ship',
    'npm ship',
    'pnpm run ship',
    'pnpm ship',
    'pnpm --dir ./sub run deploy',
    'pnpm -C ./sub ship',
    'pnpm --filter app run ship',
    'yarn run ship',
    'yarn deploy',
    'yarn --cwd ./sub run ship',
    'bun run ship',
    'bun deploy',
    'bun --cwd ./sub run ship',
    'make ship',
    'make -C ./sub deploy',
    'make -f Makefile.ci ENV=prod test ship',
    'just ship',
    'just --justfile ./Justfile deploy',
    'just --working-directory ./sub test deploy',
  ]) {
    const r = sh(blockedCmd);
    assert.equal(r.status, 97, `expected exit 97 for "${blockedCmd}", got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /agent-loop guard:.*blocked/i, blockedCmd);
  }

  // Allowed scripts/targets pass through to the real binary
  for (const allowedCmd of [
    ['npm test', 'real-npm: test'],
    ['pnpm run lint', 'real-pnpm: run lint'],
    ['yarn test', 'real-yarn: test'],
    ['bun test', 'real-bun: test'],
    ['make test', 'real-make: test'],
    ['make -C ./sub ENV=test check', 'real-make: -C ./sub ENV=test check'],
    ['just test', 'real-just: test'],
  ]) {
    const r = sh(allowedCmd[0]);
    assert.equal(r.status, 0, `${allowedCmd[0]}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), allowedCmd[1]);
  }

  // Without AGENT_LOOP=1, shims are transparent even for blocked targets
  assert.equal(sh('pnpm run ship', envNormal).status, 0);
  assert.equal(sh('make ship', envNormal).status, 0);

  // installGuards wires writeRunnerShims for the repository
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync(realGit, ['init', '-q', '-b', 'master'], { cwd: repo });
  const guards = installGuards({
    workDir: repo,
    shimDir: path.join(root, 'guard-shims'),
    blockedNpmScripts: ['ship'],
    realGit,
  });
  try {
    const r = spawnSync('/bin/sh', ['-c', 'pnpm run ship'], {
      cwd: repo,
      env: { ...process.env, AGENT_LOOP: '1', PATH: guards.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(r.status, 97);
  } finally {
    guards.restore();
  }
});
