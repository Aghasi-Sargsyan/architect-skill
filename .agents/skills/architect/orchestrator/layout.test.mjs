import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as layoutMod from './layout.mjs';
import {
  COMPACT_CONFIG_PATH,
  CLASSIC_CONFIG_PATH,
  alwaysFrozenFiles,
  resolveConfigPath,
  resolveLayout,
  skillFilePath,
} from './layout.mjs';
import { DEFAULTS, initProject, loadConfig, validateConfig, withDefaults } from './config.mjs';
import { localChecks } from './check.mjs';
import { checkExecutorRun } from './mechanics.mjs';
import { loadConfigOrDefaults, parseArgs } from './cli.mjs';
import { checkPostReviewSelfCheck, runSelfCheckGit } from './selfcheck.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
for (const k of Object.keys(ENV)) {
  if (k.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(k)) {
    delete ENV[k];
  }
}

let dir;
let prevAgentLoop;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: { ...ENV, AGENT_LOOP: '' } }).trim();
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-layout-s2-')));
  g('init', '-q', '-b', 'master');
});

afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
  rmSync(dir, { recursive: true, force: true });
});

test('T-021 (У1): DEFAULTS has no layout field; old config without layout resolves to classic, .architect/config.json resolves to compact', () => {
  assert.equal(DEFAULTS.layout, undefined, 'DEFAULTS must not hardcode layout so legacy configs are not silently switched to compact');
  assert.equal(withDefaults({}).layout, undefined);

  // Legacy config at .agents/orchestrator.json without "layout" -> classic
  write(CLASSIC_CONFIG_PATH, JSON.stringify({ agyBin: 'agy' }));
  const legacy = loadConfig(path.join(dir, CLASSIC_CONFIG_PATH));
  assert.equal(legacy.layout, 'classic');
  assert.deepEqual(legacy.paths, {
    layout: 'classic',
    planPath: 'PLAN.md',
    executorPath: 'EXECUTOR.md',
    decisionsPath: 'docs/decisions.md',
    plansArchiveDir: 'docs/plans',
    profilesPath: 'docs/executor-profiles.md',
  });

  // Config at .architect/config.json without "layout" -> compact
  write(COMPACT_CONFIG_PATH, JSON.stringify({ agyBin: 'agy' }));
  const compact = loadConfig(path.join(dir, COMPACT_CONFIG_PATH));
  assert.equal(compact.layout, 'compact');
  assert.deepEqual(compact.paths, {
    layout: 'compact',
    planPath: '.architect/PLAN.md',
    executorPath: '.architect/EXECUTOR.md',
    decisionsPath: '.architect/decisions.md',
    plansArchiveDir: '.architect/plans',
    profilesPath: '.architect/executor-profiles.md',
  });

  // Explicit layout field overrides path inference; invalid layout fails validation
  assert.equal(resolveLayout({ config: { layout: 'compact' }, configPath: CLASSIC_CONFIG_PATH }).layout, 'compact');
  assert.equal(resolveLayout({ config: { layout: 'classic' }, configPath: COMPACT_CONFIG_PATH }).layout, 'classic');
  assert.match(validateConfig(withDefaults({ layout: 'unknown' })).join('\n'), /layout/);
});

test('T-021 (D6, У1): --init defaults to .architect/config.json with explicit "layout": "compact", and resolveConfigPath autodiscovers config', () => {
  assert.equal(resolveConfigPath({ workDir: dir, init: true }), COMPACT_CONFIG_PATH);
  const notes = initProject({ workDir: dir, realGit });
  assert.match(notes.join('\n'), /(?:создан|created) \.architect\/config\.json/);
  const created = JSON.parse(readFileSync(path.join(dir, COMPACT_CONFIG_PATH), 'utf8'));
  assert.equal(created.layout, 'compact', '--init must write "layout": "compact" explicitly into .architect/config.json');
  assert.equal(resolveConfigPath({ workDir: dir }), COMPACT_CONFIG_PATH);

  // When only .agents/orchestrator.json exists, resolveConfigPath finds it
  rmSync(path.join(dir, '.architect'), { recursive: true, force: true });
  write(CLASSIC_CONFIG_PATH, JSON.stringify(DEFAULTS));
  assert.equal(resolveConfigPath({ workDir: dir }), CLASSIC_CONFIG_PATH);
  assert.equal(resolveConfigPath({ workDir: dir, configPath: 'custom/cfg.json' }), 'custom/cfg.json');
});

