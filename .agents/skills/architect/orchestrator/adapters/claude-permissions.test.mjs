// Frozen reference test for T-028 and T-029 (Claude sandbox allowUnsandboxedCommands: false, narrow .git deny rules including .git/info/**, GUARDED_UNTRACKED_FILES .git/info/exclude, and external skill additionalDirectories + deny Edit/Write).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../config.mjs';
import { GUARDED_UNTRACKED_FILES } from '../guards.mjs';
import { controlShimDir } from '../control-dir.mjs';
import {
  claudePermissionsCheck,
  claudeRulesFor,
  claudeSettingsPath,
  writeClaudeAllowlist,
} from './claude.mjs';

let root;
let home;
let workDir;
let externalSkillDir;
let internalSkillDir;

const config = (extra = {}) => ({
  ...DEFAULTS,
  runner: 'claude',
  blockedScripts: ['ship'],
  allowedCommands: ['npm test'],
  ...extra,
});

const toAbsPattern = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-claude-t028-')));
  home = path.join(root, 'home');
  workDir = path.join(home, 'projects', 'app');
  externalSkillDir = path.join(root, 'external-skills', 'architect');
  internalSkillDir = path.join(workDir, '.agents', 'skills', 'architect');

  mkdirSync(path.join(workDir, '.git', 'hooks'), { recursive: true });
  mkdirSync(path.join(workDir, '.git', 'info'), { recursive: true });
  mkdirSync(externalSkillDir, { recursive: true });
  mkdirSync(internalSkillDir, { recursive: true });
  writeFileSync(path.join(externalSkillDir, 'SKILL.md'), '# External Skill\n');
  writeFileSync(path.join(internalSkillDir, 'SKILL.md'), '# Internal Skill\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('T-028 & T-029 (1 & 2): GUARDED_UNTRACKED_FILES includes .git/info/exclude; sandbox.allowUnsandboxedCommands is false; .git deny is narrowed to .git/config, .git/hooks/**, and .git/info/**', () => {
  assert.ok(GUARDED_UNTRACKED_FILES.includes('.git/info/exclude'), 'GUARDED_UNTRACKED_FILES must include .git/info/exclude');

  const settingsPath = claudeSettingsPath(home, workDir);
  const rules = claudeRulesFor(config(), workDir, home, { skillDir: internalSkillDir });

  assert.deepEqual(rules.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
  });

  const gitDirPat = toAbsPattern(path.join(workDir, '.git'));
  const gitConfigPat = toAbsPattern(path.join(workDir, '.git', 'config'));
  const gitHooksPat = toAbsPattern(path.join(workDir, '.git', 'hooks'));
  const gitInfoPat = toAbsPattern(path.join(workDir, '.git', 'info'));

  assert.ok(!rules.deny.includes(`Edit(${gitDirPat}/**)`), 'broad Edit(.git/**) must not be in deny');
  assert.ok(!rules.deny.includes(`Write(${gitDirPat}/**)`), 'broad Write(.git/**) must not be in deny');
  assert.ok(rules.deny.includes(`Edit(${gitConfigPat})`));
  assert.ok(rules.deny.includes(`Write(${gitConfigPat})`));
  assert.ok(rules.deny.includes(`Edit(${gitHooksPat}/**)`));
  assert.ok(rules.deny.includes(`Write(${gitHooksPat}/**)`));
  assert.ok(rules.deny.includes(`Edit(${gitInfoPat}/**)`));
  assert.ok(rules.deny.includes(`Write(${gitInfoPat}/**)`));

  writeClaudeAllowlist({ settingsPath, ...rules });
  const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(raw.sandbox?.allowUnsandboxedCommands, false);

  const ok = claudePermissionsCheck({ config: config(), settingsPath, workDir, home, skillDir: internalSkillDir });
  assert.equal(ok.ok, true, ok.detail);

  // Missing or true allowUnsandboxedCommands must fail claudePermissionsCheck:
  for (const badVal of [true, undefined]) {
    const mutated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (badVal === undefined) delete mutated.sandbox.allowUnsandboxedCommands;
    else mutated.sandbox.allowUnsandboxedCommands = badVal;
    writeFileSync(settingsPath, JSON.stringify(mutated, null, 2));

    const res = claudePermissionsCheck({ config: config(), settingsPath, workDir, home, skillDir: internalSkillDir });
    assert.equal(res.ok, false, `allowUnsandboxedCommands=${badVal} must be rejected`);
  }

  // Restore valid settings, then verify missing .git/config, .git/hooks/**, or .git/info/** in deny is rejected:
  writeClaudeAllowlist({ settingsPath, ...rules });
  for (const requiredDeny of [`Edit(${gitConfigPat})`, `Write(${gitHooksPat}/**)`, `Edit(${gitInfoPat}/**)`]) {
    const mutated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    mutated.permissions.deny = mutated.permissions.deny.filter((r) => r !== requiredDeny);
    writeFileSync(settingsPath, JSON.stringify(mutated, null, 2));

    const res = claudePermissionsCheck({ config: config(), settingsPath, workDir, home, skillDir: internalSkillDir });
    assert.equal(res.ok, false, `missing ${requiredDeny} in deny must be rejected`);
  }

  // Direct Edit/Write inside .git in allow is still rejected:
  writeClaudeAllowlist({
    settingsPath,
    allow: [...rules.allow, `Write(${gitDirPat}/index)`],
    deny: rules.deny,
  });
  const badGitAllow = claudePermissionsCheck({ config: config(), settingsPath, workDir, home, skillDir: internalSkillDir });
  assert.equal(badGitAllow.ok, false);
  assert.match(badGitAllow.detail, /запись в \.git проекта|writing to project \.git/);
});

test('T-028 & T-029 (3): external skill adds additionalDirectories: [skillDir], Read(//<skillDir>/**) in allow, and Edit/Write(//<skillDir>/**) in deny; claudePermissionsCheck validates all three', () => {
  const extAbs = toAbsPattern(externalSkillDir);
  const extRead = `Read(${extAbs}/**)`;
  const extEditDeny = `Edit(${extAbs}/**)`;
  const extWriteDeny = `Write(${extAbs}/**)`;
  const intRead = `Read(${toAbsPattern(internalSkillDir)}/**)`;

  // Skill inside workDir -> no Read rule, no additionalDirectories, no extra skill deny:
  // ADR-066 (C-22): the shim directory in the control directory is always readable; nothing else is added.
  const shimDir = controlShimDir({ workDir, home });
  const shimRead = `Read(${toAbsPattern(shimDir)}/**)`;
  const intRules = claudeRulesFor(config(), workDir, home, { skillDir: internalSkillDir });
  assert.ok(!intRules.allow.includes(intRead), 'internal skill dir must not add Read rule');
  assert.ok(!intRules.allow.some((r) => r.startsWith('Read(') && r !== shimRead), 'no Read rule but the shim directory when skill is inside workDir');
  assert.deepEqual(intRules.additionalDirectories ?? [], [shimDir]);

  // Skill outside workDir -> Read in allow, Edit/Write in deny, and additionalDirectories: [externalSkillDir]:
  const extRules = claudeRulesFor(config(), workDir, home, {
    skillFilePath: path.join(externalSkillDir, 'SKILL.md'),
  });
  assert.ok(extRules.allow.includes(extRead), `external skill must add ${extRead} to allow`);
  assert.ok(extRules.deny.includes(extEditDeny), `external skill must add ${extEditDeny} to deny`);
  assert.ok(extRules.deny.includes(extWriteDeny), `external skill must add ${extWriteDeny} to deny`);
  assert.deepEqual(extRules.additionalDirectories, [externalSkillDir, shimDir]);

  const settingsPath = claudeSettingsPath(home, workDir);
  writeClaudeAllowlist({ settingsPath, ...extRules });
  const writtenJson = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(writtenJson.permissions?.additionalDirectories?.includes(externalSkillDir));

  const okExt = claudePermissionsCheck({
    config: config(),
    settingsPath,
    workDir,
    home,
    skillFilePath: path.join(externalSkillDir, 'SKILL.md'),
  });
  assert.equal(okExt.ok, true, okExt.detail);

  // Removing externalSkillDir from permissions.additionalDirectories must fail check:
  {
    const mutated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    mutated.permissions.additionalDirectories = [];
    writeFileSync(settingsPath, JSON.stringify(mutated, null, 2));
    const res = claudePermissionsCheck({
      config: config(),
      settingsPath,
      workDir,
      home,
      skillFilePath: path.join(externalSkillDir, 'SKILL.md'),
    });
    assert.equal(res.ok, false, 'missing additionalDirectories entry for external skill must fail check');
  }

  // Removing Edit(//<externalSkillDir>/**) from permissions.deny must fail check:
  writeClaudeAllowlist({ settingsPath, ...extRules });
  {
    const mutated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    mutated.permissions.deny = mutated.permissions.deny.filter((r) => r !== extEditDeny);
    writeFileSync(settingsPath, JSON.stringify(mutated, null, 2));
    const res = claudePermissionsCheck({
      config: config(),
      settingsPath,
      workDir,
      home,
      skillFilePath: path.join(externalSkillDir, 'SKILL.md'),
    });
    assert.equal(res.ok, false, 'missing deny Edit(//<externalSkillDir>/**) must fail check');
  }

  // Unauthorized directory in permissions.additionalDirectories must fail check:
  writeClaudeAllowlist({ settingsPath, ...extRules });
  {
    const mutated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    mutated.permissions.additionalDirectories.push('/etc');
    writeFileSync(settingsPath, JSON.stringify(mutated, null, 2));
    const res = claudePermissionsCheck({
      config: config(),
      settingsPath,
      workDir,
      home,
      skillFilePath: path.join(externalSkillDir, 'SKILL.md'),
    });
    assert.equal(res.ok, false, 'unauthorized additionalDirectories entry must fail check');
  }
});
