import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import * as mechanicsMod from './mechanics.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'),
);
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-bypass-s9-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('T-042: DEFAULTS in config.example.json keep bypassScanPaths=["src","tests"] and indices 0..8 untouched, adding prototype/globalThis/__proto__ mutation pattern at index 9', () => {
  assert.deepEqual(DEFAULTS.bypassScanPaths, ['src', 'tests']);
  assert.equal(DEFAULTS.bypassPatterns.length, 10);
  assert.equal(DEFAULTS.bypassPatterns[5], '\\.(skip|only)\\(');
  assert.equal(DEFAULTS.bypassPatterns[6], '#\\s*noqa\\b');
  assert.equal(DEFAULTS.bypassPatterns[7], '#\\s*type:\\s*ignore');
  assert.equal(DEFAULTS.bypassPatterns[8], '#\\[allow\\(');

  const protoRe = new RegExp(DEFAULTS.bypassPatterns[9]);

  // Positive cases: built-in prototype, globalThis, Reflect, Object.assign, and __proto__ mutations
  for (const positive of [
    "Object.defineProperty(String.prototype, 'executor', { get() { return () => ''; } });",
    'Object.defineProperties(Object.prototype, { foo: { value: 1 } });',
    'Object.setPrototypeOf(String.prototype, {});',
    'Object.assign(String.prototype, { executor: () => "" });',
    'Object.assign(globalThis, { fetch: mockFetch });',
    "Reflect.defineProperty(Array.prototype, 'x', { value: 1 });",
    'Reflect.setPrototypeOf(Object.prototype, null);',
    "Reflect.defineProperty(globalThis, 'fetch', { value: null });",
    'String.prototype.executor = () => "";',
    "Object.prototype['polluted'] = true;",
    'globalThis.fetch = mockFetch;',
    "globalThis['fetch'] = mockFetch;",
    'obj.__proto__ = customProto;',
    'const poisoned = { __proto__: customProto };',
  ]) {
    assert.equal(protoRe.test(positive), true, `expected index 9 pattern to match: ${positive}`);
  }

  // Negative cases: comparisons (===, ==), in-checks, typeof checks must NOT match
  for (const negative of [
    'globalThis.fetch === x',
    'globalThis.fetch == null',
    "'closedBy' in HTMLDialogElement.prototype",
    'typeof globalThis.crypto',
    "assert.equal('executor' in String.prototype, false);",
    'obj.__proto__ === Object.prototype',
  ]) {
    assert.equal(protoRe.test(negative), false, `expected index 9 pattern NOT to match: ${negative}`);
  }
});

test('T-042: mechanics.mjs skips prototype/globalThis pattern (index 9) on test files (tests/** and *.test.*) while enforcing .skip/.only and all patterns 0..8 everywhere', () => {
  assert.equal(typeof mechanicsMod.isTestFile, 'function');
  assert.equal(mechanicsMod.isTestFile('tests/unit/a.ts'), true);
  assert.equal(mechanicsMod.isTestFile('.agents/skills/architect/orchestrator/foo.test.mjs'), true);
  assert.equal(mechanicsMod.isTestFile('src/components/App.tsx'), false);
  assert.equal(mechanicsMod.isTestFile('.agents/skills/architect/orchestrator/prompts.mjs'), false);

  const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  mkdirSync(path.join(tmp, '.agents', 'skills', 'architect', 'orchestrator'), { recursive: true });
  mkdirSync(path.join(tmp, 'src'), { recursive: true });
  mkdirSync(path.join(tmp, 'tests'), { recursive: true });

  const prodOrch = '.agents/skills/architect/orchestrator/prompts.mjs';
  const testOrch = '.agents/skills/architect/orchestrator/prompts-verify.test.mjs';
  const testDirFile = 'tests/helper.ts';

  writeFileSync(path.join(tmp, prodOrch), 'export const x = 1;\n');
  writeFileSync(path.join(tmp, testOrch), 'export const t = 1;\n');
  writeFileSync(path.join(tmp, testDirFile), 'export const h = 1;\n');
  g('add', prodOrch, testOrch, testDirFile);
  g('commit', '-q', '-m', 'init');

  const compiled = DEFAULTS.bypassPatterns.map((p) => new RegExp(p));
  const scanPaths = ['src', 'tests', '.agents/skills/architect/orchestrator'];

  // 1. Prototype mutation in production orchestrator module is caught
  const b1 = g('rev-parse', 'HEAD');
  writeFileSync(
    path.join(tmp, prodOrch),
    "export const x = 1;\nObject.defineProperty(String.prototype, 'executor', { value: 1 });\n",
  );
  g('add', prodOrch);
  g('commit', '-q', '-m', 'T-042: mutate prototype in prompts.mjs');
  const r1 = mechanicsMod.checkExecutorRun({
    realGit,
    cwd: tmp,
    base: b1,
    task: { id: 'T-042', risk: 'high', change: [prodOrch] },
    frozen: [],
    scanPaths,
    bypassPatterns: compiled,
  });
  assert.equal(r1.ok, false);
  assert.ok(
    r1.violations.some((v) => v.includes('check bypass') && v.includes('String.prototype')),
    `expected check bypass violation in ${prodOrch}, got: ${r1.violations.join('; ')}`,
  );

  // 2. Prototype/globalThis strings in *.test.* and tests/** are allowed (no false positive on test fixtures/mocks)
  const b2 = g('rev-parse', 'HEAD');
  writeFileSync(
    path.join(tmp, testOrch),
    "const fixture = \"Object.defineProperty(String.prototype, 'executor', { value: 1 })\";\nglobalThis.fetch = mockFetch;\n",
  );
  writeFileSync(
    path.join(tmp, testDirFile),
    'globalThis.fetch = mockFetch;\nobj.__proto__ = null;\n',
  );
  g('add', testOrch, testDirFile);
  g('commit', '-q', '-m', 'T-042: test fixtures with prototype and globalThis');
  const r2 = mechanicsMod.checkExecutorRun({
    realGit,
    cwd: tmp,
    base: b2,
    task: { id: 'T-042', risk: 'high', change: [testOrch, testDirFile] },
    frozen: [],
    scanPaths,
    bypassPatterns: compiled,
  });
  assert.equal(r2.ok, true, `expected no bypass violations in test files, got: ${r2.violations.join('; ')}`);

  // 3. .skip( / .only( (index 5) and : any (index 0) are STILL caught in *.test.* and tests/**
  const b3 = g('rev-parse', 'HEAD');
  writeFileSync(path.join(tmp, testOrch), "test.only('focused test', () => {});\n");
  g('add', testOrch);
  g('commit', '-q', '-m', 'T-042: add test.only in test file');
  const r3 = mechanicsMod.checkExecutorRun({
    realGit,
    cwd: tmp,
    base: b3,
    task: { id: 'T-042', risk: 'high', change: [testOrch] },
    frozen: [],
    scanPaths,
    bypassPatterns: compiled,
  });
  assert.equal(r3.ok, false);
  assert.ok(
    r3.violations.some((v) => v.includes('check bypass') && v.includes('test.only(')),
    `expected .only( bypass violation in ${testOrch}, got: ${r3.violations.join('; ')}`,
  );
});
