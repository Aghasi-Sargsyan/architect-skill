// Reference tests for T-120 (ADR-073, C-34): the red-check counts a reference test as red only after a
// confirmed test-case failure; a failure of the whole file, a missing reporter result or an unconfirmed
// custom runner is NOT VERIFIED and blocks the high-risk task. Frozen for T-120.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { which } from './guards.mjs';
import { parsePlan } from './plan.mjs';
import { DEFAULTS, validateConfig } from './config.mjs';
import * as evidence from './evidence.mjs';
import * as redCheck from './red-check.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const HEAD_IMPORTS = 'import { test, describe, it } from "node:test";\nimport assert from "node:assert/strict";\n';

const FIXTURES = {
  assertion: HEAD_IMPORTS + 'test("invariant", () => { assert.equal(1, 2); });\n',
  stub: HEAD_IMPORTS + 'const stub = () => { throw new Error("Not implemented"); };\ntest("uses stub", () => { stub(); });\n',
  typeError: HEAD_IMPORTS + 'test("wrong setup", () => { const o = {}; o.missing(); });\n',
  topLevelThrow: HEAD_IMPORTS + 'throw new Error("boom at top level");\n',
  exitTopLevel: HEAD_IMPORTS + 'process.exit(1);\n',
  exitInTest: HEAD_IMPORTS + 'test("exits", () => { process.exit(1); });\n',
  suite: HEAD_IMPORTS + 'describe("suite", () => { it("inner", () => { assert.equal(1, 2); }); });\n',
  green: HEAD_IMPORTS + 'test("green", () => { assert.equal(1, 1); });\n',
  missingModule: 'import { missing } from "./no-such-module-t120.mjs";\nconsole.log(missing);\n',
};

function makeRepo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 't120-redcheck-')));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  writeFileSync(path.join(root, 'README.md'), '# Init\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'arch: close cycle 1');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  return { root, g, baseSha: g('rev-parse', 'HEAD') };
}

function planFor(file) {
  return parsePlan([
    '# PLAN', '', '## Frozen', '- `EXECUTOR.md`', `- \`${file}\``, '',
    '## Tasks',
    '- [ ] T-001: Feature',
    '  - Risk: high.',
    '  - Change: `src/a.mjs`.',
    `  - Test cases: \`${file}\`.`,
    `  - Verify: \`node --test ${file}\`.`,
  ].join('\n') + '\n');
}

function check(repo, name, config = {}) {
  const file = `tests/${name}.test.mjs`;
  writeFileSync(path.join(repo.root, file), FIXTURES[name]);
  const res = redCheck.runRedCheck({ realGit, cwd: repo.root, baseSha: repo.baseSha, plan: planFor(file), config, env: { ...process.env, AGENT_LOOP: '' } });
  return { file, res };
}

