// T-103 reference tests (C-14, C-15): the generated git shim enforces git-policy.mjs while AGENT_LOOP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIM_MAX_BYTES, isGuardShimFile, unwrapGit, writeGitShim } from './guards.mjs';

const POLICY = fileURLToPath(new URL('./git-policy.mjs', import.meta.url));
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const BASE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP' && k !== 'AGENT_LOOP_SANDBOX_ROOT')),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const LOOP_ENV = { ...BASE_ENV, AGENT_LOOP: '1' };

let tmp;
let work;
let other;
let sandbox;
let nested;
let shim;
const rg = (cwd, ...a) => execFileSync(realGit, a, { cwd, encoding: 'utf8', env: BASE_ENV }).trim();
const sg = (cwd, ...a) => spawnSync(shim, a, { cwd, encoding: 'utf8', env: LOOP_ENV });
const head = (cwd) => rg(cwd, 'rev-parse', 'HEAD');
const initRepo = (dir, file) => {
  mkdirSync(dir, { recursive: true });
  rg(dir, 'init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, file), 'one\n');
  rg(dir, 'add', file);
  rg(dir, 'commit', '-q', '-m', 'init');
};
const expectBlocked = (res, label) => {
  assert.equal(res.status, 97, `${label}: exit ${res.status}, stderr ${res.stderr}`);
  assert.match(res.stderr, /agent-loop guard:/, label);
};

before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'git-shim-policy-')));
  work = path.join(tmp, 'work');
  other = path.join(tmp, 'other');
  sandbox = path.join(tmp, 'sandbox');
  nested = path.join(work, 'nested');
  initRepo(work, 'a.txt');
  mkdirSync(path.join(work, 'sub'));
  writeFileSync(path.join(work, 'sub', 'c.txt'), 'c\n');
  rg(work, 'add', 'sub/c.txt');
  rg(work, 'commit', '-q', '-m', 'add sub');
  initRepo(other, 'o.txt');
  initRepo(path.join(sandbox, 'repo'), 's.txt');
  initRepo(nested, 'n.txt');
  shim = writeGitShim({ shimDir: path.join(tmp, 'shim'), realGit, sandboxRoot: sandbox, workDir: work });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('the shim stays a recognizable guard shim and bakes the real node and git-policy.mjs', () => {
  assert.equal(shim, path.join(tmp, 'shim', 'git'));
  assert.ok(isGuardShimFile(shim));
  assert.ok(statSync(shim).size <= SHIM_MAX_BYTES);
  assert.equal(unwrapGit(shim), unwrapGit(realGit));
  const text = readFileSync(shim, 'utf8');
  assert.ok(text.includes(POLICY), 'the policy path is absolute and baked in');
  assert.ok(text.includes(process.execPath), 'the policy runs with the real node, not the node shim');
});

test('C-14: abbreviated forbidden options are blocked and nothing happens', () => {
  const before = head(work);
  expectBlocked(sg(work, 'commit', '--no-verif', '--allow-empty', '-m', 't1'), 'commit --no-verif');
  expectBlocked(sg(work, 'commit', '--amen', '--allow-empty', '-m', 't2'), 'commit --amen');
  expectBlocked(sg(work, 'grep', '--open-files-in-p=true', 'one'), 'grep --open-files-in-p');
  assert.equal(head(work), before);
});

