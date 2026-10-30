import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS, EXAMPLE_PATH, validateConfig, withDefaults } from './config.mjs';
import { runnerChecks } from './check.mjs';
import {
  buildAuditClaudeSettings,
  countAuditsForBase,
  runPlanAudit,
  checkAuditCoverage,
} from './audit.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

function initTempRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-048: config.mjs validates optional auditor { runner: "claude", model } without adding auditor to config.example.json, and check.mjs reports missing claude binary', () => {
  const exampleRaw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
  assert.equal('auditor' in exampleRaw, false, 'auditor must not be added to config.example.json');

  const validWithAuditor = withDefaults({
    ...DEFAULTS,
    executor: { model: 'gemini-3.8-flash-high' },
    architect: { model: 'claude-opus' },
    auditor: { runner: 'claude', model: 'opus' },
  });
  assert.deepEqual(validateConfig(validWithAuditor), []);

  const badRunner = withDefaults({
    ...DEFAULTS,
    executor: { model: 'gemini-3.8-flash-high' },
    architect: { model: 'claude-opus' },
    auditor: { runner: 'agy', model: 'opus' },
  });
  assert.match(validateConfig(badRunner).join('\n'), /auditor\.runner/i);

  const badModel = withDefaults({
    ...DEFAULTS,
    executor: { model: 'gemini-3.8-flash-high' },
    architect: { model: 'claude-opus' },
    auditor: { runner: 'claude', model: '' },
  });
  assert.match(validateConfig(badModel).join('\n'), /auditor\.model/i);

  const { root } = initTempRepo('s10-t048-check-');
  try {
    const checks = runnerChecks({
      config: validWithAuditor,
      workDir: root,
      env: { ...process.env, PATH: '/nonexistent-bin-dir' },
    });
    const auditorCheck = checks.find((c) => /auditor/i.test(c.name));
    assert.ok(auditorCheck, 'runnerChecks must include an auditor check when config.auditor is present');
    assert.equal(auditorCheck.ok, false);
    assert.match(auditorCheck.detail, /claude/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-048: buildAuditClaudeSettings writes read-only settings (Read/Grep/Glob only) and runPlanAudit enforces family separation, read-only git invariance, and max 1 re-run per cycle base', async () => {
  const { root, g } = initTempRepo('s10-t048-audit-');
  try {
    writeFileSync(path.join(root, '.gitignore'), '.agent-runs/\n');
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Задачи\n');
    g('add', '.gitignore', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: close cycle 9');
    const cycleBaseSha = g('rev-parse', 'HEAD');

    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Задачи\n- [ ] T-045: Task\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: draft plan');

    const settingsFile = path.join(root, '.agent-runs', 'test-settings.json');
    buildAuditClaudeSettings({ workDir: root, skillDir: path.resolve(orchDir, '..'), settingsPath: settingsFile });
    assert.ok(existsSync(settingsFile));
    const settingsJson = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(settingsJson.sandbox?.enabled, true);
    assert.equal(settingsJson.permissions?.blockReadsOutsideWorkingDirectories, true);
    assert.ok(settingsJson.permissions.allow.every((r) => /^(Read|Grep|Glob)\(/.test(r)));
    assert.ok(settingsJson.permissions.deny.some((r) => /^Bash\(/.test(r)));
    assert.ok(settingsJson.permissions.deny.some((r) => /^Edit\(/.test(r)));
    assert.ok(settingsJson.permissions.deny.some((r) => /^Write\(/.test(r)));

    const config = {
      ...DEFAULTS,
      executor: { model: 'gemini-3.8-flash-high' },
      architect: { model: 'claude-opus-4' }, // loop reviewer may be claude; must NOT be compared with auditor!
      auditor: { runner: 'claude', model: 'claude-sonnet-4' },
    };

    // Same model family between plan author and auditor is rejected
    await assert.rejects(
      () => runPlanAudit({
        config,
        workDir: root,
        realGit,
        authorModel: 'claude-opus-4',
        runAgent: async () => ({ ok: true, json: { findings: [], summary: 'ok' } }),
      }),
      /family|author/i,
    );

    // Run 1 (with Gemini authorModel -> different family from Claude auditor)
    let capturedOpts = null;
    const run1 = await runPlanAudit({
      config,
      workDir: root,
      realGit,
      authorModel: 'gemini-4-argon',
      runAgent: async (opts) => {
        capturedOpts = opts;
        return {
          ok: true,
          json: {
            findings: [
              { id: 'raw-1', severity: 'blocker', category: 'frozen_tests', file: 'tests/a.test.mjs', summary: 'Missing negative case', recommendation: 'Add fail-closed assertion' },
              { id: 'raw-2', severity: 'important', category: 'regex_contracts', file: 'src/a.mjs', summary: 'Regex misses whitespace', recommendation: 'Use \\s+' },
              { id: 'raw-3', severity: 'minor', category: 'change_frozen_overlap', file: 'PLAN.md', summary: 'Minor nit', recommendation: 'Optional' },
            ],
            summary: 'Found 1 blocker, 1 important, 1 minor.',
          },
        };
      },
    });

    assert.ok(capturedOpts?.settingsPath, 'runPlanAudit must pass settingsPath to runClaudeAgent');
    assert.equal(run1.audit.cycleBaseSha, cycleBaseSha);
    assert.equal(run1.audit.model, 'claude-sonnet-4');
    assert.deepEqual(run1.audit.findings.map((f) => f.id), ['A-1', 'A-2', 'A-3']);
    assert.ok(existsSync(run1.auditJsonPath));
    assert.ok(existsSync(run1.auditMdPath));

    // Advance HEAD within the same cycle (cycleBaseSha is still close cycle 9!) and run the 1 allowed re-run (Run 2)
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Задачи\n- [ ] T-045: Task v2\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: update draft plan');

    const run2 = await runPlanAudit({
      config,
      workDir: root,
      realGit,
      authorModel: 'gemini-4-argon',
      runAgent: async () => ({
        ok: true,
        json: {
          findings: [
            { id: '1', severity: 'blocker', category: 'frozen_tests', file: 'tests/a.test.mjs', summary: 'Blocker 1', recommendation: 'Fix 1' },
            { id: '2', severity: 'important', category: 'regex_contracts', file: 'src/a.mjs', summary: 'Important 2', recommendation: 'Fix 2' },
          ],
          summary: 'Second run.',
        },
      }),
    });
    assert.equal(run2.audit.cycleBaseSha, cycleBaseSha);
    assert.equal(countAuditsForBase(path.join(root, '.agent-runs', 'audits'), cycleBaseSha), 2);

    // Run 3 on the same cycleBaseSha must fail (max 1 re-run = 2 total runs per cycle base)
    await assert.rejects(
      () => runPlanAudit({
        config,
        workDir: root,
        realGit,
        authorModel: 'gemini-4-argon',
        runAgent: async () => ({ ok: true, json: { findings: [], summary: 'ok' } }),
      }),
      /limit|re-run|повтор/i,
    );

    // Coverage check against latest audit (run2: A-1 blocker, A-2 important)
    const missingCoverage = checkAuditCoverage({
      workDir: root,
      planText: '# PLAN\n\n## Decisions (ADR)\n- A-1 [blocker]: принято\n',
      cycleBaseSha,
    });
    assert.equal(missingCoverage.ok, false);
    assert.match(missingCoverage.violations.join('\n'), /A-2/);

    const fullCoverage = checkAuditCoverage({
      workDir: root,
      planText: '# PLAN\n\n## Decisions (ADR)\n- A-1 [blocker]: отклонено: false positive on frozen helper\n- A-2 [important]: принято\n',
      cycleBaseSha,
    });
    assert.equal(fullCoverage.ok, true);
    assert.equal(fullCoverage.rejectedBlockers.length, 1);
    assert.equal(fullCoverage.rejectedBlockers[0].id, 'A-1');
    assert.match(fullCoverage.rejectedBlockers[0].reason, /false positive/);

    // Read-only invariant check: if runAgent mutates working tree on a new cycle base, runPlanAudit throws
    g('commit', '--allow-empty', '-q', '-m', 'arch: close cycle 10');
    await assert.rejects(
      () => runPlanAudit({
        config,
        workDir: root,
        realGit,
        authorModel: 'gemini-4-argon',
        runAgent: async () => {
          writeFileSync(path.join(root, 'PLAN.md'), 'mutated by rogue auditor\n');
          return { ok: true, json: { findings: [], summary: 'mutated' } };
        },
      }),
      /read-only|dirty|working tree|HEAD/i,
    );

    for (const f of ['config.mjs', 'check.mjs', 'audit.mjs']) {
      const lines = readFileSync(path.join(orchDir, f), 'utf8').split('\n').length;
      assert.ok(lines <= 400, `${f} must stay <= 400 lines (got ${lines})`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
