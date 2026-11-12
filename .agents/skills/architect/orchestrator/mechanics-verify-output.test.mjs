// Reference tests for T-110 (C-24): a Verify command with a lot of output is not a timeout; overflow and timeout differ.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, validateConfig } from './config.mjs';
import { runTaskVerification } from './mechanics.mjs';

let work;
beforeEach(() => { work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-verify-out-'))); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const cfg = { allowedCommands: ['node'], blockedScripts: [] };
const verify = (file, extra = {}) => runTaskVerification({ task: { id: 'T-001', verifyCommands: [`node ${file}`] }, workDir: work, env: process.env, config: cfg, ...extra });

test('T-110: 3 MiB of output on a passing command is a pass, not a timeout', () => {
  writeFileSync(path.join(work, 'big-ok.mjs'), "process.stdout.write('x'.repeat(3 * 1024 * 1024));\n");
  const res = verify('big-ok.mjs', { timeoutMs: 60000 });
  assert.equal(res.kind, 'passed', JSON.stringify(res).slice(0, 300));
  assert.equal(res.ok, true);
});

test('T-110: 3 MiB of output on a failing command is a failure with the exit code and a bounded output tail', () => {
  writeFileSync(path.join(work, 'big-fail.mjs'), "process.stdout.write('y'.repeat(3 * 1024 * 1024) + '\\nTAIL_MARKER\\n');\nprocess.exit(3);\n");
  const res = verify('big-fail.mjs', { timeoutMs: 60000 });
  assert.equal(res.kind, 'failed');
  assert.equal(res.exitCode, 3);
  assert.equal(res.timedOut, false);
  assert.match(res.outputTail, /TAIL_MARKER/);
  assert.ok(res.outputTail.length <= 4000, 'the tail stays bounded');
});

test('T-110: a real timeout is kind "timeout" with timedOut true and environment: true (a stop, not a rework)', () => {
  writeFileSync(path.join(work, 'hang.mjs'), 'setTimeout(() => {}, 30000);\n');
  const res = verify('hang.mjs', { timeoutMs: 300 });
  assert.equal(res.kind, 'timeout');
  assert.equal(res.timedOut, true);
  assert.equal(res.environment, true);
});

test('T-110: failed and passed results never carry environment: true', () => {
  writeFileSync(path.join(work, 'bad.mjs'), 'process.exit(1);\n');
  assert.notEqual(verify('bad.mjs', { timeoutMs: 60000 }).environment, true);
  writeFileSync(path.join(work, 'good.mjs'), 'process.exit(0);\n');
  assert.notEqual(verify('good.mjs', { timeoutMs: 60000 }).environment, true);
});

test('T-110: the default Verify timeout is 600000 ms and stays a valid config value', () => {
  assert.equal(DEFAULTS.verifyTimeoutMs, 600000);
  assert.deepEqual(validateConfig(DEFAULTS), []);
});
