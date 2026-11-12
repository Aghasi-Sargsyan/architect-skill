import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { DEFAULTS } from './config.mjs';
import { EVAL_FIXTURE_ANCHORS } from './selfcheck.mjs';
import {
  parseArgs,
  runFastSelfCheck,
  runFullSelfCheck,
  formatSelfCheckReport,
  formatStartupNotices,
} from './cli.mjs';

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

test('T-049: parseArgs parses --self-check, --base <ref>, and --audit-plan and enforces mutual exclusion and --base requirements', () => {
  const sc = parseArgs(['--self-check']);
  assert.equal(sc.selfCheck, true);
  assert.equal(sc.base, null);

  const scWithBase = parseArgs(['--self-check', '--base', '@{u}']);
  assert.equal(scWithBase.selfCheck, true);
  assert.equal(scWithBase.base, '@{u}');

  const audit = parseArgs(['--audit-plan']);
  assert.equal(audit.auditPlan, true);

  assert.throws(() => parseArgs(['--base', 'HEAD~1']), /--base.*--self-check/i);
  assert.throws(() => parseArgs(['--self-check', '--base']), /--base/i);
  assert.throws(() => parseArgs(['--self-check', '--dry-run']), /only one/i);
  assert.throws(() => parseArgs(['--audit-plan', '--check']), /only one/i);
});

