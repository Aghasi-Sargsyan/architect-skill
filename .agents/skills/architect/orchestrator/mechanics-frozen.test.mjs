import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExecutorRun } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';
import { DEFAULTS, validateConfig, withDefaults } from './config.mjs';
import { localChecks } from './check.mjs';
import { runAgent } from './adapters/agy.mjs';

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
const commit = (msg, files) => {
  g('add', ...files);
  g('commit', '-q', '-m', msg);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-mech-s1-')));
  g('init', '-q', '-b', 'master');
  write('EXECUTOR.md', '<!-- executor-policy-version: 1.5 -->\nrules\n');
  write('PLAN.md', '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/ref.test.ts`\n\n## Задачи\n\n- [ ] T-017: test\n  - Риск: средний.\n  - Менять: `src/a.ts`\n');
  write('tests/ref.test.ts', 'export const ref = "immutable content for rename detection";\n');
  write('src/unlisted.ts', 'export const unlisted = "unlisted content for rename detection";\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('package.json', '{"name": "app", "scripts": {"test": "vitest"}}\n');
  write('tsconfig.test.json', '{"compilerOptions": {"strict": true}}\n');
  write('.gitignore', '.agent-runs/\n');
  commit('init', ['.']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('B1: renaming a Frozen file or a file outside «Менять» into an allowed new path is caught', () => {
  const b1 = g('rev-parse', 'HEAD');
  g('mv', 'tests/ref.test.ts', 'src/renamed-ref.ts');
  g('commit', '-q', '-m', 'T-017: rename frozen');
  const res1 = checkExecutorRun({
    realGit,
    cwd: dir,
    base: b1,
    task: { id: 'T-017', risk: 'средний', change: ['src/renamed-ref.ts'] },
    frozen: ['EXECUTOR.md', 'tests/ref.test.ts'],
    scanPaths: ['src', 'tests'],
    bypassPatterns: [],
  });
  assert.match(res1.violations.join('\n'), /Frozen: tests\/ref\.test\.ts/);

  const b2 = g('rev-parse', 'HEAD');
  g('mv', 'src/unlisted.ts', 'src/renamed-unlisted.ts');
  g('commit', '-q', '-m', 'T-017: rename unlisted');
  const res2 = checkExecutorRun({
    realGit,
    cwd: dir,
    base: b2,
    task: { id: 'T-017', risk: 'средний', change: ['src/renamed-unlisted.ts'] },
    frozen: ['EXECUTOR.md', 'tests/ref.test.ts'],
    scanPaths: ['src', 'tests'],
    bypassPatterns: [],
  });
  assert.match(res2.violations.join('\n'), /(?:вне «Менять»|outside Change[^:]*): src\/unlisted\.ts/);
});

test('B2: parsePlan accepts ## Frozen heading suffixes/translations; localChecks and checkExecutorRun enforce EXECUTOR.md in Frozen', () => {
  for (const heading of ['## Frozen (не трогать)', '## FROZEN — do not edit', '## Замороженные файлы (Frozen)', '## Замороженные']) {
    const parsed = parsePlan(`# PLAN\n\n${heading}\n- \`EXECUTOR.md\`\n- \`src/types.ts\`\n\n## Задачи\n\n- [ ] T-001: x\n  - Менять: \`src/a.ts\`\n`);
    assert.deepEqual(parsed.frozen, ['EXECUTOR.md', 'src/types.ts'], heading);
  }

  // In a repo with EXECUTOR.md, localChecks fails if EXECUTOR.md is missing from Frozen.
  write('PLAN.md', '# PLAN\n\n## Frozen\n- `tests/ref.test.ts`\n\n## Задачи\n\n- [ ] T-017: test\n  - Риск: средний.\n  - Менять: `src/a.ts`\n');
  commit('drop executor from frozen', ['PLAN.md']);
  const checksMissing = localChecks({ config: { ...DEFAULTS }, workDir: dir, realGit });
  assert.ok(checksMissing.some((c) => !c.ok && /Frozen/i.test(c.name) && /EXECUTOR\.md/.test(c.detail)), JSON.stringify(checksMissing));

  // Even if frozen=[] is passed to checkExecutorRun, touching EXECUTOR.md is always a Frozen violation.
  const b = g('rev-parse', 'HEAD');
  write('EXECUTOR.md', 'modified\n');
  commit('T-017: touch executor', ['EXECUTOR.md']);
  const mech = checkExecutorRun({
    realGit,
    cwd: dir,
    base: b,
    task: { id: 'T-017', risk: 'высокий', change: ['EXECUTOR.md'] },
    frozen: [],
    scanPaths: [],
    bypassPatterns: [],
  });
  assert.match(mech.violations.join('\n'), /Frozen: EXECUTOR\.md/);
});

test('B3: protectedConfigFiles in config defaults/validation; modifying verification configs is blocked unless task risk is high', () => {
  assert.ok(Array.isArray(DEFAULTS.protectedConfigFiles) && DEFAULTS.protectedConfigFiles.length > 0, 'DEFAULTS.protectedConfigFiles must be defined');
  for (const pattern of ['package.json', 'tsconfig.json', 'tsconfig.*.json', 'vitest.config.*']) {
    assert.ok(DEFAULTS.protectedConfigFiles.includes(pattern), `missing default pattern: ${pattern}`);
  }
  assert.match(validateConfig(withDefaults({ protectedConfigFiles: 'package.json' })).join('\n'), /protectedConfigFiles/);

  const b = g('rev-parse', 'HEAD');
  write('package.json', '{"name": "app", "scripts": {"test": "vitest --passWithNoTests"}}\n');
  write('tsconfig.test.json', '{"compilerOptions": {"strict": false}}\n');
  commit('T-017: weaken configs', ['package.json', 'tsconfig.test.json']);

  for (const lowOrMedRisk of ['низкий', 'средний', 'low', 'medium', '']) {
    const res = checkExecutorRun({
      realGit,
      cwd: dir,
      base: b,
      task: { id: 'T-017', risk: lowOrMedRisk, change: ['package.json', 'tsconfig.test.json'] },
      frozen: ['EXECUTOR.md'],
      scanPaths: ['src'],
      bypassPatterns: [],
      protectedConfigFiles: DEFAULTS.protectedConfigFiles,
    });
    assert.match(res.violations.join('\n'), /(?:конфиг проверок|verification config).*package\.json/, `risk=${lowOrMedRisk}`);
    assert.match(res.violations.join('\n'), /(?:конфиг проверок|verification config).*tsconfig\.test\.json/, `risk=${lowOrMedRisk}`);
  }

  for (const highRisk of ['высокий', 'high', 'Высокий']) {
    const ok = checkExecutorRun({
      realGit,
      cwd: dir,
      base: b,
      task: { id: 'T-017', risk: highRisk, change: ['package.json', 'tsconfig.test.json'] },
      frozen: ['EXECUTOR.md'],
      scanPaths: ['src'],
      bypassPatterns: [],
      protectedConfigFiles: DEFAULTS.protectedConfigFiles,
    });
    assert.deepEqual(ok.violations, [], `high-risk task with files in change must pass: ${highRisk}`);
  }
});

test('B4: runAgent escalates from SIGTERM to SIGKILL when a timed-out runner ignores SIGTERM', async () => {
  const stubborn = path.join(dir, 'stubborn-agy');
  const pidFile = path.join(dir, 'stubborn.pid');
  // Only SIGKILL can stop it: it ignores SIGTERM and never exits on its own.
  writeFileSync(
    stubborn,
    `#!/bin/sh
[ "$1" = warmup ] && exit 0
echo $$ > '${pidFile}'
trap '' TERM
while :; do sleep 1 >/dev/null 2>&1; done
`,
  );
  chmodSync(stubborn, 0o755);
  execFileSync(stubborn, ['warmup']);
  const logs = [];
  const res = await runAgent({
    bin: stubborn,
    model: 'm',
    prompt: 'p',
    cwd: dir,
    schemaPath: 's.json',
    env: process.env,
    skipPermissions: false,
    timeoutMs: 2000,
    killGraceMs: 200,
    maxAttempts: 1,
    home: dir,
    log: (m) => logs.push(m),
  });
  assert.equal(res.ok, false, `logs=${logs.join('; ')}`);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `the stubborn runner must record its pid, got ${pid}`);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the runner that ignores SIGTERM must be dead');
  assert.ok(logs.some((l) => /signal=SIGKILL/.test(l)), `expected the log to show the SIGKILL escalation, logs=${logs.join('; ')} err=${res.error}`);
});
