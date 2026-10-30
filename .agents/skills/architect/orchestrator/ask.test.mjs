import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerPath, askPermission, questionPath, questionText, writeAnswer } from './ask.mjs';

let workDir;
let runDir;
const question = { id: 'T-001-exec-q', who: 'Исполнитель', taskId: 'T-001', command: 'npm run lint -- --fix', options: [{ answer: '1', rule: 'npm run lint' }, { answer: '2', rule: 'npm run lint -- --fix' }] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'orch-ask-'));
  runDir = path.join(workDir, '.agent-runs', 'run1');
  mkdirSync(runDir, { recursive: true });
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

test('without a terminal: question file, --answer, answer returned, both files removed and kept in the run folder', async () => {
  const logs = [];
  const asked = askPermission({ question, workDir, runDir, tty: false, timeoutMs: 5000, log: (m) => logs.push(m), pollMs: 20 });
  await sleep(50);
  assert.ok(existsSync(questionPath(workDir)));
  assert.throws(() => writeAnswer({ workDir, answer: '4' }), /не из вариантов 1, 2, 3|not one of the options 1, 2, 3/);
  writeFileSync(answerPath(workDir), JSON.stringify({ id: 'other-question', answer: '1' }));
  await sleep(60);
  assert.equal(existsSync(answerPath(workDir)), false, 'an answer to another question is dropped');
  assert.equal(writeAnswer({ workDir, answer: '1' }).command, question.command);
  assert.equal(await asked, '1');
  assert.equal(existsSync(questionPath(workDir)), false);
  assert.equal(existsSync(answerPath(workDir)), false);
  assert.deepEqual(readdirSync(runDir).sort(), ['T-001-exec-q.answer.json', 'T-001-exec-q.question.json']);
  assert.match(logs.join('\n'), /--answer <1\|2\|3>/);
  const qText = questionText(question);
  const expectedRu = [
    '### 🔐 Разрешение команды',
    '',
    '**Кто:** Исполнитель, задача T-001',
    '',
    '**Команда:** `npm run lint -- --fix`',
    '',
    '**Варианты:**',
    '1. **Всегда** — правило `command(npm run lint)`, с любыми аргументами',
    '2. **Только эту** — правило `command(npm run lint -- --fix)`; дополнительные аргументы тоже пройдут',
    '3. **Нет** — агент продолжит без неё или эскалирует',
    '',
    '**Ответьте:** `1`, `2` или `3`',
  ].join('\n');
  const expectedEn = [
    '### 🔐 Command Permission',
    '',
    '**Who:** Исполнитель, task T-001',
    '',
    '**Command:** `npm run lint -- --fix`',
    '',
    '**Options:**',
    '1. **Always** — rule `command(npm run lint)`, with any arguments',
    '2. **This command only** — rule `command(npm run lint -- --fix)`; extra arguments will also pass',
    '3. **No** — the agent will continue without it or escalate',
    '',
    '**Reply:** `1`, `2` or `3`',
  ].join('\n');
  assert.ok(qText === expectedRu || qText === expectedEn, qText);
  const onlyThis = questionText({ ...question, options: [{ answer: '2', rule: 'pnpm test' }] });
  assert.match(onlyThis, /\*\*(?:Варианты|Options):\*\*\n2\. \*\*(?:Только эту|This command only)\*\*[^\n]*\n3\. \*\*(?:Нет|No)\*\*/, 'list numbers are the answer codes');
  assert.ok(!/^1\./m.test(onlyThis));
  assert.match(onlyThis, /\*\*(?:Ответьте|Reply):\*\* `2` (?:или|or) `3`$/);
  assert.ok(!onlyThis.includes('\n>'), 'no blockquote: its lines would merge');
});

test('no answer in time → null and the question is withdrawn; --answer without a question fails', async () => {
  assert.equal(await askPermission({ question, workDir, runDir, tty: false, timeoutMs: 100, log: () => {}, pollMs: 20 }), null);
  assert.equal(existsSync(questionPath(workDir)), false);
  assert.throws(() => writeAnswer({ workDir, answer: '1' }), /ничего не спрашивает|is not asking anything/);
  assert.equal(readFileSync(path.join(runDir, 'T-001-exec-q.question.json'), 'utf8').includes('npm run lint'), true);
});
