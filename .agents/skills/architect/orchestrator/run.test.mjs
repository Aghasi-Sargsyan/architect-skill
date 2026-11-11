import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import { agySettingsPath, rulesFor, writeAgyAllowlist } from './permissions.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let root;
let work;
let env;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();
const run = (...args) => spawnSync(process.execPath, [RUN, ...args], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-run-')));
  work = path.join(root, 'work');
  mkdirSync(work);
  const home = path.join(root, 'home');
  mkdirSync(home);
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  Object.assign(env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  // A runner stand-in: every turn is an Executor escalation, so the loop stops after one agent run.
  const agy = path.join(root, 'fake-agy');
  const answer = JSON.stringify({ task_id: 'T-001', status: 'escalation', commits: [], report_markdown: 'stop' });
  writeFileSync(agy, `#!/bin/sh\nif [ "$1" = "models" ]; then printf 'm\\tM\\n'; exit 0; fi\nprintf '%s' '${JSON.stringify({ status: 'SUCCESS', response: answer })}'\n`);
  chmodSync(agy, 0o755);
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(work, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n  - Change: `a.txt`\n');
  writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n');
  const config = { ...DEFAULTS, agyBin: agy, notify: false };
  mkdirSync(path.join(work, '.agents'));
  writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config));
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  writeAgyAllowlist({ settingsPath: agySettingsPath(home), ...rulesFor(config, work) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('--dry-run reports readiness and exits 1 when not ready', () => {
  const ok = run('--dry-run');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /готов к запуску|ready to start/);
  rmSync(agySettingsPath(env.HOME));
  const bad = run('--dry-run');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /✗ allowlist Antigravity/);
});

test('--background: preflight in the parent, then a detached child that takes the lock and writes the summary', () => {
  assert.match(run('--background', '--pause').stderr, /несовместим с --pause|incompatible with --pause/);
  writeFileSync(path.join(work, 'a.txt'), 'dirty\n');
  const refused = run('--background');
  assert.equal(refused.status, 1, 'a dirty tree is reported at the prompt, nothing detaches');
  assert.match(refused.stderr, /✗ (?:чистое дерево|clean working tree)/);
  rmSync(path.join(work, 'a.txt'));

  const started = run('--background');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /(?:цикл запущен в фоне \(pid \d+\); вывод —|loop started in background \(pid \d+\); output —) \.agent-runs\/background-.*\.log/);
  const runs = path.join(work, '.agent-runs');
  let summary = null;
  for (let i = 0; i < 100 && !summary; i++) {
    const dirs = existsSync(runs) ? readdirSync(runs).filter((d) => existsSync(path.join(runs, d, 'summary.md'))) : [];
    summary = dirs.length ? readFileSync(path.join(runs, dirs[0], 'summary.md'), 'utf8') : null;
    if (!summary) sleep(200);
  }
  assert.ok(summary, 'the detached loop wrote its summary');
  assert.match(summary, /T-001: (?:эскалация Исполнителя|Executor escalation)/);
  assert.equal(existsSync(path.join(runs, '.lock')), false, 'the child released the lock');
  const log = readdirSync(runs).find((f) => f.startsWith('background-'));
  assert.match(readFileSync(path.join(runs, log), 'utf8'), /■ (?:Стоп|Stop)/);
  assert.throws(() => g('config', '--get', 'remote.origin.pushurl'));
});

