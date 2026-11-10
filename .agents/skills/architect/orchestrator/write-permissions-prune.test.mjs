import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agySettingsPath, permissionsCheck, rulesFor, writeAgyAllowlist } from './permissions.mjs';
import { claudePermissionsCheck, claudeRulesFor, claudeSettingsPath, writeClaudeAllowlist } from './adapters/claude.mjs';
import { handleWritePermissionsCli } from './permissions-cli.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

const makeConfig = (extra = {}) => ({
  runner: 'agy',
  allowedCommands: ['npm test'],
  blockedScripts: ['ship'],
  ...extra,
});

test('writeAgyAllowlist with pruneCtx removes cross-project and forbidden rules, merges deny before ruleProblem, preserves safe custom rules, and stays idempotent', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-prune-agy-')));
  try {
    const home = path.join(root, 'home');
    const workA = path.join(root, 'proj-a');
    const workB = path.join(root, 'proj-b');
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    const settingsPath = agySettingsPath(home);
    mkdirSync(path.dirname(settingsPath), { recursive: true });

    const seed = {
      theme: 'dark',
      account: 'dev@example.invalid',
      permissions: {
        allow: [
          'command(adb)',
          'mcp(context7)',
          'command(git status)',
          'command(git restore)',
          'command(git checkout scripts/harvest-native-client.ts)',
          'command(git switch main)',
          'command(npm run ship)',
          `write_file(${workB})`,
          `read_file(${workB})`,
          `write_file(${workA})`,
        ],
        deny: [`write_file(${path.join(workB, '.git')})`],
      },
    };
    const beforeText = `${JSON.stringify(seed, null, 2)}\n`;
    writeFileSync(settingsPath, beforeText, { mode: 0o600 });

    const cfg = makeConfig();
    const wanted = rulesFor(cfg, workA);
    const pruneCtx = { blockedScripts: cfg.blockedScripts, workDir: workA, home };

    const first = writeAgyAllowlist({ settingsPath, ...wanted, pruneCtx });
    assert.equal(first.backup, true);
    assert.equal(readFileSync(`${settingsPath}.bak`, 'utf8'), beforeText);
    assert.deepEqual(first.removedAllow, [
      'command(git restore)',
      'command(git checkout scripts/harvest-native-client.ts)',
      'command(git switch main)',
      'command(npm run ship)',
      `write_file(${workB})`,
      `read_file(${workB})`,
    ]);
    assert.ok(!first.removedAllow.includes(`write_file(${workA})`), 'deny must be merged before ruleProblem so current project write_file is kept');

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(parsed.theme, 'dark');
    assert.equal(parsed.account, 'dev@example.invalid');
    assert.ok(parsed.permissions.allow.includes('command(adb)'));
    assert.ok(parsed.permissions.allow.includes('mcp(context7)'));
    assert.ok(parsed.permissions.allow.includes(`write_file(${workA})`));
    assert.ok(!parsed.permissions.allow.includes(`write_file(${workB})`));
    assert.ok(!parsed.permissions.allow.includes('command(git restore)'));

    const checkRes = permissionsCheck({ config: cfg, settingsPath, workDir: workA, home });
    assert.equal(checkRes.ok, true, checkRes.detail);

    rmSync(`${settingsPath}.bak`);
    const second = writeAgyAllowlist({ settingsPath, ...wanted, pruneCtx });
    assert.deepEqual(second, { addedAllow: [], addedDeny: [], removedAllow: [], backup: false });
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeAgyAllowlist without pruneCtx preserves backwards-compatible return shape and does not prune existing rules', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-prune-compat-')));
  try {
    const settingsPath = path.join(root, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['command(git restore)'], deny: [] } }));
    const res = writeAgyAllowlist({ settingsPath, allow: ['command(git status)'], deny: [] });
    assert.deepEqual(res, { addedAllow: ['command(git status)'], addedDeny: [], backup: true });
    assert.equal('removedAllow' in res, false);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(parsed.permissions.allow, ['command(git restore)', 'command(git status)']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeClaudeAllowlist with pruneCtx removes forbidden Bash and cross-project Write rules while keeping safe custom rules', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-prune-claude-')));
  try {
    const home = path.join(root, 'home');
    const workA = path.join(root, 'proj-a');
    const workB = path.join(root, 'proj-b');
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });
    const cfg = makeConfig({ runner: 'claude' });
    const settingsPath = claudeSettingsPath(home, workA);
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const toAbs = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;

    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          'Bash(adb:*)',
          'Bash(git restore:*)',
          'Bash(git checkout scripts/harvest-native-client.ts)',
          'Bash(npm run ship:*)',
          `Write(${toAbs(workB)}/**)`,
        ],
        deny: [],
      },
    }));

    const rules = claudeRulesFor(cfg, workA);
    const res = writeClaudeAllowlist({
      settingsPath,
      workDir: workA,
      home,
      ...rules,
      pruneCtx: { config: cfg, blockedScripts: cfg.blockedScripts, workDir: workA, home },
    });
    assert.equal(res.backup, true);
    assert.deepEqual(res.removedAllow, [
      'Bash(git restore:*)',
      'Bash(git checkout scripts/harvest-native-client.ts)',
      'Bash(npm run ship:*)',
      `Write(${toAbs(workB)}/**)`,
    ]);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(parsed.permissions.allow.includes('Bash(adb:*)'));
    assert.ok(!parsed.permissions.allow.includes('Bash(git restore:*)'));

    const checkRes = claudePermissionsCheck({ config: cfg, settingsPath, workDir: workA, home });
    assert.equal(checkRes.ok, true, checkRes.detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handleWritePermissionsCli prunes unsafe rules, masks paths in output, passes post-write check, and keeps target modules <= 400 lines', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-prune-cli-')));
  try {
    const home = path.join(root, 'home');
    const workA = path.join(root, 'proj-a');
    const workB = path.join(home, 'Projects', 'other-proj');
    mkdirSync(workA, { recursive: true });
    mkdirSync(workB, { recursive: true });

    const settingsPath = agySettingsPath(home);
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: [`write_file(${workB})`, 'command(git restore)'],
        deny: [],
      },
    }));

    const lines = [];
    const cfg = makeConfig();
    const out = handleWritePermissionsCli({ config: cfg, workDir: workA, home, log: (msg) => lines.push(String(msg)) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.removedAllow, [`write_file(${workB})`, 'command(git restore)']);
    assert.equal(out.backup, true);

    const joined = lines.join('\n');
    assert.match(joined, /removed 2/i);
    assert.match(joined, /settings\.json\.bak/);
    assert.match(joined, /~/);
    assert.match(joined, /<workDir>/);
    assert.equal(joined.includes(home), false, 'raw home path must be masked in CLI output');
    assert.equal(joined.includes(workA), false, 'raw workDir path must be masked in CLI output');
    assert.doesNotMatch(joined, /^✗/m);

    const linesSecond = [];
    const second = handleWritePermissionsCli({ config: cfg, workDir: workA, home, log: (msg) => linesSecond.push(String(msg)) });
    assert.equal(second.ok, true);
    assert.deepEqual(second.removedAllow, []);
    assert.match(linesSecond.join('\n'), /all rules already present, file unchanged/);

    const runSrc = readFileSync(path.join(orchDir, 'run.mjs'), 'utf8');
    assert.match(runSrc, /handleWritePermissionsCli/, 'run.mjs must delegate opts.writePermissions to handleWritePermissionsCli');

    for (const rel of ['permissions.mjs', 'permissions-cli.mjs', 'run.mjs', path.join('adapters', 'claude.mjs')]) {
      const text = readFileSync(path.join(orchDir, rel), 'utf8');
      const lineCount = text.split('\n').length;
      assert.ok(lineCount <= 400, `${rel} must stay <= 400 lines, got ${lineCount}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
