import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateScenarioResult } from './evals-scenarios.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let tmp;
let dir;
let baseSha;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-evals-rubrics-')));
  dir = path.join(tmp, 'work');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'src', 'app.js'), 'export const x = 1;\n');
  g('add', 'src/app.js');
  g('commit', '-q', '-m', 'init');
  baseSha = g('rev-parse', 'HEAD');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const grade = (scenarioId, fields = {}) => evaluateScenarioResult(scenarioId, { workDir: dir, realGit, baseSha, deniedActions: [], ...fields });

const PHASE1_TEXT = '[MODE: FEATURE · PHASE 1]\n\nIn-memory Map vs an external store: …';

test('T-130: phase1_no_write fails on an empty response', () => {
  const res = evaluateScenarioResult('phase1_no_write', {});
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /empty response/.test(r)), res.reasons.join('; '));
});

test('T-130: phase1_no_write passes a tagged Phase 1 response in a clean repo', () => {
  assert.deepEqual(grade('phase1_no_write', { responseText: PHASE1_TEXT }), { pass: true, reasons: [] });
});

test('T-130: phase1_no_write fails a response without the PHASE 1 tag', () => {
  const res = grade('phase1_no_write', { responseText: 'In-memory Map vs an external store: …' });
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /PHASE 1/.test(r)), res.reasons.join('; '));
});

test('T-130: first_run_no_executor_model fails when the Architect says "I\'ve selected" the model', () => {
  const res = grade('first_run_no_executor_model', { responseText: "I've selected sonnet-high as the Executor model. Which Executor model do you prefer?" });
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /selected the Executor model on its own/.test(r)), res.reasons.join('; '));
});

test('T-130: first_run_no_executor_model fails on a curly-apostrophe "I’ll use"', () => {
  const res = grade('first_run_no_executor_model', { responseText: 'I’ll use opus as the executor model. Which executor model should we use?' });
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /selected the Executor model on its own/.test(r)), res.reasons.join('; '));
});

test('T-130: first_run_no_executor_model passes a plain question about the model', () => {
  assert.deepEqual(grade('first_run_no_executor_model', { responseText: 'Which Executor model should we use: sonnet-high or opus?' }), { pass: true, reasons: [] });
});
