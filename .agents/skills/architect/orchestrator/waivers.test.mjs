// Reference tests for T-123 (ADR-073, C-32, Р-10): a WAIVER is read only from the committed PLAN.md and
// covers only its own rule and its own commit; Frozen masks (`dir/**`) protect files in the self-check the
// same way as in mechanics.mjs (matchesFrozenPath). Frozen for T-123.
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
import * as waivers from './waivers.mjs';
import * as selfcheck from './selfcheck.mjs';
import { checkTestMonotonicity } from './monotonicity.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const ENV = { ...process.env, AGENT_LOOP: '' };
const CONFIG = {
  bypassScanPaths: ['src', 'tests'],
  bypassPatterns: DEFAULTS.bypassPatterns,
  bypassRegexps: DEFAULTS.bypassPatterns.map((p) => new RegExp(p)),
  protectedConfigFiles: [],
};
const testFile = (asserts) => 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n'
  + asserts.map((v, i) => `test("t${i}", () => { assert.equal(${v}, ${v}); });\n`).join('');
const planWith = (frozen, decisions = []) => [
  '# PLAN', '', '## Decisions', '- ADR-001: base', ...decisions, '', '## Frozen', '- `EXECUTOR.md`', ...frozen.map((f) => `- \`${f}\``), '',
  '## Tasks', '- [ ] T-001: Feature', '  - Risk: high.', '  - Change: `src/a.js`.', `  - Test cases: \`${frozen[0] ?? 'tests/none.test.mjs'}\`.`, '  - Verify: `npm test`.', '',
].join('\n');

function repo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: ENV }).trim();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const commit = (msg, files, removed = []) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    if (Object.keys(files).length) g('add', '--', ...Object.keys(files));
    if (removed.length) g('rm', '-q', '--', ...removed);
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  return { root, g, write, commit };
}

const frozenViolation = (violations, file) => violations.filter((v) => /touches frozen test/.test(v) && v.includes(file));

