// T-102 reference tests (C-14, C-15): the agent git policy (git-policy.mjs) and its use in commandProblem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitArgsProblem, runGitPolicyCli } from './git-policy.mjs';
import { BASE_COMMANDS, commandProblem, proposeRules } from './permissions.mjs';

const POLICY = fileURLToPath(new URL('./git-policy.mjs', import.meta.url));
const args = (s) => s.split(' ').filter(Boolean);
const blocked = (s, re, ctx) => {
  const p = gitArgsProblem(Array.isArray(s) ? s : args(s), ctx);
  assert.equal(typeof p, 'string', `expected "git ${s}" to be blocked`);
  assert.match(p, /^git/, `message starts with git: ${p}`);
  assert.ok(!p.includes('\n') && !p.startsWith('agent-loop guard:'), p);
  if (re) assert.match(p, re, `git ${s}`);
  return p;
};
const allowed = (s, ctx) => assert.equal(gitArgsProblem(Array.isArray(s) ? s : args(s), ctx), null, `expected "git ${s}" to be allowed`);

test('rule mode: every git entry of BASE_COMMANDS and the usual Executor calls are allowed', () => {
  const gitBase = BASE_COMMANDS.filter((c) => c.startsWith('git '));
  assert.ok(gitBase.length >= 20);
  for (const c of gitBase) allowed(c.slice(4));
  allowed(['commit', '--only', 'a.mjs', 'docs/b.md', '-m', 'T-101: add a']);
  allowed(['commit', '-m', '--amend is only a message']);
  allowed(['commit', '--author', 'A <a@example.invalid>', '-m', 'x']);
  allowed(['commit', '--message', '--all inside the value', '--only', 'a.mjs']);
  allowed(['commit', '--trailer', '--amend', '-m', 'x']);
  allowed('commit -qm x');
  allowed('commit -am x');
  allowed(['commit', '-am', 'handle -n option in parser']);
  allowed('commit --all -m x');
  allowed('commit -mn');
  allowed('commit --allow-empty -m x');
  allowed('commit --no-edit');
  allowed('add src/a.mjs src/dir/');
  allowed('add -N src/new.mjs');
  allowed('rm --cached a.txt');
  allowed('rm -r src/old');
  allowed('mv a.mjs b.mjs');
  allowed('grep -n foo');
  allowed(['grep', '-e', '-O', 'src']);
  allowed('grep -e a --or -e b');
  allowed('grep --recurse-submodules foo');
  allowed('log --oneline --output-indicator-new=+ -3');
  allowed('diff --no-indent-heuristic --stat');
  allowed('diff --cached --name-only');
  allowed('show --stat HEAD');
  allowed('stash');
  allowed('stash pop');
  allowed('tag v1.0.0');
  allowed('push origin master');
  allowed('--no-pager log -1');
  allowed('--version');
  allowed([]);
  allowed('-C some/dir status');
});

test('C-14: forbidden long options are blocked by any unambiguous abbreviation', () => {
  for (const a of ['--no-verify', '--no-verif', '--no-v', '--no-']) blocked(`commit ${a} -m x`, /--no-verify/);
  for (const a of ['--amend', '--amen', '--am', '--a']) blocked(`commit ${a} -m x`, /--amend/);
  blocked('commit --pathspec-from-file=list.txt', /--pathspec-from-file/);
  blocked('push --no-verif origin master', /--no-verify/);
  blocked('push --receive-pack=touch-x origin', /--receive-pack/);
  blocked('push --exec=touch-x origin', /--exec/);
  blocked('log --output=x.txt', /--output/);
  blocked('log --out=x.txt', /--output/);
  blocked('show --outp x.txt HEAD', /--output/);
  blocked('diff --output x.txt', /--output/);
  blocked('diff --no-index a b', /--no-index/);
  blocked('grep --no-ind foo', /--no-index/);
  for (const a of ['--open-files-in-pager', '--open-files-in-p=true', '--open-f', '--op']) blocked(`grep ${a} foo`, /--open-files-in-pager/);
  for (const a of ['--all', '--al', '--update', '--upd', '--u', '--force', '--f', '--no-ignore-removal', '--renormalize', '--pathspec-from-file=x']) blocked(`add ${a} a.txt`, /--(all|update|force|no-ignore-removal|renormalize|pathspec-from-file)/);
  blocked('rm --pathspec-from-file=x', /--pathspec-from-file/);
});

