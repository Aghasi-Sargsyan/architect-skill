// Reference tests of the control directory outside the working tree (ADR-066, C-22; ADR-061 item 3).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_DIR_MODE, controlDirFor, controlShimDir, ensureControlDir, freshShimDir, projectKey } from './control-dir.mjs';

let root;
let home;
let work;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-control-dir-')));
  home = path.join(root, 'home');
  work = path.join(root, 'my app');
  mkdirSync(home);
  mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('projectKey: sanitized basename of the real path plus 8 hex of its SHA-256', () => {
  const hash8 = createHash('sha256').update(work).digest('hex').slice(0, 8);
  assert.equal(projectKey(work), `my_app-${hash8}`);
  const link = path.join(root, 'link');
  symlinkSync(work, link);
  assert.equal(projectKey(link), projectKey(work), 'a symlink to the project gives the same key');
  assert.notEqual(projectKey(path.join(root, 'other')), projectKey(work));
});

test('controlDirFor and controlShimDir: under <home>/.config/architect/runs, no side effects', () => {
  const dir = controlDirFor({ workDir: work, home });
  assert.equal(dir, path.join(home, '.config', 'architect', 'runs', projectKey(work)));
  assert.equal(controlShimDir({ workDir: work, home }), path.join(dir, 'shims'));
  assert.equal(existsSync(path.join(home, '.config')), false, 'computing the path creates nothing');
  assert.equal(dir.startsWith(`${work}${path.sep}`), false, 'the control directory is outside the working tree');
});

test('ensureControlDir: creates the directory with mode 0700 and repairs a looser mode', () => {
  assert.equal(CONTROL_DIR_MODE, 0o700);
  const dir = ensureControlDir({ workDir: work, home });
  assert.equal(dir, controlDirFor({ workDir: work, home }));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  chmodSync(dir, 0o755);
  assert.equal(ensureControlDir({ workDir: work, home }), dir, 'a second call is idempotent');
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'a looser mode is tightened back');
});

test('ensureControlDir: fail-closed on a symlink or a file at the control path', () => {
  const dir = controlDirFor({ workDir: work, home });
  mkdirSync(path.dirname(dir), { recursive: true });
  const elsewhere = path.join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, dir);
  assert.throws(() => ensureControlDir({ workDir: work, home }), /not a plain directory/);
  rmSync(dir);
  writeFileSync(dir, 'x');
  assert.throws(() => ensureControlDir({ workDir: work, home }), /not a plain directory/);
});

test('freshShimDir: an empty shims/ in a 0700 control directory; files of an earlier run are gone', () => {
  const dir = freshShimDir({ workDir: work, home });
  assert.equal(dir, controlShimDir({ workDir: work, home }));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(statSync(controlDirFor({ workDir: work, home })).mode & 0o777, 0o700);
  writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\nexit 0\n');
  assert.equal(freshShimDir({ workDir: work, home }), dir);
  assert.deepEqual(readdirSync(dir), [], 'a file planted by an earlier run is removed');
});
