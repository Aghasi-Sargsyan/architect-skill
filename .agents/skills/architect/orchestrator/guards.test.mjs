import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, installGuards, installPrePushHook, DISABLED_PUSH_URL } from './guards.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(BASE_ENV, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });

let root; // everything lives under root; only root/sandbox counts as the push sandbox
const rg = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', env: BASE_ENV }).trim();

/** bare remote + clone with one pushed commit and one local commit ahead */
function makeRepo(parent) {
  mkdirSync(parent, { recursive: true });
  rg(parent, 'init', '-q', '--bare', '-b', 'master', 'remote.git');
  rg(parent, 'clone', '-q', 'remote.git', 'work');
  const work = path.join(parent, 'work');
  writeFileSync(path.join(work, 'a.txt'), '1\n');
  rg(work, 'add', 'a.txt');
  rg(work, 'commit', '-q', '-m', 'init');
  rg(work, 'push', '-q', 'origin', 'master');
  writeFileSync(path.join(work, 'a.txt'), '2\n');
  rg(work, 'commit', '-q', '-am', 'local');
  return { work, remote: path.join(parent, 'remote.git') };
}
const remoteHead = (remote) => rg(remote, 'rev-parse', 'master');

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup({ blocked = ['ship', 'sync:push'] } = {}) {
  const outside = makeRepo(path.join(root, 'outside'));
  const inside = makeRepo(path.join(root, 'sandbox'));
  const fakeNpmLog = path.join(root, 'npm.log');
  const fakeNpm = path.join(root, 'fake-npm');
  writeFileSync(fakeNpm, `#!/bin/sh\necho "$@" >> '${fakeNpmLog}'\n`);
  chmodSync(fakeNpm, 0o755);
  const g = installGuards({
    workDir: outside.work, shimDir: path.join(root, 'shims'), blockedNpmScripts: blocked,
    sandboxRoot: path.join(root, 'sandbox'), realGit, realNpm: fakeNpm,
  });
  const env = { ...BASE_ENV, AGENT_LOOP: '1', PATH: g.env.PATH };
  const sh = (cwd, cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
  return { outside, inside, g, sh, fakeNpmLog };
}

test('push from the project repository is blocked three ways; the remote does not move', () => {
  const { outside, g, sh } = setup();
  const before = remoteHead(outside.remote);
  const viaShim = sh(outside.work, 'git push origin master');
  assert.equal(viaShim.status, 97);
  assert.match(viaShim.stderr, /git push is blocked/);
  assert.equal(sh(outside.work, 'git push --no-verify origin master').status, 97);
  const absolute = sh(outside.work, `'${realGit}' push --no-verify origin master`);
  assert.notEqual(absolute.status, 0, 'pushurl layer must stop an absolute-path push');
  assert.match(absolute.stderr, /agent-loop-push-disabled/);
  assert.equal(remoteHead(outside.remote), before);
  g.restore();
});

test('pre-push hook refuses an absolute-path push while AGENT_LOOP=1', () => {
  const { outside, inside, g, sh } = setup();
  g.restore(); // drop pushurl + hook from the project repo; test the hook alone on the sandbox repo
  const hook = installPrePushHook({ workDir: inside.work, realGit });
  assert.equal(hook.skipped, null);
  const before = remoteHead(inside.remote);
  const r = sh(inside.work, `'${realGit}' push origin master`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused by pre-push hook/);
  assert.equal(remoteHead(inside.remote), before);
  hook.restore();
  assert.equal(existsSync(path.join(inside.work, '.git', 'hooks', 'pre-push')), false);
  assert.ok(remoteHead(outside.remote));
});

test('push between repositories inside the sandbox root is allowed (test fixtures like tests/ship.test.ts)', () => {
  const { inside, g, sh } = setup();
  const local = rg(inside.work, 'rev-parse', 'HEAD');
  const r = sh(inside.work, 'git push -q origin master');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteHead(inside.remote), local);
  const viaC = sh(root, `git -C '${inside.work}' push -q origin HEAD:refs/heads/other`);
  assert.equal(viaC.status, 0, viaC.stderr);
  g.restore();
});

test('a sandbox repository pushing to a remote outside the sandbox is blocked', () => {
  const { inside, outside, g, sh } = setup();
  rg(inside.work, 'remote', 'add', 'out', outside.remote);
  const before = remoteHead(outside.remote);
  assert.equal(sh(inside.work, 'git push out master').status, 97);
  assert.equal(remoteHead(outside.remote), before);
  g.restore();
});

