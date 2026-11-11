// Frozen reference test: Claude Code setup — runner choice for --init, the .claude/skills/architect link, and non-blocking --check warnings.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClaudeSetup, detectInitRunner, ensureClaudeSkillLink } from './claude-setup.mjs';
import { initProject } from './config.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const runMjs = path.join(orchDir, 'run.mjs');
const LINK_TARGET = path.join('..', '..', '.agents', 'skills', 'architect');
let tmp;
let prevAgentLoop;

beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-setup-')));
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
  rmSync(tmp, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeProject(name = 'project', { repo = false, skill = true } = {}) {
  const workDir = path.join(tmp, name);
  mkdirSync(workDir, { recursive: true });
  if (repo) {
    git(workDir, 'init', '-q', '-b', 'master');
    git(workDir, 'config', 'user.email', 'test@example.com');
    git(workDir, 'config', 'user.name', 'Test');
  }
  const agents = path.join(workDir, '.agents', 'skills', 'architect');
  if (skill) {
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, 'SKILL.md'), '---\nname: architect\n---\n\n# Architect Prompt v3.47\n');
  }
  return { workDir, agents, claude: path.join(workDir, '.claude', 'skills', 'architect'), home: path.join(tmp, `${name}-home`) };
}

function findGit() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'git');
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error('git not found in PATH');
}

