import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localChecks, probePermissions, readiness, runnerChecks } from './check.mjs';
import { DEFAULTS } from './config.mjs';
import { rulesFor, writeAgyAllowlist } from './permissions.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
let dir;
const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: ENV }).trim();
const PLAN = '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n  - Model: Gemini 3.8 Flash / High\n  - Change: `src/a.ts`\n\n- [ ] T-002: two\n  - Model: `no-such-model`\n  - Change: `src/b.ts`\n';
const config = (extra = {}) => ({ ...DEFAULTS, ...extra });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

/**
 * A stand-in for the runner: `models` prints a list; a turn optionally writes the probe file (as the agent's
 * write and edit tools would) and prints the CLI's JSON envelope with `answer`.
 */
function fakeRunner({ answer, stderr = '', writes = '' }) {
  const file = path.join(dir, '..', `fake-agy-${path.basename(dir)}`);
  const envelope = JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(answer) });
  writeFileSync(file, `#!/bin/sh
if [ "$1" = "models" ]; then printf 'Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-4-argon-high\\tGemini 4 Argon (High)\\n'; exit 0; fi
[ -n '${stderr}' ] && echo '${stderr}' >&2
if [ -n '${writes}' ]; then for d in .agent-runs/check-*; do printf '${writes}\\n' > "$d/probe-write.txt"; done; fi
printf '%s' '${envelope}'
`);
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-check-')));
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, 'PLAN.md'), PLAN);
  writeFileSync(path.join(dir, '.gitignore'), '.agent-runs/\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(path.join(dir, '..', `fake-agy-${path.basename(dir)}`), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('a ready repository passes every local check', () => {
  const r = localChecks({ config: config(), workDir: dir, realGit });
  assert.deepEqual(failed(r), [], JSON.stringify(r));
  assert.ok(!r.some((x) => x.detail.includes(dir)), 'no absolute paths in the output');
});

test('local checks name the problem: Windows, old Node, no PLAN.md, empty Change, not ignored, dirty tree, skip outside the sandbox', () => {
  const f1 = failed(localChecks({ config: config(), workDir: dir, realGit, platform: 'win32', nodeVersion: '16.20.0' }));
  assert.equal(f1.length, 2);
  assert.match(f1[0], /^(?:ОС|OS)$/);
  assert.equal(f1[1], 'Node.js');
  writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Risk: low.\n');
  writeFileSync(path.join(dir, '.gitignore'), '');
  const r = localChecks({ config: config({ permissions: 'skip' }), workDir: dir, realGit });
  const f2 = failed(r);
  assert.match(f2[0], /^(?:поле «Менять» \/ Change|Change \(«Менять»\) field)$/);
  assert.match(f2[1], /^\.agent-runs\/ (?:в|in) \.gitignore$/);
  assert.match(f2[2], /^(?:чистое дерево|clean working tree)$/);
  assert.deepEqual(f2.slice(3), dir.startsWith(realpathSync(os.tmpdir())) ? [] : ['permissions']);
  rmSync(path.join(dir, 'PLAN.md'));
  assert.ok(failed(localChecks({ config: config(), workDir: dir, realGit })).includes('PLAN.md'));
});

test('runner checks: binary, model list, configured models and the open tasks\' «Модель»', () => {
  const bin = fakeRunner({ answer: {} });
  const r = runnerChecks({ config: config({ agyBin: bin }), workDir: dir });
  assert.equal(r.length, 6);
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, true, true, false]);
  assert.match(r[0].name, new RegExp(`^(?:раннер|runner) ${path.basename(bin)}$`));
  assert.match(r[1].name, /^(?:список моделей|model list)$/);
  assert.equal(r[2].name, 'executor.model');
  assert.equal(r[3].name, 'architect.model');
  assert.match(r[4].name, /^T-001: (?:«Модель»|Model)$/);
  assert.match(r[5].name, /^T-002: (?:«Модель»|Model)$/);
  assert.equal(r[4].detail, 'gemini-3.8-flash-high');
  assert.deepEqual(runnerChecks({ config: config({ agyBin: path.join(dir, 'missing-agy') }), workDir: dir }).map((x) => x.ok), [false]);
});

