// Reference tests for task-range.mjs (ADR-064, C-07/C-08/C-11/C-12). Frozen for T-095.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import { commitsSince } from './git.mjs';
import { taskSubjectRe, resolveTaskBase, findTaskDirtyFiles, checkTaskRange, formatRangeSummary } from './task-range.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const KEEP = ['GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const ENV = { ...process.env, AGENT_LOOP: '', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
for (const k of Object.keys(ENV)) if (k.startsWith('GIT_') && !KEEP.includes(k)) delete ENV[k];

const BYPASS = ['as', 'any'].join(' ');
const PATTERNS = DEFAULTS.bypassPatterns.map((p) => new RegExp(p));
const FROZEN = ['EXECUTOR.md', 'tests/ref.test.ts'];
const SCAN = ['src', 'tests'];
const TASK = { id: 'T-007', title: 't', done: false, risk: 'medium', dependsOn: [], change: ['src/a.ts', 'tests/a.test.ts', 'package.json'] };
const PLAN = '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/ref.test.ts`\n\n## Tasks\n\n- [ ] T-007: t\n  - Risk: medium.\n  - Change: `src/a.ts`, `tests/a.test.ts`, `package.json`.\n';

let dir;
let planSha;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const commit = (msg, files = []) => {
  if (files.length) g('add', '--', ...files);
  g('commit', '-q', '-m', msg);
  return g('rev-parse', 'HEAD');
};
const s7 = (sha) => sha.slice(0, 7);
const check = (task = TASK, extra = {}) => {
  const { baseSha } = resolveTaskBase({ realGit, cwd: dir, taskId: task.id });
  return checkTaskRange({
    realGit, cwd: dir, task, baseSha, frozen: FROZEN, scanPaths: SCAN, bypassPatterns: PATTERNS,
    protectedConfigFiles: ['package.json'], orchestratorDir: orchDir, ...extra,
  });
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-task-range-'));
  g('init', '-q', '-b', 'master');
  write('EXECUTOR.md', 'rules\n');
  write('PLAN.md', '# PLAN\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('tests/ref.test.ts', 'ref one\nref two\n');
  write('package.json', '{}\n');
  commit('init', ['.']);
  write('PLAN.md', PLAN);
  planSha = commit('arch: plan T-007', ['PLAN.md']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('taskSubjectRe matches only commits of the given task', () => {
  const re = taskSubjectRe('T-007');
  assert.ok(re.test('T-007: add a'));
  assert.ok(re.test('T-007 (fix 2): fix a'));
  assert.equal(re.test('T-0071: other task'), false);
  assert.equal(re.test('T-007 add a'), false);
  assert.equal(re.test('arch: accept T-007'), false);
  assert.equal(re.test('T-008: other'), false);
});

test('resolveTaskBase: no task commits → HEAD; otherwise the parent of the first task commit, stable across arch: commits and an arch: HEAD (C-07, C-08)', () => {
  const none = resolveTaskBase({ realGit, cwd: dir, taskId: 'T-007' });
  assert.deepEqual(none, { baseSha: planSha, firstTaskSha: null });

  write('src/a.ts', 'export const a = 2;\n');
  const first = commit('T-007: first attempt', ['src/a.ts']);
  write('PLAN.md', `${PLAN}  - note\n`);
  commit('arch: note after stop', ['PLAN.md']);
  write('src/a.ts', 'export const a = 3;\n');
  commit('T-007 (fix 1): second attempt', ['src/a.ts']);
  const mid = resolveTaskBase({ realGit, cwd: dir, taskId: 'T-007' });
  assert.deepEqual(mid, { baseSha: planSha, firstTaskSha: first });

  write('PLAN.md', `${PLAN}  - note\n  - note 2\n`);
  commit('arch: another note on HEAD', ['PLAN.md']);
  assert.deepEqual(resolveTaskBase({ realGit, cwd: dir, taskId: 'T-007' }), mid, 'an arch: commit on HEAD must not empty the range');
});

test('resolveTaskBase fails closed when the first task commit is a root commit', () => {
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-task-range-root-'));
  g('init', '-q', '-b', 'master');
  write('src/a.ts', 'x\n');
  commit('T-007: root commit', ['src/a.ts']);
  assert.throws(() => resolveTaskBase({ realGit, cwd: dir, taskId: 'T-007' }), /has no parent/);
});

test('C-07: a Frozen violation in an earlier task commit stays visible after a clean restart commit', () => {
  write('tests/ref.test.ts', 'ref one\nweakened\n');
  write('src/a.ts', 'export const a = 2;\n');
  const a = commit('T-007: weaken frozen test', ['tests/ref.test.ts', 'src/a.ts']);
  write('src/a.ts', 'export const a = 3;\n');
  const b = commit('T-007 (fix 1): clean change after restart', ['src/a.ts']);

  const res = check();
  assert.equal(res.ok, false);
  assert.match(res.violations.join('\n'), new RegExp(`${s7(a)} touches Frozen — touched Frozen: tests/ref\\.test\\.ts`));
  assert.deepEqual(res.taskCommits.map((c) => c.sha), [a, b]);
  assert.deepEqual(res.dirtyFiles, ['src/a.ts', 'tests/ref.test.ts']);
  assert.equal(res.baseSha, planSha);
  assert.equal(res.headSha, b);
});

test('recovery: an arch: fix-frozen commit that restores the file takes ownership; a later task touch is a violation again', () => {
  write('tests/ref.test.ts', 'ref one\nweakened\n');
  commit('T-007: weaken frozen test', ['tests/ref.test.ts']);
  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007 (fix 1): real change', ['src/a.ts']);
  assert.equal(check().ok, false);

  write('tests/ref.test.ts', 'ref one\nref two\n');
  const owner = commit('arch: fix-frozen T-007: restore tests/ref.test.ts after Executor violation', ['tests/ref.test.ts']);
  const restored = check();
  assert.deepEqual(restored.violations, []);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.ownerCommits.map((c) => c.sha), [owner]);

  write('tests/ref.test.ts', 'ref one\nweakened again\n');
  const again = commit('T-007 (fix 2): touch frozen again', ['tests/ref.test.ts']);
  assert.match(check().violations.join('\n'), new RegExp(`${s7(again)} touches Frozen — touched Frozen: tests/ref\\.test\\.ts`));
});

test('recovery: the Executor removes a bypass in a rework commit — the range turns green and the file is reported as scanned', () => {
  write('src/a.ts', `export const a = 2 ${BYPASS};\n`);
  commit('T-007: add with bypass', ['src/a.ts']);
  const red = check();
  assert.equal(red.ok, false);
  assert.match(red.violations.join('\n'), /check bypassing in task range \(check bypass\): src\/a\.ts: /);

  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007 (fix 1): remove bypass', ['src/a.ts']);
  const green = check();
  assert.deepEqual(green.violations, []);
  assert.deepEqual(green.scannedFiles, ['src/a.ts']);
});

test('outside Change: a modified or deleted file is a violation; restoring it to the base content in a later task commit clears it', () => {
  write('src/b.ts', 'export const b = 2;\n');
  const bad = commit('T-007: edit file outside Change', ['src/b.ts']);
  assert.match(check().violations.join('\n'), new RegExp(`${s7(bad)} touches file outside Change list — outside task "Change" list: src/b\\.ts`));

  write('src/b.ts', 'export const b = 1;\n');
  commit('T-007 (fix 1): restore src/b.ts', ['src/b.ts']);
  assert.deepEqual(check().violations, []);

  g('rm', '-q', 'src/b.ts');
  commit('T-007 (fix 2): delete src/b.ts');
  assert.match(check().violations.join('\n'), /outside task "Change" list: src\/b\.ts/);
});

test('R-7: PLAN.md in a task commit is a violation even when PLAN.md is listed in Change', () => {
  const task = { ...TASK, change: [...TASK.change, 'PLAN.md'] };
  write('PLAN.md', `${PLAN}  - tampered\n`);
  const bad = commit('T-007: tamper with plan', ['PLAN.md']);
  const res = check(task);
  assert.match(res.violations.join('\n'), new RegExp(`${s7(bad)} modifies PLAN\\.md: task commits must not modify PLAN\\.md`));
  assert.doesNotMatch(res.violations.join('\n'), /outside task "Change" list: PLAN\.md/, 'one violation per file: PLAN.md rule wins');
});

test('foreign commits, zero task commits, always-frozen files and protected configs', () => {
  assert.match(check().violations.join('\n'), new RegExp(`no task commits found for T-007 in task range ${s7(planSha)}\\.\\.${s7(planSha)}`));

  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007: ok', ['src/a.ts']);
  write('src/a.ts', 'export const a = 3;\n');
  const wip = commit('wip by hand', ['src/a.ts']);
  assert.match(check().violations.join('\n'), new RegExp(`foreign commit ${s7(wip)} in task range: "wip by hand" is neither T-007 nor arch:`));

  write('EXECUTOR.md', 'changed rules\n');
  write('package.json', '{ "x": 1 }\n');
  commit('T-007 (fix 1): touch executor rules and config', ['EXECUTOR.md', 'package.json']);
  const text = check().violations.join('\n');
  assert.match(text, /touched Frozen: EXECUTOR\.md/);
  assert.match(text, /touches verification config outside high-risk task: package\.json/);
  assert.doesNotMatch(check({ ...TASK, risk: 'high' }).violations.join('\n'), /verification config/, 'high-risk tasks may change protected configs listed in Change');
});

test('findTaskDirtyFiles attributes each file to its newest owner commit (sorted, net-diff based)', () => {
  const isTask = (c) => /^T-\d+(?: \(fix \d+\))?: /.test(c.subject);
  write('src/a.ts', 'export const a = 2;\n');
  write('src/b.ts', 'export const b = 2;\n');
  const c1 = commit('T-001: touch a and b', ['src/a.ts', 'src/b.ts']);
  write('src/b.ts', 'export const b = 3;\n');
  const c2 = commit('arch: fix-frozen T-001: own b', ['src/b.ts']);
  write('tests/a.test.ts', 'tmp\n');
  commit('T-002: add temp test', ['tests/a.test.ts']);
  g('rm', '-q', 'tests/a.test.ts');
  commit('T-002 (fix 1): drop temp test');

  const view = () => findTaskDirtyFiles({ realGit, cwd: dir, baseSha: planSha, commits: commitsSince(realGit, dir, planSha), isTaskCommit: isTask })
    .map((d) => [d.file, d.refSha, d.lastTaskCommit.sha, d.lastTaskCommit.subject]);
  assert.deepEqual(view(), [['src/a.ts', planSha, c1, 'T-001: touch a and b']]);

  write('src/b.ts', 'export const b = 4;\n');
  const c5 = commit('T-001 (fix 1): touch b again', ['src/b.ts']);
  assert.deepEqual(view(), [
    ['src/a.ts', planSha, c1, 'T-001: touch a and b'],
    ['src/b.ts', c2, c5, 'T-001 (fix 1): touch b again'],
  ]);
});

test('C-12: formatRangeSummary names the range and never claims a scan that did not happen', () => {
  write('src/a.ts', 'export const a = 2;\n');
  const a = commit('T-007: change a', ['src/a.ts']);
  write('PLAN.md', `${PLAN}  - note\n`);
  const o = commit('arch: note', ['PLAN.md']);
  write('tests/a.test.ts', 'new test\n');
  const b = commit('T-007 (fix 1): add test', ['tests/a.test.ts']);
  const res = check();
  assert.deepEqual(res.violations, []);
  const head = `task range ${s7(planSha)}..${s7(b)}: commits ${s7(a)} "T-007: change a", ${s7(b)} "T-007 (fix 1): add test" (owner commits: ${s7(o)} "arch: note"); files only from Change; Frozen untouched; `;
  assert.equal(formatRangeSummary(res, { scanPaths: SCAN, bypassPatterns: PATTERNS }), `${head}no check bypasses (config bypassPatterns) in src/a.ts tests/a.test.ts; clean tree`);
  assert.equal(formatRangeSummary(res, { scanPaths: [], bypassPatterns: PATTERNS }), `${head}automatic check bypass scan disabled in config — verify manually; clean tree`);

  const docsOnly = check(TASK, { scanPaths: ['scripts'] });
  assert.deepEqual(docsOnly.scannedFiles, []);
  assert.equal(formatRangeSummary(docsOnly, { scanPaths: ['scripts'], bypassPatterns: PATTERNS }), `${head}bypass scan skipped: no changed task files under scripts; clean tree`);
});

test('checkTaskRange is read-only, rejects headRef other than HEAD, and task-range.mjs stays <= 400 lines', () => {
  write('src/a.ts', 'export const a = 2;\n');
  commit('T-007: change a', ['src/a.ts']);
  const before = [g('rev-parse', 'HEAD'), g('status', '--porcelain'), readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8')];
  check();
  assert.deepEqual([g('rev-parse', 'HEAD'), g('status', '--porcelain'), readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8')], before);
  assert.throws(() => check(TASK, { headRef: 'HEAD~1' }), /supports only headRef "HEAD"/);
  const lines = readFileSync(path.join(orchDir, 'task-range.mjs'), 'utf8').split('\n').length;
  assert.ok(lines <= 400, `task-range.mjs must stay <= 400 lines (got ${lines})`);
});
