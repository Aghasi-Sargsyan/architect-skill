// Reference tests for accept.mjs (ADR-061 R-2, ADR-064, C-09). Frozen for T-098.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markTaskDone, acceptanceSubject, commitAcceptance } from './accept.mjs';
import { generateCommitMsgHookScript, validateCommitMessage } from './hooks.mjs';
import { parsePlan } from './plan.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const KEEP = ['GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const ENV = { ...process.env, AGENT_LOOP: '', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
for (const k of Object.keys(ENV)) if (k.startsWith('GIT_') && !KEEP.includes(k)) delete ENV[k];

const PLAN = '# PLAN\n\n## Tasks\n\n- [x] T-001: done before\n- [ ] T-002: accept me\n  - Risk: low.\n  - Change: `src/a.js`.\n  - [ ] T-002: an indented mention is not a task line\n- [ ] T-0021: similar id\n';

let dir;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const read = (rel) => readFileSync(path.join(dir, rel), 'utf8');
const useHook = (script) => {
  write('.gitignore', 'hooks-under-test/\n');
  g('add', '.gitignore');
  g('commit', '-q', '-m', 'arch: ignore test hooks dir');
  const hooksDir = path.join(dir, 'hooks-under-test');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path.join(hooksDir, 'commit-msg'), script);
  chmodSync(path.join(hooksDir, 'commit-msg'), 0o755);
  g('config', 'core.hooksPath', hooksDir);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-accept-'));
  g('init', '-q', '-b', 'master');
  write('PLAN.md', PLAN);
  write('src/a.js', 'export const a = 2;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'T-002: implement a');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('markTaskDone switches exactly one column-0 open task line and preserves every other byte', () => {
  const out = markTaskDone(PLAN, 'T-002');
  assert.equal(out, PLAN.replace('- [ ] T-002: accept me', '- [x] T-002: accept me'));
  assert.equal(parsePlan(out).tasks.find((t) => t.id === 'T-002').done, true);
  assert.equal(parsePlan(out).tasks.find((t) => t.id === 'T-0021').done, false, 'T-0021 must not be touched');
  const crlf = '# PLAN\r\n\r\n## Tasks\r\n\r\n- [ ] T-002: crlf\r\n';
  assert.equal(markTaskDone(crlf, 'T-002'), '# PLAN\r\n\r\n## Tasks\r\n\r\n- [x] T-002: crlf\r\n');
});

test('markTaskDone fails closed on an already accepted, missing or duplicated task line', () => {
  assert.throws(() => markTaskDone(PLAN, 'T-001'), /already marked \[x\]/);
  assert.throws(() => markTaskDone(PLAN, 'T-009'), /not found/);
  assert.throws(() => markTaskDone(`${PLAN}- [ ] T-002: duplicate\n`, 'T-002'), /more than once/);
});

test('acceptanceSubject follows commitLanguage', () => {
  assert.equal(acceptanceSubject('T-002', 'ru'), 'arch: приёмка T-002');
  assert.equal(acceptanceSubject('T-002', 'en'), 'arch: accept T-002');
  assert.equal(acceptanceSubject('T-002', null), 'arch: accept T-002');
  assert.equal(validateCommitMessage({ subject: acceptanceSubject('T-002', 'en'), commitLanguage: 'en', stagedFiles: ['PLAN.md'], planDiff: '-- [ ] T-002: x\n+- [x] T-002: x' }).ok, true);
});

test('commitAcceptance commits only PLAN.md on top of expectedHead and passes the real commit-msg hook', () => {
  useHook(generateCommitMsgHookScript());
  const expectedHead = g('rev-parse', 'HEAD');
  const res = commitAcceptance({ realGit, cwd: dir, planPath: 'PLAN.md', taskId: 'T-002', expectedHead, commitLanguage: 'en' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.subject, 'arch: accept T-002');
  assert.equal(res.sha, g('rev-parse', 'HEAD'));
  assert.equal(g('rev-parse', 'HEAD^'), expectedHead);
  assert.equal(g('log', '-1', '--format=%s'), 'arch: accept T-002');
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['PLAN.md']);
  assert.equal(read('PLAN.md'), PLAN.replace('- [ ] T-002: accept me', '- [x] T-002: accept me'));
  assert.equal(g('status', '--porcelain'), '');
});

test('commitAcceptance supports the compact layout and Russian commit language', () => {
  write('.architect/PLAN.md', PLAN);
  g('add', '.architect/PLAN.md');
  g('commit', '-q', '-m', 'arch: plan compact');
  const expectedHead = g('rev-parse', 'HEAD');
  const res = commitAcceptance({ realGit, cwd: dir, planPath: '.architect/PLAN.md', taskId: 'T-002', expectedHead, commitLanguage: 'ru' });
  assert.equal(res.ok, true, res.error);
  assert.equal(g('log', '-1', '--format=%s'), 'arch: приёмка T-002');
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['.architect/PLAN.md']);
  assert.equal(read('PLAN.md'), PLAN, 'the root PLAN.md is not the configured plan and stays untouched');
});

test('commitAcceptance refuses before writing when HEAD moved, the tree is dirty, or the task is already accepted', () => {
  const stale = g('rev-parse', 'HEAD');
  write('src/a.js', 'export const a = 3;\n');
  g('add', 'src/a.js');
  g('commit', '-q', '-m', 'T-002 (fix 1): later commit');
  const head = g('rev-parse', 'HEAD');

  const moved = commitAcceptance({ realGit, cwd: dir, planPath: 'PLAN.md', taskId: 'T-002', expectedHead: stale });
  assert.equal(moved.ok, false);
  assert.match(moved.error, /HEAD moved/);
  assert.equal(read('PLAN.md'), PLAN);
  assert.equal(g('rev-parse', 'HEAD'), head);

  write('scratch.txt', 'untracked\n');
  const dirty = commitAcceptance({ realGit, cwd: dir, planPath: 'PLAN.md', taskId: 'T-002', expectedHead: head });
  assert.equal(dirty.ok, false);
  assert.match(dirty.error, /working tree is not clean/);
  assert.equal(read('PLAN.md'), PLAN);
  rmSync(path.join(dir, 'scratch.txt'));

  const done = commitAcceptance({ realGit, cwd: dir, planPath: 'PLAN.md', taskId: 'T-001', expectedHead: head });
  assert.equal(done.ok, false);
  assert.match(done.error, /already marked \[x\]/);
  assert.equal(g('rev-parse', 'HEAD'), head);
  assert.equal(g('status', '--porcelain'), '');
});

test('commitAcceptance restores the plan and the index when git commit fails (fail-closed, no partial state)', () => {
  useHook('#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n');
  const head = g('rev-parse', 'HEAD');
  const res = commitAcceptance({ realGit, cwd: dir, planPath: 'PLAN.md', taskId: 'T-002', expectedHead: head });
  assert.equal(res.ok, false);
  assert.match(res.error, /commit failed/);
  assert.equal(g('rev-parse', 'HEAD'), head);
  assert.equal(read('PLAN.md'), PLAN);
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(g('diff', '--cached', '--name-only'), '');
  const lines = readFileSync(path.join(orchDir, 'accept.mjs'), 'utf8').split('\n').length;
  assert.ok(lines <= 400, `accept.mjs must stay <= 400 lines (got ${lines})`);
});
