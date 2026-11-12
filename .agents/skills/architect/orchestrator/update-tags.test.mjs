// T-125 reference test (Frozen): --update and the update notice follow release tags (C-39, ADR-076).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { RELEASE_TAG_RE, pickLatestReleaseTag, resolveLatestReleaseTag } from './update-tags.mjs';
import { updateSkill, checkSkillUpdateAvailable } from './update.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);

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

function writeSkill(root, ver) {
  const dir = path.join(root, '.agents', 'skills', 'architect');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `# Architect Prompt ${ver}\n`);
  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
}

/** Commits a skill version upstream, optionally tags it; returns the full commit SHA. */
function release(upstream, ver, tag = null, annotated = false) {
  writeSkill(upstream, ver);
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', `arch: release ${ver}`);
  if (tag && annotated) git(upstream, 'tag', '-a', tag, '-m', `release ${tag}`);
  else if (tag) git(upstream, 'tag', tag);
  return git(upstream, 'rev-parse', 'HEAD');
}

function makeConsumer(root) {
  const consumer = path.join(root, 'consumer');
  initRepo(consumer);
  writeSkill(consumer, 'v3.45');
  writeFileSync(path.join(consumer, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  git(consumer, 'add', '.');
  git(consumer, 'commit', '-q', '-m', 'initial skill');
  return consumer;
}

const consumerSkillMd = (consumer) => readFileSync(path.join(consumer, '.agents', 'skills', 'architect', 'SKILL.md'), 'utf8');

async function withTmp(fn) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-tags-')));
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('C-39: RELEASE_TAG_RE accepts only vMAJOR.MINOR.PATCH', () => {
  for (const ok of ['v3.55.0', 'v10.0.12']) assert.match(ok, RELEASE_TAG_RE);
  for (const bad of ['v3.55', '3.55.0', 'v3.55.0-rc1', 'x3.55.0', 'v3.55.0^{}']) assert.doesNotMatch(bad, RELEASE_TAG_RE);
});

test('C-39: pickLatestReleaseTag orders numerically, ignores non-releases, and prefers the peeled commit', () => {
  const out = [
    `${A}\trefs/tags/v3.9.0`,
    `${B}\trefs/tags/v3.10.0`,
    `${C}\trefs/tags/v3.10.0^{}`,
    `${D}\trefs/tags/v3.11.0-rc1`,
    `${E}\trefs/tags/x3.12.0`,
    `${E}\trefs/tags/v3.12`,
    `${E}\trefs/heads/master`,
  ].join('\n');
  assert.deepEqual(pickLatestReleaseTag(out), { tag: 'v3.10.0', sha: C });

  assert.deepEqual(pickLatestReleaseTag(`${C}\trefs/tags/v4.0.0^{}\n${B}\trefs/tags/v4.0.0\n`), { tag: 'v4.0.0', sha: C });
  assert.deepEqual(pickLatestReleaseTag(`${A}\trefs/tags/v9.99.99\n${B}\trefs/tags/v10.0.0\n`), { tag: 'v10.0.0', sha: B });
  assert.deepEqual(pickLatestReleaseTag(`${'F'.repeat(40)}\trefs/tags/v1.0.0\n`), { tag: 'v1.0.0', sha: 'f'.repeat(40) });
  assert.deepEqual(pickLatestReleaseTag(`zzz\trefs/tags/v9.0.0\n${A}\trefs/tags/v1.0.0\n`), { tag: 'v1.0.0', sha: A });
  assert.equal(pickLatestReleaseTag(''), null);
  assert.equal(pickLatestReleaseTag(`${A}\trefs/heads/master\n${B}\trefs/tags/nightly\n`), null);
});

test('C-39: resolveLatestReleaseTag reads a real remote, reports missing tags and unreachable remotes without throwing', async () => {
  await withTmp(async (tmp) => {
    const up = path.join(tmp, 'up');
    initRepo(up);
    release(up, 'v1.2', 'v1.2.0');
    const second = release(up, 'v1.10', 'v1.10.0', true);
    release(up, 'v1.11');
    assert.deepEqual(resolveLatestReleaseTag({ realGit, repoUrl: up, timeoutMs: 10000 }), { ok: true, tag: 'v1.10.0', sha: second });

    const bare = path.join(tmp, 'untagged');
    initRepo(bare);
    release(bare, 'v1.0');
    const none = resolveLatestReleaseTag({ realGit, repoUrl: bare, timeoutMs: 10000 });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no-release-tags');

    const gone = resolveLatestReleaseTag({ realGit, repoUrl: path.join(tmp, 'does-not-exist'), timeoutMs: 10000 });
    assert.equal(gone.ok, false);
    assert.equal(gone.reason, 'unreachable');
    assert.equal(typeof gone.detail, 'string');
  });
});

test('C-39: updateSkill installs the newest release tag, not the untagged master HEAD', async () => {
  await withTmp(async (tmp) => {
    const up = path.join(tmp, 'up');
    initRepo(up);
    const tagged = release(up, 'v3.98', 'v3.98.0');
    release(up, 'v3.99');
    const consumer = makeConsumer(tmp);

    const res = await updateSkill({ workDir: consumer, repoUrl: up, realGit, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
    assert.equal(res.ok, true);
    assert.equal(res.tag, 'v3.98.0');
    assert.match(consumerSkillMd(consumer), /^# Architect Prompt v3\.98$/m);
    const version = readFileSync(path.join(consumer, '.agents', 'skills', 'architect', '.version'), 'utf8');
    assert.ok(version.includes(`(${tagged.slice(0, 7)})`), `.version must record the tagged commit: ${version}`);
  });
});

test('C-39: updateSkill without release tags fails closed and leaves the installed skill untouched; an explicit ref still works', async () => {
  await withTmp(async (tmp) => {
    const up = path.join(tmp, 'up');
    initRepo(up);
    release(up, 'v3.99');
    const consumer = makeConsumer(tmp);
    const orchestratorDir = path.join(tmp, 'elsewhere', 'orchestrator');

    await assert.rejects(
      () => updateSkill({ workDir: consumer, repoUrl: up, realGit, orchestratorDir }),
      (err) => /no release tags/i.test(err.message) && /ARCHITECT_UPDATE_REF/.test(err.message),
    );
    assert.match(consumerSkillMd(consumer), /v3\.45/);
    assert.equal(existsSync(path.join(consumer, '.agents', 'skills', 'architect', '.version')), false);

    const viaRef = await updateSkill({ workDir: consumer, repoUrl: up, realGit, orchestratorDir, ref: 'master' });
    assert.equal(viaRef.ok, true);
    assert.match(consumerSkillMd(consumer), /v3\.99/);
  });
});

test('C-39: checkSkillUpdateAvailable compares the installed commit with the newest release tag', async () => {
  await withTmp(async (tmp) => {
    const up = path.join(tmp, 'up');
    initRepo(up);
    const tagged = release(up, 'v3.98', 'v3.98.0');
    const head = release(up, 'v3.99');
    const consumer = makeConsumer(tmp);
    writeFileSync(path.join(consumer, '.agents', 'skills', 'architect', '.version'), `v3.98 / 1.8 (${tagged.slice(0, 7)})\n`);
    const opts = { workDir: consumer, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator'), repoUrl: up, realGit, force: true };

    const current = checkSkillUpdateAvailable(opts);
    assert.equal(current.updateAvailable, false, 'an untagged commit on master is not an update');
    assert.equal(current.notice, null);

    git(up, 'tag', 'v3.99.0', head);
    const newer = checkSkillUpdateAvailable(opts);
    assert.equal(newer.updateAvailable, true);
    assert.ok(newer.notice.includes('v3.99.0'), newer.notice);
    assert.ok(newer.notice.includes(head.slice(0, 7)), newer.notice);
  });
});

test('C-39: offline mode never runs git and answers only from a valid cache', async () => {
  await withTmp(async (tmp) => {
    const consumer = makeConsumer(tmp);
    const marker = path.join(tmp, 'git-called.txt');
    const fakeGit = path.join(tmp, 'fake-git');
    writeFileSync(fakeGit, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
    chmodSync(fakeGit, 0o755);
    const base = { workDir: consumer, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator'), repoUrl: path.join(tmp, 'up'), realGit: fakeGit };

    const noCache = checkSkillUpdateAvailable({ ...base, offline: true, force: true });
    assert.equal(noCache.updateAvailable, false);
    assert.equal(noCache.notice, null);
    assert.equal(existsSync(marker), false, 'offline mode must not spawn git');

    const now = 1_700_000_000_000;
    const notice = '! skill update available: v3.45 (unknown -> v3.99.0 abcdef0) — run "/architect update"';
    mkdirSync(path.join(consumer, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(consumer, '.agent-runs', '.update-check.json'), JSON.stringify({
      checkedAt: now - 1000, localSha: '', remoteSha: 'abcdef0'.padEnd(40, '0'), ver: 'v3.45', updateAvailable: true, notice,
    }));
    const cached = checkSkillUpdateAvailable({ ...base, offline: true, nowMs: now });
    assert.equal(cached.updateAvailable, true);
    assert.equal(cached.notice, notice);
    assert.equal(existsSync(marker), false, 'offline mode must not spawn git even with a cache');
  });
});

test('C-39: the network check stays in --check; self-check, --dry-run and the loop start read the cache offline', () => {
  const cli = readFileSync(path.join(orchDir, 'cli.mjs'), 'utf8');
  const check = readFileSync(path.join(orchDir, 'check.mjs'), 'utf8');
  assert.match(cli, /checkSkillUpdateAvailable\(\{[^}]*\boffline:\s*true\b[^}]*\}\)/, 'runFullSelfCheck must call checkSkillUpdateAvailable with offline: true');
  assert.match(check, /checkSkillUpdateAvailable\(\{[^}]*\}\)/, 'runCheckCommand must keep the network update check');
  assert.doesNotMatch(check, /checkSkillUpdateAvailable\(\{[^}]*\boffline\b[^}]*\}\)/, '--check must not use offline mode');
});