test('non-push git commands pass through, even with "push" as an argument', () => {
  const { outside, g, sh } = setup();
  writeFileSync(path.join(outside.work, 'b.txt'), 'b\n');
  const r = sh(outside.work, 'git add b.txt && git commit -q -m push && git log -1 --format=%s');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'push');
  g.restore();
});

test('npm shim blocks the listed scripts and passes everything else through', () => {
  const { outside, g, sh, fakeNpmLog } = setup();
  for (const cmd of ['npm run ship', 'npm run-script ship', 'npm run sync:push -- --force', 'npm ship']) {
    const r = sh(outside.work, cmd);
    assert.equal(r.status, 97, cmd);
    assert.match(r.stderr, /is blocked for agents/);
  }
  assert.equal(sh(outside.work, 'npm test').status, 0);
  assert.equal(sh(outside.work, 'npm run build').status, 0);
  assert.equal(readFileSync(fakeNpmLog, 'utf8'), 'test\nrun build\n');
  g.restore();
});

test('without AGENT_LOOP the shims are transparent', () => {
  const { inside, g } = setup();
  const env = { ...BASE_ENV, PATH: g.env.PATH };
  const r = spawnSync('/bin/sh', ['-c', 'git push -q origin master && npm run ship'], { cwd: inside.work, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  g.restore();
});

test('restore unsets pushurl, or puts back a previous one, and removes the hook', () => {
  const { outside, g } = setup();
  assert.equal(rg(outside.work, 'config', '--get', 'remote.origin.pushurl'), DISABLED_PUSH_URL);
  g.restore();
  assert.throws(() => rg(outside.work, 'config', '--get', 'remote.origin.pushurl'));
  assert.equal(existsSync(path.join(outside.work, '.git', 'hooks', 'pre-push')), false);

  rg(outside.work, 'config', 'remote.origin.pushurl', outside.remote);
  const g2 = installGuards({ workDir: outside.work, shimDir: path.join(root, 'shims2'), blockedNpmScripts: [], sandboxRoot: root, realGit, realNpm: '/usr/bin/true' });
  g2.restore();
  assert.equal(rg(outside.work, 'config', '--get', 'remote.origin.pushurl'), outside.remote);
});

test('a foreign pre-push hook is chained and restored byte for byte', () => {
  const { outside, g } = setup();
  g.restore();
  const hook = path.join(outside.work, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, '#!/bin/sh\necho user-hook\nexit 0\n');
  chmodSync(hook, 0o755);
  const original = readFileSync(hook, 'utf8');
  const installed = installPrePushHook({ workDir: outside.work, realGit });
  assert.match(readFileSync(hook, 'utf8'), /agent-loop guard hook/);
  installed.restore();
  assert.equal(readFileSync(hook, 'utf8'), original);
});

test('core.hooksPath inside the work tree (husky) or outside the repository: the hook layer is skipped, nothing is written', () => {
  const { outside, g } = setup();
  g.restore();
  rg(outside.work, 'config', 'core.hooksPath', '.husky/_');
  const husky = installGuards({ workDir: outside.work, shimDir: path.join(root, 'shims-h'), blockedNpmScripts: [], sandboxRoot: root, realGit, realNpm: '/usr/bin/true' });
  assert.match(husky.notes.join('\n'), /pre-push (?:не установлен: core\.hooksPath \(\.husky\/_\) вне \.git|hook not installed: core\.hooksPath \(\.husky\/_\) is outside \.git)/);
  assert.equal(existsSync(path.join(outside.work, '.husky')), false);
  assert.equal(rg(outside.work, 'status', '--porcelain'), '');
  assert.equal(rg(outside.work, 'config', '--get', 'remote.origin.pushurl'), DISABLED_PUSH_URL, 'the pushurl layer stays');
  husky.restore();

  const shared = path.join(root, 'shared-hooks');
  rg(outside.work, 'config', 'core.hooksPath', shared);
  const hook = installPrePushHook({ workDir: outside.work, realGit });
  assert.match(String(hook.skipped), /вне репозитория|outside repository/);
  assert.equal(existsSync(shared), false);
});

test('every remote gets a disabled pushurl; multiple and leftover values are restored correctly', () => {
  const { outside, g } = setup();
  g.restore();
  rg(outside.work, 'remote', 'add', 'mirror', outside.remote);
  rg(outside.work, 'remote', 'add', 'two', outside.remote);
  rg(outside.work, 'config', '--add', 'remote.two.pushurl', '/tmp/a.git');
  rg(outside.work, 'config', '--add', 'remote.two.pushurl', '/tmp/b.git');
  rg(outside.work, 'config', 'remote.mirror.pushurl', DISABLED_PUSH_URL); // leftover from a crashed run
  const g2 = installGuards({ workDir: outside.work, shimDir: path.join(root, 'shims-r'), blockedNpmScripts: [], sandboxRoot: root, realGit, realNpm: '/usr/bin/true' });
  for (const name of ['origin', 'mirror', 'two']) {
    assert.equal(rg(outside.work, 'config', '--get-all', `remote.${name}.pushurl`), DISABLED_PUSH_URL, name);
  }
  g2.restore();
  assert.throws(() => rg(outside.work, 'config', '--get', 'remote.origin.pushurl'));
  assert.throws(() => rg(outside.work, 'config', '--get', 'remote.mirror.pushurl'), 'a leftover is unset, not restored');
  assert.equal(rg(outside.work, 'config', '--get-all', 'remote.two.pushurl'), '/tmp/a.git\n/tmp/b.git');
});

test('verify: intact guards report nothing; edited pushurl, a new remote, a changed hook or hooksPath are reported', () => {
  const { outside, g } = setup();
  assert.deepEqual(g.verify(), []);
  const hook = path.join(outside.work, '.git', 'hooks', 'pre-push');
  const original = readFileSync(hook, 'utf8');

  rg(outside.work, 'config', 'remote.origin.pushurl', outside.remote);
  const vOrigin = g.verify();
  assert.equal(vOrigin.length, 1);
  assert.match(vOrigin[0], /^(?:pushurl remote «origin» изменён|pushurl of remote "origin" was modified)$/);
  rg(outside.work, 'config', 'remote.origin.pushurl', DISABLED_PUSH_URL);

  rg(outside.work, 'remote', 'add', 'sneaky', outside.remote);
  const vSneaky = g.verify();
  assert.equal(vSneaky.length, 1);
  assert.match(vSneaky[0], /^(?:pushurl remote «sneaky» изменён|pushurl of remote "sneaky" was modified)$/);
  rg(outside.work, 'remote', 'remove', 'sneaky');

  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  const vHook = g.verify();
  assert.equal(vHook.length, 1);
  assert.match(vHook[0], /^(?:хук pre-push изменён или удалён|pre-push hook was modified or removed)$/);
  writeFileSync(hook, original);

  rg(outside.work, 'config', 'core.hooksPath', path.join(root, 'elsewhere'));
  const vHooksPath = g.verify();
  assert.equal(vHooksPath.length, 1);
  assert.match(vHooksPath[0], /^core\.hooksPath (?:изменён|was modified)$/);
  rg(outside.work, 'config', '--unset', 'core.hooksPath');
  assert.deepEqual(g.verify(), []);
  g.restore();
});

test('a repository without remotes is fine', () => {
  const dir = path.join(root, 'solo');
  mkdirSync(dir);
  rg(dir, 'init', '-q', '-b', 'master');
  const g = installGuards({ workDir: dir, shimDir: path.join(root, 'shims-s'), blockedNpmScripts: [], sandboxRoot: root, realGit, realNpm: '/usr/bin/true' });
  assert.deepEqual(g.notes, []);
  g.restore();
  assert.equal(existsSync(path.join(dir, '.git', 'hooks', 'pre-push')), false);
});

test('lock: a second loop is refused while the first runs; a stale lock is taken over', () => {
  const runs = path.join(root, 'runs');
  const release = acquireLock(runs);
  assert.throws(() => acquireLock(runs), /цикл уже запущен|loop is already running/);
  release();
  writeFileSync(path.join(runs, '.lock'), '999999');
  const again = acquireLock(runs);
  // ADR-068: the lock is JSON {pid, startedAt, token}; the owner is this process.
  assert.equal(JSON.parse(readFileSync(path.join(runs, '.lock'), 'utf8')).pid, process.pid);
  again();
});
