import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExecutorRun, checkArchitectRun, findBypasses } from './mechanics.mjs';
import { DEFAULTS } from './config.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
for (const k of Object.keys(ENV)) if (k.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(k)) delete ENV[k];

let dir;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const commit = (msg, files) => {
  g('add', ...files);
  g('commit', '-q', '-m', msg);
};

const TASK = { id: 'T-007', title: 't', done: false, risk: 'средний', dependsOn: [], change: ['src/a.ts', 'tests/a.test.ts'] };
const FROZEN = ['EXECUTOR.md', 'tests/ref.test.ts'];
const SCAN = ['src', 'scripts', 'tests'];
const TS_PATTERNS = DEFAULTS.bypassPatterns.map((p) => new RegExp(p));
const TS_ONLY_PATTERNS = DEFAULTS.bypassPatterns.slice(0, 6).map((p) => new RegExp(p));
const plan = (mark) => `# PLAN\n\n## Frozen\n- \`EXECUTOR.md\`\n\n## Задачи\n\n- [${mark}] T-007: t\n  - Риск: средний.\n  - Менять:\n    - \`src/a.ts\`\n`;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-mech-'));
  g('init', '-q', '-b', 'master');
  write('src/a.ts', 'export const a = 1;\n');
  write('EXECUTOR.md', 'rules\n');
  write('PLAN.md', plan(' '));
  write('tests/ref.test.ts', 'ref\n');
  commit('init', ['.']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => g('rev-parse', 'HEAD');
const run = (b, bypassPatterns = TS_PATTERNS) => checkExecutorRun({ realGit, cwd: dir, base: b, task: TASK, frozen: FROZEN, scanPaths: SCAN, bypassPatterns });

test('clean task commit passes', () => {
  const b = base();
  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007: change a', ['src/a.ts']);
  assert.deepEqual(run(b).violations, []);
});

test('fix commits are accepted alongside the primary commit', () => {
  const b = base();
  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007: change a', ['src/a.ts']);
  write('tests/a.test.ts', 'ok\n');
  commit('T-007 (fix 1): add test', ['tests/a.test.ts']);
  assert.deepEqual(run(b).violations, []);
});

test('no commit, foreign subject, file outside «Менять», Frozen and dirty tree are violations', () => {
  const b = base();
  assert.match(run(b).violations.join('\n'), /нет ни одного коммита|no task commits found/);
  write('src/other.ts', 'x\n');
  write('tests/ref.test.ts', 'changed\n');
  commit('feat: something', ['src/other.ts', 'tests/ref.test.ts']);
  write('src/a.ts', 'dirty\n');
  const v = run(b).violations.join('\n');
  assert.match(v, /(?:чужой коммит|foreign commit) .*feat: something/);
  assert.match(v, /(?:вне «Менять»|outside Change[^:]*): src\/other\.ts/);
  assert.match(v, /Frozen: tests\/ref\.test\.ts/);
  assert.match(v, /не чистое|not clean/);
});

test('bypasses are caught only inside scan paths', () => {
  const b = base();
  write('src/a.ts', 'export const a: any = 1; // @ts-ignore\n');
  write('PLAN.md', `${plan(' ')}\nтекст с as unknown as и .only( в правилах\n`);
  commit('T-007: bypass', ['src/a.ts', 'PLAN.md']);
  const v = run(b).violations;
  assert.ok(v.some((x) => /^(?:обход проверок|check bypass)/.test(x) && x.includes(': any')), v.join('\n'));
  assert.ok(!v.some((x) => x.includes('as unknown as')), 'PLAN.md is outside scan paths');
  assert.ok(!run(b, []).violations.some((x) => /^(?:обход проверок|check bypass)/.test(x)), 'bypassPatterns: [] turns the check off');
});

test('findBypasses: only added lines, without the leading «+», file headers skipped; custom stacks work', () => {
  const diff = [
    'diff --git a/src/only(.py b/src/only(.py',
    '--- a/src/only(.py',
    '+++ b/src/only(.py',
    '@@ -1 +1,3 @@',
    '-x = cast(int, y)  # removed lines do not count',
    '+x = cast(int, y)',
    '+import os  # noqa: F401',
    '+anyway = 1',
  ].join('\n');
  const python = ['\\bcast\\(', '#\\s*noqa', '^\\+'].map((p) => new RegExp(p));
  assert.deepEqual(findBypasses(diff, python), ['x = cast(int, y)', 'import os  # noqa: F401'], 'the leading «+» is stripped before matching');
  assert.deepEqual(findBypasses(diff, [new RegExp('only\\(')]), [], '«+++ b/…» header is not an added line');
  assert.deepEqual(findBypasses(diff, TS_ONLY_PATTERNS), []);
  assert.deepEqual(findBypasses(diff, TS_PATTERNS), ['import os  # noqa: F401']);
  assert.deepEqual(findBypasses(diff, []), []);
});

// ADR-061 R-2 / ADR-064: in the automated loop the Architect review is read-only; the orchestrator commits acceptance.
test('architect review is read-only: a moved HEAD or a dirty tree is a violation, an untouched repository is not', () => {
  const expectedHead = base();
  const ok = () => checkArchitectRun({ realGit, cwd: dir, expectedHead });
  assert.deepEqual(ok().violations, []);
  write('PLAN.md', plan('x'));
  assert.match(ok().violations.join('\n'), /working tree is not clean after review/);
  commit('arch: приёмка T-007', ['PLAN.md']);
  const moved = ok();
  assert.match(moved.violations.join('\n'), new RegExp(`Architect review changed HEAD \\(read-only in the automated loop\\): ${expectedHead.slice(0, 7)} → [0-9a-f]{7}`));
  assert.equal(moved.violations.length, 1);
});

test('amending the Executor commit during review is caught as a moved HEAD (C-09)', () => {
  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007: change a', ['src/a.ts']);
  const expectedHead = base();
  g('commit', '--amend', '-q', '-m', 'arch: accept T-007');
  const r = checkArchitectRun({ realGit, cwd: dir, expectedHead });
  assert.match(r.violations.join('\n'), /Architect review changed HEAD/);
  assert.equal(r.violations.length, 1);
});
