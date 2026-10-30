import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExecutorRun, checkArchitectRun, findBypasses } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';
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

test('architect review: accepted needs [x] and an arch: commit; non-arch commits and a missing task are violations', () => {
  const b = base();
  const ok = () => checkArchitectRun({ realGit, cwd: dir, base: b, task: TASK, verdict: 'accepted', plan: parsePlan(plan('x')) });
  assert.match(ok().violations.join('\n'), /(?:нет коммита приёмки|no acceptance commit) \(arch:\)/);
  write('PLAN.md', plan('x'));
  commit('arch: приёмка T-007', ['PLAN.md']);
  assert.deepEqual(ok().violations, []);
  const notMarked = checkArchitectRun({ realGit, cwd: dir, base: b, task: TASK, verdict: 'accepted', plan: parsePlan(plan(' ')) });
  assert.match(notMarked.violations.join('\n'), /(?:не отмечена|not marked) \[x\]/);
  const closed = checkArchitectRun({ realGit, cwd: dir, base: b, task: TASK, verdict: 'accepted', plan: parsePlan('# PLAN\n\n## Задачи\n') });
  assert.match(closed.violations.join('\n'), /(?:пропала из|disappeared from) PLAN\.md/);
  write('src/a.ts', 'arch edit\n');
  commit('T-007: sneaky', ['src/a.ts']);
  assert.match(ok().violations.join('\n'), /(?:не-arch коммит|non-arch commit)/);
});

test('rework verdict without commits is not a violation', () => {
  const b = base();
  const r = checkArchitectRun({ realGit, cwd: dir, base: b, task: TASK, verdict: 'rework', plan: parsePlan(plan(' ')) });
  assert.deepEqual(r.violations, []);
});