test('permission probe: passes only when the commands ran and the file was really written and edited; guards restored', async () => {
  g('remote', 'add', 'origin', path.join(dir, 'nowhere.git'));
  const allOk = { git_status: 'ok', rev_parse: 'ok', write: 'ok', edit: 'ok', note: '' };
  const ok = await probePermissions({ config: config({ agyBin: fakeRunner({ answer: allOk, writes: 'two' }) }), workDir: dir, realGit });
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /команды, запись и правка файла разрешены|commands, file write, and file edit are allowed/);
  assert.throws(() => g('config', '--get', 'remote.origin.pushurl'), 'pushurl restored after the probe');
  assert.equal(existsSync(path.join(dir, '.git', 'hooks', 'pre-push')), false);
  assert.equal(existsSync(path.join(dir, '.agent-runs', '.lock')), false);
  assert.ok(readdirSync(path.join(dir, '.agent-runs')).some((d) => d.startsWith('check-')));

  const claimed = await probePermissions({ config: config({ agyBin: fakeRunner({ answer: allOk }) }), workDir: dir, realGit });
  assert.equal(claimed.ok, false, 'the agent saying "ok" is not enough');
  assert.match(claimed.detail, /(?:файл не создан|file was not created) .*--write-permissions/);
  const notEdited = await probePermissions({ config: config({ agyBin: fakeRunner({ answer: { ...allOk, edit: 'denied' }, writes: 'one' }) }), workDir: dir, realGit });
  assert.match(notEdited.detail, /(?:файл не исправлен \(агент: denied\)|file was not edited \(agent: denied\))/);

  const denied = await probePermissions({ config: config({ agyBin: fakeRunner({ answer: { ...allOk, git_status: 'denied' }, stderr: 'command auto-denied: cannot prompt' }) }), workDir: dir, realGit });
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /allowlist/);
});

test('readiness: no model calls; settings, lock, next task, «Менять» and the task model all gate the start', () => {
  const settingsPath = path.join(dir, '..', `settings-${path.basename(dir)}.json`);
  const cfg = config({ agyBin: fakeRunner({ answer: {} }), permissions: 'allowlist' });
  const modelFor = (task) => (task.model.includes('no-such') ? { error: 'not found' } : { model: 'gemini-3.8-flash-high' });
  const run = (only = null) => readiness({ config: cfg, workDir: dir, realGit, only, settingsPath, modelFor });
  const failedNames = (r) => r.filter((x) => !x.ok).map((x) => x.name);
  try {
    assert.deepEqual(failedNames(run()), ['allowlist Antigravity'], 'no settings file → not ready');
    writeAgyAllowlist({ settingsPath, ...rulesFor(cfg, dir) });
    assert.deepEqual(failedNames(run()), [], JSON.stringify(run()));
    assert.match(failedNames(run('T-002')).join(','), /^T-002: (?:модель Исполнителя|Executor model)$/);
    assert.match(failedNames(run('T-009')).join(','), /^(?:следующая задача|next task)$/);
    mkdirSync(path.join(dir, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(dir, '.agent-runs', '.lock'), String(process.pid));
    assert.match(failedNames(run()).join(','), /^(?:другой цикл|another loop)$/);
    rmSync(path.join(dir, '.agent-runs', '.lock'));
    writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Tasks\n\n- [ ] T-001: one\n  - Modify: `src/a.ts`\n');
    g('commit', '-q', '-am', 'typo');
    const emptyChangeNames = failedNames(run());
    assert.equal(emptyChangeNames.length, 2);
    assert.match(emptyChangeNames[0], /^(?:поле «Менять» \/ Change|Change \(«Менять»\) field)$/);
    assert.match(emptyChangeNames[1], /^T-001: (?:«Менять»|Change)$/);
  } finally {
    rmSync(settingsPath, { force: true });
  }
});