test('T-120: evidence.mjs re-exports runRedCheck from red-check.mjs; the modules and the reporter exist and stay <= 400 lines', () => {
  assert.equal(typeof redCheck.runRedCheck, 'function');
  assert.equal(evidence.runRedCheck, redCheck.runRedCheck, 'evidence.mjs must re-export the red-check.mjs implementation');
  for (const mod of ['red-check.mjs', 'red-check-reporter.mjs', 'evidence.mjs']) {
    const lines = readFileSync(path.join(orchDir, mod), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${mod} must stay <= 400 lines (got ${lines})`);
  }
  assert.doesNotMatch(readFileSync(path.join(orchDir, 'evidence.mjs'), 'utf8'), /test-reporter/, 'red-check logic must live in red-check.mjs');
});

test('T-120: the reporter prints one ARCHITECT_RED_CHECK line and separates test-case failures from failures of the whole file', () => {
  const repo = makeRepo();
  try {
    const reporter = pathToFileURL(path.join(orchDir, 'red-check-reporter.mjs')).href;
    const run = (name) => {
      const file = path.join(repo.root, 'tests', `${name}.test.mjs`);
      writeFileSync(file, FIXTURES[name]);
      const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
      const out = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', file], { cwd: repo.root, env, encoding: 'utf8' });
      const lines = out.stdout.split('\n').filter((l) => l.startsWith('ARCHITECT_RED_CHECK '));
      assert.equal(lines.length, 1, `exactly one result line for ${name}: ${out.stdout}\n${out.stderr}`);
      return JSON.parse(lines[0].slice('ARCHITECT_RED_CHECK '.length));
    };
    const a = run('assertion');
    assert.equal(a.caseFailures.length, 1);
    assert.equal(a.caseFailures[0].code, 'ERR_ASSERTION');
    assert.equal(a.caseFailures[0].name, 'invariant');
    assert.deepEqual(a.otherFailures, []);

    const s = run('stub');
    assert.equal(s.caseFailures.length, 1);
    assert.match(s.caseFailures[0].message, /Not implemented/);

    const t = run('typeError');
    assert.equal(t.caseFailures[0].errorName, 'TypeError');

    for (const name of ['topLevelThrow', 'exitTopLevel', 'exitInTest', 'missingModule']) {
      const r = run(name);
      assert.deepEqual(r.caseFailures, [], `${name}: a failure of the whole file is not a test-case failure`);
      assert.equal(r.otherFailures.length, 1, `${name}: exactly one other failure`);
    }

    const suite = run('suite');
    assert.equal(suite.caseFailures.length, 1, 'the inner it() failure counts once');
    assert.deepEqual(suite.otherFailures, [], 'the suite aggregate (subtestsFailed) is ignored');

    const green = run('green');
    assert.deepEqual(green, { caseFailures: [], otherFailures: [] });
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('T-120: default runner — assertion, stub and other errors inside a test case are red; only a non-assertion error adds NOT VERIFIED', () => {
  const repo = makeRepo();
  try {
    const a = check(repo, 'assertion');
    assert.equal(a.res.ok, true, a.res.violations.join('; '));
    assert.equal(a.res.checked.length, 1);
    assert.equal(a.res.checked[0].status, 'red');
    assert.equal(a.res.checked[0].failure, 'assertion');
    assert.equal(a.res.notVerified.some((m) => m.includes(a.file)), false);

    const s = check(repo, 'stub');
    assert.equal(s.res.ok, true, s.res.violations.join('; '));
    assert.equal(s.res.checked[0].failure, 'not-implemented');
    assert.equal(s.res.notVerified.some((m) => m.includes(s.file)), false, 'a Not implemented stub is the sanctioned red');

    const t = check(repo, 'typeError');
    assert.equal(t.res.ok, true, t.res.violations.join('; '));
    assert.equal(t.res.checked[0].failure, 'error');
    assert.ok(t.res.notVerified.some((m) => m.includes(t.file) && m.includes('TypeError') && /NOT VERIFIED/.test(m)), JSON.stringify(t.res.notVerified));

    const suite = check(repo, 'suite');
    assert.equal(suite.res.ok, true, suite.res.violations.join('; '));
    assert.equal(suite.res.checked[0].failure, 'assertion');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('T-120: default runner — a failure of the whole file is not red: violation plus NOT VERIFIED naming the file', () => {
  const repo = makeRepo();
  try {
    for (const name of ['topLevelThrow', 'exitTopLevel', 'exitInTest']) {
      const { file, res } = check(repo, name);
      assert.equal(res.ok, false, `${name} must block the high-risk task`);
      assert.deepEqual(res.checked, [], `${name} must not be reported as red`);
      assert.ok(res.violations.some((v) => v.includes(file) && /red not confirmed/.test(v)), `${name}: ${res.violations.join('; ')}`);
      assert.ok(res.notVerified.some((m) => m.includes(file) && /NOT VERIFIED/.test(m)), `${name}: ${res.notVerified.join('; ')}`);
    }

    const missing = check(repo, 'missingModule');
    assert.equal(missing.res.ok, false);
    assert.deepEqual(missing.res.checked, []);
    assert.ok(missing.res.violations.some((v) => v.includes(missing.file) && /ERR_MODULE_NOT_FOUND/.test(v)), missing.res.violations.join('; '));

    const green = check(repo, 'green');
    assert.equal(green.res.ok, false);
    assert.ok(green.res.violations.some((v) => v.includes(green.file) && /expected red/.test(v)), green.res.violations.join('; '));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('T-120: a custom redCheckCommand is red only when redCheckConfirmPattern matches its output', () => {
  const repo = makeRepo();
  try {
    const custom = { redCheckCommand: 'node --test --test-reporter=tap {file}' };

    const unset = check(repo, 'assertion', custom);
    assert.equal(unset.res.ok, false, 'a custom runner without redCheckConfirmPattern cannot confirm red');
    assert.deepEqual(unset.res.checked, []);
    assert.ok(unset.res.violations.some((v) => v.includes(unset.file) && /redCheckConfirmPattern is not configured/.test(v)), unset.res.violations.join('; '));
    assert.ok(unset.res.notVerified.some((m) => m.includes(unset.file)));

    const matched = check(repo, 'assertion', { ...custom, redCheckConfirmPattern: 'ERR_ASSERTION' });
    assert.equal(matched.res.ok, true, matched.res.violations.join('; '));
    assert.equal(matched.res.checked[0].status, 'red');
    assert.equal(matched.res.checked[0].failure, 'pattern');

    const mismatch = check(repo, 'assertion', { ...custom, redCheckConfirmPattern: 'NO_SUCH_MARKER_T120' });
    assert.equal(mismatch.res.ok, false);
    assert.ok(mismatch.res.violations.some((v) => v.includes(mismatch.file) && /does not match redCheckConfirmPattern/.test(v)), mismatch.res.violations.join('; '));

    const crash = check(repo, 'topLevelThrow', { ...custom, redCheckConfirmPattern: 'ERR_ASSERTION' });
    assert.equal(crash.res.ok, false, 'the pattern must match: a crash of the whole file has no ERR_ASSERTION');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('T-120: redCheckConfirmPattern is a known config field: string, valid RegExp, default empty', () => {
  assert.equal(DEFAULTS.redCheckConfirmPattern, '');
  assert.deepEqual(validateConfig({ ...DEFAULTS, redCheckConfirmPattern: 'FAILED .*::' }).filter((p) => /redCheckConfirmPattern/.test(p)), []);
  assert.match(validateConfig({ ...DEFAULTS, redCheckConfirmPattern: 5 }).join('\n'), /redCheckConfirmPattern/);
  assert.match(validateConfig({ ...DEFAULTS, redCheckConfirmPattern: '(' }).join('\n'), /redCheckConfirmPattern/);
});
