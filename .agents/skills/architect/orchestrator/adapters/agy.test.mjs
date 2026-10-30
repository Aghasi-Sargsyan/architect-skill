import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deniedFromTranscript, maskHome, runAgent, transcriptPath } from './agy.mjs';

let home;
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  writeFileSync(path.join(home, rel), text);
};
const step = (status, content) => JSON.stringify({ step_index: 1, type: 'GENERIC', status, content });

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-agy-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test('deniedFromTranscript: the newest denied command; broken lines and other errors are skipped', () => {
  const file = transcriptPath('c1', home);
  assert.equal(maskHome(file, home), '~/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl');
  assert.equal(deniedFromTranscript('c1', home), null, 'no transcript');
  write(path.relative(home, file), [
    step('ERROR', 'Encountered error in step execution: permission check failed for unsandboxed "ls -la x": user denied permission to run command: ls -la x'),
    step('DONE', 'ok'),
    step('ERROR', 'Encountered error in step execution: permission check failed for unsandboxed "cat "a b".txt": user denied permission to run command: cat "a b".txt Do not attempt'),
    '{ broken',
  ].join('\n'));
  assert.deepEqual(deniedFromTranscript('c1', home), { kind: 'command', command: 'cat "a b".txt' });
  write(path.relative(home, file), step('ERROR', 'write_file permission denied for /etc/x'));
  assert.equal(deniedFromTranscript('c1', home).kind, 'other');
});

test('runAgent: a denial wins over a valid answer in the same turn; --conversation continues it', async () => {
  const agy = path.join(home, 'fake-agy');
  const argsLog = path.join(home, 'args.log');
  const answer = JSON.stringify({ task_id: 'T-1', status: 'escalation', commits: [], report_markdown: 'x' });
  writeFileSync(agy, `#!/bin/sh
echo "$@" >> '${argsLog}'
case "$*" in *--conversation*) printf '%s' '${JSON.stringify({ status: 'SUCCESS', conversation_id: 'c1', response: answer })}'; exit 0;; esac
echo 'a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied' >&2
printf '%s' '${JSON.stringify({ status: 'SUCCESS', conversation_id: 'c1', response: answer, denied_actions: [{ action: 'command' }] })}'
`);
  chmodSync(agy, 0o755);
  write(path.relative(home, transcriptPath('c1', home)), `${step('ERROR', 'permission check failed for unsandboxed "cat a": user denied permission to run command: cat a')}\n`);
  const base = { bin: agy, model: 'm', prompt: 'p', cwd: home, schemaPath: 's.json', env: process.env, skipPermissions: false, timeoutMs: 10_000, home };
  const rows = [];
  const first = await runAgent({ ...base, onTranscriptRows: (r) => rows.push(...r) });
  assert.equal(first.ok, false);
  assert.equal(first.denied, true, 'the valid escalation in the same turn must not hide the denial');
  assert.equal(first.conversationId, 'c1');
  assert.deepEqual(first.deniedStep, { kind: 'command', command: 'cat a' });
  assert.equal(first.transcript, '~/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl');
  assert.equal(rows.length, 1, 'the final read delivers steps written before the exit');
  assert.equal(rows[0].status, 'ERROR');
  const next = await runAgent({ ...base, conversationId: first.conversationId });
  assert.equal(next.ok, true);
  assert.match(readFileSync(argsLog, 'utf8').split('\n')[1], /--conversation c1/);
});
