import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import { parsePlan } from './plan.mjs';
import { localChecks, readiness } from './check.mjs';
import { runRedCheck } from './evidence.mjs';
import { runFastSelfCheck } from './cli.mjs';
import { checkExecutorRun } from './mechanics.mjs';
import { which } from './guards.mjs';

const realGit = which('git');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function initRepo(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  g('init', '-q', '-b', 'master');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-runs/\n');
  return { dir, g };
}

test('C-01..C-04: localChecks and readiness reject glued/malformed tasks, invalid Risk, unbackticked/directory Frozen, and untested high-risk code', () => {
  // 1. Completed T-001 + malformed "- [ ] **T-002** — Title" must fail PLAN.md check instead of looking complete
  {
    const { dir, g } = initRepo('gates-c01-');
    try {
      writeFileSync(
        path.join(dir, 'PLAN.md'),
        [
          '# PLAN',
          '## Frozen',
          '- `EXECUTOR.md`',
          '## Tasks',
          '- [x] T-001: Done',
          '  - Risk: low',
          '  - Change: `src/a.mjs`',
          '- [ ] **T-002** — Unparsed open task',
          '  - Risk: high',
          '  - Change: `src/b.mjs`',
        ].join('\n') + '\n',
      );
      g('add', '.gitignore', 'PLAN.md');
      g('commit', '-q', '-m', 'init');

      const lc = localChecks({ config: { ...DEFAULTS }, workDir: dir, realGit });
      const planCheck = lc.find((c) => c.name === 'PLAN.md');
      assert.ok(planCheck && !planCheck.ok, `expected PLAN.md check to fail: ${JSON.stringify(lc)}`);
      assert.match(planCheck.detail, /line 8/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 2. Invalid Risk ("high (billing).") and missing Frozen target / bare directory fail localChecks & readiness without leaking absolute paths
  {
    const { dir, g } = initRepo('gates-c02-c03-');
    try {
      mkdirSync(path.join(dir, 'tests'), { recursive: true });
      writeFileSync(path.join(dir, 'tests', 'keep.txt'), 'ok\n');
      writeFileSync(
        path.join(dir, 'PLAN.md'),
        [
          '# PLAN',
          '## 3. Frozen',
          '- `EXECUTOR.md`',
          '- `tests`',
          '- tests/no-backticks.test.mjs',
          '## 5. Tasks',
          '- [ ] T-001: Billing task',
          '  - Risk: high (billing).',
          '  - Change: `src/billing.mjs`',
          '  - Verify: `npm test`',
        ].join('\n') + '\n',
      );
      g('add', '.gitignore', 'PLAN.md', 'tests/keep.txt');
      g('commit', '-q', '-m', 'init');

      const cfg = { ...DEFAULTS, permissions: 'skip' };
      const r = readiness({ config: cfg, workDir: dir, realGit, modelFor: () => ({ model: 'm' }) });
      const failed = r.filter((c) => !c.ok);
      assert.ok(failed.some((c) => /Risk/i.test(c.name) && c.detail.includes('T-001')), JSON.stringify(failed));
      assert.ok(failed.some((c) => c.name === 'Frozen' && c.detail.includes('line 5')), JSON.stringify(failed));
      assert.ok(failed.some((c) => c.name === 'Frozen' && c.detail.includes('"tests"')), JSON.stringify(failed));
      assert.ok(!r.some((c) => c.detail.includes(dir)), 'must not leak absolute workDir in check details');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 3. Open high-risk executable code task outside bypassScanPaths without referenceTests fails localChecks & readiness
  {
    const { dir, g } = initRepo('gates-c04-');
    try {
      writeFileSync(
        path.join(dir, 'PLAN.md'),
        [
          '# PLAN',
          '## Frozen',
          '- `EXECUTOR.md`',
          '## Tasks',
          '- [ ] T-001: Auth token check',
          '  - Risk: high',
          '  - Change: `services/auth.py`',
          '  - Verify: `python3 -m pytest`',
        ].join('\n') + '\n',
      );
      g('add', '.gitignore', 'PLAN.md');
      g('commit', '-q', '-m', 'init');

      const cfg = { ...DEFAULTS, bypassScanPaths: ['src', 'tests'] };
      const lc = localChecks({ config: cfg, workDir: dir, realGit });
      assert.ok(
        lc.some((c) => !c.ok && /Reference tests/i.test(c.name) && c.detail.includes('T-001')),
        `expected Reference tests failure in localChecks, got: ${JSON.stringify(lc)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('C-04 & C-02: runRedCheck, runFastSelfCheck, and checkExecutorRun enforce strict Risk and block untested high-risk code tasks', () => {
  const { dir, g } = initRepo('gates-sc-mech-');
  try {
    mkdirSync(path.join(dir, 'services'), { recursive: true });
    writeFileSync(path.join(dir, 'services', 'auth.py'), 'x = 1\n');
    writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}\n');
    g('add', '.gitignore', 'services/auth.py', 'package.json');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    const baseSha = g('rev-parse', 'HEAD');

    const untestedHighPlan = [
      '# PLAN',
      '',
      '## Decisions (ADR)',
      '- ADR-001: Base',
      '',
      '## Frozen',
      '- `EXECUTOR.md`',
      '',
      '## Tasks',
      '- [ ] T-001: High-risk Python auth',
      '  - Risk: high',
      '  - Change: `services/auth.py`',
      '  - Verify: `python3 -m pytest`',
    ].join('\n') + '\n';
    writeFileSync(path.join(dir, 'PLAN.md'), untestedHighPlan);
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: plan cycle 2');

    // runRedCheck must report BOTH notVerified AND a blocking violation even though services/ is outside bypassScanPaths
    const red = runRedCheck({
      realGit,
      cwd: dir,
      baseSha,
      plan: parsePlan(untestedHighPlan),
      config: { bypassScanPaths: ['src', 'tests'] },
    });
    assert.equal(red.ok, false, 'runRedCheck must fail on untested high-risk executable code task');
    assert.ok(red.notVerified.some((s) => s.includes('T-001') && /NOT VERIFIED/i.test(s)));
    assert.ok(red.violations.some((s) => s.includes('T-001')));

    // runFastSelfCheck must also fail on malformed PLAN.md / untested high-risk code task
    const fast = runFastSelfCheck({
      realGit,
      workDir: dir,
      config: { ...DEFAULTS, bypassScanPaths: ['src', 'tests'] },
      baseRef: baseSha,
    });
    assert.equal(fast.ok, false);
    assert.ok(fast.violations.some((v) => v.includes('T-001')));

    // With explicit structural verification marker, runRedCheck passes
    const structuralPlan = untestedHighPlan.replace(
      '  - Verify: `python3 -m pytest`',
      '  - Test cases: structural verification\n  - Verify: `python3 -m pytest`',
    );
    const redStruct = runRedCheck({
      realGit,
      cwd: dir,
      baseSha,
      plan: parsePlan(structuralPlan),
      config: { bypassScanPaths: ['src', 'tests'] },
    });
    assert.equal(redStruct.ok, true, JSON.stringify(redStruct));

    // checkExecutorRun rejects invalid Risk strings and recognizes uppercase/dotted HIGH.
    const commitBase = g('rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","private":true}\n');
    g('add', 'package.json');
    g('commit', '-q', '-m', 'T-002: update protected package.json');

    const badRiskMech = checkExecutorRun({
      realGit,
      cwd: dir,
      baseSha: commitBase,
      task: { id: 'T-002', risk: 'high (billing).', change: ['package.json'] },
      frozen: ['EXECUTOR.md'],
      protectedConfigFiles: ['package.json'],
      scanPaths: ['services'],
    });
    assert.equal(badRiskMech.ok, false);
    assert.ok(badRiskMech.violations.some((v) => /risk/i.test(v)), JSON.stringify(badRiskMech.violations));

    const validHighMech = checkExecutorRun({
      realGit,
      cwd: dir,
      baseSha: commitBase,
      task: { id: 'T-002', risk: 'HIGH.', change: ['package.json'] },
      frozen: ['EXECUTOR.md'],
      protectedConfigFiles: ['package.json'],
      scanPaths: ['services'],
    });
    assert.equal(validHighMech.ok, true, JSON.stringify(validHighMech.violations));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
