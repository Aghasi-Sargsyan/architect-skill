// Reference tests for T-124 (ADR-073, C-33): a word in a comment no longer exempts a silent catch; only the
// cleanup shape (one cleanup call in `try`, a `cleanup: <reason>` comment as the catch body) is allowed, the self-check
// uses the strict scanner, and every production module of the orchestrator passes it. Frozen for T-124.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import * as scan from './catch-scan.mjs';
import * as selfcheck from './selfcheck.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const C = 'catch';
const diffOf = (file, text) => [`+++ b/${file}`, '@@ -1,0 +1,0 @@', ...text.split('\n').map((l) => `+${l}`)].join('\n');
const silent = (text) => scan.findSilentCatches(diffOf('src/sample.mjs', text));

const REPORTED = {
  empty: `try { work(); } ${C} {}`,
  ignoreComment: `try {\n  work();\n} ${C} (err) {\n  // ignore error\n}`,
  wordInComment: `try { f(); } ${C} { /* cleanup: close resource */ }`,
  twoStatements: `try { a(); b.close(); } ${C} { /* cleanup: close b */ }`,
  noMarker: `try { x.close(); } ${C} { /* close */ }`,
  voidErr: `try { parse(); } ${C} (err) { void err; }`,
  promise: `doAsync().${C}(() => { /* cleanup: stop */ });`,
  tryNotVisible: `} ${C} { /* cleanup: close x */ }`,
  nonCleanupCall: `try { run(['config', '--unset-all', key]); } ${C} { /* cleanup: close unset-all */ }`,
};
const ALLOWED = {
  kill: `try {\n  proc.kill();\n} ${C} {\n  // cleanup: stop child process\n}`,
  rmSync: `try { rmSync(root, { recursive: true, force: true }); } ${C} { /* cleanup: remove temp root */ }`,
  awaitClose: `try { await server.close(); } ${C} { /* cleanup: close server */ }`,
  restore: `try {\n  guards.restore();\n} ${C} {\n  // cleanup: restore guard shims; teardown errors must not mask the cell result\n}`,
  handled: `try { work(); } ${C} (err) { notes.push(String(err)); }`,
  voidThenReturn: `try { work(); } ${C} (e) { void e; return null; }`,
};

test('T-124: findSilentCatches reports every silent catch except the cleanup shape', () => {
  for (const [name, text] of Object.entries(REPORTED)) {
    const hits = silent(text);
    assert.equal(hits.length, 1, `${name} must be reported: ${text}`);
    assert.equal(hits[0].file, 'src/sample.mjs');
  }
  for (const [name, text] of Object.entries(ALLOWED)) {
    assert.deepEqual(silent(text), [], `${name} must be allowed: ${text}`);
  }
  for (const call of ['close', 'stop', 'abort', 'kill', 'destroy', 'rmSync', 'unlinkSync', 'clearTimeout']) {
    assert.ok(scan.CLEANUP_CALLS.includes(call), `${call} is a cleanup call`);
  }
  assert.equal(silent(Object.values(REPORTED).join('\n')).length, Object.keys(REPORTED).length);
});

test('T-124: catch-scan.mjs owns the scanners, selfcheck.mjs re-exports the legacy API and no import cycle exists', () => {
  assert.equal(selfcheck.findEmptyCatches, scan.findEmptyCatches);
  assert.equal(selfcheck.splitDiffByFiles, scan.splitDiffByFiles);
  const scanSrc = readFileSync(path.join(orchDir, 'catch-scan.mjs'), 'utf8');
  assert.doesNotMatch(scanSrc, /from '\.\/selfcheck\.mjs'/, 'catch-scan.mjs must not import selfcheck.mjs');
  const scSrc = readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8');
  assert.doesNotMatch(scSrc, /const CATCH_RE\b|function findEmptyCatches\(|function splitDiffByFiles\(/);
  assert.deepEqual(scan.findEmptyCatches(diffOf('src/sample.mjs', REPORTED.wordInComment)), [], 'the legacy scanner keeps its lenient semantics');
  for (const mod of ['catch-scan.mjs', 'selfcheck.mjs']) {
    assert.ok(readFileSync(path.join(orchDir, mod), 'utf8').split('\n').length <= 400, `${mod} must stay <= 400 lines`);
  }
});

test('T-124: the self-check reports a word-exempted silent catch and accepts the cleanup shape', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 't124-selfcheck-')));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } }).trim();
  try {
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.com');
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'plans', 'c1.md'), '# Cycle 1\n');
    g('add', '--', 'docs/plans/c1.md');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'bad.mjs'), `export function f() {\n  ${REPORTED.wordInComment}\n}\n`);
    writeFileSync(path.join(root, 'src', 'ok.mjs'), `export function g(proc) {\n  ${ALLOWED.kill.split('\n').join('\n  ')}\n}\n`);
    g('add', '--', 'src/bad.mjs', 'src/ok.mjs');
    g('commit', '-q', '-m', 'arch: add modules');
    const config = { bypassScanPaths: ['src'], bypassPatterns: DEFAULTS.bypassPatterns, bypassRegexps: DEFAULTS.bypassPatterns.map((p) => new RegExp(p)), protectedConfigFiles: [] };
    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: root, config });
    const catches = sc.violations.filter((v) => /empty catch in/.test(v));
    assert.equal(catches.length, 1, sc.violations.join('; '));
    assert.match(catches[0], /src\/bad\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-124: every production module of the orchestrator passes the strict scanner', () => {
  const files = [
    ...readdirSync(orchDir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')),
    ...readdirSync(path.join(orchDir, 'adapters')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `adapters/${f}`),
  ];
  assert.ok(files.length >= 40, `expected the whole orchestrator, found ${files.length} modules`);
  const hits = [];
  for (const rel of files) {
    for (const h of scan.findSilentCatches(diffOf(rel, readFileSync(path.join(orchDir, rel), 'utf8')))) hits.push(`${h.file}: ${h.line}`);
  }
  assert.deepEqual(hits, [], `silent catch blocks remain:\n${hits.join('\n')}`);
});
