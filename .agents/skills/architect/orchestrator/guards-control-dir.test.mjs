// T-107 reference tests (C-22; ADR-061 item 3, ADR-066): guard shims in the control directory outside the
// working tree, shim hashes checked after every turn, local config overlays in the guarded snapshot,
// the claude runner reads the shim directory and nothing else under ~/.config/architect.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudePermissionsCheck, claudeRulesFor, writeClaudeAllowlist } from './adapters/claude.mjs';
import { DEFAULTS } from './config.mjs';
import { controlShimDir } from './control-dir.mjs';
import { GUARDED_UNTRACKED_FILES, installGuards } from './guards.mjs';
import { agySettingsPath, rulesFor, writeAgyAllowlist } from './permissions.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let root;
let home;
let work;
let runDir;
let env;
const g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();
const abs = (p) => `//${p.replace(/^\/+/, '')}`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-guards-control-')));
  home = path.join(root, 'home');
  work = path.join(root, 'work');
  runDir = path.join(work, '.agent-runs', 'run1');
  mkdirSync(home);
  mkdirSync(runDir, { recursive: true });
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  Object.assign(env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n*.local.json\n');
  writeFileSync(path.join(work, 'a.txt'), '1\n');
  g('add', '.gitignore', 'a.txt');
  g('commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const install = () => installGuards({
  workDir: work, shimDir: controlShimDir({ workDir: work, home }), backupDir: runDir,
  blockedNpmScripts: [], sandboxRoot: path.join(root, 'sandbox'), realGit, realNpm: '/usr/bin/true',
});

test('the local config overlays are in the guarded snapshot, next to the earlier files', () => {
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md', '.mcp.json', '.git/info/exclude']) {
    assert.ok(GUARDED_UNTRACKED_FILES.includes(rel), rel);
  }
  assert.ok(GUARDED_UNTRACKED_FILES.includes('.agents/orchestrator.local.json'));
  assert.ok(GUARDED_UNTRACKED_FILES.includes('.architect/config.local.json'));
});

