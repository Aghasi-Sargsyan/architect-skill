// T-108 reference tests (C-21; ADR-061 item 4, ADR-066): the shared Antigravity settings file is merged without
// removing anyone's rules; another project's file rules are a note, not a failure; claude prunes and archives all.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeRulesFor, claudeSettingsPath, writeClaudeAllowlist } from './adapters/claude.mjs';
import { DEFAULTS } from './config.mjs';
import { agySettingsPath, checkPermissions, foreignProjectRule, permissionsCheck, rulesFor, writeAgyAllowlist } from './permissions.mjs';
import { handleWritePermissionsCli } from './permissions-cli.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let root;
let home;
let projA;
let projB;
let settingsPath;
const config = { ...DEFAULTS, runner: 'agy' };
const readAllow = () => JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow;
const makeProject = (dir) => {
  mkdirSync(dir, { recursive: true });
  execFileSync(realGit, ['init', '-q', '-b', 'master'], { cwd: dir });
  return dir;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-agy-shared-')));
  home = path.join(root, 'home');
  projA = makeProject(path.join(root, 'work', 'proj-a'));
  projB = makeProject(path.join(root, 'work', 'proj-b'));
  mkdirSync(home);
  settingsPath = agySettingsPath(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('foreignProjectRule: a file rule exactly at the root of another git project is a note; anything else is not', () => {
  const ctx = { workDir: projA, home };
  assert.match(foreignProjectRule(`write_file(${projB})`, ctx), /another project/);
  assert.match(foreignProjectRule(`read_file(${projB})`, ctx), /another project/);
  assert.equal(foreignProjectRule(`write_file(${projA})`, ctx), null, 'the current project is not foreign');
  assert.equal(foreignProjectRule(`write_file(${path.join(projB, 'src')})`, ctx), null, 'only the project root, not a subdirectory');
  const plain = path.join(root, 'plain');
  mkdirSync(plain);
  assert.equal(foreignProjectRule(`write_file(${plain})`, ctx), null, 'a directory without .git is not a project');
  assert.equal(foreignProjectRule(`write_file(${path.join(root, 'work')})`, ctx), null, 'a parent of the current project is never foreign');
  assert.equal(foreignProjectRule(`write_file(${home})`, ctx), null);
  assert.equal(foreignProjectRule('command(npm test)', ctx), null);
});

test('two projects in one shared settings file: --write-permissions keeps the other project, both pass the checks', () => {
  const pruneA = { config, blockedScripts: [], workDir: projA, home };
  const pruneB = { config, blockedScripts: [], workDir: projB, home };
  writeAgyAllowlist({ settingsPath, ...rulesFor(config, projA), pruneCtx: pruneA });
  const resB = writeAgyAllowlist({ settingsPath, ...rulesFor(config, projB), pruneCtx: pruneB });
  assert.deepEqual(resB.removedAllow, []);
  writeAgyAllowlist({ settingsPath, ...rulesFor(config, projA), pruneCtx: pruneA });
  const allow = readAllow();
  assert.ok(allow.includes(`write_file(${projA})`));
  assert.ok(allow.includes(`write_file(${projB})`));
  for (const workDir of [projA, projB]) {
    const check = permissionsCheck({ config, settingsPath, workDir, home });
    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /other projects/);
    const legacy = checkPermissions(config, workDir, home);
    assert.equal(legacy.ok, true, legacy.issues.join('; '));
  }
});

test('the shared file is never pruned: rules of the person stay; an unsafe one keeps the check red and is named', () => {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['command(git push)', 'command(make deploy-docs)', `write_file(${projB})`], deny: [] } }));
  const logs = [];
  const res = handleWritePermissionsCli({ config, workDir: projA, home, log: (m) => logs.push(m) });
  const allow = readAllow();
  assert.ok(allow.includes('command(git push)'), 'an unsafe rule of the person is not removed');
  assert.ok(allow.includes('command(make deploy-docs)'));
  assert.ok(allow.includes(`write_file(${projB})`));
  assert.ok(allow.includes(`write_file(${projA})`));
  assert.deepEqual(res.removedAllow, []);
  assert.equal(res.ok, false, 'the unsafe rule keeps --check red');
  assert.match(logs.join('\n'), /git push/);
  assert.equal(existsSync(`${settingsPath}.pruned.json`), false, 'nothing pruned — nothing archived');
});

test('a rule outside any project is still unsafe for the check', () => {
  writeAgyAllowlist({ settingsPath, ...rulesFor(config, projA) });
  const plain = path.join(root, 'plain');
  mkdirSync(plain);
  writeAgyAllowlist({ settingsPath, allow: [`write_file(${plain})`] });
  const check = permissionsCheck({ config, settingsPath, workDir: projA, home });
  assert.equal(check.ok, false);
  assert.match(check.detail, /unsafe/);
});

test('claude (per-project settings file): pruning stays and every removed rule is archived, commands included', () => {
  const cfg = { ...DEFAULTS, runner: 'claude' };
  const file = claudeSettingsPath(home, projA);
  const rules = claudeRulesFor(cfg, projA, home);
  writeClaudeAllowlist({ settingsPath: file, workDir: projA, home, ...rules, allow: [...rules.allow, 'Bash(git push:*)'] });
  const res = handleWritePermissionsCli({ config: cfg, workDir: projA, home, log: () => {} });
  assert.ok(res.removedAllow.includes('Bash(git push:*)'), res.removedAllow.join(', '));
  const archived = JSON.parse(readFileSync(`${file}.pruned.json`, 'utf8')).rules;
  assert.ok(archived.includes('Bash(git push:*)'), archived.join(', '));
});
