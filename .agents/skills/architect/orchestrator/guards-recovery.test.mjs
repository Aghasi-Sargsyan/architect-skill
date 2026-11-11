import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import { localChecks } from './check.mjs';
import { DISABLED_PUSH_URL, installGuards, recoverCrashedGuards, which } from './guards.mjs';

const realGit = which('git');
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP')),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

test('recoverCrashedGuards and localChecks from a subdirectory preserve live repo-root guards and recover stale ones', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'guards-subdir-')));
  const remoteDir = path.join(root, 'remote.git');
  const repoDir = path.join(root, 'repo');
  const subDir = path.join(repoDir, '.agents', 'skills', 'architect', 'orchestrator');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(subDir, { recursive: true });

  try {
    git(remoteDir, 'init', '--bare', '-q');
    git(repoDir, 'init', '-q', '-b', 'master');
    git(repoDir, 'remote', 'add', 'origin', remoteDir);

    const g = installGuards({
      workDir: repoDir,
      shimDir: path.join(root, 'shims'),
      blockedScripts: [],
      sandboxRoot: root,
      realGit,
    });
    assert.deepEqual(g.verify(), []);

    // Live orchestrator lock at repo root while unit tests call localChecks / recoverCrashedGuards on subDir
    mkdirSync(path.join(repoDir, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(repoDir, '.agent-runs', '.lock'), `${process.pid}\n`);

    const liveRes = recoverCrashedGuards({ workDir: subDir, realGit });
    assert.equal(liveRes.recovered, false);
    assert.equal(liveRes.activePid, process.pid);
    assert.deepEqual(g.verify(), [], 'live guards must remain intact when recoverCrashedGuards runs from subDir');

    localChecks({ config: DEFAULTS, workDir: subDir, realGit, platform: 'darwin', nodeVersion: '22.0.0' });
    assert.deepEqual(g.verify(), [], 'live guards must remain intact when localChecks runs from subDir');
    assert.equal(git(repoDir, 'config', '--get', 'remote.origin.pushurl'), DISABLED_PUSH_URL);

    // Dead PID in repo root .lock: calling recoverCrashedGuards from subDir must recover guards and clear lock
    writeFileSync(path.join(repoDir, '.agent-runs', '.lock'), '99999999\n');
    const staleRes = recoverCrashedGuards({ workDir: subDir, realGit });
    assert.equal(staleRes.recovered, true);
    assert.equal(staleRes.activePid, null);
    assert.equal(existsSync(path.join(repoDir, '.agent-runs', '.lock')), false);
    assert.equal(existsSync(path.join(repoDir, '.git', 'hooks', 'pre-push')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
