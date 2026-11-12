// Reference tests for T-111 (C-27): the bypass scanner ignores comments, strings and foreign languages, and catches real bypasses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBypasses } from './mechanics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const patterns = JSON.parse(readFileSync(path.join(here, 'config.example.json'), 'utf8')).bypassPatterns.map((p) => new RegExp(p));
const diff = (file, ...added) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -0,0 +1 @@', ...added.map((l) => `+${l}`)].join('\n');
const hits = (file, ...added) => findBypasses(diff(file, ...added), patterns);

test('T-111: prose in a comment or a string is not a bypass', () => {
  assert.deepEqual(hits('src/a.ts', '// Accepts arrays, any iterable of strings'), []);
  assert.deepEqual(hits('src/a.ts', 'const label = "Pick a file (any format)";'), []);
  assert.deepEqual(hits('src/a.ts', "const hint = 'value: any thing';"), []);
  assert.deepEqual(hits('src/a.ts', ' * @param x - handles (any) input'), []);
});

test('T-111: TypeScript patterns do not apply to Python or Go files', () => {
  assert.deepEqual(hits('src/a.py', 'ok = any(x > 1 for x in xs)'), []);
  assert.deepEqual(hits('src/a.py', 'if all(a) or any(b): pass'), []);
});

test('T-111: real TypeScript bypasses are still found', () => {
  assert.equal(hits('src/a.ts', 'const x: any = 1;').length, 1);
  assert.equal(hits('src/a.ts', 'const y = z as any;').length, 1);
  assert.equal(hits('src/a.ts', '// @ts-ignore').length, 1, 'a directive inside a comment is the bypass itself');
  assert.equal(hits('src/a.ts', 'foo as unknown as Bar;').length, 1);
  assert.equal(hits('tests/a.test.ts', "it.skip('x', () => {});").length, 1);
});

test('T-111: previously missed skip forms are found', () => {
  assert.equal(hits('tests/a.test.js', "test['skip']('x', () => {});").length, 1);
  assert.equal(hits('tests/a.test.js', "test('x', { skip: true }, () => {});").length, 1);
  assert.equal(hits('tests/a.test.js', "test.todo('x');").length, 1);
  assert.equal(hits('tests/a.test.js', "xit('x', () => {});").length, 1);
  assert.equal(hits('tests/test_a.py', '@pytest.mark.skip(reason="x")').length, 1);
});

test('T-111: Python and Rust bypasses are found only in their own languages', () => {
  assert.equal(hits('src/a.py', 'import os  # noqa').length, 1);
  assert.equal(hits('src/a.py', 'x = f()  # type: ignore').length, 1);
  assert.equal(hits('src/a.rs', '#[allow(dead_code)]').length, 1);
  assert.deepEqual(hits('src/a.ts', 'const s = 1; // noqa'), []);
});

test('T-111: a plain word "skip" or "only" in prose is not a bypass', () => {
  assert.deepEqual(hits('src/a.ts', '// we skip the cache when only one entry is left'), []);
  assert.deepEqual(hits('src/a.ts', 'const only = list.filter(Boolean);'), []);
});
