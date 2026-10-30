// Frozen reference test for T-027 (allowlist-based path validation for agy and claude, symlink/segment checks, external skill read, and per-project claude settings).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import {
  agySettingsPath,
  permissionsCheck,
  ruleProblem,
  rulesFor,
  writeAgyAllowlist,
} from './permissions.mjs';
import {
  CLAUDE_SETTINGS_SHOWN,
  claudePermissionsCheck,
  claudeRulesFor,
  claudeSettingsPath,
  writeClaudeAllowlist,
} from './adapters/claude.mjs';

let root;
let home;
let workDir;
let siblingPrefixDir;
let otherProjectDir;
let externalSkillDir;

const config = (extra = {}) => ({
  ...DEFAULTS,
  blockedScripts: ['ship', 'deploy'],
  allowedCommands: ['npm test'],
  ...extra,
});

const toAbsPattern = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-perm-s3-')));
  home = path.join(root, 'home');
  workDir = path.join(home, 'projects', 'Workspace');
  siblingPrefixDir = path.join(home, 'projects', 'Workspace-old');
  otherProjectDir = path.join(home, 'projects', 'other-project');
  externalSkillDir = path.join(root, 'external-skills', 'architect');

  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  mkdirSync(path.join(workDir, 'src'), { recursive: true });
  mkdirSync(siblingPrefixDir, { recursive: true });
  mkdirSync(otherProjectDir, { recursive: true });
  mkdirSync(externalSkillDir, { recursive: true });
  writeFileSync(path.join(externalSkillDir, 'SKILL.md'), '# Skill\n');
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeFileSync(path.join(home, '.zshrc'), 'export PATH=$PATH\n');

  // Symlink inside project pointing outside to ~/.ssh
  symlinkSync(path.join(home, '.ssh'), path.join(workDir, 'ssh-link'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('Invariants 1, 2, 3 (agy): ruleProblem and permissionsCheck enforce allowlist for write_file and read_file, reject ~/.ssh, ~/.zshrc, /etc, other projects, prefix-Collisions, .., and symlinks outside workDir', () => {
  const baseRules = rulesFor(config(), workDir);
  const externalSkillFile = path.join(externalSkillDir, 'SKILL.md');
  const ctx = {
    blockedScripts: ['ship'],
    workDir,
    home,
    deny: baseRules.deny,
    skillFilePath: externalSkillFile,
  };

  // Allowed ("ок") rules:
  assert.equal(ruleProblem(`write_file(${workDir})`, ctx), null, 'write_file(<workDir>) with .git and .claude deny is ok');
  assert.equal(ruleProblem(`write_file(${path.join(workDir, 'src')})`, ctx), null, 'write_file(<workDir>/src) is ok');
  assert.equal(ruleProblem(`read_file(${workDir})`, ctx), null, 'read_file(<workDir>) is ok');
  assert.equal(ruleProblem(`read_file(${path.join(workDir, 'src')})`, ctx), null, 'read_file(<workDir>/src) is ok');
  assert.equal(ruleProblem(`read_file(${externalSkillDir})`, ctx), null, 'read_file(<external skill dir>) is ok (Invariant 2, C3)');
  assert.equal(ruleProblem(`read_file(${externalSkillFile})`, ctx), null, 'read_file(<external SKILL.md>) is ok (Invariant 2, C3)');

  // Writing to external skill dir must be rejected (Invariant 1):
  assert.ok(ruleProblem(`write_file(${externalSkillDir})`, ctx), 'write_file(<external skill dir>) must be rejected');

  // Unsafe ("опасно") targets:
  const unsafeTargets = [
    `write_file(${path.join(home, '.ssh')})`,
    `write_file(${path.join(home, '.ssh', 'authorized_keys')})`,
    `write_file(${path.join(home, '.zshrc')})`,
    `write_file(${otherProjectDir})`,
    'write_file(/etc)',
    'write_file(/etc/passwd)',
    `write_file(${siblingPrefixDir})`,
    `write_file(${workDir}/../other-project)`,
    `write_file(${path.join(workDir, 'ssh-link')})`,
    `write_file(${path.join(workDir, 'ssh-link', 'id_rsa')})`,
    `read_file(${path.join(home, '.ssh')})`,
    `read_file(${path.join(home, '.zshrc')})`,
    `read_file(${otherProjectDir})`,
    'read_file(/etc/passwd)',
    `read_file(${siblingPrefixDir})`,
    `read_file(${workDir}/../other-project)`,
    `read_file(${path.join(workDir, 'ssh-link')})`,
    `read_file(${path.join(workDir, 'ssh-link', 'id_rsa')})`,
  ];

  for (const r of unsafeTargets) {
    assert.ok(ruleProblem(r, ctx), `agy ruleProblem must reject unsafe rule: ${r}`);
  }

  // Other-project write rule produces a clear explanation with guidance and never deletes user rules automatically:
  const settingsPath = agySettingsPath(home);
  const otherRule = `write_file(${otherProjectDir})`;
  writeAgyAllowlist({
    settingsPath,
    allow: [...baseRules.allow, otherRule],
    deny: baseRules.deny,
  });
  const checkRes = permissionsCheck({ config: config(), settingsPath, workDir, home, skillFilePath: externalSkillFile });
  assert.equal(checkRes.ok, false, 'other-project write_file must fail permissionsCheck');
  assert.match(checkRes.detail, /write_file\(~\/projects\/other-project\)/, 'must name the offending rule');
  assert.match(checkRes.detail, /вне текущего проекта|outside the current project/i, 'must explain why the rule is rejected');
  assert.match(checkRes.detail, /другого проекта|по очереди|other project rule|one at a time/i, 'must explain what to do (remove other project rule or run loops one by one)');

  const preserved = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(preserved.permissions.allow.includes(otherRule), 'permissionsCheck must never delete user rules on its own');
});

test('Invariants 1, 2, 3, 4 (claude): claudePermissionsCheck enforces allowlist for Edit/Write/Read, rejects ~/... and relative paths in allow, and isolates settings per project when workDir is passed', () => {
  // Backward compatibility: 1-arg claudeSettingsPath(home) still returns ~/.config/architect/claude-settings.json
  assert.equal(CLAUDE_SETTINGS_SHOWN, '~/.config/architect/claude-settings.json');
  assert.equal(claudeSettingsPath(home), path.join(home, '.config', 'architect', 'claude-settings.json'));

  // Per-project settings file when workDir is provided: outside project, under ~/.config/architect/claude/<name>-<hash>.json
  const projSettings = claudeSettingsPath(home, workDir);
  const otherSettings = claudeSettingsPath(home, otherProjectDir);
  assert.equal( path.dirname(projSettings), path.join(home, '.config', 'architect', 'claude'));
  assert.match(path.basename(projSettings), /^Workspace-[0-9a-f]{8}\.json$/);
  assert.notEqual(projSettings, otherSettings, 'different projects must get distinct claude settings files');

  const externalSkillFile = path.join(externalSkillDir, 'SKILL.md');
  const baseRules = claudeRulesFor(config({ runner: 'claude' }), workDir, home);

  // Allowed ("ок"): Edit/Write(//<workDir>/**) with .git and .claude deny, plus Read(//<externalSkillDir>/**)
  writeClaudeAllowlist({
    settingsPath: projSettings,
    allow: [
      ...baseRules.allow,
      `Read(${toAbsPattern(externalSkillDir)}/**)`,
    ],
    deny: baseRules.deny,
  });
  const okCheck = claudePermissionsCheck({
    config: config({ runner: 'claude' }),
     workDir,
    home,
    skillFilePath: externalSkillFile,
  });
  assert.equal(okCheck.ok, true, okCheck.detail);

  // Unsafe ("опасно") rules in claude allow:
  const unsafeClaudeRules = [
    `Edit(${toAbsPattern(path.join(home, '.ssh'))}/**)`,
    `Write(${toAbsPattern(path.join(home, '.zshrc'))})`,
    `Edit(${toAbsPattern(otherProjectDir)}/**)`,
    'Write(//etc/**)',
    'Read(//etc/passwd)',
    `Edit(${toAbsPattern(siblingPrefixDir)}/**)`,
    `Write(${toAbsPattern(workDir)}/../other-project/**)`,
    `Edit(${toAbsPattern(path.join(workDir, 'ssh-link'))}/**)`,
    `Read(${toAbsPattern(path.join(workDir, 'ssh-link'))}/**)`,
    `Read(${toAbsPattern(path.join(home, '.ssh'))}/**)`,
    'Edit(~/projects/Workspace/**)',
    'Write(~/.ssh/**)',
    'Read(~/projects/Workspace/**)',
    'Edit(src/**)',
    'Write(./src/index.ts)',
    'Read(README.md)',
    `Edit(${toAbsPattern(externalSkillDir)}/**)`,
  ];

  for (const badRule of unsafeClaudeRules) {
    const tmpSettings = path.join(root, 'claude-bad.json');
    writeClaudeAllowlist({
      settingsPath: tmpSettings,
      allow: [...baseRules.allow, badRule],
      deny: baseRules.deny,
    });
    const res = claudePermissionsCheck({
      config: config({ runner: 'claude' }),
      settingsPath: tmpSettings,
      workDir,
      home,
      skillFilePath: externalSkillFile,
    });
    assert.equal(res.ok, false, `claudePermissionsCheck must reject unsafe rule: ${badRule}`);
    assert.ok(res.detail.includes(badRule), `detail must report ${badRule}, got: ${res.detail}`);
    if (badRule === `Edit(${toAbsPattern(otherProjectDir)}/**)`) {
      assert.match(res.detail, /вне текущего проекта|outside the current project/i);
      assert.match(res.detail, /другого проекта|по очереди|other project rule|one at a time/i);
    }
    rmSync(tmpSettings, { force: true });
  }
});