test('C-14/C-15: forbidden short letters are blocked anywhere in a cluster, values are skipped', () => {
  blocked('commit -n -m x', /--no-verify/);
  blocked('commit -qn -m x', /--no-verify/);
  blocked('commit -nm x', /--no-verify/);
  blocked('add -A', /--all/);
  blocked('add -Av', /--all/);
  blocked('add -vu', /--update/);
  blocked('add -f secret.env', /--force/);
  blocked('grep -O foo', /--open-files-in-pager/);
  blocked('grep -iO foo', /--open-files-in-pager/);
  blocked('grep -Oless foo', /--open-files-in-pager/);
});

test('C-15: add / commit / rm need explicit pathspecs inside the project', () => {
  for (const p of ['.', './', 'src/..', 'src/../', '..', '../x', ':/', ':(top)', ':!secret', '*', '*.mjs', 'src/**/x.mjs']) {
    blocked(['add', p], /pathspec/);
    blocked(['commit', '-m', 'x', '--', p], /pathspec/);
  }
  blocked(['commit', '.'], /pathspec/);
  blocked(['rm', '-r', '.'], /pathspec/);
  blocked(['add', '--', '.'], /pathspec/);
  blocked(['add', '--end-of-options', '.'], /pathspec/);
});

test('C-15: global overrides and subcommands outside the allowlist are blocked (aliases and external commands too)', () => {
  blocked('-c core.hooksPath=/dev/null commit -m x', /-c/);
  blocked('-ccore.hooksPath=/dev/null status', /-c/);
  blocked('--config-env=core.hooksPath=X status', /--config-env/);
  blocked('--git-dir=/x status', /--git-dir/);
  blocked('--git-d=/x status', /--git-dir/);
  blocked('--work-tree /x status', /--work-tree/);
  blocked('--exec-path=/x status', /--exec-path/);
  blocked('--namespace=x log', /--namespace/);
  blocked('-C', /-C/);
  for (const s of ['config core.hooksPath /dev/null', 'config --get user.name', 'reset --hard HEAD~1', 'clean -fd', 'rebase -i HEAD~2',
    'update-ref refs/heads/master HEAD~1', 'filter-branch', 'worktree add ../x', 'notes add -m x', 'checkout x', 'restore a.txt',
    'switch x', 'fetch origin', 'pull', 'merge x', 'cherry-pick abc', 'replace a b', 'reflog expire --all', 'gc', 'remote -v',
    'ci -m x', 'lfs status', 'format-patch -o /tmp HEAD~1', 'archive HEAD']) {
    blocked(s, /not an allowed subcommand/);
  }
});

let tmp;
let work;
let sandbox;
let other;
before(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'git-policy-')));
  work = path.join(tmp, 'work');
  sandbox = path.join(tmp, 'sandbox');
  other = path.join(tmp, 'other');
  for (const d of [path.join(work, '.git'), path.join(work, 'sub', 'deep'), path.join(work, 'nested', '.git'), path.join(work, 'nested', 'inner'), path.join(sandbox, 'repo'), other]) mkdirSync(d, { recursive: true });
  symlinkSync(work, path.join(tmp, 'link'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));
const ctxAt = (cwd) => ({ cwd, workReal: work, sandboxRoot: sandbox });

test('C-15: shim mode — -C and cwd must stay inside the project (nested repositories and the sandbox keep legacy rules)', () => {
  allowed('status', ctxAt(work));
  allowed('log -1', ctxAt(path.join(work, 'sub', 'deep')));
  allowed('status', ctxAt(path.join(tmp, 'link')));
  allowed(['-C', 'sub', '-C', '..', 'status'], ctxAt(work));
  allowed(['-C', '', 'status'], ctxAt(work));
  allowed(['-C', path.join(work, 'sub'), 'log'], ctxAt(other));
  blocked(['-C', other, 'log'], /outside the project/, ctxAt(work));
  blocked(['-C', other, 'status'], /outside the project/, ctxAt(work));
  blocked(['-C', '..', 'status'], /outside the project/, ctxAt(work));
  blocked(['-C', 'sub', '-C', '../..', 'status'], /outside the project/, ctxAt(work));
  blocked('status', /outside the project/, ctxAt(other));
  blocked(['-C', path.join(tmp, 'missing'), 'status'], /does not exist/, ctxAt(work));
  allowed(['-C', 'nested', 'commit', '--amend', '-m', 'x'], ctxAt(work));
  allowed('config user.name x', ctxAt(path.join(work, 'nested', 'inner')));
  allowed(['-C', path.join(sandbox, 'repo'), 'config', 'user.name', 'x'], ctxAt(work));
  allowed('reset --hard', ctxAt(path.join(sandbox, 'repo')));
  blocked(['-C', path.join(sandbox, 'repo'), '-c', 'a=b', 'status'], /-c/, ctxAt(work));
  blocked('commit --amend -m x', /--amend/, ctxAt(work));
  blocked('config core.hooksPath /dev/null', /not an allowed subcommand/, ctxAt(path.join(work, 'sub')));
  blocked('status', /outside the project/, { cwd: sandbox, workReal: work, sandboxRoot: '' });
});

