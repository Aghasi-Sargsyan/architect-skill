import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import * as layoutMod from './layout.mjs';
import * as configMod from './config.mjs';
import * as hooksMod from './hooks.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

function initTempRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-066 (a): layout.mjs exports local config paths and freezes .local.json, .github/workflows/**, and CODEOWNERS', () => {
  assert.equal(layoutMod.COMPACT_LOCAL_CONFIG_PATH, '.architect/config.local.json');
  assert.equal(layoutMod.CLASSIC_LOCAL_CONFIG_PATH, '.agents/orchestrator.local.json');
  assert.equal(typeof layoutMod.resolveLocalConfigPath, 'function');
  assert.equal(layoutMod.resolveLocalConfigPath('.architect/config.json'), '.architect/config.local.json');
  assert.equal(layoutMod.resolveLocalConfigPath('.agents/orchestrator.json'), '.agents/orchestrator.local.json');

  const frozenList = layoutMod.alwaysFrozenFiles('.agents/orchestrator.json', { workDir: process.cwd(), orchestratorDir: orchDir });
  assert.ok(frozenList.includes('.architect/config.local.json'));
  assert.ok(frozenList.includes('.agents/orchestrator.local.json'));
  assert.ok(frozenList.includes('CODEOWNERS'));
  assert.ok(frozenList.includes('.github/CODEOWNERS'));

  assert.equal(layoutMod.isAlwaysFrozenFile('.github/workflows/ci.yml', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('.github/workflows/team-ci.yml', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('CODEOWNERS', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('.github/CODEOWNERS', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('docs/CODEOWNERS', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('.agents/orchestrator.local.json', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('.architect/config.local.json', { workDir: process.cwd(), orchestratorDir: orchDir }), true);
  assert.equal(layoutMod.isAlwaysFrozenFile('src/index.mjs', { workDir: process.cwd(), orchestratorDir: orchDir }), false);
});

test('T-066 (b): initProject with team: true writes "team": true, "fullTestCommand", .github/workflows/team-ci.yml, and .local.json in .gitignore', () => {
  const { root } = initTempRepo('t066-init-team-');
  try {
    const notes = configMod.initProject({ workDir: root, configPath: '.architect/config.json', realGit, team: true });
    const cfgRaw = JSON.parse(readFileSync(path.join(root, '.architect', 'config.json'), 'utf8'));
    assert.equal(cfgRaw.team, true, 'initProject({ team: true }) must set "team": true');
    assert.equal(cfgRaw.fullTestCommand, 'npm test', 'initProject({ team: true }) must set default "fullTestCommand"');

    const wfPath = path.join(root, '.github', 'workflows', 'team-ci.yml');
    assert.equal(existsSync(wfPath), true, 'initProject({ team: true }) must create .github/workflows/team-ci.yml');
    const wfText = readFileSync(wfPath, 'utf8');
    assert.match(wfText, /ubuntu-latest/);
    assert.match(wfText, /--check-task/);
    assert.match(wfText, /fullTestCommand/);
    assert.ok(notes.some((n) => n.includes('team-ci.yml')));

    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.architect\/config\.local\.json/);
    assert.match(gitignore, /\.agents\/orchestrator\.local\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-066 (c): loadConfig merges personal .local.json over shared config, tracks _modelSources, and rejects policy fields in .local.json fail-closed', () => {
  assert.equal(typeof configMod.validateLocalConfig, 'function');
  const { root } = initTempRepo('t066-local-cfg-');
  try {
    configMod.initProject({ workDir: root, configPath: '.agents/orchestrator.json', realGit, team: true });
    const sharedPath = path.join(root, '.agents', 'orchestrator.json');
    const localPath = path.join(root, '.agents', 'orchestrator.local.json');

    const sharedRaw = JSON.parse(readFileSync(sharedPath, 'utf8'));
    sharedRaw.executor = { model: 'gemini-3.8-flash-high' };
    sharedRaw.architect = { model: 'gemini-4-argon-high' };
    writeFileSync(sharedPath, JSON.stringify(sharedRaw, null, 2) + '\n');

    // 1. Without .local.json, _modelSources points to .agents/orchestrator.json
    const cfgShared = configMod.loadConfig(sharedPath);
    assert.equal(cfgShared.executor.model, 'gemini-3.8-flash-high');
    assert.equal(cfgShared._modelSources?.executor, '.agents/orchestrator.json');
    assert.equal(cfgShared._modelSources?.architect, '.agents/orchestrator.json');

    // 2. With valid .local.json, personal runner/model/bin override shared config and _modelSources points to .local.json
    writeFileSync(
      localPath,
      JSON.stringify({
        runner: 'claude',
        runnerBin: '/opt/custom/claude',
        executor: { model: 'claude-sonnet-4-6' },
        notify: false,
      }, null, 2) + '\n',
    );
    const cfgMerged = configMod.loadConfig(sharedPath);
    assert.equal(cfgMerged.runner, 'claude');
    assert.equal(cfgMerged.runnerBin, '/opt/custom/claude');
    assert.equal(cfgMerged.executor.model, 'claude-sonnet-4-6');
    assert.equal(cfgMerged.architect.model, 'gemini-4-argon-high');
    assert.equal(cfgMerged.notify, false);
    assert.equal(cfgMerged._modelSources?.executor, '.agents/orchestrator.local.json');
    assert.equal(cfgMerged._modelSources?.architect, '.agents/orchestrator.json');

    // 3. Policy fields in .local.json are rejected fail-closed
    for (const forbiddenKey of ['permissions', 'allowedCommands', 'blockedScripts', 'bypassPatterns', 'commitLanguage', 'team']) {
      writeFileSync(localPath, JSON.stringify({ [forbiddenKey]: 'override' }) + '\n');
      assert.throws(
        () => configMod.loadConfig(sharedPath),
        new RegExp(`local config.*${forbiddenKey}`, 'i'),
        `loadConfig must reject policy key "${forbiddenKey}" in .local.json`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-066 (d): resolveExecutorModelInfo follows chain .local.json -> shared config -> agent file, and resolveBaseShaForTask fails closed on unresolvable --base', () => {
  assert.equal(typeof hooksMod.resolveExecutorModelInfo, 'function');
  const { root, g } = initTempRepo('t066-model-chain-');
  try {
    writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n- Executor model: Gemini 3.8 Flash (High)\n');
    g('add', 'AGENTS.md');
    g('commit', '-q', '-m', 'arch: plan initial');

    // 1. Only AGENTS.md present -> source is AGENTS.md
    const infoAgents = hooksMod.resolveExecutorModelInfo({ workDir: root });
    assert.equal(infoAgents.ok, true);
    assert.equal(infoAgents.model, 'Gemini 3.8 Flash (High)');
    assert.equal(infoAgents.source, 'AGENTS.md');
    assert.match(infoAgents.detail, /Gemini 3\.8 Flash \(High\) \(source: AGENTS\.md\)/);

    // 2. Shared config overrides AGENTS.md -> source is .agents/orchestrator.json
    mkdirSync(path.join(root, '.agents'), { recursive: true });
    writeFileSync(
      path.join(root, '.agents', 'orchestrator.json'),
      JSON.stringify({ ...configMod.DEFAULTS, executor: { model: 'gemini-3.8-flash-high' } }, null, 2) + '\n',
    );
    const infoShared = hooksMod.resolveExecutorModelInfo({ workDir: root });
    assert.equal(infoShared.ok, true);
    assert.equal(infoShared.model, 'gemini-3.8-flash-high');
    assert.equal(infoShared.source, '.agents/orchestrator.json');

    // 3. Local config overrides shared config -> source is .agents/orchestrator.local.json
    writeFileSync(
      path.join(root, '.agents', 'orchestrator.local.json'),
      JSON.stringify({ executor: { model: 'claude-sonnet-4-6' } }, null, 2) + '\n',
    );
    const loaded = configMod.loadConfig(path.join(root, '.agents', 'orchestrator.json'));
    const infoLocal = hooksMod.resolveExecutorModelInfo({ workDir: root, config: loaded });
    assert.equal(infoLocal.ok, true);
    assert.equal(infoLocal.model, 'claude-sonnet-4-6');
    assert.equal(infoLocal.source, '.agents/orchestrator.local.json');
    assert.match(infoLocal.detail, /claude-sonnet-4-6 \(source: \.agents\/orchestrator\.local\.json\)/);

    // 4. resolveBaseShaForTask throws fail-closed with fetch-depth: 0 hint when --base ref does not exist
    assert.throws(
      () => hooksMod.resolveBaseShaForTask({ realGit, workDir: root, taskId: 'T-001', baseRef: 'origin/cycle/999' }),
      /Cannot resolve --base "origin\/cycle\/999".*fetch-depth: 0/i,
    );

    // 5. validateCommitMessage accepts Merge commits and rejects unprefixed non-merge commits
    assert.equal(hooksMod.validateCommitMessage({ subject: 'Merge pull request #7 from org/task/T-001', commitLanguage: 'en', isMerge: true }).ok, true);
    assert.equal(hooksMod.validateCommitMessage({ subject: "Merge branch 'task/T-001' into cycle/1", commitLanguage: 'en' }).ok, true);
    const unprefixed = hooksMod.validateCommitMessage({ subject: 'random wip commit', commitLanguage: 'en' });
    assert.equal(unprefixed.ok, false);
    assert.match(unprefixed.error ?? '', /T-NNN:|arch:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
