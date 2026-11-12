// T-126 reference test (Frozen): --update installs all or nothing and never deletes untracked files silently (C-39, ADR-077).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { installSkillAtomically, findUntrackedSkillFiles } from './update-swap.mjs';
import { updateSkill } from './update.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

let prevAgentLoop;
beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
});

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** { 'rel/path': content } for every file under dir (empty object when dir is absent). */
function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  visit(dir);
  return out;
}

const leftovers = (dir) => readdirSync(dir).filter((n) => n.includes('.update-'));

async function withTmp(fn) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-swap-')));
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Source skill + two installed targets + one EXECUTOR.md copy. */
function fixture(tmp) {
  const source = path.join(tmp, 'source');
  write(path.join(source, 'SKILL.md'), '# Architect Prompt v3.99\n');
  write(path.join(source, 'references', 'retro.md'), 'new retro\n');
  write(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  write(path.join(source, 'EXECUTOR.md'), 'new executor\n');
  const t1 = path.join(tmp, 'p', '.agents', 'skills', 'architect');
  const t2 = path.join(tmp, 'p', '.claude', 'skills', 'architect');
  for (const t of [t1, t2]) {
    write(path.join(t, 'SKILL.md'), '# Architect Prompt v3.45\n');
    write(path.join(t, 'references', 'retro.md'), 'old retro\n');
    write(path.join(t, 'old-only.md'), 'removed upstream\n');
  }
  const exec = path.join(tmp, 'p', 'EXECUTOR.md');
  write(exec, 'old executor\n');
  return { source, targets: [t1, t2], exec, files: [{ from: path.join(source, 'EXECUTOR.md'), to: exec }] };
}

test('C-39: installSkillAtomically replaces every target and file copy and leaves no staging entries', async () => {
  await withTmp(async (tmp) => {
    const fx = fixture(tmp);
    const res = installSkillAtomically({ sourceDir: fx.source, targets: fx.targets, versionLine: 'v3.99 / 1.9 (abcdef0)', files: fx.files });
    assert.deepEqual(res.replaced, fx.targets);
    assert.deepEqual(res.files, [fx.exec]);
    for (const t of fx.targets) {
      assert.deepEqual(snapshot(t), {
        '.version': 'v3.99 / 1.9 (abcdef0)\n',
        'EXECUTOR.md': 'new executor\n',
        'SKILL.md': '# Architect Prompt v3.99\n',
        'references/retro.md': 'new retro\n',
      });
      assert.deepEqual(leftovers(path.dirname(t)), []);
    }
    assert.equal(readFileSync(fx.exec, 'utf8'), 'new executor\n');
    assert.deepEqual(leftovers(path.dirname(fx.exec)), []);
  });
});

test('C-39: a failure at any rename rolls every target and file back and cleans up', async () => {
  let total = 0;
  await withTmp(async (tmp) => {
    const fx = fixture(tmp);
    installSkillAtomically({
      sourceDir: fx.source, targets: fx.targets, versionLine: 'v (x)', files: fx.files,
      rename: (a, b) => { total += 1; renameSync(a, b); },
    });
  });
  assert.ok(total >= 4, `expected at least 4 renames (2 targets, 1 file), got ${total}`);

  for (let failAt = 1; failAt <= total; failAt++) {
    await withTmp(async (tmp) => {
      const fx = fixture(tmp);
      const before = fx.targets.map(snapshot);
      let calls = 0;
      assert.throws(
        () => installSkillAtomically({
          sourceDir: fx.source, targets: fx.targets, versionLine: 'v (x)', files: fx.files,
          rename: (a, b) => {
            calls += 1;
            if (calls === failAt) throw new Error(`injected rename failure #${failAt}`);
            renameSync(a, b);
          },
        }),
        new RegExp(`injected rename failure #${failAt}`),
      );
      fx.targets.forEach((t, i) => {
        assert.deepEqual(snapshot(t), before[i], `target ${i} must be restored after failure #${failAt}`);
        assert.deepEqual(leftovers(path.dirname(t)), [], `no staging entries after failure #${failAt}`);
      });
      assert.equal(readFileSync(fx.exec, 'utf8'), 'old executor\n', `EXECUTOR.md restored after failure #${failAt}`);
      assert.deepEqual(leftovers(path.dirname(fx.exec)), []);
    });
  }
});

test('C-39: findUntrackedSkillFiles lists untracked files of git-managed skill folders only', async () => {
  await withTmp(async (tmp) => {
    const p = path.join(tmp, 'p');
    initRepo(p);
    const managed = path.join(p, '.agents', 'skills', 'architect');
    const unmanaged = path.join(p, '.claude', 'skills', 'architect');
    write(path.join(managed, 'SKILL.md'), '# v\n');
    write(path.join(p, '.gitignore'), '*.log\n');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', 'skill');
    write(path.join(managed, 'notes.md'), 'mine\n');
    write(path.join(managed, 'sub', 'draft.md'), 'mine\n');
    write(path.join(managed, '.version'), 'v (x)\n');
    write(path.join(managed, 'debug.log'), 'ignored\n');
    write(path.join(unmanaged, 'SKILL.md'), '# never committed\n');

    assert.deepEqual(
      findUntrackedSkillFiles({ realGit, workDir: p, targets: [managed, unmanaged] }),
      ['.agents/skills/architect/notes.md', '.agents/skills/architect/sub/draft.md'],
    );

    const plain = path.join(tmp, 'plain');
    write(path.join(plain, '.agents', 'skills', 'architect', 'x.md'), 'x\n');
    assert.deepEqual(findUntrackedSkillFiles({ realGit, workDir: plain, targets: [path.join(plain, '.agents', 'skills', 'architect')] }), []);

    const badGit = path.join(tmp, 'bad-git');
    writeFileSync(badGit, '#!/bin/sh\necho "fatal: broken" >&2\nexit 128\n');
    chmodSync(badGit, 0o755);
    assert.throws(() => findUntrackedSkillFiles({ realGit: badGit, workDir: p, targets: [managed] }));
  });
});

test('C-39: updateSkill refuses to delete untracked skill files unless --force', async () => {
  await withTmp(async (tmp) => {
    const up = path.join(tmp, 'up');
    initRepo(up);
    write(path.join(up, '.agents', 'skills', 'architect', 'SKILL.md'), '# Architect Prompt v3.99\n');
    write(path.join(up, '.agents', 'skills', 'architect', 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
    git(up, 'add', '.');
    git(up, 'commit', '-q', '-m', 'arch: release v3.99');
    git(up, 'tag', 'v3.99.0');

    const p = path.join(tmp, 'p');
    initRepo(p);
    const skill = path.join(p, '.agents', 'skills', 'architect');
    write(path.join(skill, 'SKILL.md'), '# Architect Prompt v3.45\n');
    write(path.join(skill, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', 'skill');
    write(path.join(skill, 'my-notes.md'), 'keep me\n');
    const orchestratorDir = path.join(tmp, 'elsewhere', 'orchestrator');

    await assert.rejects(
      () => updateSkill({ workDir: p, repoUrl: up, realGit, orchestratorDir }),
      (err) => /untracked/i.test(err.message) && err.message.includes('my-notes.md') && /--force/.test(err.message),
    );
    assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), '# Architect Prompt v3.45\n');
    assert.equal(readFileSync(path.join(skill, 'my-notes.md'), 'utf8'), 'keep me\n');

    const forced = await updateSkill({ workDir: p, repoUrl: up, realGit, orchestratorDir, force: true });
    assert.equal(forced.ok, true);
    assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), '# Architect Prompt v3.99\n');
  });
});

test('C-39: updateSkill installs through installSkillAtomically and guards with findUntrackedSkillFiles', () => {
  const src = readFileSync(path.join(orchDir, 'update.mjs'), 'utf8');
  assert.match(src, /installSkillAtomically\(/, 'update.mjs must install through installSkillAtomically');
  assert.match(src, /findUntrackedSkillFiles\(/, 'update.mjs must check findUntrackedSkillFiles before installing');
  assert.doesNotMatch(src, /for \(const dir of targetDirs\) \{\s*rmSync\(dir/, 'the per-target rmSync + cpSync loop must be gone');
});
