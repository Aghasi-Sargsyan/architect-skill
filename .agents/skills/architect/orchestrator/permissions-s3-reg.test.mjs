// Regression tests for T-027 (separate file so permissions-s3.test.mjs remains untouched):
// 1. permissionsCheck with exact rules from rulesFor -> ok: true
// 2. read_file(<parent of external skill folder>) -> rejected
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

let root;
let home;
let workDir;
let externalSkillsParent;
let externalSkillDir;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-perm-s3-reg-')));
  home = path.join(root, 'home');
  workDir = path.join(home, 'projects', 'app');
  externalSkillsParent = path.join(root, 'external-skills');
  externalSkillDir = path.join(externalSkillsParent, 'architect');

  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  mkdirSync(externalSkillDir, { recursive: true });
  writeFileSync(path.join(externalSkillDir, 'SKILL.md'), '# Skill\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('Regression 1: permissionsCheck with exact rules from rulesFor returns ok: true', () => {
  const cfg = { ...DEFAULTS, blockedScripts: ['ship'], allowedCommands: ['npm test'] };
  const settingsPath = agySettingsPath(home);
  const rules = rulesFor(cfg, workDir);

  writeAgyAllowlist({ settingsPath, ...rules });
  const res = permissionsCheck({ config: cfg, settingsPath, workDir, home });
  assert.equal(res.ok, true, res.detail);
});

test('Regression 2: read_file on the parent of the external skill folder is rejected', () => {
  const cfg = { ...DEFAULTS };
  const rules = rulesFor(cfg, workDir);
  const externalSkillFile = path.join(externalSkillDir, 'SKILL.md');
  const ctx = {
    blockedScripts: [],
    workDir,
    home,
    deny: rules.deny,
    skillFilePath: externalSkillFile,
  };

  // Reading the skill folder itself is allowed:
  assert.equal(ruleProblem(`read_file(${externalSkillDir})`, ctx), null);
  // Reading the parent of the external skill folder must be rejected:
  assert.ok(
    ruleProblem(`read_file(${externalSkillsParent})`, ctx),
    'read_file(<parent of external skill folder>) must be rejected',
  );

  // Also verify via permissionsCheck:
  const settingsPath = agySettingsPath(home);
  writeAgyAllowlist({
    settingsPath,
    allow: [...rules.allow, `read_file(${externalSkillsParent})`],
    deny: rules.deny,
  });
  const checkRes = permissionsCheck({
    config: cfg,
    settingsPath,
    workDir,
    home,
    skillFilePath: externalSkillFile,
  });
  assert.equal(checkRes.ok, false, 'permissionsCheck must reject read_file on parent of external skill folder');
});
