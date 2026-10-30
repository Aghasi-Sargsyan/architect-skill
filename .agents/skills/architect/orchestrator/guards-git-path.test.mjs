import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGuards } from './guards.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-t034-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('T-034 (Г5): the node shim checks paths only for `node --test`; npx, node --version and global node CLIs work while AGENT_LOOP=1', () => {
  const workDir = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  const outsideBin = path.join(outside, 'bin');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outsideBin, { recursive: true });
  execFileSync(realGit, ['init', '-q'], { cwd: workDir, env: BASE_ENV });
  writeFileSync(path.join(outside, 'secret.test.mjs'), 'TOP_SECRET_TOKEN\n');

  const globalCli = path.join(outsideBin, 'fake-global-cli');
  writeFileSync(globalCli, '#!/usr/bin/env node\nprocess.stdout.write("global-cli-ok");\n');
  chmodSync(globalCli, 0o755);

  const guards = installGuards({ workDir, shimDir: path.join(root, 'shims'), blockedScripts: ['ship'], sandboxRoot: path.join(root, 'sandbox'), realGit });
  const env = { ...BASE_ENV, AGENT_LOOP: '1', PATH: `${guards.env.PATH}${path.delimiter}${outsideBin}` };
  const sh = (cmd, cwd = workDir) => spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  try {
    for (const okCmd of ['npx --version', 'node --version', 'fake-global-cli']) {
      const r = sh(okCmd);
      assert.equal(r.status, 0, `expected exit 0 for "${okCmd}", got ${r.status}: ${r.stderr}`);
    }
    assert.match(sh('fake-global-cli').stdout, /global-cli-ok/);
    const fromOutside = sh('npx --version', outside);
    assert.equal(fromOutside.status, 0, `npx outside workDir is not node --test: ${fromOutside.stderr}`);

    // node --test keeps the T-032 path guard
    for (const [cmd, cwd] of [
      [`node --test '${path.join(outside, 'secret.test.mjs')}'`, workDir],
      ['node --test', outside],
    ]) {
      const r = sh(cmd, cwd);
      assert.equal(r.status, 97, `expected exit 97 for "${cmd}" in ${cwd}, got ${r.status}`);
      assert.doesNotMatch(r.stdout + r.stderr, /TOP_SECRET_TOKEN/);
    }
  } finally {
    guards.restore();
  }
});
