import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import * as checkMod from './check.mjs';
import { runFastSelfCheck } from './cli.mjs';
import { which } from './guards.mjs';

const { localChecks } = checkMod;
const realGit = which('git');

function initRepo(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { dir, g };
}

test('T-052: localChecks and runFastSelfCheck reject skill installed in repo root', () => {
  assert.equal(typeof checkMod.checkSkillInstallation, 'function', 'check.mjs must export checkSkillInstallation');
  const { dir, g } = initRepo('install-root-t052-');
  try {
    const rootOrchDir = path.join(dir, 'orchestrator');
    mkdirSync(rootOrchDir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# Architect Prompt v3.27\n');
    writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
    writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: x\n  - Risk: low.\n  - Change: `src/a.js`\n');
    writeFileSync(path.join(dir, '.gitignore'), '.agent-runs/\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');

    const checks = localChecks({ config: DEFAULTS, workDir: dir, realGit, orchestratorDir: rootOrchDir });
    const rootFailure = checks.find((c) => !c.ok && /skill|root|подпапк|subfolder/i.test(`${c.name} ${c.detail}`));
    assert.ok(rootFailure, `localChecks must reject skill in repository root: ${JSON.stringify(checks)}`);

    const sc = runFastSelfCheck({ realGit, workDir: dir, config: DEFAULTS, orchestratorDir: rootOrchDir });
    assert.equal(sc.ok, false, 'runFastSelfCheck must fail when skill is installed at repository root');
    assert.match(sc.violations.join('\n'), /root|subfolder/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-052: localChecks and runFastSelfCheck verify EXECUTOR.md copy parity and AGENTS.md orchestrator command flags', () => {
  const { dir, g } = initRepo('install-parity-t052-');
  try {
    const skillDir = path.join(dir, '.claude', 'skills', 'architect');
    const orchDir = path.join(skillDir, 'orchestrator');
    mkdirSync(orchDir, { recursive: true });
    const canonicalExec = '<!-- executor-policy-version: 1.8 -->\n# Executor Rules\n';
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Architect Prompt v3.27\n');
    writeFileSync(path.join(skillDir, 'EXECUTOR.md'), canonicalExec);
    writeFileSync(path.join(dir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.7 -->\n# Outdated\n');
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Project Rules\nRun `npm run agents -- --init` or `npm run agents -- --dry-run`.\n',
    );
    writeFileSync(path.join(dir, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: x\n  - Risk: low.\n  - Change: `src/a.js`\n');
    writeFileSync(path.join(dir, '.gitignore'), '.agent-runs/\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init with outdated executor and incomplete AGENTS.md');

    const badChecks = localChecks({ config: DEFAULTS, workDir: dir, realGit, orchestratorDir: orchDir });
    assert.ok(
      badChecks.some((c) => !c.ok && c.name === 'EXECUTOR.md' && /match|совпадает|differ/i.test(c.detail)),
      `localChecks must report diverging EXECUTOR.md: ${JSON.stringify(badChecks)}`,
    );
    assert.ok(
      badChecks.some((c) => !c.ok && c.name === 'AGENTS.md' && /--self-check|--check/.test(c.detail)),
      `localChecks must report missing --check/--self-check when AGENTS.md documents npm run agents: ${JSON.stringify(badChecks)}`,
    );

    const badSc = runFastSelfCheck({ realGit, workDir: dir, config: DEFAULTS, orchestratorDir: orchDir });
    assert.equal(badSc.ok, false);
    assert.match(badSc.violations.join('\n'), /EXECUTOR\.md/);
    assert.match(badSc.violations.join('\n'), /AGENTS\.md/);

    // Fix EXECUTOR.md copy and AGENTS.md -> both localChecks and runFastSelfCheck pass
    writeFileSync(path.join(dir, 'EXECUTOR.md'), canonicalExec);
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# Project Rules\nRun `npm run agents` (`--init`, `--check`, `--dry-run`, `--self-check`).\n',
    );
    g('add', 'EXECUTOR.md', 'AGENTS.md');
    g('commit', '-q', '-m', 'arch: sync EXECUTOR.md and AGENTS.md');

    const okChecks = localChecks({ config: DEFAULTS, workDir: dir, realGit, orchestratorDir: orchDir });
    assert.deepEqual(
      okChecks.filter((c) => !c.ok),
      [],
      `all localChecks must pass once EXECUTOR.md and AGENTS.md are synced: ${JSON.stringify(okChecks)}`,
    );

    const okSc = runFastSelfCheck({ realGit, workDir: dir, config: DEFAULTS, orchestratorDir: orchDir });
    assert.equal(okSc.ok, true, `runFastSelfCheck must pass: ${okSc.violations.join('; ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
