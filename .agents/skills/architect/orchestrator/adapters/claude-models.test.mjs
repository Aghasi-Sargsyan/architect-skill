// Frozen reference test: Claude Code model ids with effort tiers (`<alias>-<effort>`), runner arguments and subagent frontmatter sync.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODEL_ALIASES,
  claudeModelArgs,
  listClaudeModels,
  splitClaudeModel,
  syncClaudeAgentFile,
} from './claude-models.mjs';
import { claudeSettingsPath, listClaudeModels as listFromClaudeAdapter, runClaudeAgent } from './claude.mjs';
import { getAdapter } from './index.mjs';
import { extractEffort, setRoleModel } from '../models.mjs';

const adaptersDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(path.dirname(adaptersDir));
let root;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-models-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('listClaudeModels: plain aliases keep their historical first positions, then 5 effort variants per alias', () => {
  assert.deepEqual(CLAUDE_MODEL_ALIASES, ['sonnet', 'opus', 'haiku', 'fable']);
  assert.deepEqual(CLAUDE_EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  const models = listClaudeModels();
  assert.equal(models.length, 24);
  assert.deepEqual(models.slice(0, 4), [
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'opus', name: 'Claude Opus' },
    { id: 'haiku', name: 'Claude Haiku' },
    { id: 'fable', name: 'Claude Fable' },
  ]);
  assert.deepEqual(models.slice(4, 9), [
    { id: 'sonnet-low', name: 'Claude Sonnet (Low)' },
    { id: 'sonnet-medium', name: 'Claude Sonnet (Medium)' },
    { id: 'sonnet-high', name: 'Claude Sonnet (High)' },
    { id: 'sonnet-xhigh', name: 'Claude Sonnet (XHigh)' },
    { id: 'sonnet-max', name: 'Claude Sonnet (Max)' },
  ]);
  assert.deepEqual(models[23], { id: 'fable-max', name: 'Claude Fable (Max)' });
  assert.equal(new Set(models.map((m) => m.id)).size, 24, 'ids must be unique');
});

test('listClaudeModels: extractEffort reads the tier of every variant and none for plain aliases', () => {
  for (const m of listClaudeModels()) {
    const dash = m.id.lastIndexOf('-');
    const expected = dash === -1 ? null : m.id.slice(dash + 1);
    assert.equal(extractEffort(m), expected, `effort of ${m.id}`);
  }
});

test('listClaudeModels: the claude adapter and the registry expose the same list', () => {
  assert.deepEqual(listFromClaudeAdapter(), listClaudeModels());
  assert.deepEqual(getAdapter('claude').listModels(), listClaudeModels());
});

