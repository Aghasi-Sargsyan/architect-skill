// Reference tests for T-097 (ADR-064, C-08/C-09/C-10): task commits are no longer exempt from the self-check,
// only the first `arch: plan` commit of each cycle is exempt from fix-frozen, and monotonicity lives in
// monotonicity.mjs so the loop can check it from the task base. Frozen for T-097.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import { commitsSince } from './git.mjs';
import { runSelfCheckGit, parseWaivers } from './selfcheck.mjs';
import { checkTestMonotonicity, countTests, countAsserts, isUnderScanPaths } from './monotonicity.mjs';
import { resolveTaskBase } from './task-range.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const EMPTY_CATCH = 'try { work(); } ' + 'catch ' + '{}';
const BYPASS = ['as', 'any'].join(' ');
const REF_TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => { assert.equal(1, 1); assert.ok(true); });\ntest("b", () => { assert.equal(2, 2); });\n';
const WEAK_REF_TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => { assert.equal(1, 1); assert.ok(1); });\ntest("b", () => { assert.equal(2, 2); });\n';
const PLAN = '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/ref.test.mjs`\n\n## Tasks\n- [ ] T-001: Demo\n  - Risk: high.\n  - Change: `src/a.js`, `tests/a.test.mjs`.\n  - Test cases: `tests/ref.test.mjs`.\n  - Verify: `npm test`.\n';
const CONFIG = {
  bypassScanPaths: ['src', 'tests'],
  bypassPatterns: DEFAULTS.bypassPatterns,
  bypassRegexps: DEFAULTS.bypassPatterns.map((p) => new RegExp(p)),
  protectedConfigFiles: [],
};

