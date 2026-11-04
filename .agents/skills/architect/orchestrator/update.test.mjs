import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli.mjs';
import * as cliMod from './cli.mjs';
import { DEFAULTS } from './config.mjs';
import { runCheckCommand } from './check.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(orchDir);
const repoRoot = path.resolve(skillDir, '../../..');

function initUpstreamRepo(dir, skillVer = 'v3.99', execVer = '1.9') {
  execFileSync('git', ['init', '-b', 'master'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  const targetSkill = path.join(dir, '.agents', 'skills', 'architect');
  mkdirSync(path.dirname(targetSkill), { recursive: true });
  cpSync(skillDir, targetSkill, { recursive: true });

  const skillMdPath = path.join(targetSkill, 'SKILL.md');
  const execMdPath = path.join(targetSkill, 'EXECUTOR.md');
  writeFileSync(
    skillMdPath,
    readFileSync(skillMdPath, 'utf8').replace(/^# Architect Prompt v\d+\.\d+/m, `# Architect Prompt ${skillVer}`),
  );
  writeFileSync(
    execMdPath,
    readFileSync(execMdPath, 'utf8').replace(/^<!-- executor-policy-version: \d+\.\d+ -->/m, `<!-- executor-policy-version: ${execVer} -->`),
  );

  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'arch: release test skill version'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('T-073 (a): parseArgs supports --update and enforces mutual exclusion with other mode flags', () => {
  const parsed = parseArgs(['--update']);
  assert.equal(parsed.update, true, 'parseArgs(["--update"]) must set opts.update = true');
  assert.throws(
    () => parseArgs(['--update', '--check']),
    /only one per invocation/,
    '--update must be mutually exclusive with --check and other mode flags',
  );
});

test('T-073 (b): handleUpdateCli updates installed skill folder, syncs root EXECUTOR.md, writes .version, refreshes commit-msg hook, and leaves config untouched', async () => {
  assert.equal(typeof cliMod.handleUpdateCli, 'function', 'cli.mjs must export handleUpdateCli');

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-skill-test-')));
  try {
    const upstreamDir = path.join(tmp, 'upstream');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const upstreamSha = initUpstreamRepo(upstreamDir, 'v3.99', '1.9');

    execFileSync('git', ['init', '-b', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: projectDir, stdio: 'ignore' });

    const projSkillDir = path.join(projectDir, '.agents', 'skills', 'architect');
    mkdirSync(path.dirname(projSkillDir), { recursive: true });
    cpSync(skillDir, projSkillDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'EXECUTOR.md'), readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8'));

    const cfgPath = path.join(projectDir, '.architect', 'config.json');
    mkdirSync(path.dirname(cfgPath), { recursive: true });
    const customCfg = JSON.stringify({ layout: 'compact', executor: { model: 'gemini-3-flash' } }, null, 2);
    writeFileSync(cfgPath, customCfg);

    const lines = [];
    const res = await cliMod.handleUpdateCli({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      print: (line) => lines.push(line),
    });

    assert.equal(res.ok, true);
    assert.equal(res.afterVersion, 'v3.99 / 1.9');
    assert.equal(res.commitSha, upstreamSha);
    assert.match(readFileSync(path.join(projSkillDir, 'SKILL.md'), 'utf8'), /^# Architect Prompt v3\.99/m);
    assert.match(readFileSync(path.join(projectDir, 'EXECUTOR.md'), 'utf8'), /^<!-- executor-policy-version: 1\.9 -->/m);
    assert.equal(
      readFileSync(path.join(projectDir, 'EXECUTOR.md'), 'utf8'),
      readFileSync(path.join(projSkillDir, 'EXECUTOR.md'), 'utf8'),
      'root EXECUTOR.md must be synced byte-for-byte with updated skill EXECUTOR.md',
    );
    assert.equal(
      readFileSync(path.join(projSkillDir, '.version'), 'utf8').trim(),
      `v3.99 / 1.9 (${upstreamSha})`,
      '.version file must record updated version and commit SHA',
    );
    assert.equal(readFileSync(cfgPath, 'utf8'), customCfg, 'project config.json must not be modified by --update');
    assert.equal(existsSync(path.join(projectDir, '.git', 'hooks', 'commit-msg')), true, 'commit-msg hook must be installed/refreshed');
    assert.ok(lines.some((l) => l.includes('v3.99 / 1.9') && l.includes(upstreamSha)), 'output must report updated version and commit SHA');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-075 (a): checkSkillUpdateAvailable detects newer upstream commit, caches result for 24h in .agent-runs/.update-check.json, and clears after updateSkill', async () => {
  assert.equal(typeof cliMod.checkSkillUpdateAvailable, 'function', 'cli.mjs must export checkSkillUpdateAvailable');

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-check-test-')));
  try {
    const upstreamDir = path.join(tmp, 'upstream');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const initialSha = initUpstreamRepo(upstreamDir, 'v3.30', '1.8');

    execFileSync('git', ['init', '-b', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: projectDir, stdio: 'ignore' });

    const projSkillDir = path.join(projectDir, '.agents', 'skills', 'architect');
    mkdirSync(path.dirname(projSkillDir), { recursive: true });
    cpSync(skillDir, projSkillDir, { recursive: true });
    writeFileSync(path.join(projSkillDir, '.version'), `v3.30 / 1.8 (${initialSha})\n`);
    writeFileSync(path.join(projectDir, 'EXECUTOR.md'), readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8'));

    const fixedNow = 1_700_000_000_000;
    const sameCheck = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      nowMs: fixedNow,
    });
    assert.equal(sameCheck.updateAvailable, false, 'no update when local .version SHA matches upstream HEAD');
    assert.equal(sameCheck.notice, null);

    // Advance upstream with a new commit
    writeFileSync(path.join(upstreamDir, 'CHANGELOG.md'), '# New release\n');
    execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: upstreamDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'arch: new upstream commit'], { cwd: upstreamDir, stdio: 'ignore' });
    const newerSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: upstreamDir, encoding: 'utf8' }).trim();

    // Within 24h TTL, cached result should still be returned without hitting upstream
    const cachedSame = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      nowMs: fixedNow + 1000,
    });
    assert.equal(cachedSame.cached, true, 'must use 24h cache within TTL');
    assert.equal(cachedSame.updateAvailable, false);

    // After 24h TTL expires, check hits upstream and detects newerSha
    const afterTtl = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      nowMs: fixedNow + 25 * 60 * 60 * 1000,
    });
    assert.equal(afterTtl.updateAvailable, true, 'must detect newer upstream SHA after cache TTL expires');
    assert.equal(afterTtl.localSha, initialSha);
    assert.ok(afterTtl.remoteSha.startsWith(newerSha.slice(0, 7)));
    assert.match(afterTtl.notice, /skill update available/i);
    assert.match(afterTtl.notice, /--update/);

    // Running handleUpdateCli updates .version and clears/refreshes update cache
    await cliMod.handleUpdateCli({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      print: () => {},
    });
    const postUpdate = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      nowMs: fixedNow + 25 * 60 * 60 * 1000 + 5000,
    });
    assert.equal(postUpdate.updateAvailable, false, 'updateAvailable must be false immediately after updating');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-075 (b): checkSkillUpdateAvailable fails open on unreachable repo and surfaces ! notice in runCheckCommand and startup notices', async () => {
  assert.equal(typeof cliMod.checkSkillUpdateAvailable, 'function', 'cli.mjs must export checkSkillUpdateAvailable');

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-check-failopen-')));
  try {
    const upstreamDir = path.join(tmp, 'upstream');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const upstreamSha = initUpstreamRepo(upstreamDir, 'v3.99', '1.9');

    execFileSync('git', ['init', '-b', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: projectDir, stdio: 'ignore' });

    const projSkillDir = path.join(projectDir, '.agents', 'skills', 'architect');
    mkdirSync(path.dirname(projSkillDir), { recursive: true });
    cpSync(skillDir, projSkillDir, { recursive: true });
    writeFileSync(path.join(projSkillDir, '.version'), 'v3.30 / 1.8 (0000000)\n');

    // Unreachable repo must fail open without throwing
    const unreachable = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: path.join(tmp, 'does-not-exist-repo'),
      realGit: 'git',
    });
    assert.equal(unreachable.updateAvailable, false, 'unreachable repo must fail open with updateAvailable: false');
    assert.equal(unreachable.notice, null);

    // Populate cache from reachable upstream with newer commit
    const detected = cliMod.checkSkillUpdateAvailable({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      force: true,
    });
    assert.equal(detected.updateAvailable, true);
    assert.ok(detected.notice.includes(upstreamSha.slice(0, 7)));

    // Startup notices and self-check report include update notice
    const notices = cliMod.formatStartupNotices({ updateNotice: detected.notice });
    assert.ok(notices.some((n) => n.startsWith('! ') && n.includes('skill update available')));

    const printed = [];
    await runCheckCommand({
      config: { ...DEFAULTS, permissions: 'skip', executor: { model: 'gemini-3-flash' }, architect: { model: 'gemini-4-argon-high' } },
      workDir: projectDir,
      realGit: 'git',
      print: (line) => printed.push(line),
    });
    assert.ok(
      printed.some((line) => line.startsWith('! ') && line.includes('skill update available')),
      'runCheckCommand must print "! skill update available: ..." notice when update is available',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-077: --update refuses to overwrite uncommitted tracked changes in skill folder or EXECUTOR.md unless --force is passed, while allowing dirty project files outside the skill', async () => {
  const withForce = parseArgs(['--update', '--force']);
  assert.equal(withForce.update, true);
  assert.equal(withForce.force, true);
  assert.throws(
    () => parseArgs(['--check', '--force']),
    /--force is allowed only with --update/,
    '--force must be rejected when --update is not set',
  );

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'update-dirty-guard-test-')));
  try {
    const upstreamDir = path.join(tmp, 'upstream');
    const projectDir = path.join(tmp, 'project');
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const upstreamSha = initUpstreamRepo(upstreamDir, 'v3.99', '1.9');

    execFileSync('git', ['init', '-b', 'master'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: projectDir, stdio: 'ignore' });

    const projSkillDir = path.join(projectDir, '.agents', 'skills', 'architect');
    mkdirSync(path.dirname(projSkillDir), { recursive: true });
    cpSync(skillDir, projSkillDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'EXECUTOR.md'), readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8'));
    writeFileSync(path.join(projectDir, 'app.js'), 'export const v = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: projectDir, stdio: 'ignore' });

    // 1. Dirty project file outside skill folder (app.js) does NOT block --update
    writeFileSync(path.join(projectDir, 'app.js'), 'export const v = 2;\n');
    const cleanSkillRes = await cliMod.handleUpdateCli({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      print: () => {},
    });
    assert.equal(cleanSkillRes.ok, true, 'dirty project files outside skill folder must not block --update');
    assert.equal(readFileSync(path.join(projectDir, 'app.js'), 'utf8'), 'export const v = 2;\n', 'dirty project file must remain untouched');
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'commit updated skill'], { cwd: projectDir, stdio: 'ignore' });

    // 2. Dirty tracked file inside .agents/skills/architect/ blocks --update without --force
    const localSkillMd = path.join(projSkillDir, 'SKILL.md');
    writeFileSync(localSkillMd, '# Architect Prompt v3.50\nLOCAL UNCOMMITTED EDIT\n');
    const lines = [];
    const blockedSkillRes = await cliMod.handleUpdateCli({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      print: (l) => lines.push(l),
    });
    assert.equal(blockedSkillRes.ok, false, '--update must fail when tracked skill files have uncommitted edits');
    assert.match(blockedSkillRes.error, /uncommitted changes in skill files/i);
    assert.match(blockedSkillRes.error, /--force/);
    assert.match(readFileSync(localSkillMd, 'utf8'), /LOCAL UNCOMMITTED EDIT/, 'local uncommitted edit in SKILL.md must not be overwritten');

    // 3. Passing force: true (--update --force) overwrites dirty skill files and updates cleanly
    const forcedRes = await cliMod.handleUpdateCli({
      workDir: projectDir,
      orchestratorDir: path.join(projSkillDir, 'orchestrator'),
      repoUrl: upstreamDir,
      realGit: 'git',
      force: true,
      print: () => {},
    });
    assert.equal(forcedRes.ok, true, '--update --force must succeed and overwrite dirty skill files');
    assert.equal(forcedRes.commitSha, upstreamSha);
    assert.match(readFileSync(localSkillMd, 'utf8'), /^# Architect Prompt v3\.99/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
