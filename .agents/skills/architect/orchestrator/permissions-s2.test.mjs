import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_COMMANDS, allowedCommandsFor } from './permissions.mjs';
import { DEFAULTS } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('T-022 (C2): BASE_COMMANDS contains only the 12 stack-neutral git and inspection commands', () => {
  assert.deepEqual(BASE_COMMANDS, [
    'git status',
    'git diff',
    'git log',
    'git show',
    'git rev-parse',
    'git branch --show-current',
    'git add',
    'git commit',
    'node --test',
    'wc -l',
    'grep',
    'ls',
  ]);
  for (const projectSpecific of ['npm test', 'npm run build', 'npm run test:smoke', 'npx tsc', 'npx vitest run']) {
    assert.ok(!BASE_COMMANDS.includes(projectSpecific), `${projectSpecific} must not be in global BASE_COMMANDS`);
  }
});

test('T-022 (C2, D1): DEFAULTS in config.example.json covers multi-stack protectedConfigFiles and bypassPatterns without parent-project scripts', () => {
  assert.ok(!DEFAULTS.bypassScanPaths.includes('scripts'), 'DEFAULTS.bypassScanPaths must not hardcode parent-project "scripts"');
  for (const cfgPattern of ['package.json', 'tsconfig.json', 'pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod', 'Makefile', 'justfile']) {
    assert.ok(DEFAULTS.protectedConfigFiles.includes(cfgPattern), `DEFAULTS.protectedConfigFiles must include ${cfgPattern}`);
  }
  const combinedBypass = DEFAULTS.bypassPatterns.map((p) => new RegExp(p));
  for (const sample of ['const x: any = 1', '// @ts-ignore', '# noqa: F401', '# type: ignore', '#[allow(dead_code)]', 'test.skip(']) {
    assert.ok(combinedBypass.some((re) => re.test(sample)), `DEFAULTS.bypassPatterns must catch: ${sample}`);
  }

  // When a project specifies its stack commands in allowedCommands, allowedCommandsFor includes them
  const cmds = allowedCommandsFor({
    ...DEFAULTS,
    blockedNpmScripts: ['ship'],
    allowedCommands: ['pytest', 'cargo test'],
  });
  assert.ok(cmds.includes('pytest'));
  assert.ok(cmds.includes('cargo test'));
  assert.equal(cmds.length, 14);
});

test('T-022 (C2, У2): test fixtures in permissions.test.mjs and plan.test.mjs do not contain parent-project script names', () => {
  const permTest = readFileSync(path.join(here, 'permissions.test.mjs'), 'utf8');
  const planTest = readFileSync(path.join(here, 'plan.test.mjs'), 'utf8');
  for (const leak of ['sync:pull', 'sync:push', 'import:takeout', 'build:mobile', 'test:smoke']) {
    assert.ok(!permTest.includes(leak), `permissions.test.mjs must not contain parent-project script "${leak}"`);
  }
  assert.ok(!planTest.includes('verify-ui-core.ts'), 'plan.test.mjs must not contain parent-project file "verify-ui-core.ts"');
});
