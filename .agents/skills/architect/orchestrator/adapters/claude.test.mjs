// Frozen reference test for T-026 (Claude Code CLI adapter, designed from Probe A0 facts: C3, C4, C5).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_SETTINGS_SHOWN,
  claudePermissionsCheck,
  claudeRulesFor,
  claudeSettingsPath,
  createClaudeFormatter,
  extractClaudeDeniedStep,
  listClaudeModels,
  runClaudeAgent,
  toClaudeBashRule,
  writeClaudeAllowlist,
} from './claude.mjs';
import { DEFAULTS } from '../config.mjs';

let root;
let home;
let workDir;
let settingsPath;

const config = (extra = {}) => ({
  ...DEFAULTS,
  runner: 'claude',
  blockedScripts: ['ship', 'deploy'],
  allowedCommands: ['npm test', 'pytest'],
  ...extra,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-claude-s3-')));
  home = path.join(root, 'home');
  workDir = path.join(home, 'projects', 'app');
  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  settingsPath = claudeSettingsPath(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('C3, C4, B1, B2, Probe A0: claudeSettingsPath lives outside workDir, claudeRulesFor uses //... and ~/... syntax, omits bare Read, enables blockReadsOutsideWorkingDirectories and OS sandbox, and blocks .git / .claude / ~/.claude', () => {
  assert.equal(CLAUDE_SETTINGS_SHOWN, '~/.config/architect/claude-settings.json');
  assert.equal(settingsPath, path.join(home, '.config', 'architect', 'claude-settings.json'));
  assert.equal(toClaudeBashRule('git status'), 'Bash(git status:*)');

  const toAbsPattern = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const rules = claudeRulesFor(config(), workDir, home);
  assert.ok(rules.allow.includes('Bash(git status:*)'));
  assert.ok(rules.allow.includes('Bash(npm test:*)'));
  assert.ok(rules.allow.includes('Bash(pytest:*)'));
  assert.ok(!rules.allow.some((r) => r.includes('ship')), 'blocked scripts must never appear in allow');
  assert.ok(!rules.allow.includes('Read'), 'bare Read must not be in allow (B2)');
  assert.ok(rules.allow.includes(`Edit(${toAbsPattern(workDir)}/**)`), 'Edit rule must use double-slash //... for filesystem-absolute path (B1)');
  assert.ok(rules.allow.includes(`Write(${toAbsPattern(workDir)}/**)`), 'Write rule must use double-slash //... for filesystem-absolute path (B1)');

  // Deny rules protect .git/config, .git/hooks/**, and .git/info/** (narrowed in T-028/T-029 so git commit works inside sandbox), .claude (via //...), and home config dirs (via ~/...)
  for (const mustDeny of [
    `Edit(${toAbsPattern(path.join(workDir, '.git', 'config'))})`,
    `Write(${toAbsPattern(path.join(workDir, '.git', 'config'))})`,
    `Edit(${toAbsPattern(path.join(workDir, '.git', 'hooks'))}/**)`,
    `Write(${toAbsPattern(path.join(workDir, '.git', 'hooks'))}/**)`,
    `Edit(${toAbsPattern(path.join(workDir, '.git', 'info'))}/**)`,
    `Write(${toAbsPattern(path.join(workDir, '.git', 'info'))}/**)`,
    `Edit(${toAbsPattern(path.join(workDir, '.claude'))}/**)`,
    `Write(${toAbsPattern(path.join(workDir, '.claude'))}/**)`,
    'Edit(~/.claude/**)',
    'Write(~/.claude/**)',
    'Edit(~/.config/architect/**)',
    'Write(~/.config/architect/**)',
    'Edit(~/.gemini/**)',
    'Write(~/.gemini/**)',
  ]) {
    assert.ok(rules.deny.includes(mustDeny), `claudeRulesFor.deny must include ${mustDeny}`);
  }

  // Write allowlist and check permissionsCheck
  assert.equal(claudePermissionsCheck({ config: config(), settingsPath, workDir, home }).ok, false, 'missing file fails');
  const written = writeClaudeAllowlist({ settingsPath, ...rules });
  assert.equal(written.addedAllow.length, rules.allow.length);
  const rawSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(
    rawSettings.sandbox,
    { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
    'OS sandbox must be enabled with autoAllowBashIfSandboxed: false and allowUnsandboxedCommands: false',
  );
  assert.equal(rawSettings.permissions?.blockReadsOutsideWorkingDirectories, true, 'permissions.blockReadsOutsideWorkingDirectories must be true (B2)');

  const ok = claudePermissionsCheck({ config: config(), settingsPath, workDir, home });
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /allowlist Claude Code|правил Bash|Bash\(…\) rules/);

  // Unsafe rules (including single-slash Edit(/Users/...) or bare Read) are rejected by claudePermissionsCheck
  writeClaudeAllowlist({
    settingsPath,
    allow: ['Bash(git push:*)', 'Bash(/usr/bin/git status:*)', 'Write(*)', 'Read', `Edit(${workDir}/**)`],
  });
  const unsafe = claudePermissionsCheck({ config: config(), settingsPath, workDir, home });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.detail, /Bash\(git push:\*\)/);
  assert.match(unsafe.detail, /Bash\(\/usr\/bin\/git status:\*\)/);
  assert.match(unsafe.detail, /Write\(\*\)/);
  assert.match(unsafe.detail, /Read/);
  assert.match(unsafe.detail, /Edit\(\//);
});

test('Probe A0 (б), (г): runClaudeAgent passes --setting-sources "", --settings, --permission-mode dontAsk, --permission-prompts none, --json-schema string, and --resume, and extracts permission_denials before subtype success', async () => {
  const schemaFile = path.join(root, 'schema.json');
  const schemaObj = {
    type: 'object',
    properties: { task_id: { type: 'string' }, status: { type: 'string' } },
    required: ['task_id', 'status'],
  };
  writeFileSync(schemaFile, JSON.stringify(schemaObj, null, 2));

  const argsLog = path.join(root, 'claude-args.jsonl');
  const fakeClaude = path.join(root, 'fake-claude');
  writeFileSync(
    fakeClaude,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const isResume = args.includes('--resume');
if (!isResume) {
  // Turn 1: exits 0 with subtype:"success", but has permission_denials (exact Probe A0 behavior!)
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-a0-123',
    permission_denials: [
      {
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        tool_input: { command: 'npm run lint' }
      }
    ],
    structured_output: { task_id: 'T-026', status: 'done' },
    result: '{"task_id":"T-026","status":"done"}'
  }));
} else {
  // Turn 2 (--resume sess-a0-123): clean success without permission_denials
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-a0-123',
    permission_denials: [],
    structured_output: { task_id: 'T-026', status: 'done' },
    result: '{"task_id":"T-026","status":"done"}'
  }));
}
`,
  );
  chmodSync(fakeClaude, 0o755);

  // Turn 1: should return denied:true with deniedStep extracted from permission_denials
  const r1 = await runClaudeAgent({
    bin: fakeClaude,
    model: 'sonnet',
    prompt: 'Do T-026',
    cwd: workDir,
    schemaPath: schemaFile,
    env: process.env,
    skipPermissions: false,
    timeoutMs: 10_000,
    settingsPath,
    home,
  });

  assert.equal(r1.ok, false);
  assert.equal(r1.denied, true);
  assert.equal(r1.conversationId, 'sess-a0-123');
  assert.deepEqual(r1.deniedStep, { kind: 'command', command: 'npm run lint' });

  // Turn 2: resume with conversationId
  const r2 = await runClaudeAgent({
    bin: fakeClaude,
    model: 'sonnet',
    prompt: 'Continue T-026',
    cwd: workDir,
    schemaPath: schemaFile,
    env: process.env,
    skipPermissions: false,
    timeoutMs: 10_000,
    conversationId: r1.conversationId,
    settingsPath,
    home,
  });

  assert.equal(r2.ok, true);
  assert.equal(r2.conversationId, 'sess-a0-123');
  assert.deepEqual(r2.json, { task_id: 'T-026', status: 'done' });

  const loggedCalls = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(loggedCalls.length, 2);

  // Verify exact CLI flags from Probe A0 (г)
  const call1 = loggedCalls[0];
  assert.equal(call1[call1.indexOf('--setting-sources') + 1], '');
  assert.equal(call1[call1.indexOf('--settings') + 1], settingsPath);
  assert.equal(call1[call1.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(call1[call1.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(call1[call1.indexOf('--output-format') + 1], 'json');
  assert.deepEqual(JSON.parse(call1[call1.indexOf('--json-schema') + 1]), schemaObj, '--json-schema must pass the JSON schema string, not a file path');
  assert.ok(!call1.includes('--resume'));

  const call2 = loggedCalls[1];
  assert.equal(call2[call2.indexOf('--resume') + 1], 'sess-a0-123');
});

test('extractClaudeDeniedStep and createClaudeFormatter handle Bash and file tools', () => {
  assert.deepEqual(
    extractClaudeDeniedStep([{ tool_name: 'Bash', tool_input: { command: '/usr/bin/git log' } }]),
    { kind: 'command', command: '/usr/bin/git log' },
  );
  assert.deepEqual(
    extractClaudeDeniedStep([{ tool_name: 'Write', tool_input: { file_path: '/app/.claude/settings.local.json' } }]),
    { kind: 'other', text: 'Write: /app/.claude/settings.local.json' },
  );

  const fmt = createClaudeFormatter({ workDir: '/w/proj', home: '/w' });
  const lines = fmt([
    {
      timestamp: '2026-10-26T12:00:00Z',
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/w/proj/src/a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/w/proj/src/a.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/w/other/b.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run unit tests' } },
        ],
      },
    },
  ]);
  const formatted = lines.map((l) => l.slice(9));
  assert.equal(formatted.length, 4);
  assert.match(formatted[0], /^📖 (?:читает|reads) src\/a\.ts$/);
  assert.match(formatted[1], /^✏️ (?:правит|edits) src\/a\.ts$/);
  assert.match(formatted[2], /^📝 (?:создаёт|creates) ~\/other\/b\.ts$/);
  assert.equal(formatted[3], '▶ npm test — Run unit tests');

  const models = listClaudeModels();
  assert.ok(models.some((m) => m.id === 'sonnet'));
  assert.ok(models.some((m) => m.id === 'opus'));
  assert.ok(models.some((m) => m.id === 'haiku'));
});
