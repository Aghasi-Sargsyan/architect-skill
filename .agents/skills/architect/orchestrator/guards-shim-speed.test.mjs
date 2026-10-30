import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as guardsMod from './guards.mjs';
import { findExecutable } from './events.mjs';
import { askPermission, writeAnswer, resolveInterval as askResolveInterval } from './ask.mjs';
import { watch, follow, resolveInterval as feedResolveInterval } from './feed.mjs';

let tmp;
const savedEnv = {};
const ENV_KEYS = [
  'AGENT_LOOP_ASK_POLL_MS',
  'AGENT_LOOP_WATCH_POLL_MS',
  'AGENT_LOOP_WATCH_GRACE_MS',
  'AGENT_LOOP_FOLLOW_POLL_MS',
  'AGENT_LOOP_FOLLOW_GRACE_MS',
];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-shim-s9-')));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('T-041: isGuardShimFile and unwrapGit enforce SHIM_MAX_BYTES (16384) and SHIM_HEADER_BYTES (512), handle EACCES safely, and keep PATH scan fast', () => {
  assert.equal(guardsMod.SHIM_MAX_BYTES, 16384);
  assert.equal(guardsMod.SHIM_HEADER_BYTES, 512);
  assert.equal(typeof guardsMod.isGuardShimFile, 'function');

  const shimDir = path.join(tmp, 'shims');
  const binDir = path.join(tmp, 'bins');
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const validShim = path.join(shimDir, 'git');
  writeFileSync(validShim, "#!/bin/sh\n# agent-loop guard: git shim\nREAL_GIT='/usr/bin/git'\nexec \"$REAL_GIT\" \"$@\"\n");
  chmodSync(validShim, 0o755);
  assert.equal(guardsMod.isGuardShimFile(validShim), true);
  assert.equal(guardsMod.unwrapGit(validShim), '/usr/bin/git');

  // Marker only after first 512 bytes must return false
  const lateMarkerFile = path.join(binDir, 'late');
  writeFileSync(lateMarkerFile, `${'x'.repeat(600)}\n# agent-loop guard\n`);
  chmodSync(lateMarkerFile, 0o755);
  assert.equal(guardsMod.isGuardShimFile(lateMarkerFile), false);

  // File larger than SHIM_MAX_BYTES (16384) must NOT be read by isGuardShimFile or unwrapGit
  // Even if it contains "agent-loop guard: git shim" without a valid REAL_GIT=..., unwrapGit must return it as-is without reading or throwing!
  const oversizedGit = path.join(binDir, 'git');
  writeFileSync(oversizedGit, `#!/bin/sh\n# agent-loop guard: git shim\n# broken REAL_GIT\n${'a'.repeat(20000)}\n`);
  chmodSync(oversizedGit, 0o755);
  assert.equal(guardsMod.isGuardShimFile(oversizedGit), false, 'oversized file (> 16 KB) must not be treated as a guard shim');
  assert.equal(guardsMod.unwrapGit(oversizedGit), oversizedGit, 'unwrapGit must skip reading files > SHIM_MAX_BYTES');
  assert.equal(findExecutable('git', [shimDir, binDir].join(path.delimiter)), oversizedGit);

  // Unreadable file (EACCES) must not throw and its directory must remain in cleanShimPath
  const restrictedDir = path.join(tmp, 'restricted');
  mkdirSync(restrictedDir, { recursive: true });
  const unreadableGit = path.join(restrictedDir, 'git');
  writeFileSync(unreadableGit, '#!/bin/sh\n# agent-loop guard\n');
  chmodSync(unreadableGit, 0o000);
  try {
    if (process.getuid && process.getuid() !== 0) {
      assert.equal(guardsMod.isGuardShimFile(unreadableGit), false);
      const cleaned = guardsMod.cleanShimPath([shimDir, restrictedDir, binDir].join(path.delimiter));
      assert.equal(cleaned, [restrictedDir, binDir].join(path.delimiter));
    }
  } finally {
    chmodSync(unreadableGit, 0o644);
  }
});

