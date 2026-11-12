// Reference tests for T-122 (ADR-073, C-33, C-45): in the self-check and the red-check a git or JSON
// failure is a violation, never a silent fallback; an absent file is the only "no content" outcome and
// produces no `fatal:` noise on stderr. Frozen for T-122.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import { readGitBlob } from './git-read.mjs';
import { runSelfCheckGit } from './selfcheck.mjs';
import { runRedCheck } from './red-check.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const ENV = { ...process.env, AGENT_LOOP: '' };
const ORCH_CFG = { ...DEFAULTS, executor: { model: 'gemini-3.8-flash-high' }, architect: { model: 'claude-opus' } };

function repo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', env: ENV }).trim();
  const commit = (msg, files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    g('add', '--', ...Object.keys(files));
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  // Removes the loose object of `<ref>:<file>` so that reading it fails with a git error (not "missing").
  const corruptBlob = (ref, file) => {
    const oid = g('rev-parse', `${ref}:${file}`);
    rmSync(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  };
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  return { root, g, commit, corruptBlob };
}

function outcome(fn) {
  try {
    return fn();
  } catch (err) {
    return { ok: false, violations: [`threw: ${err instanceof Error ? err.message : String(err)}`], thrown: true };
  }
}

test('T-122: readGitBlob returns ok / missing and throws on a bad ref or an unreadable object, without stderr noise', () => {
  const { root, commit, corruptBlob } = repo('t122-read-');
  try {
    commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'a.txt': 'alpha\n' });
    assert.deepEqual(readGitBlob(realGit, root, 'HEAD', 'a.txt'), { status: 'ok', text: 'alpha\n' });
    assert.deepEqual(readGitBlob(realGit, root, 'HEAD', '.architect/PLAN.md'), { status: 'missing' });
    assert.throws(() => readGitBlob(realGit, root, 'no-such-ref-t122', 'a.txt'), /no-such-ref-t122/);
    corruptBlob('HEAD', 'a.txt');
    assert.throws(() => readGitBlob(realGit, root, 'HEAD', 'a.txt'), /a\.txt/, 'an unreadable object is an error, not a missing file');

    const script = `import { readGitBlob } from ${JSON.stringify(pathToFileURL(path.join(orchDir, 'git-read.mjs')).href)};\n`
      + `const r = readGitBlob(${JSON.stringify(realGit)}, ${JSON.stringify(root)}, 'HEAD', '.architect/PLAN.md');\n`
      + 'process.stdout.write(r.status);\n';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: ENV, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'missing');
    assert.equal(child.stderr, '', 'a missing path must not print git fatal: noise');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-122: an unreadable committed PLAN.md is a violation in the self-check and in the red-check', () => {
  const { root, g, commit, corruptBlob } = repo('t122-plan-');
  try {
    const plan = '# PLAN\n\n## Decisions\n- ADR-001: base\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n—\n';
    const baseSha = commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', 'PLAN.md': plan });
    commit('arch: notes', { 'notes.md': 'n\n' });
    corruptBlob('HEAD', 'PLAN.md');
    rmSync(path.join(root, 'PLAN.md'));

    const sc = outcome(() => runSelfCheckGit({ realGit, cwd: root, config: {} }));
    assert.equal(sc.ok, false, 'an unreadable PLAN.md must not be treated as an empty plan');
    assert.ok(sc.violations.some((v) => v.includes('PLAN.md')), sc.violations.join('; '));

    const red = outcome(() => runRedCheck({ realGit, cwd: root, baseSha, config: {}, env: ENV }));
    assert.equal(red.ok, false, 'the red-check must not fall back to an empty task list');
    assert.ok(red.violations.some((v) => v.includes('PLAN.md')), red.violations.join('; '));
    assert.equal(g('rev-parse', 'HEAD').length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-122: invalid JSON in a protected orchestrator config is a violation, not an empty object', () => {
  const { root, commit } = repo('t122-json-');
  try {
    commit('arch: close cycle 1', { 'docs/plans/c1.md': '# Cycle 1\n', '.agents/orchestrator.json': JSON.stringify({ bypassScanPaths: ['src'] }) });
    commit('arch: orchestrator setup', { '.agents/orchestrator.json': '{ "bypassScanPaths": [' });
    const sc = outcome(() => runSelfCheckGit({ realGit, cwd: root, config: {} }));
    assert.equal(sc.ok, false);
    assert.ok(sc.violations.some((v) => v.includes('.agents/orchestrator.json') && /not valid JSON/.test(v)), sc.violations.join('; '));
    assert.equal(sc.thrown, undefined, 'invalid JSON is reported as a violation, the self-check keeps running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-122: --self-check in a classic-layout project prints no git fatal: noise; the checks keep no silent error swallowing', () => {
  const { root, commit } = repo('t122-noise-');
  try {
    commit('arch: close cycle 1', {
      'docs/plans/c1.md': '# Cycle 1\n',
      '.agents/orchestrator.json': JSON.stringify(ORCH_CFG, null, 2),
      '.gitignore': '.agent-runs/\n',
    });
    commit('arch: plan cycle 2', { 'PLAN.md': '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n—\n' });
    const cli = spawnSync(process.execPath, [path.join(orchDir, 'run.mjs'), '--self-check'], { cwd: root, env: ENV, encoding: 'utf8' });
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    assert.doesNotMatch(cli.stderr, /fatal:/, cli.stderr);

    for (const mod of ['selfcheck.mjs', 'red-check.mjs', 'evidence.mjs']) {
      const src = readFileSync(path.join(orchDir, mod), 'utf8');
      assert.doesNotMatch(src, /\bvoid\s+(?:err|e|error)\b/, `${mod} must not swallow errors with void err`);
    }
    const sc = readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8');
    assert.match(sc, /from '\.\/git-read\.mjs'/, 'selfcheck.mjs reads committed files through git-read.mjs');
    assert.match(readFileSync(path.join(orchDir, 'red-check.mjs'), 'utf8'), /from '\.\/git-read\.mjs'/);
    assert.ok(readFileSync(path.join(orchDir, 'git-read.mjs'), 'utf8').split('\n').length <= 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
