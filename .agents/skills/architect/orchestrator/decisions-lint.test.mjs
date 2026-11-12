// T-131 reference test (Frozen): --self-check warns about long lines added to the ADR index only (C-38, ADR-074).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DECISIONS_INDEX_LINE_LIMIT, checkDecisionsIndex } from './decisions-lint.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

function repo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'decisions-lint-')));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  return { root, g, write };
}

const OLD_LONG = `- **ADR-001:** ${'x'.repeat(900)}`;

function baseRepo() {
  const r = repo();
  r.write('docs/decisions.md', `# ADR\n${OLD_LONG}\n`);
  r.write('docs/decisions-full.md', `# ADR full\n${OLD_LONG}\n`);
  r.write('.architect/decisions.md', '# ADR\n');
  r.g('add', '.');
  r.g('commit', '-q', '-m', 'arch: close cycle 1');
  return { ...r, baseSha: r.g('rev-parse', 'HEAD') };
}

test('C-38: the limit is 300 code points', () => {
  assert.equal(DECISIONS_INDEX_LINE_LIMIT, 300);
});

test('C-38: only long lines added to an index file are reported, in code points, with the file and length', () => {
  const r = baseRepo();
  try {
    appendFileSync(path.join(r.root, 'docs/decisions.md'), `- **ADR-002:** ${'я'.repeat(286)}\n- **ADR-003:** ${'я'.repeat(285)}\n- **ADR-004:** short\n\n`);
    appendFileSync(path.join(r.root, 'docs/decisions-full.md'), `- **ADR-002:** ${'y'.repeat(1000)}\n`);
    appendFileSync(path.join(r.root, '.architect/decisions.md'), `- **ADR-005:** ${'z'.repeat(335)}\n`);
    r.g('add', '.');
    r.g('commit', '-q', '-m', 'arch: plan cycle 2');

    const warnings = checkDecisionsIndex({ realGit, cwd: r.root, baseSha: r.baseSha, headSha: 'HEAD' });
    assert.equal(warnings.length, 2, warnings.join('\n'));
    assert.ok(warnings[0].startsWith('decisions index: line too long in '), warnings[0]);
    const byFile = (f) => warnings.find((w) => w.includes(` in ${f} (`));
    assert.match(byFile('docs/decisions.md'), /\(301 > 300 chars\)/);
    assert.match(byFile('.architect/decisions.md'), /\(350 > 300 chars\)/);
    for (const w of warnings) {
      assert.ok(w.endsWith('— keep one short line per ADR and move the full text to decisions-full.md'), w);
      assert.doesNotMatch(w, /([zя])\1{60}/u, 'the quoted excerpt is at most 60 code points');
    }
    assert.equal(warnings.some((w) => w.includes('decisions-full.md (')), false, 'decisions-full.md is never checked');
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('C-38: a changed old long line counts as added; an untouched one never does', () => {
  const r = baseRepo();
  try {
    appendFileSync(path.join(r.root, 'docs/decisions.md'), '- **ADR-002:** short\n');
    r.g('add', '.');
    r.g('commit', '-q', '-m', 'arch: plan cycle 2');
    assert.deepEqual(checkDecisionsIndex({ realGit, cwd: r.root, baseSha: r.baseSha }), []);

    const text = readFileSync(path.join(r.root, 'docs/decisions.md'), 'utf8').replace(OLD_LONG, `${OLD_LONG}!`);
    writeFileSync(path.join(r.root, 'docs/decisions.md'), text);
    r.g('add', '.');
    r.g('commit', '-q', '-m', 'arch: edit ADR-001');
    const warnings = checkDecisionsIndex({ realGit, cwd: r.root, baseSha: r.baseSha });
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /\(916 > 300 chars\)/);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('C-38: an EMPTY range checks nothing, and a git failure is one explicit warning', () => {
  const r = baseRepo();
  try {
    assert.deepEqual(checkDecisionsIndex({ realGit, cwd: r.root, baseSha: null }), []);
    assert.deepEqual(checkDecisionsIndex({ realGit, cwd: r.root, baseSha: '' }), []);
    const broken = checkDecisionsIndex({ realGit, cwd: r.root, baseSha: '0'.repeat(40) });
    assert.equal(broken.length, 1);
    assert.match(broken[0], /^decisions index: cannot read the diff \(/);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('C-38: runFastSelfCheck adds the index warnings to its warnings', () => {
  const cli = readFileSync(path.join(orchDir, 'cli.mjs'), 'utf8');
  assert.match(cli, /checkDecisionsIndex\(\{[^}]*baseSha:\s*gitRes\.baseSha[^}]*\}\)/, 'runFastSelfCheck must call checkDecisionsIndex with the self-check range');
});
