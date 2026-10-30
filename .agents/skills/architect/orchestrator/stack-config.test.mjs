import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, validateConfig } from './config.mjs';
import { isTestFile } from './mechanics.mjs';
import { runSelfCheckGit } from './selfcheck.mjs';
import { runRedCheck } from './evidence.mjs';
import { runFullSelfCheck } from './cli.mjs';
import { which } from './guards.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

function initRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-053: DEFAULTS in config.example.json and validateConfig support testFilePatterns, testPatterns, assertPatterns (including expect), and redCheckCommand', () => {
  assert.ok(Array.isArray(DEFAULTS.testFilePatterns) && DEFAULTS.testFilePatterns.length >= 4);
  assert.ok(Array.isArray(DEFAULTS.testPatterns) && DEFAULTS.testPatterns.length >= 1);
  assert.ok(Array.isArray(DEFAULTS.assertPatterns) && DEFAULTS.assertPatterns.some((p) => p.includes('expect')));
  assert.equal(DEFAULTS.redCheckCommand, 'node --test {file}');
  assert.deepEqual(validateConfig(DEFAULTS), []);

  // Default isTestFile recognizes *_test.go and test_*.py outside tests/ as well as *.spec.ts and tests/**
  assert.equal(isTestFile('pkg/auth/service_test.go'), true);
  assert.equal(isTestFile('app/auth/test_login.py'), true);
  assert.equal(isTestFile('src/components/Button.spec.tsx'), true);
  assert.equal(isTestFile('tests/unit/a.ts'), true);
  assert.equal(isTestFile('src/auth/service.go'), false);
  assert.equal(isTestFile('app/auth/login.py'), false);

  // Custom testFilePatterns in isTestFile
  assert.equal(isTestFile('custom/check_auth.rb', ['(?:^|/)check_[^/]+\\.rb$']), true);
  assert.equal(isTestFile('src/main.rb', ['(?:^|/)check_[^/]+\\.rb$']), false);

  // Invalid regexes or types in new config keys are rejected by validateConfig
  assert.match(validateConfig({ ...DEFAULTS, testFilePatterns: ['('] }).join('\n'), /testFilePatterns/);
  assert.match(validateConfig({ ...DEFAULTS, testPatterns: ['('] }).join('\n'), /testPatterns/);
  assert.match(validateConfig({ ...DEFAULTS, assertPatterns: ['('] }).join('\n'), /assertPatterns/);
  assert.match(validateConfig({ ...DEFAULTS, redCheckCommand: 123 }).join('\n'), /redCheckCommand/);
});

