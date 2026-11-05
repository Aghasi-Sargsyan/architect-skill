import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agyMod from './agy.mjs';
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

test('T-079: finishFromTranscript and runAgent recover a completed finish tool call when agy exits 0 with raw.status ERROR, while failing closed without finish', async () => {
  const finishArgs = {
    task_id: 'T-037',
    status: 'done',
    commits: ['5e3d20b655d366ab46eda2f351b3ac7874c20b91'],
    report_markdown: '# Report T-037\nAll checks passed.',
  };
  const { finishFromTranscript } = agyMod;
  assert.equal(typeof finishFromTranscript, 'function', 'finishFromTranscript must be exported from adapters/agy.mjs');
  assert.equal(finishFromTranscript('c-missing', home), null);

  const finishRow = JSON.stringify({
    step_index: 184,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    tool_calls: [{ name: 'finish', args: finishArgs }],
  });
  const postFinishRow = JSON.stringify({
    step_index: 185,
    type: 'GENERIC',
    status: 'DONE',
    content: 'Task is complete. Summarize what you did and do not call any more tools.',
  });
  write(path.relative(home, transcriptPath('c-t037', home)), `${finishRow}\n${postFinishRow}\n`);
  assert.deepEqual(finishFromTranscript('c-t037', home), finishArgs);

  // 1. agy exits 0 with raw.status === 'ERROR' after finish tool call -> recovered with ok: true
  const agyRecover = path.join(home, 'fake-agy-recover');
  writeFileSync(
    agyRecover,
    `#!/bin/sh\nprintf '%s' '${JSON.stringify({ status: 'ERROR', conversation_id: 'c-t037', response: JSON.stringify(finishArgs) })}'\nexit 0\n`,
  );
  chmodSync(agyRecover, 0o755);
  const logs = [];
  const rec = await runAgent({
    bin: agyRecover,
    model: 'gemini-3.8-flash-high',
    prompt: 'p',
    cwd: home,
    schemaPath: 's.json',
    env: process.env,
    skipPermissions: false,
    timeoutMs: 10_000,
    home,
    log: (m) => logs.push(m),
  });
  assert.equal(rec.ok, true, 'runAgent must recover completed finish response when exit=0, no denial, and finish is in transcript');
  assert.equal(rec.recoveredAfterFinish, true);
  assert.deepEqual(rec.json, finishArgs);
  assert.ok(logs.some((l) => /recovered.*finish/i.test(l)), `expected recovery log message, got: ${logs.join('; ')}`);

  // 2. agy exits with raw.status === 'ERROR' and NO finish tool call in transcript -> fails closed
  write(path.relative(home, transcriptPath('c-nofinish', home)), `${step('DONE', 'reading favicon.ico')}\n`);
  const agyFail = path.join(home, 'fake-agy-fail');
  writeFileSync(
    agyFail,
    `#!/bin/sh\nprintf '%s' '${JSON.stringify({ status: 'ERROR', conversation_id: 'c-nofinish', response: 'Unsupported mime type: image/x-icon' })}'\nexit 0\n`,
  );
  chmodSync(agyFail, 0o755);
  const failed = await runAgent({
    bin: agyFail,
    model: 'gemini-3.8-flash-high',
    prompt: 'p',
    cwd: home,
    schemaPath: 's.json',
    env: process.env,
    skipPermissions: false,
    timeoutMs: 10_000,
    home,
  });
  assert.equal(failed.ok, false, 'runAgent must fail closed when raw.status is ERROR and no finish call exists in transcript');
  assert.match(failed.error, /status ERROR.*image\/x-icon/);

  const agyLines = readFileSync(new URL('./agy.mjs', import.meta.url), 'utf8').split('\n').length;
  assert.ok(agyLines <= 400, `adapters/agy.mjs must stay <= 400 lines (got ${agyLines})`);
});
