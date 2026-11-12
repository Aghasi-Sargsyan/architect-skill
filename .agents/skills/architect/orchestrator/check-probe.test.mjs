// Reference tests for T-115 (C-29): `--check` makes no live model call unless the probe is requested.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckCommand } from './check.mjs';
import { DEFAULTS } from './config.mjs';
import { parseArgs } from './cli.mjs';
import { installCommitMsgHook } from './hooks.mjs';
import { rulesFor, writeAgyAllowlist } from './permissions.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
let dir;
let marker;
let runner;
let settingsPath;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-probe-')));
  marker = path.join(dir, '..', `turn-marker-${path.basename(dir)}`);
  runner = path.join(dir, '..', `fake-agy-${path.basename(dir)}`);
  settingsPath = path.join(dir, '..', `settings-${path.basename(dir)}.json`);
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n  - Change: `src/a.ts`\n');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-runs/\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  installCommitMsgHook({ workDir: dir, realGit });
  // The stand-in runner lists models and records any other call (a model turn) in the marker file.
  writeFileSync(runner, `#!/bin/sh
if [ "$1" = "models" ]; then printf 'Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'; exit 0; fi
echo turn > '${marker}'
printf '%s' '{"status":"SUCCESS","response":"{}"}'
`);
  chmodSync(runner, 0o755);
});
afterEach(() => {
  for (const f of [marker, runner, settingsPath]) rmSync(f, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

const cfg = () => ({ ...DEFAULTS, agyBin: runner, permissions: 'allowlist', executor: { ...DEFAULTS.executor, model: 'gemini-3.8-flash-high' }, architect: { ...DEFAULTS.architect, model: 'gemini-3.8-flash-high' } });

test('T-115: without the probe flag no model turn is started and the output says how to run it', async () => {
  const config = cfg();
  writeAgyAllowlist({ settingsPath, ...rulesFor(config, dir) });
  const lines = [];
  const ok = await runCheckCommand({ config, workDir: dir, realGit, settingsPath, print: (l) => lines.push(l) });
  assert.equal(existsSync(marker), false, 'no live model turn without the flag');
  assert.match(lines.join('\n'), /permission probe: skipped.*--probe/);
  assert.equal(typeof ok, 'boolean');
});

test('T-115: with probe: true the live turn runs', async () => {
  const config = cfg();
  writeAgyAllowlist({ settingsPath, ...rulesFor(config, dir) });
  const lines = [];
  await runCheckCommand({ config, workDir: dir, realGit, settingsPath, probe: true, print: (l) => lines.push(l) });
  assert.equal(existsSync(marker), true, 'the probe starts a model turn');
  assert.match(lines.join('\n'), /permission probe/);
});

test('T-115: the --probe flag is parsed and defaults to false', () => {
  assert.equal(parseArgs(['--check']).probe, false);
  assert.equal(parseArgs(['--check', '--probe']).probe, true);
});