test('T-123: parseWaivers lives in waivers.mjs and selfcheck.mjs re-exports it; waiverCovers matches rule and commit', () => {
  assert.equal(selfcheck.parseWaivers, waivers.parseWaivers);
  assert.doesNotMatch(readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8'), /function parseWaivers\(/);
  const [mono, ff] = waivers.parseWaivers('## Decisions\n- WAIVER abc1234: monotonicity — merged tests\n- WAIVER DEF5678: fix-frozen — fixture typo\n');
  assert.equal(mono.rule, 'monotonicity');
  const sha = 'abc1234' + '0'.repeat(33), sha2 = 'def5678' + '1'.repeat(33);
  assert.equal(waivers.waiverCovers(mono, sha, 'monotonicity'), true);
  assert.equal(waivers.waiverCovers(mono, sha, 'fix-frozen'), false, 'a monotonicity WAIVER does not cover fix-frozen');
  assert.equal(waivers.waiverCovers(mono, sha2, 'monotonicity'), false, 'a WAIVER covers only its own commit');
  assert.equal(waivers.waiverCovers(ff, sha2, 'fix-frozen'), true, 'sha7 comparison is case-insensitive');
  assert.equal(waivers.waiverCovers(ff, sha2, 'monotonicity'), false);
  assert.ok(readFileSync(path.join(orchDir, 'waivers.mjs'), 'utf8').split('\n').length <= 400);
});

test('T-123: a Frozen mask protects files; only a committed fix-frozen WAIVER for that commit clears the violation', () => {
  const { root, g, write, commit } = repo('t123-mask-');
  try {
    commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'tests/ref/inv.test.mjs': testFile([1, 2]), 'src/a.js': 'export const a = 1;\n' });
    commit('arch: plan cycle 2', { 'PLAN.md': planWith(['tests/ref/**']) });
    const task = commit('T-001: tweak the frozen test', { 'tests/ref/inv.test.mjs': testFile([1, 2, 3]), 'src/a.js': 'export const a = 2;\n' });
    const file = 'tests/ref/inv.test.mjs';

    const masked = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.equal(frozenViolation(masked.violations, file).length, 1, `a dir/** Frozen mask must protect ${file}: ${masked.violations.join('; ')}`);

    write('PLAN.md', planWith(['tests/ref/**'], [`- WAIVER ${task.slice(0, 7)}: fix-frozen — test fix approved`]));
    const uncommitted = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.equal(frozenViolation(uncommitted.violations, file).length, 1, 'a WAIVER only in the working tree must not apply');
    assert.deepEqual(waivers.readCommittedWaivers({ realGit, cwd: root, config: CONFIG }), []);
    g('checkout', '--', 'PLAN.md');

    commit('arch: waiver for the wrong rule', { 'PLAN.md': planWith(['tests/ref/**'], [`- WAIVER ${task.slice(0, 7)}: monotonicity — wrong rule`]) });
    const wrongRule = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.equal(frozenViolation(wrongRule.violations, file).length, 1, 'a monotonicity WAIVER must not clear a fix-frozen violation');

    commit('arch: waiver fix-frozen', { 'PLAN.md': planWith(['tests/ref/**'], [`- WAIVER ${task.slice(0, 7)}: fix-frozen — test fix approved`]) });
    const waived = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.deepEqual(frozenViolation(waived.violations, file), [], waived.violations.join('; '));
    assert.equal(waivers.readCommittedWaivers({ realGit, cwd: root, config: CONFIG }).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-123: a frozen test outside bypassScanPaths matched by a mask still gets the 0-assertion NOT VERIFIED check', () => {
  const { root, commit } = repo('t123-mask-nv-');
  try {
    commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'src/a.js': 'export const a = 1;\n' });
    commit('arch: plan cycle 2', {
      'PLAN.md': planWith(['checks/**']),
      'checks/empty.test.mjs': 'import { test } from "node:test";\ntest("placeholder", () => {});\n',
    });
    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    assert.ok(sc.notVerified.some((m) => m.includes('checks/empty.test.mjs')), JSON.stringify(sc.notVerified));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-123: a monotonicity WAIVER covers only its commit — a later decrease in the same file is still a violation', () => {
  const { root, commit } = repo('t123-mono-');
  try {
    const baseSha = commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'tests/a.test.mjs': testFile([1, 2, 3]) });
    commit('arch: plan cycle 2', { 'PLAN.md': planWith([]) });
    const consolidate = commit('T-001: consolidate tests', { 'tests/a.test.mjs': testFile([1, 2]) });
    commit('arch: waiver monotonicity', { 'PLAN.md': planWith([], [`- WAIVER ${consolidate.slice(0, 7)}: monotonicity — tests merged`]) });

    const committed = waivers.readCommittedWaivers({ realGit, cwd: root, config: CONFIG });
    const clean = checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits: commitsSince(realGit, root, baseSha), waivers: committed });
    assert.deepEqual(clean, [], 'the waived consolidation itself is allowed');

    commit('T-001 (fix 1): drop another test', { 'tests/a.test.mjs': testFile([1]) });
    const after = checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits: commitsSince(realGit, root, baseSha), waivers: committed });
    assert.deepEqual(after, [
      'monotonicity: in tests/a.test.mjs test/it count decreased from 2 to 1',
      'monotonicity: in tests/a.test.mjs assert count decreased from 2 to 1',
    ], 'counts are compared from the waived commit, not exempted until the end of the cycle');

    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: CONFIG });
    for (const v of after) assert.ok(sc.violations.includes(v), `runSelfCheckGit must report: ${v}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-123: a waived commit that deletes a test file is allowed; a later unwaived deletion is not', () => {
  const { root, commit } = repo('t123-delete-');
  try {
    const baseSha = commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'tests/a.test.mjs': testFile([1, 2]), 'tests/b.test.mjs': testFile([1, 2]) });
    const delA = commit('T-001: remove a', {}, ['tests/a.test.mjs']);
    const touchB = commit('T-001 (fix 1): touch b', { 'tests/b.test.mjs': testFile([1, 2, 3]) });
    commit('T-001 (fix 2): remove b', {}, ['tests/b.test.mjs']);
    const list = waivers.parseWaivers(`## Decisions\n- WAIVER ${delA.slice(0, 7)}: monotonicity — a merged into c\n- WAIVER ${touchB.slice(0, 7)}: monotonicity — b grew\n`);
    const res = checkTestMonotonicity({ realGit, cwd: root, baseSha, config: CONFIG, commits: commitsSince(realGit, root, baseSha), waivers: list });
    assert.deepEqual(res, ['test file deleted without ADR in commit message: tests/b.test.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
