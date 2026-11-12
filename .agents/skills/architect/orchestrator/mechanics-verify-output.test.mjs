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

const cfg = { allowedCommands: ['node --test'], blockedScripts: [] };
// Verify commands may only be `node --test <file>`: the heavy output is printed from inside a test file.
const verify = (file, extra = {}) => runTaskVerification({ task: { id: 'T-001', verifyCommands: [`node --test ${file}`] }, workDir: work, env: process.env, config: cfg, ...extra });
const testFile = (name, body) => writeFileSync(path.join(work, name), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('t', async () => {\n${body}\n});\n`);

test('T-110: 3 MiB of output on a passing command is a pass, not a timeout', () => {
  testFile('big-ok.test.mjs', "process.stdout.write('x'.repeat(3 * 1024 * 1024) + '\\n'); assert.ok(true);");
  const res = verify('big-ok.test.mjs', { timeoutMs: 120000 });
  assert.equal(res.kind, 'passed', JSON.stringify(res).slice(0, 300));
  assert.equal(res.ok, true);
});

test('T-110: 3 MiB of output on a failing command is a failure with the exit code and a bounded output tail', () => {
  testFile('big-fail.test.mjs', "process.stdout.write('y'.repeat(3 * 1024 * 1024) + '\\n'); assert.fail('TAIL_MARKER');");
  const res = verify('big-fail.test.mjs', { timeoutMs: 120000 });
  assert.equal(res.kind, 'failed');
  assert.equal(res.exitCode, 1);
  assert.equal(res.timedOut, false);
  assert.match(res.outputTail, /TAIL_MARKER/);
  assert.ok(res.outputTail.length <= 4000, 'the tail stays bounded');
});

test('T-110: a real timeout is kind "timeout" with timedOut true and environment: true (a stop, not a rework)', () => {
  testFile('hang.test.mjs', "await new Promise((resolve) => setTimeout(resolve, 3000));");
  const res = verify('hang.test.mjs', { timeoutMs: 300 });
  assert.equal(res.kind, 'timeout');
  assert.equal(res.timedOut, true);
  assert.equal(res.environment, true);
});

test('T-110: failed and passed results never carry environment: true', () => {
  testFile('bad.test.mjs', 'assert.fail("x");');
  assert.notEqual(verify('bad.test.mjs', { timeoutMs: 120000 }).environment, true);
  testFile('good.test.mjs', 'assert.ok(true);');
  assert.notEqual(verify('good.test.mjs', { timeoutMs: 120000 }).environment, true);
});

test('T-110: the default Verify timeout is 600000 ms and stays a valid config value', () => {
  assert.equal(DEFAULTS.verifyTimeoutMs, 600000);
  assert.deepEqual(validateConfig(DEFAULTS), []);
});