function repo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } }).trim();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const commit = (msg, files) => {
    g('add', '--', ...files);
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  write('EXECUTOR.md', 'rules\n');
  write('src/a.js', 'export const a = 1;\n');
  write('tests/a.test.mjs', 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("x", () => { assert.ok(true); });\ntest("y", () => { assert.ok(true); });\n');
  write('PLAN.md', '# PLAN\n');
  commit('arch: close cycle 1', ['EXECUTOR.md', 'src/a.js', 'tests/a.test.mjs', 'PLAN.md']);
  write('PLAN.md', PLAN);
  write('tests/ref.test.mjs', REF_TEST);
  const planSha = commit('arch: plan Cycle 2', ['PLAN.md', 'tests/ref.test.mjs']);
  return { root, g, write, commit, planSha };
}

test('C-08: a task commit that changes a Frozen test is a self-check violation until an owner commit restores it', () => {
  const { root, write, commit } = repo('t097-frozen-');
  try {
    write('tests/ref.test.mjs', WEAK_REF_TEST);
    const bad = commit('T-001: weaken frozen test with the same counts', ['tests/ref.test.mjs']);
    const red = runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.equal(red.ok, false);
    assert.match(red.violations.join('\n'), new RegExp(`task commit ${bad.slice(0, 7)} touches frozen test / config / fixtures and the change is still on HEAD: "T-001: weaken frozen test with the same counts" \\(tests/ref\\.test\\.mjs\\)`));

    write('tests/ref.test.mjs', REF_TEST);
    commit('arch: fix-frozen T-001: restore tests/ref.test.mjs after Executor violation', ['tests/ref.test.mjs']);
    const green = runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.deepEqual(green.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C-08: bypasses and empty catches from task commits are reported while still on HEAD and clear after a rework commit', () => {
  const { root, write, commit } = repo('t097-content-');
  try {
    write('src/a.js', `export const a = 2 ${BYPASS};\n${EMPTY_CATCH}\n`);
    const bad = commit('T-001: add code with issues', ['src/a.js']);
    const text = runSelfCheckGit({ realGit, cwd: root, config: CONFIG }).violations.join('\n');
    assert.match(text, new RegExp(`bypass in src/a\\.js from commit ${bad.slice(0, 7)} still on HEAD`));
    assert.match(text, new RegExp(`empty catch in src/a\\.js from commit ${bad.slice(0, 7)} still on HEAD`));

    write('src/a.js', 'export const a = 2;\n');
    commit('T-001 (fix 1): remove issues', ['src/a.js']);
    assert.deepEqual(runSelfCheckGit({ realGit, cwd: root, config: CONFIG }).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C-09: only the first arch: plan commit of each cycle is exempt from fix-frozen; a second arch: plan commit in the same cycle is not', () => {
  const { root, write, commit } = repo('t097-plan-');
  try {
    write('tests/ref.test.mjs', REF_TEST.replace('assert.ok(true)', 'assert.ok(true); assert.ok(1)'));
    const later = commit('arch: plan extra tasks', ['tests/ref.test.mjs']);
    const res = runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.match(res.violations.join('\n'), new RegExp(`commit ${later.slice(0, 7)} touches frozen test / config / fixtures without arch: fix-frozen: "arch: plan extra tasks" \\(tests/ref\\.test\\.mjs\\)`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C-10: checkTestMonotonicity from the task base catches a test removed from a non-frozen Change file before acceptance', () => {
  const { root, g, write, commit } = repo('t097-mono-');
  try {
    write('src/a.js', 'export const a = 2;\n');
    commit('T-001: change a', ['src/a.js']);
    write('tests/a.test.mjs', 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("x", () => { assert.ok(true); });\n');
    const drop = commit('T-001 (fix 1): drop a test', ['tests/a.test.mjs']);
    const { baseSha } = resolveTaskBase({ realGit, cwd: root, taskId: 'T-001' });
    const commits = commitsSince(realGit, root, baseSha);
    const violations = checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits, waivers: [] });
    assert.deepEqual(violations, [
      'monotonicity: in tests/a.test.mjs test/it count decreased from 2 to 1',
      'monotonicity: in tests/a.test.mjs assert count decreased from 2 to 1',
    ]);

    const fromSelfCheck = runSelfCheckGit({ realGit, cwd: root, config: CONFIG }).violations;
    for (const v of violations) assert.ok(fromSelfCheck.includes(v), `runSelfCheckGit must report the same monotonicity string: ${v}`);

    const waivers = parseWaivers(`## Decisions\n- WAIVER ${drop.slice(0, 7)}: monotonicity — test merged elsewhere\n`);
    assert.deepEqual(checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits, waivers }), []);

    g('rm', '-q', 'tests/a.test.mjs');
    g('commit', '-q', '-m', 'T-001 (fix 2): delete test file');
    const afterDelete = checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits: commitsSince(realGit, root, baseSha), waivers: [] });
    assert.deepEqual(afterDelete, ['test file deleted without ADR in commit message: tests/a.test.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('monotonicity helpers are shared: counts, scan paths, selfcheck.mjs imports them, and both modules stay <= 400 lines', () => {
  assert.equal(countTests('test("a", () => {});\nit("b", () => {});\n', {}), 2);
  assert.equal(countAsserts('assert.ok(1);\nexpect(x).toBe(1);\n', {}), 2);
  assert.equal(isUnderScanPaths('src/a.js', ['src']), true);
  assert.equal(isUnderScanPaths('srcx/a.js', ['src']), false);
  assert.equal(isUnderScanPaths('docs/a.md', []), true);
  const selfcheckSrc = readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8');
  assert.match(selfcheckSrc, /from '\.\/monotonicity\.mjs'/);
  assert.doesNotMatch(selfcheckSrc, /function countByPatterns\(/, 'countByPatterns must live only in monotonicity.mjs');
  for (const mod of ['selfcheck.mjs', 'monotonicity.mjs']) {
    const lines = readFileSync(path.join(orchDir, mod), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${mod} must stay <= 400 lines (got ${lines})`);
  }
});