test('C-15: shim mode — pathspecs resolve against the effective directory', () => {
  allowed(['add', 'sub'], ctxAt(work));
  allowed(['add', '../a.txt'], ctxAt(path.join(work, 'sub')));
  allowed(['add', '..'], ctxAt(path.join(work, 'sub', 'deep')));
  blocked(['add', '..'], /pathspec/, ctxAt(path.join(work, 'sub')));
  blocked(['add', '../..'], /pathspec/, ctxAt(path.join(work, 'sub')));
  blocked(['-C', 'sub', 'add', '..'], /pathspec/, ctxAt(work));
  blocked(['add', work], /pathspec/, ctxAt(path.join(work, 'sub')));
});

test('runGitPolicyCli: exit 0 silently when allowed, 97 with "agent-loop guard:" when blocked or broken', () => {
  const io = () => {
    const chunks = [];
    return { chunks, stderr: { write: (s) => { chunks.push(String(s)); return true; } } };
  };
  const ok = io();
  assert.equal(runGitPolicyCli({ argv: [work, sandbox, 'status'], cwd: work, stderr: ok.stderr }), 0);
  assert.deepEqual(ok.chunks, []);
  const no = io();
  assert.equal(runGitPolicyCli({ argv: [work, sandbox, 'commit', '--amen', '-m', 'x'], cwd: work, stderr: no.stderr }), 97);
  assert.match(no.chunks.join(''), /^agent-loop guard: git[^\n]*--amend[^\n]*\n$/);
  const out = io();
  assert.equal(runGitPolicyCli({ argv: [work, sandbox, '-C', other, 'log'], cwd: work, stderr: out.stderr }), 97);
  assert.match(out.chunks.join(''), /^agent-loop guard: [^\n]*outside the project/);
  const bad = io();
  assert.equal(runGitPolicyCli({ argv: [], cwd: work, stderr: bad.stderr }), 97);
  assert.match(bad.chunks.join(''), /^agent-loop guard: git policy failed: /);
});

test('runGitPolicyCli as a program: `node git-policy.mjs <workReal> <sandboxRoot> <args>`', () => {
  const run = (...a) => spawnSync(process.execPath, [POLICY, work, sandbox, ...a], { cwd: work, encoding: 'utf8' });
  const no = run('commit', '--no-verif', '-m', 'x');
  assert.equal(no.status, 97);
  assert.equal(no.stdout, '');
  assert.match(no.stderr, /^agent-loop guard: git[^\n]*--no-verify/);
  const ok = run('log', '--oneline');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout + ok.stderr, '');
});

test('commandProblem: new git blocks are added after the old checks; old messages stay', () => {
  assert.match(commandProblem('git commit --amend -m x') ?? '', /--amend/);
  assert.match(commandProblem('git commit --no-verif -m x') ?? '', /--no-verify/);
  assert.match(commandProblem('git add -Av') ?? '', /--all/);
  assert.match(commandProblem('git add :/') ?? '', /pathspec/);
  assert.match(commandProblem('git notes add -m x') ?? '', /not an allowed subcommand/);
  assert.equal(commandProblem('git add .'), 'forbidden git add without explicit file paths (git add . / -A / -u)');
  assert.equal(commandProblem('git commit --no-verify -m x'), 'git with --no-verify is forbidden');
  assert.match(commandProblem('git -C /x show') ?? '', /rule is too broad/);
  for (const c of BASE_COMMANDS) assert.equal(commandProblem(c), null, c);
  assert.deepEqual(proposeRules('git stash list').options.map((o) => o.rule), ['git stash', 'git stash list']);
  assert.equal(proposeRules('git commit --amend -m x').auto, true);
});
