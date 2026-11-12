import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agyModule from './agy.mjs';
import { runAgent } from './agy.mjs';

let home;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-agy-s2-')));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test('T-020: parseAgentResponse accepts clean JSON or text + final JSON at the end, and reports discardedPrefixLength', () => {
  assert.equal(typeof agyModule.parseAgentResponse, 'function', 'parseAgentResponse must be exported from adapters/agy.mjs');
  const { parseAgentResponse } = agyModule;

  const finalObj = {
    task_id: 'T-020',
    status: 'done',
    commits: ['abc1234'],
    report_markdown: '### Отчёт\nВнутри строки есть {фигурные} скобки и "кавычки": {"nested": 1}',
  };
  const finalJson = JSON.stringify(finalObj, null, 2);

  // 1. Clean JSON (with surrounding whitespace) -> discardedPrefixLength === 0
  const clean = parseAgentResponse(`  \n${finalJson}\n  `);
  assert.deepEqual(clean.json, finalObj);
  assert.equal(clean.discardedPrefixLength, 0);

  // 2. Intermediate text (e.g. background task wakeup) + final JSON at the end
  const prefix = 'Команда node --test ушла в фон (WaitMsBeforeAsync).\nЗавершено успешно.\n';
  const withText = parseAgentResponse(`${prefix}${finalJson}\n`);
  assert.deepEqual(withText.json, finalObj);
  assert.equal(withText.discardedPrefixLength, prefix.length);

  // 3. Earlier valid JSON in text + final valid JSON at the end -> returns the final one
  const earlierJson = JSON.stringify({
    task_id: 'T-000',
    status: 'escalation',
    commits: [],
    report_markdown: 'intermediate or quoted json',
  });
  const multiPrefix = `Промежуточный блок: ${earlierJson}\nФинальный ответ:\n`;
  const multi = parseAgentResponse(`${multiPrefix}${finalJson}`);
  assert.deepEqual(multi.json, finalObj);
  assert.equal(multi.discardedPrefixLength, multiPrefix.length);
});

test('T-020 (П3): parseAgentResponse rejects JSON not at the end, or valid JSON in text followed by truncated final JSON', () => {
  assert.equal(typeof agyModule.parseAgentResponse, 'function', 'parseAgentResponse must be exported from adapters/agy.mjs');
  const { parseAgentResponse } = agyModule;

  const validQuoted = JSON.stringify({
    task_id: 'T-020',
    status: 'done',
    commits: ['1111111'],
    report_markdown: 'quoted from file',
  });

  // 1. Valid JSON followed by trailing non-whitespace text
  assert.throws(() => parseAgentResponse(`${validQuoted}\nЕщё какой-то текст после JSON`));

  // 2. Valid JSON in text + truncated final JSON cut mid-object
  assert.throws(() => parseAgentResponse(`Цитирую из файла: ${validQuoted}\nФинальный ответ: {"task_id":"T-020","status":"done","report_markdown":"обрез`));

  // 3. Valid JSON in text + truncated outer JSON that happens to end right after an inner object "}"
  assert.throws(() => parseAgentResponse(`Цитирую: ${validQuoted}\nФинальный ответ: {"task_id":"T-020","nested":${validQuoted}`));

  // 4. Non-object JSON values or empty text
  for (const invalid of ['', '   ', 'просто текст без json', '[1, 2, 3]', '"string"', '123', 'null', 'true']) {
    assert.throws(() => parseAgentResponse(invalid), `must reject: ${invalid}`);
  }
});

test('T-020: runAgent succeeds on text + final JSON, logs discarded prefix length, and fails on truncated final JSON', async () => {
  const agyOk = path.join(home, 'fake-agy-ok');
  const answer = { task_id: 'T-020', status: 'done', commits: ['1234567'], report_markdown: 'ok' };
  const prefix = 'Step 1: backgrounding node --test...\nStep 2: finished.\n';
  const envelopeOk = JSON.stringify({
    status: 'SUCCESS',
    conversation_id: 'conv-s2',
    response: `${prefix}${JSON.stringify(answer)}`,
  });
  writeFileSync(agyOk, `#!/bin/sh\nprintf '%s' '${envelopeOk}'\n`);
  chmodSync(agyOk, 0o755);

  const logs = [];
  const resOk = await runAgent({
    bin: agyOk,
    model: 'm',
    prompt: 'p',
    cwd: home,
    schemaPath: 's.json',
    env: process.env,
    skipPermissions: false,
    timeoutMs: 60_000,
    home,
    log: (m) => logs.push(m),
  });
  assert.equal(resOk.ok, true, resOk.error);
  assert.deepEqual(resOk.json, answer);
  assert.ok(
    logs.some((l) => l.includes(String(prefix.length))),
    `expected log to mention discarded prefix length (${prefix.length}), got: ${logs.join(' | ')}`,
  );

  // Truncated final JSON after a valid quoted JSON must fail
  const agyTrunc = path.join(home, 'fake-agy-trunc');
  const envelopeTrunc = JSON.stringify({
    status: 'SUCCESS',
    conversation_id: 'conv-trunc',
    response: `Quoted: ${JSON.stringify(answer)}\nFinal: {"task_id":"T-020","status":"done"`,
  });
  writeFileSync(agyTrunc, `#!/bin/sh\nprintf '%s' '${envelopeTrunc}'\n`);
  chmodSync(agyTrunc, 0o755);

  const resTrunc = await runAgent({
    bin: agyTrunc,
    model: 'm',
    prompt: 'p',
    cwd: home,
    schemaPath: 's.json',
    env: process.env,
    skipPermissions: false,
    timeoutMs: 60_000,
    maxAttempts: 1,
    home,
  });
  assert.equal(resTrunc.ok, false);
  assert.match(resTrunc.error, /ответ не JSON по схеме|response does not match JSON schema/);
});
