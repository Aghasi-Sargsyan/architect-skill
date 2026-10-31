import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-layout-s2-')));
  g('init', '-q', '-b', 'master');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
