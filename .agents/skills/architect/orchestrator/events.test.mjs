// Frozen reference test for T-024 (S3: events.jsonl, cross-platform binary lookup without /usr/bin/which, and C1 privacy-safe webhook).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENTS_FILE,
  WEBHOOK_ENV_VAR,
  appendEvent,
  classifyStopReason,
  defaultWebhookFile,
  findExecutable,
  formatWebhookBody,
  milestonesFromEvents,
  readEvents,
  resolveWebhookUrl,
  sendNotification,
} from './events.mjs';
import { findBinary } from './check.mjs';
import { which, whichOptional } from './guards.mjs';
import { statusText, watch } from './feed.mjs';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-events-s3-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('appendEvent and readEvents write/read JSONL events and tolerate partial trailing lines', () => {
  const runDir = path.join(tmp, 'run-1');
  mkdirSync(runDir, { recursive: true });
  appendEvent(runDir, { ts: '2026-10-26T10:00:00.000Z', type: 'run_started', executorModel: 'm1', architectModel: 'm2' });
  appendEvent(runDir, { ts: '2026-10-26T10:00:05.000Z', type: 'task_started', taskId: 'T-024', risk: 'высокий', title: 'Events', model: 'm1' });
  const events = readEvents(runDir);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[1].taskId, 'T-024');

  // Append an incomplete JSON line — readEvents must skip broken lines without throwing
  writeFileSync(path.join(runDir, EVENTS_FILE), '{"ts":"2026-10-26T10:00:00.000Z","type":"run_started"}\n{"broken":', 'utf8');
  const recovered = readEvents(runDir);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].type, 'run_started');
});

test('milestonesFromEvents computes rework and accepted+next milestones independently of run.log language', () => {
  const events = [
    { ts: '2026-10-26T10:00:00.000Z', type: 'task_started', taskId: 'T-011', risk: 'high', title: 'Task A', model: 'm' },
    { ts: '2026-10-26T10:05:00.000Z', type: 'architect_finished', taskId: 'T-011', round: 0, ok: true, verdict: 'rework' },
    { ts: '2026-10-26T10:09:30.000Z', type: 'architect_finished', taskId: 'T-011', round: 1, ok: true, verdict: 'accepted' },
    { ts: '2026-10-26T10:09:31.000Z', type: 'task_started', taskId: 'T-013', risk: 'high', title: 'Task B', model: 'm' },
    { ts: '2026-10-26T10:20:00.000Z', type: 'architect_finished', taskId: 'T-013', round: 0, ok: true, verdict: 'accepted' },
    { ts: '2026-10-26T10:20:01.000Z', type: 'run_stopped', category: 'all_accepted', status: 'ok', taskId: 'none' },
  ];
  assert.deepEqual(milestonesFromEvents(events), [
    'T-011: rework 1',
    'T-011 accepted (10 min); next T-013',
  ]);

  // Stopping on needs_user produces no milestone
  assert.deepEqual(
    milestonesFromEvents([
      { ts: '2026-10-26T10:00:00.000Z', type: 'task_started', taskId: 'T-001', risk: 'low', title: 'X', model: 'm' },
      { ts: '2026-10-26T10:01:00.000Z', type: 'architect_finished', taskId: 'T-001', round: 0, ok: true, verdict: 'needs_user' },
    ]),
    [],
  );
});