test('T-049: runFastSelfCheck and runFullSelfCheck combine selfcheck, evidence, and audit coverage, and CLI --self-check exits 0 on NOT VERIFIED and 1 on VIOLATION', () => {
  const { root, g } = initTempRepo('s10-t049-cli-');
  try {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    mkdirSync(path.join(root, '.agents', 'skills', 'architect', 'orchestrator'), { recursive: true });

    const orchCfg = {
      ...DEFAULTS,
      executor: { model: 'gemini-3.8-flash-high' },
      architect: { model: 'claude-opus' },
      bypassScanPaths: ['tests'],
      bypassRegexps: (DEFAULTS.bypassPatterns ?? []).map((p) => new RegExp(p)),
    };
    writeFileSync(path.join(root, '.agents', 'orchestrator.json'), JSON.stringify(orchCfg, null, 2));
    writeFileSync(path.join(root, '.gitignore'), '.agent-runs/\n');
    writeFileSync(
      path.join(root, '.agents', 'skills', 'architect', 'orchestrator', 'eval-fixtures.mjs'),
      EVAL_FIXTURE_ANCHORS.join('\n') + '\n',
    );
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n\n## Задачи\n',
    );
    g('add', '.');
    g('commit', '-q', '-m', 'arch: close cycle 9');
    const baseSha = g('rev-parse', 'HEAD');

    // Add a red reference test and an audit.json with a rejected blocker + a WAIVER + an eval proof without .agent-runs/evals/ (NOT VERIFIED)
    writeFileSync(
      path.join(root, 'tests', 'red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n',
    );
    const evalLine = 'ev' + 'al 2026-10-30T15-00-00-000Z @ abcdef0: 5/5 PA' + 'SS';
    writeFileSync(
      path.join(root, 'PLAN.md'),
      [
        '# PLAN',
        `Proof: ${evalLine}`,
        '',
        '## Decisions (ADR)',
        '- ADR-001: Base',
        '- WAIVER 1111111: fix-frozen — historical fix',
        '- A-1 [blocker]: отклонено: intentional design',
        '',
        '## Frozen',
        '- `EXECUTOR.md`',
        '- `tests/red.test.mjs`',
        '',
        '## Задачи',
        '- [ ] T-045: Feature',
        '  - Риск: высокий.',
        '  - Зависит от: —.',
        '  - Менять: `src/a.mjs`.',
        '  - Тест-кейсы: `tests/red.test.mjs`.',
        '  - Проверка: `node --test tests/red.test.mjs`.',
      ].join('\n') + '\n',
    );
    const auditDir = path.join(root, '.agent-runs', 'audits', '2026-10-30T15-00-00-000Z');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      path.join(auditDir, 'audit.json'),
      JSON.stringify({
        cycleBaseSha: baseSha,
        baseSha,
        headSha: baseSha,
        model: 'claude-sonnet-4',
        findings: [
          { id: 'A-1', severity: 'blocker', category: 'frozen_tests', file: 'tests/red.test.mjs', summary: 'Check A-1', recommendation: 'Fix' },
        ],
        summary: '1 blocker',
      }, null, 2),
    );
    g('add', 'PLAN.md', 'tests/red.test.mjs');
    g('commit', '-q', '-m', 'arch: plan Cycle 10');

    const fast = runFastSelfCheck({ realGit, workDir: root, config: orchCfg });
    assert.equal(fast.ok, true, `fast self-check must pass: ${fast.violations.join('; ')}`);
    assert.equal(fast.waivers.length, 1);
    assert.equal(fast.rejectedBlockers.length, 1);
    assert.ok(fast.notVerified.length >= 1, 'missing .agent-runs/evals/ must produce NOT VERIFIED');

    const notices = formatStartupNotices(fast);
    assert.ok(notices.some((l) => /WAIVER 1111111/.test(l)));
    assert.ok(notices.some((l) => /A-1/.test(l)));

    const full = runFullSelfCheck({ realGit, workDir: root, config: orchCfg });
    assert.equal(full.ok, true, `full self-check with red test must pass: ${full.violations.join('; ')}`);
    assert.equal(full.redCheck.checked.length, 1);
    assert.match(formatSelfCheckReport(full), /NOT VERIFIED/);

    // CLI invocation of run.mjs --self-check on valid (with NOT VERIFIED) exits 0
    const runMjs = path.join(orchDir, 'run.mjs');
    const cliOk = spawnSync(process.execPath, [runMjs, '--self-check'], {
      cwd: root,
      env: { ...process.env, AGENT_LOOP: '' },
      encoding: 'utf8',
    });
    assert.equal(cliOk.status, 0, `expected exit 0 on NOT VERIFIED only, got ${cliOk.status}: ${cliOk.stdout}\n${cliOk.stderr}`);

    // Now make the reference test pass (green before implementation) -> CLI --self-check must exit 1!
    writeFileSync(
      path.join(root, 'tests', 'red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("green", () => { assert.equal(1, 1); });\n',
    );
    const cliFail = spawnSync(process.execPath, [runMjs, '--self-check'], {
      cwd: root,
      env: { ...process.env, AGENT_LOOP: '' },
      encoding: 'utf8',
    });
    assert.equal(cliFail.status, 1, 'CLI --self-check must exit with code 1 on VIOLATION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-049: run.mjs delegates parseArgs to cli.mjs, both files stay <= 400 lines, and temp repo fixture documents --self-check, --audit-plan, and cross-Node test command', () => {
  const { root } = initTempRepo('s10-t049-agents-');
  try {
    const runText = readFileSync(path.join(orchDir, 'run.mjs'), 'utf8');
    const cliText = readFileSync(path.join(orchDir, 'cli.mjs'), 'utf8');
    writeFileSync(
      path.join(root, 'AGENTS.md'),
      '# Rules\nCommands: `npm run agents` (`--self-check`, `--audit-plan`) and `node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs`.\n',
    );
    const agentsText = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

    assert.equal(/function\s+parseArgs\s*\(/.test(runText), false, 'parseArgs must be moved out of run.mjs into cli.mjs');
    assert.ok(runText.split('\n').length <= 400, `run.mjs must stay <= 400 lines (got ${runText.split('\n').length})`);
    assert.ok(cliText.split('\n').length <= 400, `cli.mjs must stay <= 400 lines (got ${cliText.split('\n').length})`);

    assert.match(agentsText, /--self-check/);
    assert.match(agentsText, /--audit-plan/);
    assert.ok(
      agentsText.includes('node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs'),
      'AGENTS.md fixture must use the Node 22+ compatible node --test glob form',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-112: parseArgs parses --stop (default false) and keeps it exclusive with the other modes', () => {
  assert.equal(parseArgs(['--stop']).stop, true);
  assert.equal(parseArgs([]).stop, false);
  assert.throws(() => parseArgs(['--stop', '--check']), /only one/i);
});

test('T-112: the --stop dispatch with no running loop prints "no running loop" and exits with code 1', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 't112-stop-')));
  try {
    const dispatchUrl = new URL('./cli-dispatch.mjs', import.meta.url).href;
    const script = `import { dispatchCliSubcommand } from ${JSON.stringify(dispatchUrl)};
const sub = await dispatchCliSubcommand({ opts: { stop: true }, configPath: 'unused', realGit: 'git', cwd: ${JSON.stringify(root)}, loadConfig: () => ({ paths: {}, workDir: ${JSON.stringify(root)} }) });
if (!sub.handled) process.exitCode = 2;`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /no running loop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
