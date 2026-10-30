import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail, LineTail, createAgyFormatter, follow, milestones, statusText, watch } from './feed.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-feed-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('JsonlTail reads only complete lines, each once; a line cut mid-write waits for the next read', () => {
  const file = path.join(dir, 't.jsonl');
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read(), [], 'no file yet');
  writeFileSync(file, '{"a":1}\n{"b":');
  assert.deepEqual(tail.read(), [{ a: 1 }]);
  appendFileSync(file, '2}\nnot json\n');
  assert.deepEqual(tail.read().map((r) => r.b ?? r.type), [2, 'UNREADABLE']);
  assert.deepEqual(tail.read(), []);
  assert.deepEqual(JsonlTail.fromEnd(file).read(), [], 'a continued conversation starts at the current end');
});

test('the agy formatter: plain words, project-relative paths, the command with its exit code, denials', () => {
  const work = '/w/proj';
  const home = '/w';
  const at = '2026-10-23T13:28:46Z';
  const fmt = createAgyFormatter({ workDir: work, home });
  const call = (name, args) => ({ type: 'PLANNER_RESPONSE', created_at: at, tool_calls: [{ name, args }] });
  const lines = fmt([
    call('read_file', { Path: '"/w/proj/tests/setup.ts"', StartLine: '"1"', EndLine: '"25"' }),
    call('run_command', { CommandLine: '"npx tsc -b"', toolSummary: '"Baseline tsc check"' }),
    { type: 'GENERIC', content: 'Created At: x\nCommand exited with code 2.' },
    call('edit_file', { Path: '"/w/proj/tsconfig.json"' }),
    call('write_file', { Path: '"/w/other/x.txt"' }),
    call('run_command', { CommandLine: '"git commit --only a -m \\"T-1: x\\""' }),
  ]).concat(fmt([
    { type: 'GENERIC', content: 'Command exited with code 0.' },
    { type: 'GENERIC', status: 'ERROR', created_at: at, content: 'permission check failed for unsandboxed "cat /w/secret": user denied' },
    call('finish', { status: '"done"' }),
    call('some_new_tool', {}),
  ]));
  const body = lines.map((l) => l.slice(9));
  assert.equal(body.length, 8);
  assert.match(body[0], /^📖 (?:читает|reads) tests\/setup\.ts \((?:строки|lines) 1–25\)$/);
  assert.match(body[1], /^▶ npx tsc -b — Baseline tsc check ✗ (?:код|exit) 2$/);
  assert.match(body[2], /^✏️ (?:правит|edits) tsconfig\.json$/);
  assert.match(body[3], /^📝 (?:создаёт|creates) ~\/other\/x\.txt$/);
  assert.equal(body[4], '▶ git commit --only a -m "T-1: x" ✓');
  assert.equal(body[5], '⛔ permission check failed for unsandboxed "cat ~/secret": user denied');
  assert.match(body[6], /^🏁 (?:закончил|finished): done$/);
  assert.equal(body[7], '· some_new_tool');
  assert.match(lines[0], /^\d\d:\d\d:\d\d /);
});

test('--watch: a question → exit 2 at once; no loop after the grace period → exit 3 with the summary; read-only', async () => {
  const runs = path.join(dir, '.agent-runs');
  const run = path.join(runs, '2026-10-23T13-27-29-872Z');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, 'summary.md'), '■ Стоп: T-001: принята (--only)\n');
  const stopped = await watch({ workDir: dir, minutes: 1, pollMs: 10, graceMs: 50 });
  assert.deepEqual(stopped, { code: 3, text: '■ Стоп: T-001: принята (--only)' });
  writeFileSync(path.join(runs, 'question.json'), JSON.stringify({ id: 'q', who: 'Исполнитель', taskId: 'T-001', command: 'pnpm test', options: [{ answer: '2', rule: 'pnpm test' }] }));
  const asked = await watch({ workDir: dir, minutes: 1, pollMs: 10, graceMs: 50 });
  assert.equal(asked.code, 2);
  assert.match(asked.text, /pnpm test[\s\S]*--answer <2\|3>/);
  rmSync(path.join(runs, 'question.json'));
  writeFileSync(path.join(runs, '.lock'), String(process.pid));
  writeFileSync(path.join(run, 'run.log'), '[17:27:29] ▶ T-001 (средний): one; Исполнитель m\n');
  writeFileSync(path.join(run, 'feed.log'), 'a\nb\nc\nd\n');
  const waited = await watch({ workDir: dir, minutes: 0.001, pollMs: 10, graceMs: 50 });
  assert.equal(waited.code, 0, 'the window ended while the loop runs');
  assert.match(waited.text, /^(?:идёт|running) \d+ (?:мин|min): T-001 \(средний\): one; (?:Исполнитель|Executor) m \((?:вех|milestones): 0\)$/);
  const status = statusText(dir);
  assert.match(status, /(?:последние шаги|recent steps):\n  b\n  c\n  d$/);
});

