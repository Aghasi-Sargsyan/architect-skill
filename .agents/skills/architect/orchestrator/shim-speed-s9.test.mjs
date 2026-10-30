import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as guardsMod from './guards.mjs';
import { findExecutable } from './events.mjs';
import { askPermission, writeAnswer } from './ask.mjs';
import { watch, follow } from './feed.mjs';

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

  // 1. Env vars speed up watch and follow when explicit pollMs/graceMs are omitted
  process.env.AGENT_LOOP_WATCH_POLL_MS = '15';
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '25';
  const w0 = performance.now();
  const wRes = await watch({ workDir, minutes: 1 });
  const wElapsed = performance.now() - w0;
  assert.equal(wRes.code, 3);
  assert.ok(wElapsed < 1000, `watch with AGENT_LOOP_WATCH_GRACE_MS=25 should finish in < 1000ms, took ${wElapsed.toFixed(1)}ms`);

  process.env.AGENT_LOOP_FOLLOW_POLL_MS = '15';
  process.env.AGENT_LOOP_FOLLOW_GRACE_MS = '25';
  const printed = [];
  const f0 = performance.now();
  await follow({ workDir, print: (l) => printed.push(l) });
  const fElapsed = performance.now() - f0;
  assert.ok(printed.some((l) => l.includes('line 1')));
  assert.ok(fElapsed < 1000, `follow with AGENT_LOOP_FOLLOW_GRACE_MS=25 should finish in < 1000ms, took ${fElapsed.toFixed(1)}ms`);

  // 2. Explicit parameter takes precedence over AGENT_LOOP_* env var
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '10';
  const e0 = performance.now();
  await watch({ workDir, minutes: 1, pollMs: 15, graceMs: 120 });
  const eElapsed = performance.now() - e0;
  assert.ok(eElapsed >= 100, `explicit graceMs=120 must override AGENT_LOOP_WATCH_GRACE_MS=10, took ${eElapsed.toFixed(1)}ms`);

  // 3. Invalid env var (< 10ms or non-numeric) is ignored and falls back to default (2000ms)
  process.env.AGENT_LOOP_WATCH_GRACE_MS = '5';
  const i0 = performance.now();
  const iRes = await watch({ workDir, minutes: 0.001, pollMs: 15 }); // deadline = 60ms < default graceMs 2000ms
  const iElapsed = performance.now() - i0;
  assert.equal(iRes.code, 0, 'invalid AGENT_LOOP_WATCH_GRACE_MS=5 (< 10) must be ignored so graceMs falls back to 2000ms and 60ms window expires with code 0');
  assert.ok(iElapsed < 400);

  // 4. askPermission uses AGENT_LOOP_ASK_POLL_MS when pollMs is omitted
  process.env.AGENT_LOOP_ASK_POLL_MS = '15';
  const question = {
    id: 'q-1',
    who: 'Executor',
    taskId: 'T-041',
    command: 'npm run lint',
    options: [{ answer: '2', label: 'once', rule: 'npm run lint' }],
  };
  const a0 = performance.now();
  setTimeout(() => {
    writeAnswer({ workDir, answer: '2' });
  }, 30);
  const ans = await askPermission({ question, workDir, runDir, tty: false, timeoutMs: 2000, log: () => {} });
  const aElapsed = performance.now() - a0;
  assert.equal(ans, '2');
  assert.ok(aElapsed < 1000, `askPermission with AGENT_LOOP_ASK_POLL_MS=15 should resolve in < 1000ms, took ${aElapsed.toFixed(1)}ms`);
});
