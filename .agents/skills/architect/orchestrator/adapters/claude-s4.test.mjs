import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeTranscript, runClaudeAgent, createClaudeFormatter } from './claude.mjs';

let root;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-claude-s4-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('T-033 (Ф7): findClaudeTranscript locates ~/.claude/projects/*/<sessionId>.jsonl without relying on folder slug calculation and returns null when absent', () => {
  const home = path.join(root, 'home');
  const sessionId = '11111111-2222-4333-8444-555555555555';
  assert.equal(findClaudeTranscript(sessionId, home), null);

  const arbitraryProjectDir = path.join(home, '.claude', 'projects', '-private-tmp-arbitrary-slug-999');
  mkdirSync(arbitraryProjectDir, { recursive: true });
  const expectedFile = path.join(arbitraryProjectDir, `${sessionId}.jsonl`);
  writeFileSync(expectedFile, '{"type":"assistant"}\n');

  assert.equal(findClaudeTranscript(sessionId, home), expectedFile);
  assert.equal(findClaudeTranscript('missing-uuid', home), null);
});

test('T-033 (Ф7): runClaudeAgent passes --session-id <uuid> on first turn, tails ~/.claude/projects/*/<uuid>.jsonl live for --follow, and returns transcript:null without error if no transcript file appears', async () => {
  const home = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  mkdirSync(workDir, { recursive: true });
  const settingsPath = path.join(root, 'claude-settings.json');
  writeFileSync(settingsPath, '{}');
  const schemaPath = path.join(root, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: { task_id: { type: 'string' } } }));

  const argsLog = path.join(root, 'args.jsonl');
  const fakeClaude = path.join(root, 'fake-claude');
  writeFileSync(
    fakeClaude,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const sidIdx = args.indexOf('--session-id');
const resumeIdx = args.indexOf('--resume');
const sessionId = sidIdx >= 0 ? args[sidIdx + 1] : (resumeIdx >= 0 ? args[resumeIdx + 1] : 'fallback-id');

if (process.env.WRITE_TRANSCRIPT === '1') {
  const projDir = path.join(${JSON.stringify(home)}, '.claude', 'projects', '-custom-internal-slug');
  fs.mkdirSync(projDir, { recursive: true });
  const tf = path.join(projDir, sessionId + '.jsonl');
  const row = {
    timestamp: '2026-10-28T15:00:00Z',
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: path.join(${JSON.stringify(workDir)}, 'src/index.js') } },
        { type: 'tool_use', name: 'Bash', input: { command: 'node --test', description: 'Run tests' } }
      ]
    }
  };
  fs.appendFileSync(tf, JSON.stringify(row) + '\\n');
}

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: sessionId,
  permission_denials: [],
  structured_output: { task_id: 'T-033', status: 'done' },
  result: '{"task_id":"T-033","status":"done"}'
}));
`,
  );
  chmodSync(fakeClaude, 0o755);

  // Case 1: Transcript file appears in ~/.claude/projects/*/<uuid>.jsonl during the run
  const collectedRows = [];
  const r1 = await runClaudeAgent({
    bin: fakeClaude,
    model: 'haiku',
    prompt: 'Execute T-033',
    cwd: workDir,
    schemaPath,
    env: { ...process.env, WRITE_TRANSCRIPT: '1' },
    skipPermissions: false,
    timeoutMs: 10_000,
    settingsPath,
    home,
    onTranscriptRows: (rows) => collectedRows.push(...rows),
  });

  assert.equal(r1.ok, true);
  assert.ok(r1.conversationId, 'must return session UUID as conversationId');
  assert.match(r1.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(r1.transcript, `~/.claude/projects/-custom-internal-slug/${r1.conversationId}.jsonl`);
  assert.equal(collectedRows.length, 1);

  const fmt = createClaudeFormatter({ workDir, home });
  const feedLines = fmt(collectedRows).map((l) => l.slice(9));
  assert.equal(feedLines.length, 2);
  assert.match(feedLines[0], /^📖 (?:читает|reads) src\/index\.js$/);
  assert.equal(feedLines[1], '▶ node --test — Run tests');

  // Continuation turn with conversationId: must pass --resume <id> and NOT --session-id, and only tail new rows
  const contRows = [];
  const r2 = await runClaudeAgent({
    bin: fakeClaude,
    model: 'haiku',
    prompt: 'Continue T-033',
    cwd: workDir,
    schemaPath,
    env: { ...process.env, WRITE_TRANSCRIPT: '1' },
    skipPermissions: false,
    timeoutMs: 10_000,
    conversationId: r1.conversationId,
    settingsPath,
    home,
    onTranscriptRows: (rows) => contRows.push(...rows),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.conversationId, r1.conversationId);
  assert.equal(contRows.length, 1, 'continuation must read only newly appended rows via JsonlTail.fromEnd');

  const calls = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls[0].includes('--session-id'), 'first turn must pass --session-id');
  assert.ok(!calls[0].includes('--resume'), 'first turn must not pass --resume');
  assert.equal(calls[0][calls[0].indexOf('--session-id') + 1], r1.conversationId);
  assert.ok(calls[1].includes('--resume'), 'continuation turn must pass --resume');
  assert.ok(!calls[1].includes('--session-id'), 'continuation turn must not pass --session-id');

  // Case 2: Transcript file never appears -> transcript: null, no error
  const rNoTranscript = await runClaudeAgent({
    bin: fakeClaude,
    model: 'haiku',
    prompt: 'Execute without transcript',
    cwd: workDir,
    schemaPath,
    env: { ...process.env, WRITE_TRANSCRIPT: '0' },
    skipPermissions: false,
    timeoutMs: 10_000,
    settingsPath,
    home,
    onTranscriptRows: () => {},
  });
  assert.equal(rNoTranscript.ok, true);
  assert.equal(rNoTranscript.transcript, null);
});
