import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli.mjs';
import * as cliMod from './cli.mjs';

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
