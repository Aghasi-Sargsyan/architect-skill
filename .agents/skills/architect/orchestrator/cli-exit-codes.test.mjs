import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import { which } from './guards.mjs';
import { dispatchCliSubcommand } from './cli-dispatch.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const runMjs = path.join(orchDir, 'run.mjs');
const realGit = which('git');

function baseEnv(homeDir) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP' && k !== 'NODE_TEST_CONTEXT'),
  );
  return {
    ...clean,
    HOME: homeDir,
    ARCHITECT_NO_UPDATE_CHECK: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

test('C-06: spawning run.mjs --repair exits 0 on clean or recovered repo and exits 1 when lock holds a live PID', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cli-exit-repair-')));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = baseEnv(home);
  const g = (...args) => execFileSync(realGit, args, { cwd: repo, encoding: 'utf8', env }).trim();

  try {
    g('init', '-q', '-b', 'master');
    writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
    g('add', '.gitignore');
    g('commit', '-q', '-m', 'init');

    // 1. Clean repository: --repair must exit 0
    const cleanRun = spawnSync(process.execPath, [runMjs, '--repair'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(cleanRun.status, 0, `expected exit 0 on clean repo, got ${cleanRun.status}: ${cleanRun.stdout}\n${cleanRun.stderr}`);
    assert.match(cleanRun.stdout, /No leftover orchestrator guards/);

    // 2. Stale lock + leftover journal: --repair recovers and exits 0
    mkdirSync(path.join(repo, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-runs', '.lock'), '99999999\n');
    writeFileSync(
      path.join(repo, '.git', 'info', 'agent-loop-guards.json'),
      JSON.stringify({ pid: 99999999, remotes: {}, prePushCreated: false }) + '\n',
    );
    const recoveredRun = spawnSync(process.execPath, [runMjs, '--repair'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(recoveredRun.status, 0, `expected exit 0 after recovery, got ${recoveredRun.status}: ${recoveredRun.stderr}`);

    // 3. Live PID holding .agent-runs/.lock: --repair must refuse and exit 1
    mkdirSync(path.join(repo, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-runs', '.lock'), `${process.pid}\n`);
    const liveRun = spawnSync(process.execPath, [runMjs, '--repair'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(liveRun.status, 1, `expected exit 1 when live PID holds lock, got ${liveRun.status}`);
    assert.match(liveRun.stderr, /Cannot repair guards while orchestrator loop is running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C-06: spawning run.mjs --write-permissions exits 0 when post-check passes and exits 1 when post-check fails', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cli-exit-wp-')));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const envOk = baseEnv(home);
  const g = (...args) => execFileSync(realGit, args, { cwd: repo, encoding: 'utf8', env: envOk }).trim();

  try {
    g('init', '-q', '-b', 'master');
    mkdirSync(path.join(repo, '.agents'), { recursive: true });
    writeFileSync(
      path.join(repo, '.agents', 'orchestrator.json'),
      JSON.stringify({ ...DEFAULTS, runner: 'agy', permissions: 'allowlist' }, null, 2) + '\n',
    );
    writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
    g('add', '.gitignore', '.agents/orchestrator.json');
    g('commit', '-q', '-m', 'init');

    // 1. Valid separate HOME and workDir -> post-check passes -> exit 0
    const okRun = spawnSync(process.execPath, [runMjs, '--write-permissions'], { cwd: repo, env: envOk, encoding: 'utf8' });
    assert.equal(okRun.status, 0, `expected exit 0 when post-check succeeds: ${okRun.stdout}\n${okRun.stderr}`);

    // 2. HOME === workDir -> write_file(workDir) fails permissionsCheck ("home directory or above") -> ok: false -> exit 1
    const envFail = baseEnv(repo);
    const failRun = spawnSync(process.execPath, [runMjs, '--write-permissions'], { cwd: repo, env: envFail, encoding: 'utf8' });
    assert.equal(failRun.status, 1, `expected exit 1 when post-check fails, got ${failRun.status}: ${failRun.stdout}\n${failRun.stderr}`);
    assert.match(failRun.stdout, /✗/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C-06: cli-dispatch.mjs exports dispatchCliSubcommand and keeps both run.mjs and cli-dispatch.mjs well under 400 lines', async () => {
  assert.equal(typeof dispatchCliSubcommand, 'function');
  const runLines = readFileSync(runMjs, 'utf8').split('\n').length;
  const dispatchLines = readFileSync(path.join(orchDir, 'cli-dispatch.mjs'), 'utf8').split('\n').length;
  assert.ok(runLines <= 370, `run.mjs should drop to <= 370 lines after extracting CLI dispatch (got ${runLines})`);
  assert.ok(dispatchLines <= 400, `cli-dispatch.mjs must stay <= 400 lines (got ${dispatchLines})`);

  // Calling dispatchCliSubcommand with no subcommand flags returns { handled: false, config, layout, workDir }
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cli-dispatch-unit-')));
  try {
    mkdirSync(path.join(root, '.agents'), { recursive: true });
    const cfgPath = path.join(root, '.agents', 'orchestrator.json');
    writeFileSync(cfgPath, JSON.stringify(DEFAULTS, null, 2) + '\n');
    const res = await dispatchCliSubcommand({
      opts: {
        repair: false,
        compact: false,
        models: false,
        setModel: null,
        checkTask: null,
        selfCheck: false,
        init: false,
        installHooks: false,
        update: false,
        writePermissions: false,
        status: false,
        watch: null,
        follow: false,
        answer: null,
        check: false,
        auditPlan: false,
      },
      configPath: cfgPath,
      realGit,
      cwd: root,
    });
    assert.equal(res.handled, false);
    assert.equal(res.workDir, root);
    assert.ok(res.config && res.layout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