test('splitClaudeModel: effort is split only from Claude model ids', () => {
  assert.deepEqual(splitClaudeModel('opus-high'), { model: 'opus', effort: 'high' });
  assert.deepEqual(splitClaudeModel('fable-max'), { model: 'fable', effort: 'max' });
  assert.deepEqual(splitClaudeModel(' sonnet-xhigh '), { model: 'sonnet', effort: 'xhigh' });
  assert.deepEqual(splitClaudeModel('sonnet'), { model: 'sonnet', effort: null });
  assert.deepEqual(splitClaudeModel('claude-opus-5-5-xhigh'), { model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.deepEqual(splitClaudeModel('claude-sonnet-4-5'), { model: 'claude-sonnet-4-5', effort: null });
  assert.deepEqual(splitClaudeModel('gemini-3.8-flash-high'), { model: 'gemini-3.8-flash-high', effort: null });
  assert.deepEqual(splitClaudeModel('opus-turbo'), { model: 'opus-turbo', effort: null });
  assert.deepEqual(splitClaudeModel('high'), { model: 'high', effort: null });
});

test('splitClaudeModel and claudeModelArgs: invalid ids fail closed with a TypeError', () => {
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.throws(() => splitClaudeModel(bad), (err) => err instanceof TypeError && /non-empty string/.test(err.message), `splitClaudeModel(${String(bad)})`);
    assert.throws(() => claudeModelArgs(bad), (err) => err instanceof TypeError && /non-empty string/.test(err.message), `claudeModelArgs(${String(bad)})`);
  }
});

test('claudeModelArgs: --effort is added only for a split tier', () => {
  assert.deepEqual(claudeModelArgs('opus-high'), ['--model', 'opus', '--effort', 'high']);
  assert.deepEqual(claudeModelArgs('claude-opus-5-5-low'), ['--model', 'claude-opus-5-5', '--effort', 'low']);
  assert.deepEqual(claudeModelArgs('sonnet'), ['--model', 'sonnet']);
  assert.deepEqual(claudeModelArgs('claude-sonnet-4-5'), ['--model', 'claude-sonnet-4-5']);
});

test('syncClaudeAgentFile: writes model and effort inside the frontmatter only', () => {
  assert.equal(
    syncClaudeAgentFile('---\nname: executor\nmodel: sonnet\n---\nPrompt\n', 'opus-high'),
    '---\nname: executor\nmodel: opus\neffort: high\n---\nPrompt\n',
  );
  assert.equal(
    syncClaudeAgentFile('---\nname: executor\nmodel: opus\neffort: low\n---\nPrompt\n', 'sonnet-max'),
    '---\nname: executor\nmodel: sonnet\neffort: max\n---\nPrompt\n',
  );
  assert.equal(
    syncClaudeAgentFile('---\nname: executor\nmodel: opus\neffort: high\n---\nPrompt\n', 'haiku'),
    '---\nname: executor\nmodel: haiku\n---\nPrompt\n',
  );
  assert.equal(
    syncClaudeAgentFile('---\nname: executor\nmodel: gemini-3.8-flash-low\n---\nPrompt\n', 'gemini-3.8-flash-high'),
    '---\nname: executor\nmodel: gemini-3.8-flash-high\n---\nPrompt\n',
  );
  assert.equal(
    syncClaudeAgentFile('---\nname: executor\nmodel: sonnet\n---\nmodel: keep\neffort: keep\n', 'opus'),
    '---\nname: executor\nmodel: opus\n---\nmodel: keep\neffort: keep\n',
  );
});

test('syncClaudeAgentFile: returns null without frontmatter or without an active model line', () => {
  const template = readFileSync(path.join(skillDir, 'templates', 'claude-agent-executor.md'), 'utf8');
  assert.equal(syncClaudeAgentFile(template, 'opus-high'), null, 'the template keeps model commented out');
  assert.equal(syncClaudeAgentFile('model: sonnet\nPrompt\n', 'opus'), null);
  assert.equal(syncClaudeAgentFile('---\nname: executor\nmodel: sonnet\nPrompt without closing\n', 'opus'), null);
  assert.equal(syncClaudeAgentFile('---\nname: executor\n---\nmodel: sonnet\n', 'opus'), null);
});

test('template: claude-agent-executor.md documents an optional effort field and still pre-fills no model', () => {
  const template = readFileSync(path.join(skillDir, 'templates', 'claude-agent-executor.md'), 'utf8');
  assert.match(template, /^# effort: /m);
  assert.doesNotMatch(template, /^model:/m);
  assert.doesNotMatch(template, /^effort:/m);
});

test('setRoleModel: an effort id is stored whole in config and split into model + effort in .claude/agents/executor.md', () => {
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'orchestrator.json'), JSON.stringify({ executor: { model: 'sonnet' } }, null, 2) + '\n');
  const agentFile = path.join(root, '.claude', 'agents', 'executor.md');
  writeFileSync(agentFile, '---\nname: executor\nmodel: sonnet\n---\nPrompt\n');

  const res = setRoleModel({ workDir: root, role: 'executor', model: 'opus-high' });
  assert.equal(res.ok, true);
  assert.ok(res.updatedFiles.includes('.claude/agents/executor.md'));
  assert.equal(JSON.parse(readFileSync(path.join(root, '.agents', 'orchestrator.json'), 'utf8')).executor.model, 'opus-high');
  assert.equal(readFileSync(agentFile, 'utf8'), '---\nname: executor\nmodel: opus\neffort: high\n---\nPrompt\n');

  setRoleModel({ workDir: root, role: 'executor', model: 'gemini-3.8-flash-high' });
  assert.equal(readFileSync(agentFile, 'utf8'), '---\nname: executor\nmodel: gemini-3.8-flash-high\n---\nPrompt\n');
});

test('runClaudeAgent: an effort id becomes --model <alias> --effort <tier>; a plain alias passes no --effort', async () => {
  const home = path.join(root, 'home');
  const workDir = path.join(home, 'projects', 'app');
  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  const settingsPath = claudeSettingsPath(home);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [], deny: [] } }));
  const schemaFile = path.join(root, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }));
  const argsLog = path.join(root, 'claude-args.jsonl');
  const fakeClaude = path.join(root, 'fake-claude');
  writeFileSync(
    fakeClaude,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const sid = args[args.indexOf('--session-id') + 1] || 'sess-models';
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid, permission_denials: [], structured_output: { status: 'done' }, result: '{"status":"done"}' }));
`,
  );
  chmodSync(fakeClaude, 0o755);
  const run = (model) => runClaudeAgent({
    bin: fakeClaude, model, prompt: 'Do it', cwd: workDir, schemaPath: schemaFile, env: process.env,
    skipPermissions: false, timeoutMs: 10_000, settingsPath, home,
  });

  const r1 = await run('opus-high');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await run('sonnet');
  assert.equal(r2.ok, true, JSON.stringify(r2));

  const [a1, a2] = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const at = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(at(a1, '--model'), 'opus');
  assert.equal(at(a1, '--effort'), 'high');
  assert.equal(a1.includes('opus-high'), false, 'the combined id must never reach the claude CLI');
  assert.equal(at(a2, '--model'), 'sonnet');
  assert.equal(a2.includes('--effort'), false);
});