test('milestones: rework at once, «accepted» joined with the next start, a stopping verdict is not one', () => {
  const log = [
    '[10:00:00] ▶ T-011 (средний): a; Исполнитель m',
    '[10:04:00]   механика: ok (1 коммит.)',
    '[10:05:00]   Архитектор: rework, 60s, попыток 1 — fix it',
    '[10:09:30]   Архитектор: accepted, 60s, попыток 1 — ok',
    '[10:09:31] ▶ T-013 (средний): b; Исполнитель m',
    '[10:20:00]   Архитектор: accepted, 60s, попыток 1 — ok',
    '[10:20:00] ■ Стоп: все задачи приняты',
  ].join('\n');
  const ms1 = milestones(log);
  assert.equal(ms1.length, 2);
  assert.match(ms1[0], /^T-011: (?:доработка|rework) 1$/);
  assert.match(ms1[1], /^T-011 (?:принята \(10 мин\); дальше|accepted \(10 min\); next) T-013$/);
  const msMidnight = milestones('[23:58:00] ▶ T-001 (низкий): x\n[00:03:00]   Архитектор: accepted, 1s\n[00:03:01] ▶ T-002 (низкий): y');
  assert.equal(msMidnight.length, 1);
  assert.match(msMidnight[0], /^T-001 (?:принята \(5 мин\); дальше|accepted \(5 min\); next) T-002$/, 'past midnight');
  assert.deepEqual(milestones('[10:00:00] ▶ T-001 (низкий): x\n[10:01:00]   Архитектор: needs_user, 1s'), []);
});

test('--watch: a milestone after --since → exit 4 with «(вех: N)»; the count is printed on exits 0 and 2 too', async () => {
  const runs = path.join(dir, '.agent-runs');
  const run = path.join(runs, '2026-10-23T13-27-29-872Z');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(runs, '.lock'), String(process.pid));
  const log = path.join(run, 'run.log');
  writeFileSync(log, '[10:00:00] ▶ T-011 (средний): a; Исполнитель m\n');
  const opts = { workDir: dir, minutes: 0.002, pollMs: 10, graceMs: 50 };
  assert.match((await watch({ ...opts, since: 0 })).text, /\((?:вех|milestones): 0\)$/, 'the first task start is not a milestone');
  appendFileSync(log, '[10:09:30]   Архитектор: accepted, 1s\n[10:09:31] ▶ T-013 (средний): b; Исполнитель m\n');
  const missedBetweenCalls = await watch({ ...opts, since: 0 });
  assert.equal(missedBetweenCalls.code, 4);
  assert.match(missedBetweenCalls.text, /^T-011 (?:принята \(10 мин\); дальше T-013 \(вех: 1\)|accepted \(10 min\); next T-013 \(milestones: 1\))$/);
  assert.equal((await watch({ ...opts, since: 1 })).code, 0, 'nothing new after since=1');
  assert.equal((await watch({ ...opts, since: 9 })).code, 0, 'a since from an earlier run starts from now');
  writeFileSync(path.join(runs, 'question.json'), JSON.stringify({ id: 'q', who: 'Исполнитель', taskId: 'T-013', command: 'pnpm test', options: [{ answer: '2', rule: 'pnpm test' }] }));
  assert.match((await watch({ ...opts, since: 1 })).text, /--answer <2\|3> \((?:вех|milestones): 1\)$/);
});