test('C-15: --amend, add -A / --all / . / :/, -C outside, git config and aliases are blocked in the project', () => {
  const before = head(work);
  expectBlocked(sg(work, 'commit', '--amend', '-m', 'arch: accept T-001'), 'commit --amend');
  assert.equal(rg(work, 'log', '-1', '--format=%s'), 'add sub');
  writeFileSync(path.join(work, 'a.txt'), 'two\n');
  writeFileSync(path.join(work, 'extra.txt'), 'stray\n');
  for (const a of [['-A'], ['--al'], ['.'], [':/'], ['--', '.']]) expectBlocked(sg(work, 'add', ...a), `add ${a.join(' ')}`);
  assert.equal(rg(work, 'diff', '--cached', '--name-only'), '', 'nothing was staged');
  expectBlocked(sg(work, 'config', 'core.hooksPath', '/dev/null'), 'config');
  assert.equal(spawnSync(realGit, ['config', '--get', 'core.hooksPath'], { cwd: work, encoding: 'utf8', env: BASE_ENV }).stdout, '');
  rg(work, 'config', 'alias.ci', 'commit --amend --allow-empty -m via-alias');
  expectBlocked(sg(work, 'ci'), 'alias ci');
  expectBlocked(sg(work, 'reset', '--hard', 'HEAD'), 'reset');
  expectBlocked(sg(work, 'update-ref', 'refs/heads/master', 'HEAD~1'), 'update-ref');
  expectBlocked(sg(work, '-C', other, 'log', '--oneline', '-1'), '-C other log');
  expectBlocked(sg(work, '-C', other, 'status'), '-C other status');
  expectBlocked(sg(other, 'log', '-1'), 'cwd outside the project');
  assert.equal(head(work), before);
  assert.equal(rg(work, 'status', '--porcelain'), ' M a.txt\n?? extra.txt\n?? nested/'.trim());
});

test('old shim rules still answer first with their own messages', () => {
  const res = sg(work, 'log', '--output=x.txt');
  expectBlocked(res, 'log --output');
  assert.match(res.stderr, /agent-loop guard: --output is blocked for agents/);
  expectBlocked(sg(work, 'checkout', 'master'), 'checkout');
});

test('allowed: everyday Executor calls, nested repositories, the sandbox, and git without AGENT_LOOP', () => {
  for (const a of [['status', '--short'], ['log', '--oneline', '-1'], ['diff', '--stat'], ['show', '--stat', 'HEAD'], ['rev-parse', 'HEAD'], ['-C', path.join(work, 'sub'), 'log', '-1']]) {
    const res = sg(work, ...a);
    assert.equal(res.status, 0, `${a.join(' ')}: ${res.stderr}`);
  }
  writeFileSync(path.join(work, 'b.txt'), 'b\n');
  assert.equal(sg(work, 'add', 'b.txt').status, 0);
  const committed = sg(work, 'commit', '--only', 'b.txt', '-m', '--amend is only a message');
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(rg(work, 'log', '-1', '--format=%s'), '--amend is only a message');
  const nestedAmend = sg(work, '-C', nested, 'commit', '--amend', '--allow-empty', '-m', 'nested amended');
  assert.equal(nestedAmend.status, 0, nestedAmend.stderr);
  assert.equal(rg(nested, 'log', '-1', '--format=%s'), 'nested amended');
  const inSandbox = sg(work, '-C', path.join(sandbox, 'repo'), 'config', 'user.name', 'sandbox-user');
  assert.equal(inSandbox.status, 0, inSandbox.stderr);
  assert.equal(rg(path.join(sandbox, 'repo'), 'config', '--get', 'user.name'), 'sandbox-user');
  const plain = spawnSync(shim, ['commit', '--amend', '--allow-empty', '-m', 'outside the loop'], { cwd: work, encoding: 'utf8', env: BASE_ENV });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(rg(work, 'log', '-1', '--format=%s'), 'outside the loop');
});

test('fail-closed: a broken or missing policy blocks every git call while AGENT_LOOP=1', () => {
  const brokenPolicy = path.join(tmp, 'broken-policy.mjs');
  writeFileSync(brokenPolicy, "throw new Error('broken policy');\n");
  for (const [dir, policyPath] of [['shim-broken', brokenPolicy], ['shim-missing', path.join(tmp, 'missing-policy.mjs')]]) {
    const brokenShim = writeGitShim({ shimDir: path.join(tmp, dir), realGit, sandboxRoot: sandbox, workDir: work, policyPath });
    const before = head(work);
    const res = spawnSync(brokenShim, ['commit', '--allow-empty', '-m', 'must not run'], { cwd: work, encoding: 'utf8', env: LOOP_ENV });
    assert.equal(res.status, 97, `${dir}: ${res.stderr}`);
    assert.equal(head(work), before, `${dir}: no commit`);
  }
});