test('T-021 (D6): localChecks works with compact layout (.architect/PLAN.md and .architect/EXECUTOR.md) without root PLAN.md', () => {
  initProject({ workDir: dir, realGit });
  const rawInit = JSON.parse(readFileSync(path.join(dir, COMPACT_CONFIG_PATH), 'utf8'));
  assert.equal(rawInit.executor?.model, '');
  assert.equal(rawInit.architect?.model, '');
  rawInit.executor = { model: 'gemini-3.8-flash-high' };
  rawInit.architect = { model: 'gemini-4-argon-high' };
  write(COMPACT_CONFIG_PATH, JSON.stringify(rawInit, null, 2) + '\n');
  write('.architect/EXECUTOR.md', '<!-- executor-policy-version: 1.5 -->\nrules\n');
  write(
    '.architect/PLAN.md',
    '# PLAN\n\n## Frozen\n- `.architect/EXECUTOR.md`\n\n## Tasks\n\n- [ ] T-001: test compact\n  - Risk: low.\n  - Change: `src/app.py`\n',
  );
  g('add', '.');
  g('commit', '-q', '-m', 'init compact');

  const cfg = loadConfig(path.join(dir, COMPACT_CONFIG_PATH));
  const okChecks = localChecks({ config: cfg, workDir: dir, realGit });
  assert.deepEqual(
    okChecks.filter((c) => !c.ok),
    [],
    `compact layout must pass all localChecks: ${JSON.stringify(okChecks)}`,
  );

  // Removing .architect/EXECUTOR.md from ## Frozen fails localChecks
  write(
    '.architect/PLAN.md',
    '# PLAN\n\n## Frozen\n- `tests/ref.py`\n\n## Tasks\n\n- [ ] T-001: test compact\n  - Risk: low.\n  - Change: `src/app.py`\n',
  );
  g('commit', '-q', '-am', 'drop executor from frozen');
  const badChecks = localChecks({ config: cfg, workDir: dir, realGit });
  assert.ok(badChecks.some((c) => !c.ok && c.name === 'Frozen'), JSON.stringify(badChecks));
});

test('T-021 (C3): skillFilePath resolves relative path inside workDir and absolute path outside workDir', () => {
  const insideOrch = path.join(dir, '.claude', 'skills', 'architect', 'orchestrator');
  assert.equal(skillFilePath(dir, insideOrch), '.claude/skills/architect/SKILL.md');

  const outsideOrch = '/opt/shared-skills/architect/orchestrator';
  assert.equal(skillFilePath(dir, outsideOrch), '/opt/shared-skills/architect/SKILL.md');
});