test('T-041: askPermission, watch, and follow resolve intervals in order: explicit parameter -> AGENT_LOOP_* env var (>= 10ms) -> default', async () => {
  const workDir = path.join(tmp, 'proj');
  const runDir = path.join(workDir, '.agent-runs', '2026-10-30T00-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'summary.md'), '■ Stop: Done\n');
  writeFileSync(path.join(runDir, 'feed.log'), 'line 1\n');

  // 1. Structural checks on resolveInterval for ask.mjs and feed.mjs
  // (a) default fallback when parameter and env var are unset
  assert.equal(askResolveInterval(undefined, 'AGENT_LOOP_ASK_POLL_MS', 2000), 2000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_WATCH_POLL_MS', 2000), 2000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_WATCH_GRACE_MS', 2000), 2000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_FOLLOW_POLL_MS', 1000), 1000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_FOLLOW_GRACE_MS', 2000), 2000);

  // (b) env var precedence over default when valid (>= 10ms)
  process.env.AGENT_LOOP_ASK_POLL_MS = '15';
  process.env.AGENT_LOOP_WATCH_POLL_MS = '15';
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '25';
  process.env.AGENT_LOOP_FOLLOW_POLL_MS = '15';
  process.env.AGENT_LOOP_FOLLOW_GRACE_MS = '25';
  assert.equal(askResolveInterval(undefined, 'AGENT_LOOP_ASK_POLL_MS', 2000), 15);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_WATCH_POLL_MS', 2000), 15);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_WATCH_GRACE_MS', 2000), 25);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_FOLLOW_POLL_MS', 1000), 15);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_FOLLOW_GRACE_MS', 2000), 25);

  // (c) explicit parameter takes precedence over AGENT_LOOP_* env var
  assert.equal(askResolveInterval(50, 'AGENT_LOOP_ASK_POLL_MS', 2000), 50);
  assert.equal(feedResolveInterval(120, 'AGENT_LOOP_WATCH_GRACE_MS', 2000), 120);
  assert.equal(feedResolveInterval(40, 'AGENT_LOOP_FOLLOW_POLL_MS', 1000), 40);

  // (d) invalid env var (< 10ms or non-numeric) is ignored and falls back to default
  process.env.AGENT_LOOP_ASK_POLL_MS = '5';
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '5';
  process.env.AGENT_LOOP_FOLLOW_POLL_MS = 'invalid';
  assert.equal(askResolveInterval(undefined, 'AGENT_LOOP_ASK_POLL_MS', 2000), 2000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_WATCH_GRACE_MS', 2000), 2000);
  assert.equal(feedResolveInterval(undefined, 'AGENT_LOOP_FOLLOW_POLL_MS', 1000), 1000);

  // 2. Deterministic execution checks with fast env intervals (no real-time timers)
  process.env.AGENT_LOOP_WATCH_POLL_MS = '15';
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '25';
  const wRes = await watch({ workDir, minutes: 1 });
  assert.equal(wRes.code, 3, 'watch finishes with code 3 when summary indicates stopped and grace period passes');

  process.env.AGENT_LOOP_FOLLOW_POLL_MS = '15';
  process.env.AGENT_LOOP_FOLLOW_GRACE_MS = '25';
  const printed = [];
  await follow({ workDir, print: (l) => printed.push(l) });
  assert.ok(printed.some((l) => l.includes('line 1')), 'follow streams lines from feed.log');

  // watch: invalid env var (< 10) falls back to default 2000ms grace, so 0.001 min (60ms) expires with code 0
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '5';
  const iRes = await watch({ workDir, minutes: 0.001, pollMs: 15 });
  assert.equal(iRes.code, 0, 'invalid graceMs (< 10) falls back to 2000ms so 60ms window expires with code 0');

  // askPermission: answer '2' returned when written within timeout
  process.env.AGENT_LOOP_ASK_POLL_MS = '15';
  const question = {
    id: 'q-1',
    who: 'Executor',
    taskId: 'T-041',
    command: 'npm run lint',
    options: [{ answer: '2', label: 'once', rule: 'npm run lint' }],
  };
  setTimeout(() => {
    writeAnswer({ workDir, answer: '2' });
  }, 30);
  const ans = await askPermission({ question, workDir, runDir, tty: false, timeoutMs: 2000, log: () => {} });
  assert.equal(ans, '2', 'askPermission returns deterministic option 2 when answered');

  // askPermission: null returned when timeout expires without answer
  const timedOutAns = await askPermission({
    question: { ...question, id: 'q-timeout' },
    workDir,
    runDir,
    tty: false,
    timeoutMs: 30,
    pollMs: 15,
    log: () => {},
  });
  assert.equal(timedOutAns, null, 'askPermission returns null when deadline expires without answer');
});