test('watch and statusText read events.jsonl even when run.log has English or non-matching wording', async () => {
  const runs = path.join(tmp, '.agent-runs');
  const runDir = path.join(runs, '2026-10-26T10-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runs, '.lock'), String(process.pid));
  // run.log has English lines that do NOT match Russian regexes TASK_START_RE / VERDICT_RE
  writeFileSync(path.join(runDir, 'run.log'), '[10:00:00] Starting T-024 in English only\n[10:08:00] Architect accepted T-024\n');
  writeFileSync(path.join(runDir, 'feed.log'), '10:01:00 step 1\n');

  appendEvent(runDir, { ts: '2026-10-26T10:00:00.000Z', type: 'task_started', taskId: 'T-024', risk: 'высокий', title: 'Events log', model: 'm-exec' });
  appendEvent(runDir, { ts: '2026-10-26T10:08:00.000Z', type: 'architect_finished', taskId: 'T-024', round: 0, ok: true, verdict: 'accepted' });
  appendEvent(runDir, { ts: '2026-10-26T10:08:01.000Z', type: 'task_started', taskId: 'T-025', risk: 'высокий', title: 'Adapters', model: 'm-exec' });

  const st = statusText(tmp, Date.parse('2026-10-26T10:09:00.000Z'));
  assert.match(st, /T-025 \(высокий\): Adapters; (?:Исполнитель|Executor) m-exec/);

  const w = await watch({ workDir: tmp, minutes: 0.002, since: 0, pollMs: 10, graceMs: 30 });
  assert.equal(w.code, 4);
  assert.match(w.text, /^T-024 (?:принята \(8 мин\); дальше T-025 \(вех: 1\)|accepted \(8 min\); next T-025 \(milestones: 1\))$/);
});

test('D10: findExecutable, findBinary, which, and whichOptional resolve binaries across PATH without /usr/bin/which and skip agent-loop shims', () => {
  const shimDir = path.join(tmp, 'shims');
  const realBinDir = path.join(tmp, 'bin');
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(realBinDir, { recursive: true });

  // Put an agent-loop guard git shim in shimDir
  const gitShim = path.join(shimDir, 'git');
  writeFileSync(gitShim, '#!/bin/sh\n# agent-loop guard: git shim\nexit 0\n');
  chmodSync(gitShim, 0o755);

  const fakeToolInShim = path.join(shimDir, 'my-tool');
  writeFileSync(fakeToolInShim, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeToolInShim, 0o755);

  // Non-executable file in realBinDir should be skipped
  const nonExec = path.join(realBinDir, 'non-exec');
  writeFileSync(nonExec, '#!/bin/sh\nexit 0\n');
  chmodSync(nonExec, 0o644);

  // Real executable in realBinDir
  const realTool = path.join(realBinDir, 'my-tool');
  writeFileSync(realTool, '#!/bin/sh\nexit 0\n');
  chmodSync(realTool, 0o755);

  const customPath = `${shimDir}${path.delimiter}${realBinDir}`;
  assert.equal(findExecutable('my-tool', customPath), realTool, 'skips shimDir containing agent-loop guard git shim');
  assert.equal(findExecutable('non-exec', customPath), null, 'ignores non-executable files');
  assert.equal(findExecutable('missing-tool-xyz', customPath), null);
  assert.equal(findExecutable(realTool, ''), realTool, 'accepts absolute executable path');
  assert.equal(findExecutable(nonExec, ''), null, 'rejects non-executable absolute path');

  assert.equal(findBinary('my-tool', customPath), realTool);
  assert.equal(which('my-tool', customPath), realTool);
  assert.throws(() => which('missing-tool-xyz', customPath), /не найден|not found in PATH/);
  assert.equal(whichOptional('missing-tool-xyz', customPath), '');
});

test('C1: resolveWebhookUrl reads only from env or user file outside repo, and sendNotification never leaks stopReason or agent output into the request body', async () => {
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });

  // 1. Neither env nor file -> null
  assert.equal(resolveWebhookUrl({ env: {}, home }), null);

  // 2. User file outside repo (~/.config/architect/webhook-url) with comment line
  const wf = defaultWebhookFile(home);
  mkdirSync(path.dirname(wf), { recursive: true });
  writeFileSync(wf, '# my secret ntfy topic\nhttps://ntfy.example.invalid/secret-topic-file\n');
  assert.equal(resolveWebhookUrl({ env: {}, home }), 'https://ntfy.example.invalid/secret-topic-file');

  // 3. Env variable takes precedence over file
  assert.equal(
    resolveWebhookUrl({ env: { [WEBHOOK_ENV_VAR]: 'https://ntfy.example.invalid/secret-topic-env' }, home }),
    'https://ntfy.example.invalid/secret-topic-env',
  );

  // 4. classifyStopReason maps human stopReason to safe category/status/taskId
  assert.deepEqual(
    classifyStopReason('T-024: сбой Исполнителя — ответ не JSON: SECRET_PERSONAL_DATA_FROM_RAW_RESPONSE_999'),
    { category: 'executor_failed', status: 'failed', taskId: 'T-024' },
  );
  assert.deepEqual(
    classifyStopReason('все задачи приняты; закрытие цикла и ретро — в интерактивной сессии с Архитектором'),
    { category: 'all_accepted', status: 'ok', taskId: 'none' },
  );

  // 5. sendNotification sends ONLY fixed short fields (taskId, status, category) — stopReason text NEVER enters body or headers
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const osascriptCalls = [];
  const sensitiveStopReason = 'T-024: сбой Исполнителя — ответ не JSON: {"secret_note":"PRIVATE_SECRET_PAYLOAD_42"}';

  const res = await sendNotification({
    config: { notify: true },
    text: sensitiveStopReason,
    eventType: 'stop',
    env: { [WEBHOOK_ENV_VAR]: 'https://ntfy.example.invalid/secret-topic-env' },
    home,
    platform: 'linux',
    fetchFn: fakeFetch,
    execOsascript: (t) => osascriptCalls.push(t),
  });

  assert.equal(res.webhookSent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.example.invalid/secret-topic-env');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'agent-loop: stop task=T-024 status=failed category=executor_failed');
  assert.equal(calls[0].init.body.includes('PRIVATE_SECRET_PAYLOAD_42'), false, 'stopReason / raw.response must never leak into webhook body');
  assert.equal(JSON.stringify(calls[0].init).includes('PRIVATE_SECRET_PAYLOAD_42'), false, 'stopReason must never leak into headers or options');
  assert.equal(JSON.stringify(calls[0].init).includes('сбой Исполнителя'), false, 'human stopReason text is excluded from webhook payload');

  // 6. Question notification also strips command text
  const qCalls = [];
  await sendNotification({
    config: { notify: true },
    text: 'нужно разрешение: npx tsx scripts/run-migration.ts /Users/secret/secrets.json',
    eventType: 'question',
    taskId: 'T-024',
    role: 'executor',
    env: { [WEBHOOK_ENV_VAR]: 'https://ntfy.example.invalid/secret-topic-env' },
    home,
    platform: 'linux',
    fetchFn: async (url, init) => { qCalls.push({ url, init }); return { ok: true, status: 200 }; },
  });
  assert.equal(qCalls.length, 1);
  assert.equal(qCalls[0].init.body, 'agent-loop: question task=T-024 status=question category=permission_prompt role=executor');
  assert.equal(qCalls[0].init.body.includes('secrets.json'), false);

  // 7. formatWebhookBody sanitizes untrusted inputs
  assert.equal(
    formatWebhookBody({ eventType: 'stop', taskId: 'T-024; leak', status: 'bad', category: 'bad category!' }),
    'agent-loop: stop task=none status=stopped category=unknown_stop',
  );
});
