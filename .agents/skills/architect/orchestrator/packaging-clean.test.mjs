import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEmptyCatches } from './selfcheck.mjs';

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
            `${entry}:${idx + 1} comment must not contain host task ID T-NNN: ${trimmed}`,
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

// Relative module references that can be resolved statically: import/export ... from, side-effect imports,
// dynamic imports with a literal, and new URL('./x', import.meta.url). A line-start anchor keeps code inside
// string fixtures out of the scan.
const RELATIVE_TARGET_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^'"\n;]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm,
  /^[ \t]*\}\s*from\s+['"](\.{1,2}\/[^'"]+)['"]/gm,
  /^[ \t]*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];

function relativeTargets(source) {
  const targets = [];
  for (const pattern of RELATIVE_TARGET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

function listMjsFiles(dir) {
  const files = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) files.push(...listMjsFiles(full));
    else if (ent.isFile() && ent.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

test('T-054: the scan of relative import and URL targets sees imports, multi-line imports and URLs, and skips string fixtures', () => {
  const source = [
    "import { a } from './a.mjs';",
    "import * as b from '../b.mjs';",
    'import {',
    '  c,',
    "} from './c.mjs';",
    "import './side.mjs';",
    "export { d } from './d.mjs';",
    "const u = new URL('./u.mjs', import.meta.url);",
    "const lazy = await import('./lazy.mjs');",
    "const fixture = \"import { x } from '../fixture.mjs';\";",
    "import { node } from 'node:fs';",
  ].join('\n');
  assert.deepEqual(
    relativeTargets(source).sort(),
    ['../b.mjs', './a.mjs', './c.mjs', './d.mjs', './lazy.mjs', './side.mjs', './u.mjs'],
  );
});

test('T-054: a skill folder copied alone to a temporary directory is self-contained: every relative import and URL target of every .mjs file stays inside it, and one test file passes there', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skill-only-t054-')));
  try {
    const isolatedSkill = path.join(tmp, 'architect');
    cpSync(skillDir, isolatedSkill, { recursive: true });

    const isolatedOrch = path.join(isolatedSkill, 'orchestrator');
    const unresolved = [];
    let checkedTargets = 0;
    for (const file of listMjsFiles(isolatedOrch)) {
      // This file holds the scanner's own sample sources, which are not real imports.
      if (path.basename(file) === path.basename(fileURLToPath(import.meta.url))) continue;
      for (const spec of relativeTargets(readFileSync(file, 'utf8'))) {
        checkedTargets++;
        const target = path.resolve(path.dirname(file), spec);
        const rel = path.relative(isolatedSkill, target);
        const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (!inside || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
          unresolved.push(`${path.relative(isolatedSkill, file)} -> ${spec}`);
        }
      }
    }
    assert.ok(checkedTargets >= 100, `expected the scan to find >= 100 relative targets, found ${checkedTargets}`);
    assert.deepEqual(
      unresolved,
      [],
      `every relative target must resolve to a file inside the skill folder, unresolved: ${unresolved.join('; ')}`,
    );

    // A smoke test of the copy: one small test file, with a safety cap against a hang (not a speed limit).
    const { NODE_TEST_CONTEXT: _ntc, AGENT_LOOP: _al, ...cleanEnv } = process.env;
    const res = spawnSync(process.execPath, ['--test', path.join(isolatedOrch, 'layout.test.mjs')], {
      cwd: tmp,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(
      res.status,
      0,
      `layout.test.mjs must pass in an isolated temp directory containing only the skill folder:\n${res.stdout.slice(-2000)}\n${res.stderr.slice(-2000)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-061: skill files contain no host-specific leak strings and host ci.yml uses macos-latest Node 22/24 without ubuntu', () => {
  const forbidden = [
    ['PRIVATE', 'USER', 'TAKEOUT', 'DATA'].join('_'),
    ['MyActivity', 'json'].join('.'),
    ['', 'Users', 'aghasi'].join('/'),
  ];

  function listFilesRec(dir) {
    const files = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        files.push(...listFilesRec(full));
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
    return files;
  }

  const allSkillFiles = listFilesRec(skillDir);
  assert.ok(allSkillFiles.length >= 20, `expected >= 20 skill files, found ${allSkillFiles.length}`);

  for (const f of allSkillFiles) {
    const text = readFileSync(f, 'utf8');
    for (const needle of forbidden) {
      assert.equal(
        text.includes(needle),
        false,
        `${path.relative(skillDir, f)} must not contain forbidden leak substring ${needle}`,
      );
    }
  }

  const hostRoot = path.resolve(skillDir, '../../..');
  const ciPath = path.join(hostRoot, '.github', 'workflows', 'ci.yml');
  if (existsSync(ciPath)) {
    const ciContent = readFileSync(ciPath, 'utf8');
    assert.ok(ciContent.includes('macos-latest'), 'ci.yml must use macos-latest runner');
    assert.ok(ciContent.includes('22'), 'ci.yml must include Node 22');
    assert.ok(ciContent.includes('24'), 'ci.yml must include Node 24');
    assert.ok(ciContent.includes('ubuntu-latest'), 'ci.yml must include ubuntu-latest in matrix');
  }
});

test('T-062: non-test orchestrator .mjs modules have no empty catch blocks and pass findEmptyCatches per AGENTS.md §4', () => {
  const emptyCatchRe = new RegExp(
    '\\b' + 'catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}' +
    '|' +
    '\\.catch\\s*\\(\\s*(?:\\([^)]*\\)|[a-zA-Z0-9_$]+)?\\s*(?:=>|function[^{]*)\\s*\\{\\s*\\}\\s*\\)',
    'g',
  );

  const prodDirs = [orchDir, path.join(orchDir, 'adapters')];
  const emptyHits = [];
  let scannedCount = 0;

  for (const d of prodDirs) {
    for (const entry of readdirSync(d)) {
      if (!entry.endsWith('.mjs') || entry.endsWith('.test.mjs')) continue;
      scannedCount++;
      const fullPath = path.join(d, entry);
      const relPath = path.relative(orchDir, fullPath).replace(/\\/g, '/');
      const content = readFileSync(fullPath, 'utf8');
      emptyCatchRe.lastIndex = 0;
      let m;
      while ((m = emptyCatchRe.exec(content)) !== null) {
        const line = content.slice(0, m.index).split('\n').length;
        emptyHits.push(`${relPath}:${line}`);
      }
    }
  }

  assert.ok(scannedCount >= 20, `expected >= 20 non-test .mjs files in orchestrator, got ${scannedCount}`);
  assert.deepEqual(
    emptyHits,
    [],
    `non-test orchestrator .mjs files must not contain empty catch blocks, found: ${emptyHits.join(', ')}`,
  );

  const strictModules = ['events.mjs', 'guards.mjs', 'selfcheck.mjs', 'feed.mjs'];
  for (const mod of strictModules) {
    const text = readFileSync(path.join(orchDir, mod), 'utf8');
    const syntheticDiff = [
      `+++ b/${mod}`,
      '@@ -1,0 +1,0 @@',
      ...text.split('\n').map((l) => `+${l}`),
    ].join('\n');
    assert.deepEqual(
      findEmptyCatches(syntheticDiff),
      [],
      `${mod} must have 0 empty or non-cleanup comment-only catch blocks under findEmptyCatches`,
    );
  }

  const badDiff = ['+++ b/sample.mjs', '@@ -1,0 +1,0 @@', '+try { f(); } ' + 'catch ' + '{}'].join('\n');
  assert.equal(findEmptyCatches(badDiff).length, 1, 'findEmptyCatches must detect empty catch block');

  const okCleanupDiff = [
    '+++ b/sample.mjs',
    '@@ -1,0 +1,0 @@',
    '+try { f(); } ' + 'catch { /* cleanup: close resource */ }',
  ].join('\n');
  assert.deepEqual(findEmptyCatches(okCleanupDiff), [], 'findEmptyCatches must allow cleanup comment with close/stop/abort');
});