test('--watch started before the new run folder exists: the new run counts milestones from zero', async () => {
  const runs = path.join(dir, '.agent-runs');
  const old = path.join(runs, '2026-10-23T10-00-00-000Z');
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, 'run.log'), '[10:00:00] ▶ T-001 (низкий): a\n[10:05:00]   Архитектор: accepted, 1s\n[10:05:01] ▶ T-002 (низкий): b\n');
  writeFileSync(path.join(runs, '.lock'), String(process.pid));
  const waiting = watch({ workDir: dir, minutes: 0.05, pollMs: 10, graceMs: 50 });
  const fresh = path.join(runs, '2026-10-23T11-00-00-000Z');
  mkdirSync(fresh, { recursive: true });
  writeFileSync(path.join(fresh, 'run.log'), '[11:00:00] ▶ T-003 (низкий): c\n[11:02:00]   Архитектор: rework, 1s\n');
  const wRes = await waiting;
  assert.equal(wRes.code, 4);
  assert.match(wRes.text, /^T-003: (?:доработка 1 \(вех: 1\)|rework 1 \(milestones: 1\))$/);
});

test('--follow after a finished run: its feed, then the summary — once, even when the feed already has the stop block', async () => {
  const runs = path.join(dir, '.agent-runs');
  const run = path.join(runs, '2026-10-23T10-00-00-000Z');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, 'feed.log'), '[10:00:00] ▶ T-001 (низкий): a\n10:00:05 Исполнитель: 📖 читает a.ts\n');
  writeFileSync(path.join(run, 'summary.md'), `■ Стоп: все задачи приняты\nЛог: ${os.homedir()}/x\n`);
  const printed = [];
  await follow({ workDir: dir, print: (l) => printed.push(l), pollMs: 10, graceMs: 30 });
  assert.deepEqual(printed, ['[10:00:00] ▶ T-001 (низкий): a', '10:00:05 Исполнитель: 📖 читает a.ts', '■ Стоп: все задачи приняты\nЛог: ~/x']);

  appendFileSync(path.join(run, 'feed.log'), '[10:09:00] ■ Стоп: все задачи приняты\nЛог: ~/x\n');
  const again = [];
  await follow({ workDir: dir, print: (l) => again.push(l), pollMs: 10, graceMs: 30 });
  assert.equal(again.filter((l) => l.includes('■ Стоп:')).length, 1, 'the stop block written by run.mjs into feed.log is not repeated from summary.md');
  const none = [];
  rmSync(runs, { recursive: true });
  await follow({ workDir: dir, print: (l) => none.push(l), pollMs: 10, graceMs: 30 });
  assert.equal(none.length, 1);
  assert.match(none[0], /^(?:запусков цикла ещё не было|no loop runs yet)$/);
});

test('--follow while the loop runs: complete lines as they come, a new run folder with a separator, exit when the lock goes', async () => {
  const runs = path.join(dir, '.agent-runs');
  const first = path.join(runs, '2026-10-23T10-00-00-000Z');
  mkdirSync(first, { recursive: true });
  writeFileSync(path.join(runs, '.lock'), String(process.pid));
  writeFileSync(path.join(first, 'feed.log'), 'a\n');
  const printed = [];
  const done = follow({ workDir: dir, print: (l) => printed.push(l), pollMs: 10, graceMs: 30 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(40);
  appendFileSync(path.join(first, 'feed.log'), 'b\nhal');
  await sleep(40);
  assert.deepEqual(printed, ['a', 'b'], 'a line still being written waits');
  appendFileSync(path.join(first, 'feed.log'), 'f\n');
  await sleep(40);
  const second = path.join(runs, '2026-10-23T11-00-00-000Z');
  mkdirSync(second, { recursive: true });
  writeFileSync(path.join(second, 'feed.log'), 'c\n');
  await sleep(40);
  writeFileSync(path.join(second, 'summary.md'), '■ Стоп: T-002 принята\n');
  rmSync(path.join(runs, '.lock'));
  await done;
  assert.equal(printed.slice(0, 3).join('|'), 'a|b|half');
  assert.match(printed[3], /^── (?:новый запуск|new run) \d\d:\d\d:\d\d ──$/);
  assert.deepEqual(printed.slice(4), ['c', '■ Стоп: T-002 принята']);
  assert.deepEqual(new LineTail(path.join(second, 'feed.log')).read(), ['c']);
});