test('T-053: runSelfCheckGit counts expect() assertions by default, supports custom test/assert patterns, and reports NOT VERIFIED on 0-assertion test files without noise on setup.ts', () => {
  const { root, g } = initRepo('stack-selfcheck-t053-');
  try {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });

    // Vitest test file using expect(...) + helper tests/setup.ts with 0 tests and 0 assertions
    writeFileSync(
      path.join(root, 'tests', 'setup.ts'),
      'export const testEnv = "vitest-setup";\n',
    );
    writeFileSync(
      path.join(root, 'src', 'auth.spec.ts'),
      'import { test, expect } from "vitest";\ntest("login", () => { expect(1).toBe(1); expect(true).toBeTruthy(); });\n',
    );
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n');
    g('add', '.');
    g('commit', '-q', '-m', 'arch: close cycle 1');

    // Decrease expect() count in src/auth.spec.ts from 2 to 1 -> monotonicity violation!
    writeFileSync(
      path.join(root, 'src', 'auth.spec.ts'),
      'import { test, expect } from "vitest";\ntest("login", () => { expect(1).toBe(1); });\n',
    );
    g('add', 'src/auth.spec.ts');
    g('commit', '-q', '-m', 'arch: drop one expect assertion');

    const cfg = { ...DEFAULTS, bypassScanPaths: ['src', 'tests'] };
    const dropRes = runSelfCheckGit({ realGit, cwd: root, config: cfg });
    assert.equal(dropRes.ok, false, 'dropping expect() count must trigger monotonicity violation');
    assert.match(dropRes.violations.join('\n'), /src\/auth\.spec\.ts.*assert/i);

    // Restore 2 expects, and add a test file with 0 recognized assertions -> NOT VERIFIED with file name, while tests/setup.ts produces NO noise
    writeFileSync(
      path.join(root, 'src', 'auth.spec.ts'),
      'import { test, expect } from "vitest";\ntest("login", () => { expect(1).toBe(1); expect(true).toBeTruthy(); });\n',
    );
    writeFileSync(
      path.join(root, 'tests', 'empty-asserts.test.ts'),
      'import { test } from "vitest";\ntest("no asserts yet", () => { const x = 1 + 1; void x; });\n',
    );
    g('add', 'src/auth.spec.ts', 'tests/empty-asserts.test.ts');
    g('commit', '-q', '-m', 'arch: restore expect and add zero-assert test');

    const nvRes = runSelfCheckGit({ realGit, cwd: root, config: cfg });
    assert.equal(nvRes.ok, true, `0-assert test file must be NOT VERIFIED, not a VIOLATION: ${nvRes.violations.join('; ')}`);
    assert.ok(Array.isArray(nvRes.notVerified), 'runSelfCheckGit must return notVerified array');
    assert.ok(
      nvRes.notVerified.some((m) => m.includes('tests/empty-asserts.test.ts')),
      `notVerified must name tests/empty-asserts.test.ts, got: ${JSON.stringify(nvRes.notVerified)}`,
    );
    assert.equal(
      nvRes.notVerified.some((m) => m.includes('setup.ts')),
      false,
      `helper file tests/setup.ts without test cases must not produce NOT VERIFIED noise: ${JSON.stringify(nvRes.notVerified)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-053: runRedCheck and runFullSelfCheck report NOT VERIFIED when reference test has no suitable redCheckCommand, and run custom redCheckCommand with {file}', () => {
  const { root, g } = initRepo('stack-redcheck-t053-');
  try {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# Init\n');
    g('add', 'README.md');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    const baseSha = g('rev-parse', 'HEAD');

    // Add a Python reference test while redCheckCommand is still default "node --test {file}"
    writeFileSync(
      path.join(root, 'tests', 'test_auth.py'),
      'def test_deny():\n    assert 1 == 2\n',
    );
    const planText = [
      '# PLAN',
      '',
      '## Frozen',
      '- `EXECUTOR.md`',
      '- `tests/test_auth.py`',
      '',
      '## Tasks',
      '- [ ] T-001: Auth',
      '  - Risk: high.',
      '  - Change: `app/auth.py`.',
      '  - Test cases: `tests/test_auth.py`.',
      '  - Verify: `git status`.',
    ].join('\n') + '\n';
    writeFileSync(path.join(root, 'PLAN.md'), planText);
    g('add', 'PLAN.md', 'tests/test_auth.py');
    g('commit', '-q', '-m', 'arch: plan python task');

    // Default redCheckCommand ("node --test {file}") is not suitable for .py -> NOT VERIFIED (neither silent PASS nor false VIOLATION)
    const pyRed = runRedCheck({ realGit, cwd: root, baseSha, config: DEFAULTS });
    assert.equal(pyRed.ok, true, 'unsuitable default redCheckCommand for .py must not be a VIOLATION');
    assert.equal(pyRed.checked.length, 0, 'must not claim .py reference test was checked by node --test');
    assert.ok(
      Array.isArray(pyRed.notVerified) && pyRed.notVerified.some((m) => m.includes('tests/test_auth.py')),
      `expected NOT VERIFIED naming tests/test_auth.py, got: ${JSON.stringify(pyRed)}`,
    );

    const fullPy = runFullSelfCheck({
      realGit,
      workDir: root,
      config: {
        ...DEFAULTS,
        testPatterns: ['^\\s*def\\s+test_'],
        assertPatterns: ['\\bassert\\s+'],
      },
    });
    assert.equal(fullPy.ok, true);
    assert.ok(fullPy.notVerified.some((m) => m.includes('tests/test_auth.py')));

    for (const f of ['config.mjs', 'mechanics.mjs', 'selfcheck.mjs', 'evidence.mjs', 'cli.mjs']) {
      const lines = readFileSync(path.join(orchDir, f), 'utf8').split('\n').length;
      assert.ok(lines <= 400, `${f} must stay <= 400 lines (got ${lines})`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
