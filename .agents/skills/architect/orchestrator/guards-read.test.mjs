import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGuards } from './guards.mjs';
import { PATH_GUARDED_TOOLS, writePathShims } from './runners.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const realGrep = execFileSync('/usr/bin/which', ['grep'], { encoding: 'utf8' }).trim();
const realLs = execFileSync('/usr/bin/which', ['ls'], { encoding: 'utf8' }).trim();
const realWc = execFileSync('/usr/bin/which', ['wc'], { encoding: 'utf8' }).trim();
const realNode = process.execPath;

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(BASE_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let root;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-s4-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setupFixture() {
  const workDir = path.join(root, 'work');
  const outsideDir = path.join(root, 'outside');
  mkdirSync(path.join(workDir, 'src'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const rg = (...args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: BASE_ENV }).trim();
  rg('init', '-q', '-b', 'master');
  writeFileSync(path.join(workDir, 'src', 'inside.txt'), 'alpha\nbeta\n');
  writeFileSync(path.join(workDir, 'patterns.txt'), 'alpha\n');
  writeFileSync(path.join(workDir, 'sample.test.mjs'), 'import test from "node:test"; test("ok", () => {});\n');
  rg('add', 'src/inside.txt', 'patterns.txt', 'sample.test.mjs');
  rg('commit', '-q', '-m', 'init');
  writeFileSync(path.join(workDir, 'src', 'inside.txt'), 'alpha\nbeta\ngamma\n');

  const secretFile = path.join(outsideDir, 'secret.txt');
  writeFileSync(secretFile, 'TOP_SECRET_TOKEN=12345\n');

  // Symlink inside workDir pointing to secretFile outside workDir
  const symlinkOutside = path.join(workDir, 'src', 'leak-link.txt');
  symlinkSync(secretFile, symlinkOutside);

  // Symlink inside workDir pointing to inside.txt inside workDir
  const symlinkInside = path.join(workDir, 'src', 'safe-link.txt');
  symlinkSync(path.join(workDir, 'src', 'inside.txt'), symlinkInside);

  // Fake npm with #!/usr/bin/env node shebang outside workDir to verify shims/node does not break npm test
  const fakeNpmScript = path.join(outsideDir, 'npm-cli.js');
  writeFileSync(fakeNpmScript, `#!${realNode}\nprocess.stdout.write("npm-ok:" + process.argv.slice(2).join(" "));\n`);
  chmodSync(fakeNpmScript, 0o755);
  const fakeNpmWrapper = path.join(outsideDir, 'fake-npm');
  writeFileSync(fakeNpmWrapper, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeNpmScript)});\n`);
  chmodSync(fakeNpmWrapper, 0o755);

  const guards = installGuards({
    workDir,
    shimDir: path.join(root, 'shims'),
    blockedScripts: ['ship'],
    sandboxRoot: path.join(root, 'sandbox'),
    realGit,
    realNpm: fakeNpmWrapper,
  });

  const envLoop = { ...BASE_ENV, AGENT_LOOP: '1', PATH: guards.env.PATH };
  const envNormal = { ...BASE_ENV, AGENT_LOOP: '', PATH: guards.env.PATH };
  const sh = (cmd, { cwd = workDir, env = envLoop } = {}) => spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });

  return { workDir, outsideDir, secretFile, symlinkOutside, symlinkInside, guards, sh, envNormal };
}

test('T-032 (Ф6): unified path guard blocks existing paths outside workDir, symlinks outside workDir, and cwd outside workDir with exit 97 across grep, ls, wc, node --test, and git diff', () => {
  assert.deepEqual(PATH_GUARDED_TOOLS, ['grep', 'ls', 'wc', 'node']);
  const { workDir, outsideDir, secretFile, symlinkOutside, symlinkInside, guards, sh, envNormal } = setupFixture();

  try {
    // 1. Allowed in-project calls must pass (exit 0)
    for (const okCmd of [
      'grep -rn alpha src/inside.txt',
      'grep -f patterns.txt src/inside.txt',
      'grep -fpatterns.txt src/inside.txt',
      'grep --file=patterns.txt src/inside.txt',
      `grep alpha '${symlinkInside}'`,
      'ls -la',
      'ls src/inside.txt',
      `ls '${symlinkInside}'`,
      'wc -l src/inside.txt',
      'node --test sample.test.mjs',
      'git diff HEAD --stat',
      'git diff HEAD~0..HEAD -- src/inside.txt',
      'npm test',
    ]) {
      const r = sh(okCmd);
      assert.equal(r.status, 0, `expected exit 0 for "${okCmd}", got ${r.status}: ${r.stderr}`);
    }

    // 2. Existing paths outside workDir (positional, --opt=, -fFILE, .., and symlinks to outside) must fail with exit 97 and never leak secret content
    for (const blockedCmd of [
      `grep SECRET '${secretFile}'`,
      'grep SECRET ../outside/secret.txt',
      `grep -f '${secretFile}' src/inside.txt`,
      `grep -f'${secretFile}' src/inside.txt`,
      `grep -rn -f'${secretFile}' src/inside.txt`,
      `grep --file='${secretFile}' src/inside.txt`,
      `grep --exclude-from='${secretFile}' alpha src/`,
      `grep SECRET '${symlinkOutside}'`,
      `ls '${outsideDir}'`,
      'ls ..',
      `ls '${symlinkOutside}'`,
      `wc -l '${secretFile}'`,
      'wc -l ../outside/secret.txt',
      `wc -l '${symlinkOutside}'`,
      `node --test '${secretFile}'`,
      'node --test ../outside/secret.txt',
      `node --test '${symlinkOutside}'`,
      `git diff '${secretFile}' /dev/null`,
      'git diff ../outside/secret.txt src/inside.txt',
      `git diff '${symlinkOutside}'`,
      'git diff --no-index src/inside.txt patterns.txt',
      'git --no-index diff src/inside.txt patterns.txt',
    ]) {
      const r = sh(blockedCmd);
      assert.equal(r.status, 97, `expected exit 97 for "${blockedCmd}", got ${r.status} (stdout: ${r.stdout}, stderr: ${r.stderr})`);
      assert.match(r.stderr, /agent-loop guard:.*blocked/i, blockedCmd);
      assert.doesNotMatch(r.stdout + r.stderr, /TOP_SECRET_TOKEN/, `must not leak file content on: ${blockedCmd}`);
    }

    // 3. Running with pwd -P outside workDir must fail with exit 97 across all 5 commands
    for (const outsideCwdCmd of [
      `grep alpha '${path.join(workDir, 'src', 'inside.txt')}'`,
      `ls '${workDir}'`,
      `wc -l '${path.join(workDir, 'src', 'inside.txt')}'`,
      `node --test '${path.join(workDir, 'sample.test.mjs')}'`,
      'git diff',
    ]) {
      const r = sh(outsideCwdCmd, { cwd: outsideDir });
      assert.equal(r.status, 97, `expected exit 97 when cwd is outside workDir for "${outsideCwdCmd}", got ${r.status}`);
      assert.match(r.stderr, /agent-loop guard:.*blocked/i, outsideCwdCmd);
    }

    // 4. Without AGENT_LOOP=1, shims are transparent
    const normalLs = sh(`ls '${secretFile}'`, { env: envNormal });
    assert.equal(normalLs.status, 0, normalLs.stderr);
  } finally {
    guards.restore();
  }
});

test('T-032 (Ф6): writePathShims works standalone with realBins map', () => {
  const shimDir = path.join(root, 'standalone-shims');
  const workDir = path.join(root, 'standalone-work');
  mkdirSync(workDir, { recursive: true });
  writePathShims({
    shimDir,
    workDir,
    realBins: { grep: realGrep, ls: realLs, wc: realWc, node: realNode },
  });
  const r = spawnSync(path.join(shimDir, 'ls'), [root], {
    cwd: workDir,
    env: { ...BASE_ENV, AGENT_LOOP: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 97);
});