test('a shim changed, removed or created during the turn is reported; untouched shims give no problem', () => {
  const shimDir = controlShimDir({ workDir: work, home });
  const guards = install();
  try {
    assert.deepEqual(guards.verify(), []);
    assert.equal(execFileSync('/bin/sh', ['-c', 'command -v git'], { env: guards.env, encoding: 'utf8' }).trim(), path.join(shimDir, 'git'), 'git of the agent is the shim in the control directory');
    assert.ok(existsSync(path.join(shimDir, 'npm')));
    appendFileSync(path.join(shimDir, 'git'), '\n# changed\n');
    rmSync(path.join(shimDir, 'npm'));
    writeFileSync(path.join(shimDir, 'curl'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(shimDir, 'curl'), 0o755);
    const problems = guards.verify();
    assert.ok(problems.includes('guard shim git was modified during the turn'), problems.join('\n'));
    assert.ok(problems.includes('guard shim npm was removed during the turn'), problems.join('\n'));
    assert.ok(problems.includes('guard shim curl was created during the turn'), problems.join('\n'));
  } finally {
    guards.restore();
  }
});

test('an overlay changed during the turn is reported; its backups go to backupDir, not next to the shims', () => {
  const shimDir = controlShimDir({ workDir: work, home });
  mkdirSync(path.join(work, '.agents'));
  const overlay = path.join(work, '.agents', 'orchestrator.local.json');
  writeFileSync(overlay, '{"executor":{"model":"a"}}\n');
  const guards = install();
  try {
    writeFileSync(overlay, '{"runnerBin":"/tmp/evil"}\n');
    const problems = guards.verify();
    assert.ok(problems.includes('settings file .agents/orchestrator.local.json was modified during the turn'), problems.join('\n'));
    assert.equal(readFileSync(path.join(runDir, '.agents__orchestrator.local.json.before'), 'utf8'), '{"executor":{"model":"a"}}\n');
    assert.equal(readFileSync(path.join(runDir, '.agents__orchestrator.local.json.after'), 'utf8'), '{"runnerBin":"/tmp/evil"}\n');
    assert.equal(existsSync(path.join(path.dirname(shimDir), '.agents__orchestrator.local.json.before')), false);
  } finally {
    guards.restore();
  }
});

test('claude rules: the shim directory is readable (additionalDirectories + Read), writes under ~/.config/architect stay denied', () => {
  const shimDir = controlShimDir({ workDir: work, home });
  const rules = claudeRulesFor({ ...DEFAULTS, runner: 'claude' }, work, home);
  assert.ok(rules.additionalDirectories.includes(shimDir), rules.additionalDirectories.join(', '));
  assert.ok(rules.allow.includes(`Read(${abs(shimDir)}/**)`), rules.allow.join(', '));
  assert.ok(rules.deny.includes('Edit(~/.config/architect/**)'));
  assert.ok(rules.deny.includes('Write(~/.config/architect/**)'));
  assert.equal(rules.allow.some((r) => /^(Edit|Write)\(/.test(r) && r.includes('.config/architect')), false, 'no write rule for the control directory');
});

test('claude permission check: the shim directory is required and accepted; another directory under ~/.config/architect is unsafe', () => {
  const config = { ...DEFAULTS, runner: 'claude' };
  const shimDir = controlShimDir({ workDir: work, home });
  const settingsPath = path.join(root, 'claude-settings.json');
  writeClaudeAllowlist({ settingsPath, workDir: work, home, ...claudeRulesFor(config, work, home) });
  const good = claudePermissionsCheck({ config, settingsPath, workDir: work, home });
  assert.equal(good.ok, true, good.detail);

  const json = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const withoutShims = { ...json, permissions: { ...json.permissions, additionalDirectories: json.permissions.additionalDirectories.filter((d) => d !== shimDir) } };
  writeFileSync(settingsPath, JSON.stringify(withoutShims));
  const missing = claudePermissionsCheck({ config, settingsPath, workDir: work, home });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /additionalDirectories/);

  const other = path.join(home, '.config', 'architect', 'runs', 'other-12345678', 'shims');
  const foreignRead = { ...json, permissions: { ...json.permissions, allow: [...json.permissions.allow, `Read(${abs(other)}/**)`] } };
  writeFileSync(settingsPath, JSON.stringify(foreignRead));
  const unsafeRead = claudePermissionsCheck({ config, settingsPath, workDir: work, home });
  assert.equal(unsafeRead.ok, false);
  assert.match(unsafeRead.detail, /unsafe/);

  const foreignDir = { ...json, permissions: { ...json.permissions, additionalDirectories: [...json.permissions.additionalDirectories, path.join(home, '.config', 'architect')] } };
  writeFileSync(settingsPath, JSON.stringify(foreignDir));
  const unsafeDir = claudePermissionsCheck({ config, settingsPath, workDir: work, home });
  assert.equal(unsafeDir.ok, false);
  assert.match(unsafeDir.detail, /additionalDirectories/);
});

test('run.mjs puts the shims into the control directory of the HOME and keeps run files in .agent-runs', () => {
  const agy = path.join(root, 'fake-agy');
  const answer = JSON.stringify({ task_id: 'T-001', status: 'escalation', commits: [], report_markdown: 'stop' });
  writeFileSync(agy, `#!/bin/sh\nif [ "$1" = "models" ]; then printf 'm\\tM\\n'; exit 0; fi\nprintf '%s' '${JSON.stringify({ status: 'SUCCESS', response: answer })}'\n`);
  chmodSync(agy, 0o755);
  rmSync(path.join(work, '.agent-runs'), { recursive: true, force: true });
  writeFileSync(path.join(work, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n  - Change: `a.txt`\n');
  const config = { ...DEFAULTS, agyBin: agy, notify: false };
  mkdirSync(path.join(work, '.agents'));
  writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config));
  g('add', 'PLAN.md', '.agents/orchestrator.json');
  g('commit', '-q', '-m', 'plan');
  writeAgyAllowlist({ settingsPath: agySettingsPath(home), ...rulesFor(config, work) });
  const res = spawnSync(process.execPath, [RUN], { cwd: work, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.error, undefined, String(res.error));
  const shimDir = controlShimDir({ workDir: work, home });
  assert.ok(existsSync(path.join(shimDir, 'git')), `${res.stdout}\n${res.stderr}`);
  const runs = readdirSync(path.join(work, '.agent-runs')).filter((d) => /^\d{4}-/.test(d));
  assert.equal(runs.length, 1, runs.join(', '));
  assert.equal(existsSync(path.join(work, '.agent-runs', runs[0], 'shims')), false, 'no shims in the working tree');
  assert.ok(existsSync(path.join(work, '.agent-runs', runs[0], 'run.log')));
});
