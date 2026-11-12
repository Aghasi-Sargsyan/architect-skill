// T-127 reference test (Frozen): --compact migrates all or nothing and rewrites paths only at path boundaries (C-41, ADR-078).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateToCompact } from './layout.mjs';

let prevAgentLoop;
beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
});

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** { 'rel/path': content } for every file under dir; directories listed as 'rel/' when empty. */
function snapshot(dir) {
  const out = {};
  const visit = (d) => {
    const entries = readdirSync(d, { withFileTypes: true });
    if (entries.length === 0 && d !== dir) out[path.relative(dir, d).split(path.sep).join('/') + '/'] = '';
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  visit(dir);
  return out;
}

const PLAN = [
  '# PLAN',
  'Registry: `docs/decisions.md`, full text: `docs/decisions-full.md`, archive: `docs/plans/2026-01-01-cycle-1.md`.',
  'Not ours: `mydocs/decisions.md`, `mydocs/plans/notes.md`, `vendor/docs/plans/x.md`.',
  '',
  '## Frozen',
  '- `EXECUTOR.md`',
  '',
  '## Rules',
  'For Executor on task T-NNN: read EXECUTOR.md first and follow it.',
  '',
].join('\n');

function classicProject(root, { config = '{\n  "runner": "claude"\n}\n' } = {}) {
  write(path.join(root, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.9 -->\n');
  write(path.join(root, 'PLAN.md'), PLAN);
  write(path.join(root, 'docs', 'decisions.md'), '# ADR\n- **ADR-001:** short\n');
  write(path.join(root, 'docs', 'decisions-full.md'), '# ADR full\n- **ADR-001:** long text\n');
  write(path.join(root, 'docs', 'executor-profiles.md'), '# Profiles\n');
  write(path.join(root, 'docs', 'plans', '2026-01-01-cycle-1.md'), '# Cycle 1\n');
  write(path.join(root, '.agents', 'orchestrator.json'), config);
  write(path.join(root, 'AGENTS.md'), 'Config: `.agents/orchestrator.json`; vendored copy: `vendor/.agents/orchestrator.json`.\n');
  return root;
}

async function withTmp(fn) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'layout-atomic-')));
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('C-41: invalid JSON config fails before any write; fixing it lets the same migration finish', async () => {
  await withTmp(async (tmp) => {
    const root = classicProject(path.join(tmp, 'p'), { config: '{ "runner": "claude", ' });
    const before = snapshot(root);
    assert.throws(() => migrateToCompact({ workDir: root }), /orchestrator\.json/);
    assert.deepEqual(snapshot(root), before, 'a failed migration must leave the project byte-identical');
    assert.equal(existsSync(path.join(root, '.architect')), false);

    write(path.join(root, '.agents', 'orchestrator.json'), '{\n  "runner": "claude"\n}\n');
    let res = null;
    assert.doesNotThrow(() => { res = migrateToCompact({ workDir: root }); }, 'the retry after fixing the config must succeed');
    assert.equal(res.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.architect', 'config.json'), 'utf8')), { layout: 'compact', runner: 'claude' });
    assert.equal(existsSync(path.join(root, 'PLAN.md')), false);
    assert.equal(migrateToCompact({ workDir: root }).alreadyCompact, true);
  });
});

test('C-41: a write failure in the middle rolls back every file already written', async () => {
  await withTmp(async (tmp) => {
    const root = classicProject(path.join(tmp, 'p'));
    write(path.join(root, '.architect', 'plans'), 'a file where the plans folder must go\n');
    const before = snapshot(root);
    assert.throws(() => migrateToCompact({ workDir: root }));
    assert.deepEqual(snapshot(root), before, 'sources stay in place and no target is left behind');
  });
});

test('C-41: a target that already equals what the migration writes is not a conflict', async () => {
  await withTmp(async (tmp) => {
    const done = classicProject(path.join(tmp, 'done'));
    migrateToCompact({ workDir: done });
    const expected = snapshot(done);

    const partial = classicProject(path.join(tmp, 'partial'));
    for (const rel of ['.architect/PLAN.md', '.architect/config.json', '.architect/EXECUTOR.md']) {
      mkdirSync(path.dirname(path.join(partial, rel)), { recursive: true });
      cpSync(path.join(done, rel), path.join(partial, rel));
    }
    let res = null;
    assert.doesNotThrow(() => { res = migrateToCompact({ workDir: partial }); }, 'a target equal to the computed text must not be a conflict');
    assert.equal(res.ok, true);
    assert.deepEqual(snapshot(partial), expected, 'resuming a partial migration must give the same result as a clean one');
  });
});

test('C-41: paths are rewritten only at path boundaries, and decisions-full.md moves with the registry', async () => {
  await withTmp(async (tmp) => {
    const root = classicProject(path.join(tmp, 'p'));
    migrateToCompact({ workDir: root });
    const plan = readFileSync(path.join(root, '.architect', 'PLAN.md'), 'utf8');
    assert.ok(plan.includes('`.architect/decisions.md`'), plan);
    assert.ok(plan.includes('`.architect/decisions-full.md`'), plan);
    assert.ok(plan.includes('`.architect/plans/2026-01-01-cycle-1.md`'), plan);
    assert.ok(plan.includes('`mydocs/decisions.md`'), 'mydocs/decisions.md is not the registry');
    assert.ok(plan.includes('`mydocs/plans/notes.md`'), 'mydocs/plans/ is not the archive');
    assert.ok(plan.includes('`vendor/docs/plans/x.md`'), 'a nested docs/plans/ is not the archive');
    assert.ok(plan.includes('read .architect/EXECUTOR.md first'), plan);
    assert.equal(readFileSync(path.join(root, '.architect', 'decisions-full.md'), 'utf8'), '# ADR full\n- **ADR-001:** long text\n');
    assert.equal(existsSync(path.join(root, 'docs', 'decisions-full.md')), false);

    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('`.architect/config.json`'), agents);
    assert.ok(agents.includes('`vendor/.agents/orchestrator.json`'), 'a nested .agents/ path is not the project config');
  });
});
