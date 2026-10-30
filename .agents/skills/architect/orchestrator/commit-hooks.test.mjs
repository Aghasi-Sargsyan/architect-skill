import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, writeGitShim } from './guards.mjs';
import { DEFAULTS, initProject, validateConfig, withDefaults } from './config.mjs';
import { commandProblem } from './permissions.mjs';
import { parseArgs, runFullSelfCheck, formatSelfCheckReport } from './cli.mjs';
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

test('T-058 (a): validateConfig accepts optional commitLanguage ("en" or omitted) and rejects invalid values', () => {
  assert.deepEqual(validateConfig(withDefaults({})), []);
  assert.deepEqual(validateConfig(withDefaults({ commitLanguage: 'en' })), []);
  const bad = validateConfig(withDefaults({ commitLanguage: 'de' }));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /commitLanguage/);
});

test('T-058 (b): commit-msg hook is installed by --init and --install-hooks, respects existing hook and core.hooksPath, and enforces commitLanguage and arch:/T-NNN formats', () => {
  assert.equal(typeof hooksMod.installCommitMsgHook, 'function');
  assert.equal(typeof hooksMod.checkCommitMsgHook, 'function');
  assert.equal(typeof hooksMod.validateCommitMessage, 'function');

  const parsed = parseArgs(['--install-hooks']);
  assert.equal(parsed.installHooks, true);

  const { root, g } = initTempRepo('t058-hooks-');
  try {
    // 1. Before installation: checkCommitMsgHook reports not installed
    const beforeCheck = hooksMod.checkCommitMsgHook({ workDir: root, realGit });
    assert.equal(beforeCheck.ok, false);
    assert.match(beforeCheck.detail, /not installed/i);

    // 2. When core.hooksPath is set: installCommitMsgHook does not install, checkCommitMsgHook reports core.hooksPath
    g('config', 'core.hooksPath', '.husky');
    const skippedHooksPath = hooksMod.installCommitMsgHook({ workDir: root, realGit });
    assert.equal(skippedHooksPath.installed, false);
    assert.match(skippedHooksPath.reason, /core\.hooksPath/);
    assert.equal(existsSync(path.join(root, '.git', 'hooks', 'commit-msg')), false);
    const checkHooksPath = hooksMod.checkCommitMsgHook({ workDir: root, realGit });
    assert.equal(checkHooksPath.ok, false);
    assert.match(checkHooksPath.detail, /core\.hooksPath/);
    g('config', '--unset', 'core.hooksPath');

    // 3. When a custom .git/hooks/commit-msg exists: installCommitMsgHook does not overwrite it
    const hookFile = path.join(root, '.git', 'hooks', 'commit-msg');
    mkdirSync(path.dirname(hookFile), { recursive: true });
    writeFileSync(hookFile, '#!/bin/sh\n# custom user hook\nexit 0\n', { mode: 0o755 });
    const skippedCustom = hooksMod.installCommitMsgHook({ workDir: root, realGit });
    assert.equal(skippedCustom.installed, false);
    assert.match(skippedCustom.reason, /existing.*commit-msg/i);
    assert.match(readFileSync(hookFile, 'utf8'), /# custom user hook/);
    const checkCustom = hooksMod.checkCommitMsgHook({ workDir: root, realGit });
    assert.equal(checkCustom.ok, false);
    assert.match(checkCustom.detail, /existing.*commit-msg/i);
    rmSync(hookFile);

    // 4. initProject installs the hook and checkCommitMsgHook passes
    initProject({ workDir: root, configPath: '.agents/orchestrator.json', realGit });
    assert.equal(existsSync(hookFile), true);
    const installedCheck = hooksMod.checkCommitMsgHook({ workDir: root, realGit });
    assert.equal(installedCheck.ok, true, installedCheck.detail);

    // Configure commitLanguage: "en" in .agents/orchestrator.json
    const cfgPath = path.join(root, '.agents', 'orchestrator.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.commitLanguage = 'en';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: task one\n  - Change: `a.js`\n',
    );
    writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
    g('add', '.');

    // 5. Hook rejects Cyrillic commit when commitLanguage is "en"
    const cyrCommit = spawnSync(realGit, ['commit', '-m', 'arch: план цикла'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(cyrCommit.status, 0, 'commit-msg hook must reject Cyrillic subject when commitLanguage is "en"');
    assert.match(cyrCommit.stderr, /non-Latin|commitLanguage/i);

    // 6. Hook rejects malformed T-NNN commit ("T-001 missing colon")
    const badTaskCommit = spawnSync(realGit, ['commit', '-m', 'T-001 missing colon'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(badTaskCommit.status, 0, 'commit-msg hook must reject malformed T-NNN commit');
    assert.match(badTaskCommit.stderr, /T-NNN/i);

    // 7. Valid arch: plan commit passes
    const goodPlanCommit = spawnSync(realGit, ['commit', '-m', 'arch: plan T-001'], { cwd: root, encoding: 'utf8' });
    assert.equal(goodPlanCommit.status, 0, goodPlanCommit.stderr);

    // 8. Valid T-001 commit passes
    writeFileSync(path.join(root, 'a.js'), 'export const a = 2;\n');
    g('add', 'a.js');
    const goodTaskCommit = spawnSync(realGit, ['commit', '-m', 'T-001: update a.js'], { cwd: root, encoding: 'utf8' });
    assert.equal(goodTaskCommit.status, 0, goodTaskCommit.stderr);

    // 9. Commit that ONLY marks task [x] in PLAN.md but does NOT start with "arch: accept T-001" or "arch: приёмка T-001" is rejected!
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [x] T-001: task one\n  - Change: `a.js`\n',
    );
    g('add', 'PLAN.md');
    const badAccept = spawnSync(realGit, ['commit', '-m', 'arch: T-001 accepted'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(badAccept.status, 0, 'commit-msg hook must reject PLAN.md [x] commit not starting with arch: accept T-NNN');
    assert.match(badAccept.stderr, /arch: accept T-NNN/i);

    // 10. Commit starting with "arch: accept T-001" passes!
    const goodAccept = spawnSync(realGit, ['commit', '-m', 'arch: accept T-001 — update a.js'], { cwd: root, encoding: 'utf8' });
    assert.equal(goodAccept.status, 0, goodAccept.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-058 (c): --self-check reports commit language and format issues in <base>..HEAD as warnings without failing (ok: true)', () => {
  const { root, g } = initTempRepo('t058-selfcheck-warn-');
  try {
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: task one\n  - Change: `a.js`\n',
    );
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    g('add', '.');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    const baseSha = g('rev-parse', 'HEAD');

    // Make a historical commit marking [x] with Cyrillic and non-standard acceptance subject (without hook installed)
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [x] T-001: task one\n  - Change: `a.js`\n',
    );
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: T-001 принята');

    const cfg = {
      ...DEFAULTS,
      commitLanguage: 'en',
      bypassScanPaths: ['src'],
      bypassRegexps: [],
    };
    const res = runFullSelfCheck({ realGit, workDir: root, config: cfg, baseRef: baseSha });
    assert.equal(res.ok, true, `commit language/format issues in history must be warnings, not violations: ${res.violations.join('; ')}`);
    assert.ok(Array.isArray(res.warnings) && res.warnings.length >= 1, 'expected warnings for Cyrillic / malformed acceptance commit');
    const report = formatSelfCheckReport(res);
    assert.match(report, /Warnings \(\d+\):/);
    assert.match(report, /arch: T-001 принята/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-058 (d): git shim blocks git commit --no-verify (-n) when AGENT_LOOP=1 and commandProblem rejects --no-verify', () => {
  assert.match(commandProblem('git commit --no-verify -m "x"') ?? '', /--no-verify/i);
  assert.match(commandProblem('git commit -n -m "x"') ?? '', /--no-verify|-n/i);

  const { root } = initTempRepo('t058-shim-noverify-');
  try {
    const shimDir = path.join(root, 'shims');
    const gitShim = writeGitShim({ shimDir, realGit, sandboxRoot: root, workDir: root });
    const envLoop = { ...process.env, AGENT_LOOP: '1' };

    const resLong = spawnSync(gitShim, ['commit', '--no-verify', '-m', 'test'], { cwd: root, env: envLoop, encoding: 'utf8' });
    assert.equal(resLong.status, 97);
    assert.match(resLong.stderr, /--no-verify.*blocked/i);

    const resShort = spawnSync(gitShim, ['commit', '-n', '-m', 'test'], { cwd: root, env: envLoop, encoding: 'utf8' });
    assert.equal(resShort.status, 97);
    assert.match(resShort.stderr, /--no-verify|-n.*blocked/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-058: modified orchestrator modules stay <= 400 lines', () => {
  for (const mod of ['hooks.mjs', 'config.mjs', 'check.mjs', 'selfcheck.mjs', 'cli.mjs', 'guards.mjs', 'permissions.mjs', 'run.mjs']) {
    const p = path.join(orchDir, mod);
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').split('\n').length;
      assert.ok(lines <= 400, `${mod} must stay <= 400 lines (got ${lines})`);
    }
  }
});
