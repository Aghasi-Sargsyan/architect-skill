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

// Forbidden literals are built by concatenation so that the scanner does not flag this file itself.
const ANY = 'an' + 'y';
const SKIP = 'sk' + 'ip';
const ONLY = 'on' + 'ly';
const TS_IGNORE = '@ts-' + 'ignore';
const AS_UNKNOWN = 'as unknown ' + 'as';
const NOQA = '# no' + 'qa';
const TYPE_IGNORE = '# type: ' + 'ignore';
const RUST_ALLOW = '#[al' + 'low(';

test('T-111: prose in a comment or a string is not a bypass', () => {
  assert.deepEqual(hits('src/a.ts', `// Accepts arrays, ${ANY} iterable of strings`), []);
  assert.deepEqual(hits('src/a.ts', `const label = "Pick a file (${ANY} format)";`), []);
  assert.deepEqual(hits('src/a.ts', `const hint = 'value: ${ANY} thing';`), []);
  assert.deepEqual(hits('src/a.ts', ` * @param x - handles (${ANY}) input`), []);
});

test('T-111: TypeScript patterns do not apply to Python or Go files', () => {
  assert.deepEqual(hits('src/a.py', `ok = ${ANY}(x > 1 for x in xs)`), []);
  assert.deepEqual(hits('src/a.py', `if all(a) or ${ANY}(b): pass`), []);
});

test('T-111: real TypeScript bypasses are still found', () => {
  assert.equal(hits('src/a.ts', `const x: ${ANY} = 1;`).length, 1);
  assert.equal(hits('src/a.ts', `const y = z as ${ANY};`).length, 1);
  assert.equal(hits('src/a.ts', `// ${TS_IGNORE}`).length, 1, 'a directive inside a comment is the bypass itself');
  assert.equal(hits('src/a.ts', `foo ${AS_UNKNOWN} Bar;`).length, 1);
  assert.equal(hits('tests/a.test.ts', `it.${SKIP}('x', () => {});`).length, 1);
});

test('T-111: previously missed skip forms are found', () => {
  assert.equal(hits('tests/a.test.js', `test['${SKIP}']('x', () => {});`).length, 1);
  assert.equal(hits('tests/a.test.js', `test('x', { ${SKIP}: true }, () => {});`).length, 1);
  assert.equal(hits('tests/a.test.js', `test.${'to' + 'do'}('x');`).length, 1);
  assert.equal(hits('tests/a.test.js', `${'x' + 'it'}('x', () => {});`).length, 1);
  assert.equal(hits('tests/test_a.py', `@pytest.mark.${SKIP}(reason="x")`).length, 1);
});

test('T-111: Python and Rust bypasses are found only in their own languages', () => {
  assert.equal(hits('src/a.py', `import os  ${NOQA}`).length, 1);
  assert.equal(hits('src/a.py', `x = f()  ${TYPE_IGNORE}`).length, 1);
  assert.equal(hits('src/a.rs', `${RUST_ALLOW}dead_code)]`).length, 1);
  assert.deepEqual(hits('src/a.ts', `const s = 1; // ${NOQA.slice(2)}`), []);
});

test('T-111: a plain word "skip" or "only" in prose is not a bypass', () => {
  assert.deepEqual(hits('src/a.ts', `// we ${SKIP} the cache when ${ONLY} one entry is left`), []);
  assert.deepEqual(hits('src/a.ts', `const ${ONLY} = list.filter(Boolean);`), []);
});
