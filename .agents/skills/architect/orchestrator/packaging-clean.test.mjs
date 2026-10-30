import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(orchDir);

test('T-054: orchestrator production modules have no T-NNN task IDs in comments, and test files use module names without -sN or tNNN while preserving total test/assert counts', () => {
  const prodDirs = [orchDir, path.join(orchDir, 'adapters')];
  for (const d of prodDirs) {
    for (const entry of readdirSync(d)) {
      if (!entry.endsWith('.mjs') || entry.endsWith('.test.mjs')) continue;
      const content = readFileSync(path.join(d, entry), 'utf8');
      for (const [idx, line] of content.split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          assert.doesNotMatch(
            trimmed,
            /\bT-\d{3}\b/,
            `${entry}:${idx + 1} comment must not contain Workspace task ID T-NNN: ${trimmed}`,
          );
        }
      }
    }
  }

  let totalFiles = 0;
  let totalTests = 0;
  let totalAsserts = 0;
  const legacyNamed = [];

  for (const d of prodDirs) {
    for (const entry of readdirSync(d)) {
      if (!entry.endsWith('.test.mjs')) continue;
      totalFiles++;
      if (/-s\d+\b|^t\d+-/i.test(entry)) {
        legacyNamed.push(entry);
      }
      const content = readFileSync(path.join(d, entry), 'utf8');
      totalTests += (content.match(/\b(?:test|it)\s*\(/g) ?? []).length;
      totalAsserts += (content.match(/\bassert\./g) ?? []).length;
    }
  }

  assert.deepEqual(
    legacyNamed,
    [],
    `all test files must be named by module without -sN or tNNN prefixes/suffixes, found: ${legacyNamed.join(', ')}`,
  );
  assert.ok(totalFiles >= 49, `expected >= 49 test files, got ${totalFiles}`);
  assert.ok(totalTests >= 207, `expected >= 207 test/it blocks across skill test suite, got ${totalTests}`);
  assert.ok(totalAsserts >= 1258, `expected >= 1258 assert. calls across skill test suite, got ${totalAsserts}`);
});

test('T-054: skill test suite passes in an isolated temporary directory containing ONLY the skill folder', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skill-only-t054-')));
  try {
    const isolatedSkill = path.join(tmp, 'architect');
    cpSync(skillDir, isolatedSkill, { recursive: true });

    const isolatedOrch = path.join(isolatedSkill, 'orchestrator');
    const testFiles = [
      ...readdirSync(isolatedOrch)
        .filter((f) => f.endsWith('.test.mjs') && f !== 'packaging-clean.test.mjs')
        .map((f) => path.join(isolatedOrch, f)),
      ...readdirSync(path.join(isolatedOrch, 'adapters'))
        .filter((f) => f.endsWith('.test.mjs'))
        .map((f) => path.join(isolatedOrch, 'adapters', f)),
    ];

    const { NODE_TEST_CONTEXT: _ntc, ...cleanEnv } = process.env;
    const res = spawnSync(process.execPath, ['--test', ...testFiles], {
      cwd: tmp,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(
      res.status,
      0,
      `skill tests must pass in an isolated temp directory containing only the skill folder:\n${res.stdout.slice(-2000)}\n${res.stderr.slice(-2000)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
