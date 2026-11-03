import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import * as gitMod from './git.mjs';
import * as mechMod from './mechanics.mjs';
import * as selfcheckMod from './selfcheck.mjs';
import { runFullSelfCheck } from './cli.mjs';

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

test('T-067 (a): commitsSince returns parents/isMerge/body, and resolveMergeBase resolves common ancestor', () => {
  assert.equal(typeof gitMod.resolveMergeBase, 'function');
  assert.equal(typeof gitMod.findSquashViolations, 'function');
  const { root, g } = initTempRepo('t067-merge-commits-');
  try {
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    g('add', 'base.txt');
    g('commit', '-q', '-m', 'arch: close cycle 0');
    const baseSha = g('rev-parse', 'HEAD');

    g('checkout', '-q', '-b', 'cycle/1');
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: feat\n  - Change: `a.js`\n');
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    g('add', 'PLAN.md', 'EXECUTOR.md');
    g('commit', '-q', '-m', 'arch: plan cycle 1');
    const planSha = g('rev-parse', 'HEAD');

    g('checkout', '-q', '-b', 'task/T-001');
    writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
    g('add', 'a.js');
    g('commit', '-q', '-m', 'T-001: implement a (#12)');

    g('checkout', '-q', 'cycle/1');
    g('merge', '--no-ff', '-q', '-m', "Merge pull request #1 from org/task/T-001", 'task/T-001');

    const commits = gitMod.commitsSince(realGit, root, baseSha);
    assert.equal(commits.length, 3);
    assert.equal(commits[0].isMerge, false);
    assert.equal(commits[1].isMerge, false);
    assert.equal(commits[2].isMerge, true);
    assert.equal(commits[2].parents.length, 2);
    assert.deepEqual(commits[2].files, [], 'clean merge commit must have empty conflict-only files list');

    assert.equal(gitMod.resolveMergeBase(realGit, root, planSha, 'task/T-001'), planSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-067 (b): mid-cycle --self-check on cycle/<N> with merge commits, multiple arch: accept, and still-red Frozen test for open task T-003 passes', () => {
  const { root, g } = initTempRepo('t067-midcycle-selfcheck-');
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'EXECUTOR.md'), readFileSync(path.join(path.dirname(orchDir), 'EXECUTOR.md'), 'utf8'));
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n');
    g('add', 'EXECUTOR.md', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    const closeSha = g('rev-parse', 'HEAD');

    // Start cycle/2 with 3 tasks; T-003 has a Frozen reference test that is currently RED
    g('checkout', '-q', '-b', 'cycle/2');
    writeFileSync(path.join(root, 'src', 't3.mjs'), 'export const t3 = () => false;\n');
    writeFileSync(
      path.join(root, 'tests', 't3-frozen.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { t3 } from '../src/t3.mjs';\ntest('t3 must return true', () => { assert.equal(t3(), true); });\n",
    );
    const makePlan = (t1Done, t2Done) => [
      '# PLAN',
      '',
      '## Frozen',
      '- `EXECUTOR.md`',
      '- `tests/t3-frozen.test.mjs`',
      '',
      '## Tasks',
      `- [${t1Done ? 'x' : ' '}] T-001: Add module one`,
      '  - Risk: low',
      '  - Change: `src/one.mjs`',
      `- [${t2Done ? 'x' : ' '}] T-002: Add module two`,
      '  - Risk: low',
      '  - Change: `src/two.mjs`',
      '- [ ] T-003: Implement t3 high risk',
      '  - Risk: high',
      '  - Change: `src/t3.mjs`',
      '  - Test cases: `tests/t3-frozen.test.mjs`',
    ].join('\n') + '\n';

    writeFileSync(path.join(root, 'PLAN.md'), makePlan(false, false));
    g('add', 'PLAN.md', 'src/t3.mjs', 'tests/t3-frozen.test.mjs');
    g('commit', '-q', '-m', 'arch: plan cycle 2');

    // Task T-001 in task/T-001 (with legitimate (#42) issue reference in subject — must NOT be flagged as squash!)
    g('checkout', '-q', '-b', 'task/T-001');
    writeFileSync(path.join(root, 'src', 'one.mjs'), 'export const one = 1;\n');
    g('add', 'src/one.mjs');
    g('commit', '-q', '-m', 'T-001: implement one (#42)');

    // Merge T-001 into cycle/2 with --no-ff and mark [x] via arch: accept T-001
    g('checkout', '-q', 'cycle/2');
    g('merge', '--no-ff', '-q', '-m', 'Merge pull request #10 from org/task/T-001', 'task/T-001');
    writeFileSync(path.join(root, 'PLAN.md'), makePlan(true, false));
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: accept T-001');

    // Task T-002 in task/T-002
    g('checkout', '-q', '-b', 'task/T-002');
    writeFileSync(path.join(root, 'src', 'two.mjs'), 'export const two = 2;\n');
    g('add', 'src/two.mjs');
    g('commit', '-q', '-m', 'T-002: implement two');

    // Merge T-002 into cycle/2 with --no-ff and mark [x] via arch: accept T-002
    g('checkout', '-q', 'cycle/2');
    g('merge', '--no-ff', '-q', '-m', 'Merge pull request #11 from org/task/T-002', 'task/T-002');
    writeFileSync(path.join(root, 'PLAN.md'), makePlan(true, true));
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: accept T-002');

    const teamCfg = { ...DEFAULTS, team: true, commitLanguage: 'en', bypassScanPaths: ['src'], bypassRegexps: [] };
    const scRes = runFullSelfCheck({ realGit, workDir: root, config: teamCfg, baseRef: closeSha, orchestratorDir: orchDir });
    assert.equal(scRes.ok, true, `mid-cycle --self-check on cycle/2 must pass: ${scRes.violations.join('; ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-067 (c): squash commits are rejected with a clear message in --check-task and --self-check, while (#N) alone is allowed', () => {
  const { root, g } = initTempRepo('t067-squash-detect-');
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: feat\n  - Risk: low\n  - Change: `src/a.mjs`\n',
    );
    g('add', 'EXECUTOR.md', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: plan cycle 1');
    const planSha = g('rev-parse', 'HEAD');

    // 1. Normal commit with (#15) issue reference in subject and no squash body -> allowed!
    g('checkout', '-q', '-b', 'task/T-001');
    writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
    g('add', 'src/a.mjs');
    g('commit', '-q', '-m', 'T-001: implement a (#15)');
    const cleanExec = mechMod.checkExecutorRun({
      realGit,
      cwd: root,
      baseSha: planSha,
      task: { id: 'T-001', risk: 'low', change: ['src/a.mjs'] },
      frozen: ['EXECUTOR.md'],
      orchestratorDir: orchDir,
    });
    assert.equal(cleanExec.ok, true, `normal (#15) issue ref must not trigger squash violation: ${cleanExec.violations.join('; ')}`);

    // 2. GitHub squash commit: (#15) in subject + squashed commit bullets in body -> rejected as squash!
    g('checkout', '-q', 'master');
    writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 2;\n');
    g('add', 'src/a.mjs');
    g('commit', '-q', '-m', 'T-001: implement a (#15)\n\n* T-001: part 1\n* T-001 (fix 1): part 2');

    const squashExec = mechMod.checkExecutorRun({
      realGit,
      cwd: root,
      baseSha: planSha,
      task: { id: 'T-001', risk: 'low', change: ['src/a.mjs'] },
      frozen: ['EXECUTOR.md'],
      orchestratorDir: orchDir,
    });
    assert.equal(squashExec.ok, false);
    assert.match(squashExec.violations.join('\n'), /squash/i);

    const squashSc = selfcheckMod.runSelfCheckGit({
      realGit,
      cwd: root,
      config: { ...DEFAULTS, team: true, bypassScanPaths: ['src'], bypassRegexps: [] },
      baseRef: planSha,
      orchestratorDir: orchDir,
    });
    assert.equal(squashSc.ok, false);
    assert.match(squashSc.violations.join('\n'), /squash/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-067 (d): strict commit message violations in --self-check are enabled ONLY by config.team === true, never by CI=true', () => {
  const { root, g } = initTempRepo('t067-strict-team-only-');
  try {
    writeFileSync(path.join(root, 'EXECUTOR.md'), '# Executor\n');
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: feat\n  - Change: `a.js`\n');
    g('add', 'EXECUTOR.md', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: close cycle 1');
    const baseSha = g('rev-parse', 'HEAD');

    // Commit with Cyrillic subject when commitLanguage is "en"
    writeFileSync(path.join(root, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [x] T-001: feat\n  - Change: `a.js`\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: приёмка T-001');

    // 1. Solo mode (team: false), even with env: { CI: 'true' }, keeps commit message issues as warnings (ok: true)
    const soloCfg = { ...DEFAULTS, team: false, commitLanguage: 'en', bypassScanPaths: ['src'], bypassRegexps: [] };
    const soloRes = runFullSelfCheck({ realGit, workDir: root, config: soloCfg, baseRef: baseSha, env: { ...process.env, CI: 'true' }, orchestratorDir: orchDir });
    assert.equal(soloRes.ok, true, 'solo mode must not fail --self-check on commit warnings even when CI=true');
    assert.ok(soloRes.warnings.length >= 1);

    // 2. Team mode (team: true) promotes commit message issues to hard violations (ok: false)
    const teamCfg = { ...soloCfg, team: true };
    const teamRes = runFullSelfCheck({ realGit, workDir: root, config: teamCfg, baseRef: baseSha, orchestratorDir: orchDir });
    assert.equal(teamRes.ok, false, 'team: true must fail --self-check on commit format/language violations');
    assert.match(teamRes.violations.join('\n'), /non-Latin|commitLanguage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