/** PATH with a fake `claude`, the real `git`, and no `agy`. */
function fakeBinPath() {
  const bin = path.join(tmp, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.308 (Claude Code)"\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  symlinkSync(findGit(), path.join(bin, 'git'));
  return [bin, '/usr/bin', '/bin'].join(path.delimiter);
}

function cliEnv(home, extra = {}) {
  const env = { ...process.env, AGENT_LOOP: '', ARCHITECT_NO_UPDATE_CHECK: '1', HOME: home, ...extra };
  if (!('CLAUDECODE' in extra)) delete env.CLAUDECODE;
  return env;
}

test('detectInitRunner: claude only inside Claude Code with claude present and agy absent', () => {
  const only = (...bins) => (b) => bins.includes(b);
  assert.equal(detectInitRunner({ env: { CLAUDECODE: '1' }, hasBin: only('claude') }), 'claude');
  assert.equal(detectInitRunner({ env: { CLAUDECODE: '1' }, hasBin: only('claude', 'agy') }), null);
  assert.equal(detectInitRunner({ env: { CLAUDECODE: '1' }, hasBin: only() }), null);
  assert.equal(detectInitRunner({ env: {}, hasBin: only('claude') }), null);
  assert.equal(detectInitRunner({ env: { CLAUDECODE: '0' }, hasBin: only('claude') }), null);
  assert.equal(detectInitRunner(), null);
});

test('initProject: writes runner only when one is passed, otherwise the config is unchanged from today', () => {
  const a = makeProject('a', { repo: true });
  initProject({ workDir: a.workDir, realGit: 'git', runner: 'claude' });
  assert.equal(JSON.parse(readFileSync(path.join(a.workDir, '.architect', 'config.json'), 'utf8')).runner, 'claude');

  const b = makeProject('b', { repo: true });
  initProject({ workDir: b.workDir, realGit: 'git' });
  assert.equal('runner' in JSON.parse(readFileSync(path.join(b.workDir, '.architect', 'config.json'), 'utf8')), false);
});

test('ensureClaudeSkillLink: links .claude/skills/architect to .agents/skills/architect inside Claude Code or for the claude runner', () => {
  const a = makeProject('a');
  const r1 = ensureClaudeSkillLink({ workDir: a.workDir, skillDir: a.agents, env: { CLAUDECODE: '1' } });
  assert.equal(r1.created, true);
  assert.match(r1.reason, /\.claude\/skills\/architect/);
  assert.equal(lstatSync(a.claude).isSymbolicLink(), true);
  assert.equal(readlinkSync(a.claude), LINK_TARGET);
  assert.match(readFileSync(path.join(a.claude, 'SKILL.md'), 'utf8'), /Architect Prompt/);

  const b = makeProject('b');
  assert.equal(ensureClaudeSkillLink({ workDir: b.workDir, skillDir: b.agents, env: {}, runner: 'claude' }).created, true);
  assert.equal(readlinkSync(b.claude), LINK_TARGET);
});

test('ensureClaudeSkillLink: does nothing outside Claude Code, without an .agents install, or when the path already exists', () => {
  const a = makeProject('a');
  assert.equal(ensureClaudeSkillLink({ workDir: a.workDir, skillDir: a.agents, env: {}, runner: 'agy' }).created, false);
  assert.equal(existsSync(path.join(a.workDir, '.claude')), false, 'no .claude folder outside Claude Code');

  const b = makeProject('b');
  mkdirSync(b.claude, { recursive: true });
  writeFileSync(path.join(b.claude, 'SKILL.md'), 'own copy\n');
  assert.equal(ensureClaudeSkillLink({ workDir: b.workDir, skillDir: b.agents, env: { CLAUDECODE: '1' } }).created, false);
  assert.equal(lstatSync(b.claude).isDirectory(), true);
  assert.equal(readFileSync(path.join(b.claude, 'SKILL.md'), 'utf8'), 'own copy\n');

  const c = makeProject('c');
  mkdirSync(path.dirname(c.claude), { recursive: true });
  symlinkSync(path.join('..', '..', 'missing'), c.claude, 'dir');
  assert.equal(ensureClaudeSkillLink({ workDir: c.workDir, skillDir: c.agents, env: { CLAUDECODE: '1' } }).created, false);
  assert.equal(readlinkSync(c.claude), path.join('..', '..', 'missing'), 'a dangling link is left as it is');

  const d = makeProject('d', { skill: false });
  mkdirSync(d.claude, { recursive: true });
  writeFileSync(path.join(d.claude, 'SKILL.md'), 'installed for Claude Code\n');
  assert.equal(ensureClaudeSkillLink({ workDir: d.workDir, skillDir: d.claude, env: { CLAUDECODE: '1' } }).created, false);
  assert.equal(existsSync(path.join(d.workDir, '.agents')), false);

  const e = makeProject('e');
  assert.equal(ensureClaudeSkillLink({ workDir: e.workDir, skillDir: null, env: { CLAUDECODE: '1' } }).created, false);
  assert.equal(existsSync(path.join(e.workDir, '.claude')), false);
});

test('checkClaudeSetup: warns that the skill is not discoverable only for Claude Code projects without a reachable SKILL.md', () => {
  const plain = makeProject('plain');
  assert.deepEqual(checkClaudeSetup({ workDir: plain.workDir, home: plain.home }), []);

  const byRunner = makeProject('runner');
  const w1 = checkClaudeSetup({ workDir: byRunner.workDir, runner: 'claude', home: byRunner.home });
  assert.equal(w1.length, 1);
  assert.equal(w1[0].name, 'Claude Code skill');
  assert.match(w1[0].detail, /not discoverable/);
  assert.match(w1[0].detail, /\.claude\/skills\/architect/);

  const byDir = makeProject('dir');
  mkdirSync(path.join(byDir.workDir, '.claude'), { recursive: true });
  writeFileSync(path.join(byDir.workDir, '.claude', 'settings.json'), '{}\n');
  assert.deepEqual(checkClaudeSetup({ workDir: byDir.workDir, home: byDir.home }).map((w) => w.name), ['Claude Code skill']);

  const linked = makeProject('linked');
  mkdirSync(path.dirname(linked.claude), { recursive: true });
  symlinkSync(LINK_TARGET, linked.claude, 'dir');
  assert.deepEqual(checkClaudeSetup({ workDir: linked.workDir, runner: 'claude', home: linked.home }), []);

  const userLevel = makeProject('user');
  mkdirSync(path.join(userLevel.home, '.claude', 'skills', 'architect'), { recursive: true });
  writeFileSync(path.join(userLevel.home, '.claude', 'skills', 'architect', 'SKILL.md'), 'user skill\n');
  assert.deepEqual(checkClaudeSetup({ workDir: userLevel.workDir, runner: 'claude', home: userLevel.home }), []);
});

test('checkClaudeSetup: warns when a Claude memory file hides an AGENTS.md roles block', () => {
  const roles = '# Roles\n- Executor session: read EXECUTOR.md and PLAN.md first.\n';
  const names = (p) => checkClaudeSetup({ workDir: p.workDir, home: p.home }).map((w) => w.name);

  const hidden = makeProject('hidden');
  writeFileSync(path.join(hidden.workDir, 'AGENTS.md'), roles);
  writeFileSync(path.join(hidden.workDir, 'CLAUDE.md'), '# Claude notes\n');
  const w = checkClaudeSetup({ workDir: hidden.workDir, home: hidden.home });
  assert.deepEqual(w.map((x) => x.name), ['CLAUDE.md']);
  assert.match(w[0].detail, /@AGENTS\.md/);

  const imported = makeProject('imported');
  writeFileSync(path.join(imported.workDir, 'AGENTS.md'), roles);
  writeFileSync(path.join(imported.workDir, 'CLAUDE.md'), '@AGENTS.md\n\n# Claude notes\n');
  assert.deepEqual(names(imported), []);

  const nested = makeProject('nested');
  writeFileSync(path.join(nested.workDir, 'AGENTS.md'), roles);
  mkdirSync(path.join(nested.workDir, '.claude'), { recursive: true });
  writeFileSync(path.join(nested.workDir, '.claude', 'CLAUDE.md'), '  @./AGENTS.md  \n');
  mkdirSync(path.dirname(nested.claude), { recursive: true });
  symlinkSync(LINK_TARGET, nested.claude, 'dir');
  assert.deepEqual(names(nested), []);

  const own = makeProject('own');
  writeFileSync(path.join(own.workDir, 'AGENTS.md'), roles);
  writeFileSync(path.join(own.workDir, 'CLAUDE.md'), roles);
  assert.deepEqual(names(own), []);

  const local = makeProject('local');
  writeFileSync(path.join(local.workDir, 'AGENTS.md'), roles);
  writeFileSync(path.join(local.workDir, 'CLAUDE.local.md'), '# personal\n');
  assert.deepEqual(names(local), ['CLAUDE.md']);

  const unrelated = makeProject('unrelated');
  writeFileSync(path.join(unrelated.workDir, 'AGENTS.md'), '# Style guide\n');
  writeFileSync(path.join(unrelated.workDir, 'CLAUDE.md'), '# Claude notes\n');
  assert.deepEqual(names(unrelated), []);

  const noMemory = makeProject('nomemory');
  writeFileSync(path.join(noMemory.workDir, 'AGENTS.md'), roles);
  assert.deepEqual(names(noMemory), []);
});

test('CLI --init: inside Claude Code without agy it picks the claude runner and links the skill; outside it changes nothing', () => {
  const pathVar = fakeBinPath();

  const inside = makeProject('inside', { repo: true });
  const r1 = spawnSync(process.execPath, [runMjs, '--init'], { cwd: inside.workDir, env: cliEnv(inside.home, { CLAUDECODE: '1', PATH: pathVar }), encoding: 'utf8' });
  assert.equal(r1.status, 0, `--init must succeed: ${r1.stderr}`);
  assert.equal(JSON.parse(readFileSync(path.join(inside.workDir, '.architect', 'config.json'), 'utf8')).runner, 'claude');
  assert.equal(lstatSync(inside.claude).isSymbolicLink(), true);
  assert.equal(readlinkSync(inside.claude), LINK_TARGET);
  assert.match(r1.stdout, /\.claude\/skills\/architect/);

  const outside = makeProject('outside', { repo: true });
  const r2 = spawnSync(process.execPath, [runMjs, '--init'], { cwd: outside.workDir, env: cliEnv(outside.home, { PATH: pathVar }), encoding: 'utf8' });
  assert.equal(r2.status, 0, `--init must succeed: ${r2.stderr}`);
  assert.equal('runner' in JSON.parse(readFileSync(path.join(outside.workDir, '.architect', 'config.json'), 'utf8')), false);
  assert.equal(existsSync(path.join(outside.workDir, '.claude')), false);
});

test('CLI --check: Claude Code warnings are printed with "!" and never as a failed check', () => {
  const pathVar = fakeBinPath();
  const writeConfig = (p) => {
    mkdirSync(path.join(p.workDir, '.architect'), { recursive: true });
    writeFileSync(path.join(p.workDir, '.architect', 'config.json'), JSON.stringify({ layout: 'compact', runner: 'claude', executor: { model: 'sonnet' }, architect: { model: 'opus' } }, null, 2) + '\n');
  };

  const missing = makeProject('missing', { repo: true });
  writeConfig(missing);
  const r1 = spawnSync(process.execPath, [runMjs, '--check'], { cwd: missing.workDir, env: cliEnv(missing.home, { PATH: pathVar }), encoding: 'utf8' });
  assert.match(r1.stdout, /^! Claude Code skill: .*not discoverable/m, r1.stdout + r1.stderr);
  assert.doesNotMatch(r1.stdout, /^✗ Claude Code skill/m);

  const linked = makeProject('linked', { repo: true });
  writeConfig(linked);
  mkdirSync(path.dirname(linked.claude), { recursive: true });
  symlinkSync(LINK_TARGET, linked.claude, 'dir');
  const r2 = spawnSync(process.execPath, [runMjs, '--check'], { cwd: linked.workDir, env: cliEnv(linked.home, { PATH: pathVar }), encoding: 'utf8' });
  assert.doesNotMatch(r2.stdout, /Claude Code skill/, r2.stdout + r2.stderr);
});
