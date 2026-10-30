import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAdapter, parseRunnerSpec, checkRunnerEnv, checkModelAccess, checkAdapterPermissions, writeAdapterAllowlist } from './adapters/index.mjs';
import { parseAgyOutput, checkAgyEnv } from './adapters/agy.mjs';
import { parseClaudeOutput, checkClaudeEnv } from './adapters/claude.mjs';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

test('T-040 (D5, S5): adapters/index.mjs, adapters/agy.mjs, and adapters/claude.mjs return English messages without Cyrillic', async () => {
  assert.throws(
    () => getAdapter('unknown-runner'),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /Unsupported runner/i);
      return true;
    },
  );
  assert.throws(
    () => parseRunnerSpec('claude:'),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /empty model ID/i);
      return true;
    },
  );

  const unsupportedEnv = checkRunnerEnv('cursor');
  assert.equal(unsupportedEnv.ok, false);
  assert.doesNotMatch(unsupportedEnv.issues.join('\n'), CYRILLIC_RE);

  const unsupportedModel = await checkModelAccess({ runner: 'cursor', model: 'm' });
  assert.equal(unsupportedModel.ok, false);
  assert.doesNotMatch(unsupportedModel.detail, CYRILLIC_RE);

  const unsupportedPerm = checkAdapterPermissions('cursor');
  assert.equal(unsupportedPerm.ok, false);
  assert.doesNotMatch(unsupportedPerm.issues.join('\n'), CYRILLIC_RE);

  assert.throws(
    () => writeAdapterAllowlist('cursor'),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /does not support writing allowlist/i);
      return true;
    },
  );

  const agyBad = parseAgyOutput('not-json', 'err', 1);
  assert.equal(agyBad.ok, false);
  assert.doesNotMatch(agyBad.error, CYRILLIC_RE);

  const claudeBad = parseClaudeOutput('not-json', 'err', 1);
  assert.equal(claudeBad.ok, false);
  assert.doesNotMatch(claudeBad.error, CYRILLIC_RE);

  const agyEnv = checkAgyEnv('/nonexistent/agy');
  assert.equal(agyEnv.ok, false);
  assert.doesNotMatch(agyEnv.issues.join('\n'), CYRILLIC_RE);

  const claudeEnv = checkClaudeEnv('/nonexistent/claude');
  assert.equal(claudeEnv.ok, false);
  assert.doesNotMatch(claudeEnv.issues.join('\n'), CYRILLIC_RE);

  for (const rel of ['./adapters/index.mjs', './adapters/agy.mjs', './adapters/claude.mjs']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(src, CYRILLIC_RE, `${rel} must contain no Cyrillic`);
  }
});
