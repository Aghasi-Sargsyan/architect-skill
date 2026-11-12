// Frozen reference test: `--update` resolves skill folders by real path and never replaces a symlink with a copy.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSkillUpdateTargets } from './skill-targets.mjs';
import { handleUpdateCli, updateSkill } from './update.mjs';

const LINK_TARGET = path.join('..', '..', '.agents', 'skills', 'architect');
let prevAgentLoop;
let tmp;

beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skill-targets-')));
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(dir, version = 'v3.47') {
  mkdirSync(path.join(dir, 'orchestrator'), { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: architect\n---\n\n# Architect Prompt ${version}\n`);
  writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n# Executor\n');
  writeFileSync(path.join(dir, 'orchestrator', 'marker.txt'), `${version}\n`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

function makeProject(name = 'project') {
  const workDir = path.join(tmp, name);
  mkdirSync(workDir, { recursive: true });
  return {
    workDir,
    agents: path.join(workDir, '.agents', 'skills', 'architect'),
    claude: path.join(workDir, '.claude', 'skills', 'architect'),
  };
}

function linkClaudeToAgents(p) {
  mkdirSync(path.dirname(p.claude), { recursive: true });
  symlinkSync(LINK_TARGET, p.claude, 'dir');
}

function makeUpstream() {
  const upstream = path.join(tmp, 'upstream');
  initRepo(upstream);
  writeSkill(path.join(upstream, '.agents', 'skills', 'architect'), 'v3.99');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'arch: release v3.99');
  git(upstream, 'tag', 'v3.99.0'); // C-39 (ADR-076): --update installs release tags only
  return upstream;
}

function commitProject(workDir) {
  writeFileSync(path.join(workDir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n# Executor\n');
  git(workDir, 'add', '.');
  git(workDir, 'commit', '-q', '-m', 'arch: install skill');
}

test('resolveSkillUpdateTargets: .claude symlink to .agents yields one real target and no skipped entries', () => {
  const p = makeProject();
  writeSkill(p.agents);
  linkClaudeToAgents(p);
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
  assert.deepEqual(res, { targets: [p.agents], skipped: [] });
});

test('resolveSkillUpdateTargets: an orchestrator spelled through the .claude symlink is de-duplicated by real path', () => {
  const p = makeProject();
  writeSkill(p.agents);
  linkClaudeToAgents(p);
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(p.claude, 'orchestrator') });
  assert.deepEqual(res, { targets: [p.agents], skipped: [] });
});

test('resolveSkillUpdateTargets: a reverse link (.agents -> .claude) targets the real .claude folder, never the link', () => {
  const p = makeProject();
  writeSkill(p.claude);
  mkdirSync(path.dirname(p.agents), { recursive: true });
  symlinkSync(path.join('..', '..', '.claude', 'skills', 'architect'), p.agents, 'dir');
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
  assert.deepEqual(res, { targets: [p.claude], skipped: [] });
});

test('resolveSkillUpdateTargets: two independent real copies stay two targets in candidate order', () => {
  const p = makeProject();
  writeSkill(p.agents);
  writeSkill(p.claude);
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
  assert.deepEqual(res, { targets: [p.agents, p.claude], skipped: [] });
});

test('resolveSkillUpdateTargets: a link resolving outside the project is skipped, never a target', () => {
  const p = makeProject();
  writeSkill(p.agents);
  const external = path.join(tmp, 'external-skill');
  writeSkill(external);
  mkdirSync(path.dirname(p.claude), { recursive: true });
  symlinkSync(external, p.claude, 'dir');
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
  assert.deepEqual(res, { targets: [p.agents], skipped: [p.claude] });
});

test('resolveSkillUpdateTargets: a dangling .claude link is ignored without throwing', () => {
  const p = makeProject();
  writeSkill(p.agents);
  mkdirSync(path.dirname(p.claude), { recursive: true });
  symlinkSync(path.join('..', '..', 'missing', 'architect'), p.claude, 'dir');
  const res = resolveSkillUpdateTargets({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator') });
  assert.deepEqual(res, { targets: [p.agents], skipped: [] });
  assert.equal(lstatSync(p.claude).isSymbolicLink(), true);
});

test('updateSkill: a .claude symlink survives --update, the real folder is updated once, and git sees no change to the link', async () => {
  const upstream = makeUpstream();
  const p = makeProject();
  initRepo(p.workDir);
  writeSkill(p.agents);
  linkClaudeToAgents(p);
  commitProject(p.workDir);

  const res = await updateSkill({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator'), repoUrl: upstream });

  assert.equal(res.ok, true);
  assert.deepEqual(res.targetDirs, [p.agents]);
  assert.deepEqual(res.skippedDirs, []);
  assert.equal(lstatSync(p.claude).isSymbolicLink(), true, '.claude/skills/architect must stay a symlink');
  assert.equal(readlinkSync(p.claude), LINK_TARGET);
  assert.match(readFileSync(path.join(p.claude, 'SKILL.md'), 'utf8'), /# Architect Prompt v3\.99/);
  assert.equal(readFileSync(path.join(p.agents, 'orchestrator', 'marker.txt'), 'utf8'), 'v3.99\n');
  assert.ok(existsSync(path.join(p.agents, '.version')));
  assert.equal(git(p.workDir, 'status', '--porcelain', '--', '.claude').trim(), '');
});

test('updateSkill and handleUpdateCli: a link outside the project is reported as skipped and its target is left untouched', async () => {
  const upstream = makeUpstream();
  const p = makeProject();
  initRepo(p.workDir);
  writeSkill(p.agents);
  const external = path.join(tmp, 'external-skill');
  writeSkill(external, 'v3.10');
  mkdirSync(path.dirname(p.claude), { recursive: true });
  symlinkSync(external, p.claude, 'dir');
  commitProject(p.workDir);

  const lines = [];
  await handleUpdateCli({ workDir: p.workDir, orchestratorDir: path.join(tmp, 'elsewhere', 'orchestrator'), repoUrl: upstream, print: (m) => lines.push(m) });

  assert.equal(lstatSync(p.claude).isSymbolicLink(), true);
  assert.match(readFileSync(path.join(external, 'SKILL.md'), 'utf8'), /# Architect Prompt v3\.10/);
  assert.equal(existsSync(path.join(external, '.version')), false, 'a folder outside the project must not be updated');
  assert.match(readFileSync(path.join(p.agents, 'SKILL.md'), 'utf8'), /# Architect Prompt v3\.99/);
  const out = lines.join('\n');
  assert.match(out, /updated: \.agents\/skills\/architect/);
  assert.match(out, /skipped \(outside project\): \.claude\/skills\/architect/);
  assert.doesNotMatch(out, /updated: \.claude\/skills\/architect/);
});