test('T-021 (П6, П1): checkExecutorRun always freezes orchestrator config files, EXECUTOR.md and SKILL.md even for high-risk tasks', () => {
  const simOrchDir = path.join(dir, '.agents', 'skills', 'architect', 'orchestrator');
  const mustFreeze = alwaysFrozenFiles('custom/orch.json', { workDir: dir, orchestratorDir: simOrchDir });
  for (const f of [
    'EXECUTOR.md',
    '.architect/EXECUTOR.md',
    '.agents/orchestrator.json',
    '.architect/config.json',
    '.agents/skills/architect/SKILL.md',
    '.agents/skills/architect/EXECUTOR.md',
    'custom/orch.json',
  ]) {
    assert.ok(mustFreeze.includes(f), `alwaysFrozenFiles must include ${f}`);
  }

  write('src/a.ts', 'export const a = 1;\n');
  write('.agents/orchestrator.json', '{"agyBin":"agy"}\n');
  write('.architect/config.json', '{"layout":"compact","agyBin":"agy"}\n');
  write('.architect/EXECUTOR.md', 'rules\n');
  write('.agents/skills/architect/SKILL.md', 'skill\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  for (const protectedFile of [
    '.agents/orchestrator.json',
    '.architect/config.json',
    '.architect/EXECUTOR.md',
    '.agents/skills/architect/SKILL.md',
  ]) {
    const b = g('rev-parse', 'HEAD');
    write(protectedFile, 'tampered\n');
    g('add', protectedFile);
    g('commit', '-q', '-m', `T-021: tamper ${protectedFile}`);
    const res = checkExecutorRun({
      realGit,
      cwd: dir,
      orchestratorDir: simOrchDir,
      base: b,
      task: { id: 'T-021', risk: 'высокий', change: [protectedFile] },
      frozen: [],
      scanPaths: [],
      bypassPatterns: [],
    });
    assert.match(res.violations.join('\n'), new RegExp(`Frozen: ${protectedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('T-083: loadConfigOrDefaults defaults to compact layout (.architect/) in new projects without root PLAN.md/EXECUTOR.md and preserves classic when root files exist', () => {
  const freshCfg = loadConfigOrDefaults(null, dir);
  assert.equal(freshCfg.layout, 'compact');
  assert.equal(freshCfg.paths.planPath, '.architect/PLAN.md');
  assert.equal(freshCfg.paths.executorPath, '.architect/EXECUTOR.md');

  write('PLAN.md', '# PLAN\n');
  const classicByPlan = loadConfigOrDefaults(null, dir);
  assert.equal(classicByPlan.layout, 'classic');
  assert.equal(classicByPlan.paths.planPath, 'PLAN.md');

  rmSync(path.join(dir, 'PLAN.md'), { force: true });
  write('EXECUTOR.md', '<!-- executor-policy-version: 1.8 -->\n');
  const classicByExec = loadConfigOrDefaults(null, dir);
  assert.equal(classicByExec.layout, 'classic');
  assert.equal(classicByExec.paths.executorPath, 'EXECUTOR.md');

  const explicitClassic = loadConfigOrDefaults(CLASSIC_CONFIG_PATH, dir);
  assert.equal(explicitClassic.layout, 'classic');
});

test('T-083: migrateToCompact and CLI --compact migrate a classic project to .architect/, update references, and fail closed on AGENT_LOOP=1, active lock, or file conflicts', () => {
  const { migrateToCompact, handleCompactCli } = layoutMod;
  assert.equal(typeof migrateToCompact, 'function', 'layout.mjs must export migrateToCompact');
  assert.equal(typeof handleCompactCli, 'function', 'layout.mjs must export handleCompactCli');

  const parsed = parseArgs(['--compact']);
  assert.equal(parsed.compact, true);
  assert.throws(() => parseArgs(['--compact', '--init']), /only one/i);

  // 1. Fail closed when AGENT_LOOP=1
  const prevLoop = process.env.AGENT_LOOP;
  process.env.AGENT_LOOP = '1';
  try {
    assert.throws(() => migrateToCompact({ workDir: dir }), /AGENT_LOOP=1/);
  } finally {
    if (prevLoop === undefined) delete process.env.AGENT_LOOP;
    else process.env.AGENT_LOOP = prevLoop;
  }

  // 2. Fail closed when .agent-runs/.lock holds live PID
  write('.agent-runs/.lock', `${process.pid}\n`);
  assert.throws(() => migrateToCompact({ workDir: dir }), /loop is running|lock/i);
  rmSync(path.join(dir, '.agent-runs'), { recursive: true, force: true });

  // 3. Fail closed on conflicting classic and compact files
  write('PLAN.md', '# Classic Plan\n');
  write('.architect/PLAN.md', '# Different Compact Plan\n');
  assert.throws(() => migrateToCompact({ workDir: dir }), /conflict/i);
  assert.equal(readFileSync(path.join(dir, 'PLAN.md'), 'utf8'), '# Classic Plan\n');
  rmSync(path.join(dir, '.architect'), { recursive: true, force: true });

  // 4. Migrate full classic project to compact (.architect/)
  write('EXECUTOR.md', '<!-- executor-policy-version: 1.8 -->\n# Executor Rules\n');
  write(
    'PLAN.md',
    [
      '# PLAN',
      'Archive in `docs/plans/2026-11-01-c1.md`, decisions in `docs/decisions.md`, profiles in `docs/executor-profiles.md`.',
      '',
      '## Frozen',
      '- `EXECUTOR.md`',
      '',
      '## Rules',
      'For Executor on task T-NNN: read EXECUTOR.md first and follow it.',
      '',
      '## Tasks',
    ].join('\n') + '\n',
  );
  write('docs/decisions.md', '# Decisions\n- ADR-001: test\n');
  write('docs/executor-profiles.md', '# Profiles\n');
  write('docs/plans/2026-11-01-c1.md', '# Cycle 1 Archive\n');
  write('.agents/orchestrator.json', JSON.stringify({ runner: 'agy', executor: { model: 'gemini-3.8-flash-high' }, architect: { model: 'gemini-4-argon-high' } }, null, 2) + '\n');
  write('.agents/orchestrator.local.json', JSON.stringify({ executor: { model: 'gemini-3.8-flash-high' } }, null, 2) + '\n');
  write(
    'AGENTS.md',
    [
      '# Rules',
      '- First read `.agents/skills/architect/SKILL.md` and `.agents/skills/architect/EXECUTOR.md`.',
      '- Executor session: read `EXECUTOR.md` and `PLAN.md`, config in `.agents/orchestrator.json` or `.agents/orchestrator.local.json`.',
    ].join('\n') + '\n',
  );

  const lines = [];
  const res = handleCompactCli({ workDir: dir, print: (m) => lines.push(m) });
  assert.equal(res.ok, true);
  assert.equal(res.alreadyCompact, false);
  assert.ok(res.moved.length >= 6);
  assert.ok(lines.length > 0);

  // Old files and empty docs/ directory removed
  for (const oldRel of ['EXECUTOR.md', 'PLAN.md', 'docs/decisions.md', 'docs/executor-profiles.md', 'docs/plans/2026-11-01-c1.md', 'docs', '.agents/orchestrator.json', '.agents/orchestrator.local.json']) {
    assert.equal(
      (() => { try { readFileSync(path.join(dir, oldRel)); return true; } catch { /* cleanup: abort check */ return false; } })(),
      false,
      `${oldRel} must be removed after migration`,
    );
  }

  // New .architect/ files exist with updated content
  const newPlan = readFileSync(path.join(dir, '.architect/PLAN.md'), 'utf8');
  assert.match(newPlan, /- `\.architect\/EXECUTOR\.md`/);
  assert.match(newPlan, /read \.architect\/EXECUTOR\.md first/);
  assert.match(newPlan, /\.architect\/decisions\.md/);
  assert.match(newPlan, /\.architect\/executor-profiles\.md/);
  assert.match(newPlan, /\.architect\/plans\/2026-11-01-c1\.md/);

  const newCfg = JSON.parse(readFileSync(path.join(dir, '.architect/config.json'), 'utf8'));
  assert.equal(newCfg.layout, 'compact');
  assert.equal(newCfg.executor.model, 'gemini-3.8-flash-high');
  assert.equal(readFileSync(path.join(dir, '.architect/plans/2026-11-01-c1.md'), 'utf8'), '# Cycle 1 Archive\n');

  const updatedAgents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(updatedAgents, /\.agents\/skills\/architect\/EXECUTOR\.md/, 'skill subfolder path must stay intact');
  assert.match(updatedAgents, /read `\.architect\/EXECUTOR\.md` and `\.architect\/PLAN\.md`/);
  assert.match(updatedAgents, /\.architect\/config\.json/);
  assert.match(updatedAgents, /\.architect\/config\.local\.json/);

  // Idempotent second run
  const second = migrateToCompact({ workDir: dir });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyCompact, true);
  assert.deepEqual(second.moved, []);
});

test('T-083: runSelfCheckGit and checkPostReviewSelfCheck inspect .architect/PLAN.md in compact layout', () => {
  write('.architect/EXECUTOR.md', '<!-- executor-policy-version: 1.8 -->\n');
  write('.architect/PLAN.md', '# PLAN\n\n## Frozen\n- `.architect/EXECUTOR.md`\n\n## Tasks\n');
  g('add', '.architect/EXECUTOR.md', '.architect/PLAN.md');
  g('commit', '-q', '-m', 'arch: close cycle 1');
  const baseSha = g('rev-parse', 'HEAD');

  write('tests/ref.test.mjs', 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("a", () => { assert.equal(1, 1); });\n');
  write(
    '.architect/PLAN.md',
    '# PLAN\n\n## Frozen\n- `.architect/EXECUTOR.md`\n- `tests/ref.test.mjs`\n\n## Tasks\n- [ ] T-001: task\n  - Risk: high\n  - Change: `src/a.mjs`\n  - Test cases: `tests/ref.test.mjs`\n',
  );
  g('add', 'tests/ref.test.mjs', '.architect/PLAN.md');
  g('commit', '-q', '-m', 'arch: plan T-001 in compact layout');

  // Unjustified modification to frozen test referenced in .architect/PLAN.md must be caught
  write('tests/ref.test.mjs', 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("a", () => { assert.equal(1, 1); assert.equal(2, 2); });\n');
  g('add', 'tests/ref.test.mjs');
  g('commit', '-q', '-m', 'arch: tweak test without fix-frozen');

  const cfg = loadConfigOrDefaults(null, dir);
  const scBad = runSelfCheckGit({ realGit, cwd: dir, config: cfg, baseRef: baseSha });
  assert.equal(scBad.ok, false);
  assert.match(scBad.violations.join('\n'), /touches frozen test.*tests\/ref\.test\.mjs/);

  // Adding a WAIVER in .architect/PLAN.md during automated cycle must be caught by checkPostReviewSelfCheck
  write(
    '.architect/PLAN.md',
    '# PLAN\n\n## Decisions\n- WAIVER abcdef0: fix-frozen — excuse\n\n## Frozen\n- `.architect/EXECUTOR.md`\n- `tests/ref.test.mjs`\n\n## Tasks\n',
  );
  g('add', '.architect/PLAN.md');
  g('commit', '-q', '-m', 'arch: add waiver in compact plan');

  const postRes = checkPostReviewSelfCheck({ realGit, cwd: dir, baseSha, config: cfg });
  assert.equal(postRes.ok, false);
  assert.match(postRes.violations.join('\n'), /new WAIVER line added/);
});
