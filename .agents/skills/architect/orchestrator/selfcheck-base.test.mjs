// Reference tests for T-121 (ADR-073, C-31): the self-check range is honest — an empty close commit cannot
// reset it, the report shows how many commits were checked, an empty range has its own status, a shallow
// clone without --base fails and a close commit without a plan archive is reported. Frozen for T-121.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import * as base from './selfcheck-base.mjs';
import * as selfcheck from './selfcheck.mjs';
import { formatSelfCheckReport, runFullSelfCheck } from './cli.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const ENV = { ...process.env, AGENT_LOOP: '' };
const ARCHIVE_WARNING = /arch: close cycle commit without a plan archive/;

function repo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: ENV }).trim();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const commit = (msg, files) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    if (Object.keys(files).length) g('add', '--', ...Object.keys(files));
    g('commit', '-q', ...(Object.keys(files).length ? [] : ['--allow-empty']), '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  return { root, g, commit };
}

test('T-121: resolveSelfCheckBase lives in selfcheck-base.mjs and selfcheck.mjs re-exports it', () => {
  assert.equal(typeof base.resolveSelfCheckBase, 'function');
  assert.equal(selfcheck.resolveSelfCheckBase, base.resolveSelfCheckBase);
  const src = readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8');
  assert.doesNotMatch(src, /function resolveSelfCheckBase\(/, 'the base resolution must not be duplicated in selfcheck.mjs');
  for (const mod of ['selfcheck.mjs', 'selfcheck-base.mjs', 'cli.mjs']) {
    const lines = readFileSync(path.join(orchDir, mod), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${mod} must stay <= 400 lines (got ${lines})`);
  }
});

test('T-121: an empty arch: close cycle commit does not reset the range', () => {
  const { root, commit } = repo('t121-empty-close-');
  try {
    const close1 = commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n' });
    commit('arch: plan cycle 2', { 'PLAN.md': '# PLAN\n' });
    commit('T-001: work', { 'src/a.js': 'export const a = 1;\n' });
    commit('arch: close cycle 2', {});
    commit('arch: plan cycle 3', { 'PLAN.md': '# PLAN 3\n' });

    const b = base.resolveSelfCheckBase({ realGit, cwd: root });
    assert.equal(b.sha, close1, 'the empty close commit must be skipped');
    assert.equal(b.source, 'close-cycle');

    const range = base.resolveSelfCheckRange({ realGit, cwd: root });
    assert.equal(range.baseSha, close1);
    assert.equal(range.commitCount, 4);
    assert.equal(range.empty, false);
    assert.deepEqual(range.violations, []);
    assert.equal(range.warnings.some((w) => ARCHIVE_WARNING.test(w)), false, 'close cycle 1 has an archive');

    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: {} });
    assert.equal(sc.baseSha, close1);
    assert.equal(sc.commitCount, 4);
    assert.equal(sc.empty, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-121: a close commit without a plan archive stays the base but is reported as a warning', () => {
  const { root, commit } = repo('t121-no-archive-');
  try {
    commit('arch: close cycle 1', { 'a.txt': '1\n' });
    const close2 = commit('arch: close cycle 2', { 'a.txt': '2\n' });
    commit('arch: plan cycle 3', { 'PLAN.md': '# PLAN\n' });

    const range = base.resolveSelfCheckRange({ realGit, cwd: root });
    assert.equal(range.baseSha, close2);
    assert.equal(range.source, 'close-cycle');
    assert.ok(range.warnings.some((w) => ARCHIVE_WARNING.test(w) && w.includes(close2.slice(0, 7))), JSON.stringify(range.warnings));

    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: root, config: {} });
    assert.ok(sc.warnings.some((w) => ARCHIVE_WARNING.test(w)), JSON.stringify(sc.warnings));
    assert.equal(sc.ok, true, 'the missing archive is a warning, not a violation');

    const compact = repo('t121-compact-archive-');
    try {
      compact.commit('arch: close cycle 1', { '.architect/plans/c1.md': '# Cycle 1\n' });
      compact.commit('arch: plan cycle 2', { '.architect/PLAN.md': '# PLAN\n' });
      const r = base.resolveSelfCheckRange({ realGit, cwd: compact.root });
      assert.equal(r.warnings.some((w) => ARCHIVE_WARNING.test(w)), false, '.architect/plans/*.md is an archive too');
    } finally {
      rmSync(compact.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-121: the report shows the number of checked commits and a separate EMPTY status', () => {
  const { root, commit } = repo('t121-report-');
  try {
    commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n' });
    const empty = runFullSelfCheck({ realGit, workDir: root, config: {}, env: ENV });
    assert.equal(empty.ok, true);
    assert.equal(empty.empty, true);
    assert.equal(empty.commitCount, 0);
    assert.match(formatSelfCheckReport(empty).split('\n')[0], /^✓ Self-check EMPTY \([0-9a-f]{7}\.\.[0-9a-f]{7}, 0 commits\)$/);

    commit('arch: plan cycle 2', { 'PLAN.md': '# PLAN\n' });
    const one = runFullSelfCheck({ realGit, workDir: root, config: {}, env: ENV });
    assert.equal(one.commitCount, 1);
    assert.match(formatSelfCheckReport(one).split('\n')[0], /^✓ Self-check PASSED \([0-9a-f]{7}\.\.[0-9a-f]{7}, 1 commit\)$/);

    commit('arch: notes', { 'notes.md': 'n\n' });
    const two = runFullSelfCheck({ realGit, workDir: root, config: {}, env: ENV });
    assert.match(formatSelfCheckReport(two).split('\n')[0], /^✓ Self-check PASSED \([0-9a-f]{7}\.\.[0-9a-f]{7}, 2 commits\)$/);

    const failed = formatSelfCheckReport({ ...two, ok: false, violations: ['x'] }).split('\n')[0];
    assert.match(failed, /^✗ Self-check FAILED \([0-9a-f]{7}\.\.[0-9a-f]{7}, 2 commits\)$/);
    const legacy = formatSelfCheckReport({ ok: true, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), violations: [], warnings: [], notVerified: [] }).split('\n')[0];
    assert.equal(legacy, '✓ Self-check PASSED (aaaaaaa..bbbbbbb)', 'without commitCount the line keeps its old form');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-121: a shallow clone without --base fails the self-check; with --base it is checked normally', () => {
  const src = repo('t121-shallow-src-');
  const cloneRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 't121-shallow-')));
  try {
    const orchCfg = { ...DEFAULTS, executor: { model: 'gemini-3.8-flash-high' }, architect: { model: 'claude-opus' } };
    src.commit('arch: close cycle 1', {
      'docs/plans/c1.md': '# Cycle 1\n',
      '.agents/orchestrator.json': JSON.stringify(orchCfg, null, 2),
      '.gitignore': '.agent-runs/\n',
    });
    src.commit('arch: plan cycle 2', { 'PLAN.md': '# PLAN\n' });
    src.commit('arch: notes', { 'notes.md': 'n\n' });
    const clone = path.join(cloneRoot, 'c');
    execFileSync(realGit, ['clone', '-q', '--depth', '1', `file://${src.root}`, clone], { env: ENV });

    const range = base.resolveSelfCheckRange({ realGit, cwd: clone });
    assert.ok(range.violations.some((v) => /shallow clone/.test(v) && /fetch-depth: 0/.test(v) && /--base/.test(v)), JSON.stringify(range.violations));

    const sc = selfcheck.runSelfCheckGit({ realGit, cwd: clone, config: {} });
    assert.equal(sc.ok, false, 'a shallow clone must not print PASSED or EMPTY');
    assert.ok(sc.violations.some((v) => /shallow clone/.test(v)));

    const explicit = base.resolveSelfCheckRange({ realGit, cwd: clone, baseRef: 'HEAD' });
    assert.deepEqual(explicit.violations, [], 'an explicit --base is the documented way to check a shallow clone');

    const cli = spawnSync(process.execPath, [path.join(orchDir, 'run.mjs'), '--self-check'], { cwd: clone, env: ENV, encoding: 'utf8' });
    assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, /✗ Self-check FAILED/);
    assert.match(cli.stdout, /shallow clone/);
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});