test('a denied command: unsafe → automatic no, safe → question answered with --answer 2; the same conversation continues', () => {
  // A stateful runner stand-in: call 1 is denied `cat a.txt`, call 2 is denied `npm run lint`, call 3 escalates.
  const agy = path.join(root, 'fake-agy-deny');
  writeFileSync(agy, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('m\\tM'); process.exit(0); }
const home = process.env.HOME;
const counter = path.join(home, 'agy-calls');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
fs.appendFileSync(path.join(home, 'agy-args.log'), JSON.stringify(args) + '\\n');
const deny = (cmd) => {
  const dir = path.join(home, '.gemini/antigravity-cli/brain/conv-1/.system_generated/logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ step_index: n, status: 'ERROR', content: 'permission check failed for unsandboxed "' + cmd + '": user denied permission to run command: ' + cmd }) + '\\n');
  process.stderr.write('a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied\\n');
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: '', conversation_id: 'conv-1', denied_actions: [{ action: 'command' }] }));
};
if (n === 1) deny('cat a.txt');
else if (n === 2) deny('npm run lint');
else process.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-1', response: JSON.stringify({ task_id: 'T-001', status: 'escalation', commits: [], report_markdown: 'stop' }) }));
`);
  chmodSync(agy, 0o755);
  const configFile = path.join(work, '.agents', 'orchestrator.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), agyBin: agy }));
  g('commit', '-q', '-am', 'deny runner');

  const started = run('--background');
  assert.equal(started.status, 0, started.stderr);
  const runs = path.join(work, '.agent-runs');
  const question = path.join(runs, 'question.json');
  for (let i = 0; i < 100 && !existsSync(question); i++) sleep(100);
  assert.ok(existsSync(question), 'the loop asked about npm run lint');
  assert.match(readFileSync(question, 'utf8'), /"command": "npm run lint"/);
  const waiting = run('--watch', '1');
  assert.equal(waiting.status, 2, 'a waiting question ends --watch at once with exit 2');
  assert.match(waiting.stdout, /### 🔐 (?:Разрешение команды|Command Permission)[\s\S]*\*\*(?:Команда|Command):\*\* `npm run lint`[\s\S]*\*\*(?:Ответьте|Reply):\*\* `2` (?:или|or) `3`\n\n(?:ответ пользователя передай|pass the user's answer): --answer <2\|3>/);
  assert.match(run('--status').stdout, /ждёт ответа на вопрос о разрешении|waiting for an answer to a permission question/);
  assert.match(run('--answer', '1').stderr, /не из вариантов 2, 3|not one of the options 2, 3/, 'no [1] when the prefix equals the command');
  const answered = run('--answer', '2');
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.stdout, /(?:ответ «2» передан циклу|answer "2" sent to the loop): npm run lint/);

  let summary = null;
  for (let i = 0; i < 150 && !summary; i++) {
    const dirs = readdirSync(runs).filter((d) => existsSync(path.join(runs, d, 'summary.md')));
    summary = dirs.length ? readFileSync(path.join(runs, dirs[0], 'summary.md'), 'utf8') : null;
    if (!summary) sleep(200);
  }
  assert.ok(summary);
  assert.match(summary, /T-001: (?:эскалация Исполнителя|Executor escalation)/);
  const runDir = path.join(runs, readdirSync(runs).find((d) => existsSync(path.join(runs, d, 'summary.md'))));
  const log = readFileSync(path.join(runDir, 'run.log'), 'utf8');
  assert.match(log, /(?:автоотказ «cat a\.txt» — «cat» в терминале запрещена|auto-refused "cat a\.txt" — "cat" is forbidden in the terminal)/);
  assert.match(log, /(?:разрешено command\(npm run lint\); агент продолжает|allowed command\(npm run lint\); agent continues)/);
  const feedLog = readFileSync(path.join(runDir, 'feed.log'), 'utf8');
  assert.match(feedLog, /▶ T-001/, 'orchestrator milestones are in the feed');
  assert.match(feedLog, /(?:Исполнитель|Executor): ⛔ permission check failed for unsandboxed "cat a\.txt"/, 'agent steps are in the feed, in plain words');
  assert.ok(!feedLog.includes('{"step_index"'), 'no raw JSON in the feed');
  const stopped = run('--watch', '1');
  assert.equal(stopped.status, 3);
  assert.match(stopped.stdout, /■ (?:Стоп: T-001: эскалация Исполнителя|Stop: T-001: Executor escalation)/);
  assert.match(run('--status').stdout, /цикл не идёт; последний итог|loop is not running; last summary/);
  const followed = run('--follow');
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stdout, /▶ T-001/);
  assert.match(followed.stdout, /(?:Исполнитель|Executor): ⛔ permission check failed/);
  assert.equal(followed.stdout.split(/■ (?:Стоп|Stop):/).length - 1, 1, 'the stop block once: from feed.log, not repeated from summary.md');
  assert.match(run('--follow', '--status').stderr, /по одному за запуск|only one per invocation/);
  const calls = readFileSync(path.join(env.HOME, 'agy-args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].includes('--conversation'));
  assert.deepEqual(calls.slice(1).map((a) => a[a.indexOf('--conversation') + 1]), ['conv-1', 'conv-1']);
  assert.match(calls[1][calls[1].indexOf('-p') + 1], /«cat a\.txt» в терминале запрещена|Terminal command "cat a\.txt" is denied/);
  assert.match(calls[2][calls[2].indexOf('-p') + 1], /разрешили \(правило command\(npm run lint\)\)|was allowed \(rule command\(npm run lint\)\)/);
  const settings = JSON.parse(readFileSync(agySettingsPath(env.HOME), 'utf8'));
  assert.ok(settings.permissions.allow.includes('command(npm run lint)'));
  assert.ok(!settings.permissions.allow.some((r) => r.startsWith('command(cat')), 'cat is never added');
  assert.equal(existsSync(question), false);
  assert.equal(existsSync(path.join(runs, 'answer.json')), false);
});
