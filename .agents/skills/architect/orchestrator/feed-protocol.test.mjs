// Reference tests for T-114 (C-26): the --watch / --status protocol matches references/orchestrator.md.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { milestonesFromEvents } from './events.mjs';
import { statusText, watch } from './feed.mjs';

let dir;
let home;
let run;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-proto-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'orch-proto-home-'));
  run = path.join(dir, '.agent-runs', '2026-11-12T10-00-00-000Z');
  mkdirSync(run, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const ev = (type, ts, extra = {}) => JSON.stringify({ type, ts, ...extra });
const EVENTS = [
  ev('task_started', '2026-11-12T10:00:00.000Z', { taskId: 'T-001', risk: 'high', title: 'one', model: 'm' }),
  ev('architect_finished', '2026-11-12T10:03:00.000Z', { taskId: 'T-001', ok: true, verdict: 'rework' }),
  ev('architect_finished', '2026-11-12T10:09:30.000Z', { taskId: 'T-001', ok: true, verdict: 'accepted' }),
  ev('task_started', '2026-11-12T10:09:31.000Z', { taskId: 'T-002', risk: 'low', title: 'two', model: 'm' }),
].join('\n') + '\n';

test('T-114: milestones are English: "T-001: rework 1" and "T-001 accepted (10 min); next T-002"', () => {
  const events = EVENTS.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(milestonesFromEvents(events), ['T-001: rework 1', 'T-001 accepted (10 min); next T-002']);
});

test('T-114: --status of a running loop ends its first line with the milestone count', () => {
  writeFileSync(path.join(run, 'events.jsonl'), EVENTS);
  mkdirSync(path.join(dir, '.agent-runs'), { recursive: true });
  writeFileSync(path.join(dir, '.agent-runs', '.lock'), String(process.pid));
  const firstLine = statusText(dir, Date.parse('2026-11-12T10:12:00.000Z'), home).split('\n')[0];
  assert.match(firstLine, /\(milestones: 2\)$/);
  assert.match(firstLine, /^running 12 min: T-002/);
});

test('T-114: --watch --since 0 after the loop finished does not replay the finished run\'s milestones', async () => {
  writeFileSync(path.join(run, 'events.jsonl'), EVENTS);
  writeFileSync(path.join(run, 'summary.md'), '■ Stop: T-002 accepted\n');
  const res = await watch({ workDir: dir, home, minutes: 0.01, since: 0, pollMs: 10, graceMs: 20 });
  assert.equal(res.code, 3, JSON.stringify(res));
  assert.match(res.text, /Stop: T-002 accepted/);
});

test('T-114: --watch of a running loop prints the milestones in English with "(milestones: N)" and exits 4', async () => {
  writeFileSync(path.join(run, 'events.jsonl'), EVENTS);
  writeFileSync(path.join(dir, '.agent-runs', '.lock'), String(process.pid));
  const res = await watch({ workDir: dir, home, minutes: 0.01, since: 0, pollMs: 10, graceMs: 20 });
  assert.equal(res.code, 4);
  assert.equal(res.text, 'T-001: rework 1\nT-001 accepted (10 min); next T-002 (milestones: 2)');
});
