// T-105 reference tests (C-22, sandbox EPERM): unreadable PATH entries, binaries inside the project never used as real git.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from './events.mjs';
import { which, whichOptional } from './guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let root;
let locked;

const fakeBin = (dir, name) => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-find-exec-')));
  locked = path.join(root, 'locked');
  mkdirSync(locked);
});
afterEach(() => {
  chmodSync(locked, 0o755); // cleanup: restore search permission so the temp tree can be removed
  rmSync(root, { recursive: true, force: true });
});

test('an unreadable PATH entry is "not in this directory": the lookup goes on to the next entry', () => {
  const tool = fakeBin(path.join(root, 'bin'), 'tool');
  chmodSync(locked, 0o000);
  const envPath = [locked, path.dirname(tool)].join(path.delimiter);
  assert.equal(findExecutable('tool', envPath), tool);
  assert.equal(whichOptional('tool', envPath), tool);
  assert.equal(findExecutable('missing-tool', envPath), null, 'nothing found anywhere is still null, not a throw');
});

test('an absolute path under an unreadable directory is null, not a throw', () => {
  chmodSync(locked, 0o000);
  assert.equal(findExecutable(path.join(locked, 'git')), null);
});

test('the stat error codes EPERM and EACCES are both handled', () => {
  const src = readFileSync(path.join(here, 'events.mjs'), 'utf8');
  assert.match(src, /EPERM/);
  assert.match(src, /EACCES/);
});

test('excludeUnder: a git inside the project (node_modules/.bin, a symlinked PATH entry) is never the real git', () => {
  const project = path.join(root, 'project');
  const planted = fakeBin(path.join(project, 'node_modules', '.bin'), 'git');
  const outside = fakeBin(path.join(root, 'usr-bin'), 'git');
  const viaLink = path.join(root, 'bin-link');
  symlinkSync(path.join(project, 'node_modules', '.bin'), viaLink);
  const envPath = [path.dirname(planted), viaLink, path.dirname(outside)].join(path.delimiter);
  assert.equal(findExecutable('git', envPath), planted, 'without the option the lookup is unchanged');
  assert.equal(findExecutable('git', envPath, { excludeUnder: [project] }), outside);
  assert.equal(which('git', envPath, { excludeUnder: [project] }), outside);
  const onlyInside = [path.dirname(planted), viaLink].join(path.delimiter);
  assert.equal(findExecutable('git', onlyInside, { excludeUnder: [project] }), null);
  assert.throws(() => which('git', onlyInside, { excludeUnder: [project] }), /binary not found in PATH: git/);
  assert.equal(whichOptional('git', onlyInside, { excludeUnder: [project] }), '');
});

test('excludeUnder compares real paths: the project given through a symlink is excluded too', () => {
  const project = path.join(root, 'project');
  const planted = fakeBin(path.join(project, 'bin'), 'git');
  const outside = fakeBin(path.join(root, 'usr-bin'), 'git');
  const projectLink = path.join(root, 'project-link');
  symlinkSync(project, projectLink);
  const envPath = [path.dirname(planted), path.dirname(outside)].join(path.delimiter);
  assert.equal(findExecutable('git', envPath, { excludeUnder: [projectLink] }), outside);
});

test('run.mjs resolves the real git outside the project directory', () => {
  const src = readFileSync(path.join(here, 'run.mjs'), 'utf8');
  assert.match(src, /const realGit = which\('git', process\.env\.PATH, \{ excludeUnder: \[process\.cwd\(\)\] \}\);/);
});
