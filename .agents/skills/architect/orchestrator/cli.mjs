// CLI argument parser and orchestration entry points for --self-check and --audit-plan.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { loadConfig, withDefaults, validateConfig, DEFAULTS } from './config.mjs';
import { resolveConfigPath, resolveLayout, CLASSIC_CONFIG_PATH, COMPACT_CONFIG_PATH } from './layout.mjs';
import { effectiveBlockedScripts } from './runners.mjs';
import { runSelfCheckGit } from './selfcheck.mjs';
import { checkEvalEvidence, runRedCheck } from './evidence.mjs';
import { checkAuditCoverage, runPlanAudit } from './audit.mjs';
import { checkSkillInstallation } from './check.mjs';
import { checkParallelTasks, parsePlan } from './plan.mjs';
import { validatePlan } from './plan-validate.mjs';
import { formatMechanicsReport } from './mechanics.mjs';
import { checkTaskCommits } from './check-task.mjs';
import { checkSkillUpdateAvailable } from './update.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

/** Checks whether the Node.js version satisfies the orchestrator requirement (>= 22). */
export function nodeVersionProblem(version = process.versions.node) {
  const raw = String(version ?? '');
  const clean = raw.startsWith('v') ? raw.slice(1) : raw;
  const major = Number(clean.split('.')[0]);
  if (Number.isNaN(major) || major < 22) {
    return `Node v${clean}: the orchestrator requires Node 22+; skill rules and manual Executor handoff work without it`;
  }
  return null;
}

export function parseArgs(argv) {
  const opts = {
    configPath: null, pause: false, only: null, dryRun: false, init: false, check: false, writePermissions: false,
    background: false, answer: null, watch: null, since: null, status: false, follow: false, selfCheck: false, base: null,
    auditPlan: false, checkTask: null, installHooks: false, team: false, update: false, force: false,
    models: false, setModel: null, local: false, compact: false, repair: false, stop: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--pause', '--dry-run', '--init', '--check', '--write-permissions', '--background', '--status', '--follow', '--self-check', '--audit-plan', '--install-hooks', '--update', '--models', '--compact', '--repair', '--stop'].includes(a)) {
      opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (a === '--team') { opts.team = true; } else if (a === '--force') { opts.force = true; } else if (a === '--local') { opts.local = true;
    } else if (a === '--set-model') {
      const role = argv[++i], model = argv[++i];
      if (!role || role.startsWith('--') || !model || model.startsWith('--')) throw new Error('--set-model requires <executor|architect> <model>');
      if (role !== 'executor' && role !== 'architect') throw new Error('--set-model role must be executor or architect');
      opts.setModel = { role, model };
    } else if (a === '--check-task') {
      const next = argv[++i];
      if (!next || !/^T-\d+$/.test(next)) throw new Error('--check-task requires task ID like T-NNN');
      opts.checkTask = next;
    } else if (a === '--base') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error('--base requires a ref argument');
      opts.base = next;
    } else if (a === '--answer') { opts.answer = argv[++i] ?? '';
    } else if (a === '--watch') { opts.watch = /^\d+$/.test(argv[i + 1] ?? '') ? Number(argv[++i]) : 25;
    } else if (a === '--since') { opts.since = /^\d+$/.test(argv[i + 1] ?? '') ? Number(argv[++i]) : -1;
    } else if (a === '--only') { opts.only = argv[++i];
    } else if (a.startsWith('--')) { throw new Error(`unknown flag ${a}`);
    } else { opts.configPath = a; }
  }

  if (opts.only !== null && !/^T-\d+$/.test(opts.only ?? '')) throw new Error('--only expects ID like T-NNN');
  if (opts.team && !opts.init) throw new Error('--team is allowed only with --init');
  if (opts.force && !opts.update) throw new Error('--force is allowed only with --update');
  if (opts.local && !opts.setModel) throw new Error('--local is allowed only with --set-model');
  if (opts.base !== null && !opts.selfCheck && opts.checkTask === null) throw new Error('--base is allowed only with --self-check or --check-task');

  const modeFlags = [opts.init, opts.check, opts.dryRun, opts.writePermissions, opts.background, opts.answer !== null, opts.watch !== null, opts.status, opts.follow, opts.selfCheck, opts.auditPlan, opts.checkTask !== null, opts.installHooks, opts.update, opts.models, opts.setModel !== null, opts.compact, opts.repair, opts.stop];
  if (modeFlags.filter(Boolean).length > 1) {
    throw new Error('--init, --compact, --repair, --stop, --write-permissions, --check, --dry-run, --background, --answer, --watch, --status, --follow, --self-check, --audit-plan, --check-task, --install-hooks, --update, --models, and --set-model: only one per invocation');
  }

  if (opts.answer !== null && !/^[123]$/.test(opts.answer)) throw new Error('--answer expects 1, 2, or 3');
  if (opts.since !== null && (opts.watch === null || opts.since < 0)) throw new Error('--since N requires --watch, N is milestone count from previous output');
  if (opts.background && opts.pause) throw new Error('--background is incompatible with --pause: no interactive terminal in background');

  return opts;
}

export function safeLoadConfig(configPath) {
  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err.message && err.message.includes('unknown field "bypassRegexps"')) {
      let file = path.resolve(configPath);
      if (existsSync(file) && statSync(file).isDirectory()) {
        const compact = path.join(file, '.agents', 'orchestrator.json');
        const classic = path.join(file, '.architect', 'config.json');
        if (existsSync(compact)) file = compact;
        else if (existsSync(classic)) file = classic;
      }
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      delete raw.bypassRegexps;
      const config = withDefaults(raw);
      const problems = validateConfig(config);
      if (problems.length) throw new Error(`config ${configPath}:\n- ${problems.join('\n- ')}`);
      const paths = resolveLayout({ config, configPath });
      const effectiveBlocked = effectiveBlockedScripts(config);
      return {
        ...config,
        runner: config.runner ?? 'agy',
        runnerBin: config.runnerBin ?? (config.runner === 'claude' ? 'claude' : config.agyBin),
        blockedScripts: effectiveBlocked,
        blockedNpmScripts: effectiveBlocked,
        layout: paths.layout,
        paths,
        bypassRegexps: config.bypassPatterns.map((p) => new RegExp(p)),
      };
    }
    throw err;
  }
}

export function loadConfigOrDefaults(configPath, workDir = process.cwd()) {
  const resolved = configPath ?? resolveConfigPath({ workDir });
  try {
    return safeLoadConfig(resolved);
  } catch (err) {
    if (err.message && err.message.includes('missing config')) {
      const hasRoot = existsSync(path.join(workDir, 'PLAN.md')) || existsSync(path.join(workDir, 'EXECUTOR.md'));
      const hasCompact = existsSync(path.join(workDir, '.architect', 'PLAN.md')) || existsSync(path.join(workDir, '.architect', 'EXECUTOR.md'));
      const effectivePath = configPath ?? (hasCompact || !hasRoot ? COMPACT_CONFIG_PATH : CLASSIC_CONFIG_PATH);
      const layout = resolveLayout({ config: DEFAULTS, configPath: effectivePath });
      const effectiveBlocked = effectiveBlockedScripts(DEFAULTS);
      return {
        ...DEFAULTS,
        executor: { ...DEFAULTS.executor, model: '' },
        runner: DEFAULTS.runner ?? 'agy',
        runnerBin: DEFAULTS.runnerBin ?? (DEFAULTS.runner === 'claude' ? 'claude' : DEFAULTS.agyBin),
        blockedScripts: effectiveBlocked,
        blockedNpmScripts: effectiveBlocked,
        layout: layout.layout,
        paths: layout,
        bypassRegexps: (DEFAULTS.bypassPatterns ?? []).map((p) => new RegExp(p)),
        _missingConfigFile: true,
      };
    }
    throw err;
  }
}

export function runFastSelfCheck({ realGit, workDir = process.cwd(), config = null, baseRef = null, orchestratorDir }) {
  const g = realGit ?? which('git');
  const cfg = config ?? safeLoadConfig(resolveConfigPath({ workDir }));
  const gitRes = runSelfCheckGit({ realGit: g, cwd: workDir, config: cfg, baseRef, orchestratorDir });
  const evidenceRes = checkEvalEvidence({ realGit: g, cwd: workDir, baseSha: gitRes.baseSha });
  const auditRes = checkAuditCoverage({ workDir, cycleBaseSha: gitRes.baseSha });
  const layout = cfg?.paths ?? resolveLayout({ config: cfg });
  const installProblems = checkSkillInstallation({
    workDir,
    layout,
    orchestratorDir,
  });
  const planPath = path.join(workDir, layout.planPath);
  let planIssues = [];
  let parallelProblems = [];
  if (existsSync(planPath)) {
    const parsedPlan = parsePlan(readFileSync(planPath, 'utf8'));
    parallelProblems = checkParallelTasks(parsedPlan);
    const pv = validatePlan(parsedPlan, { workDir, layout, config: cfg });
    planIssues = [
      ...pv.parseIssues,
      ...pv.riskIssues,
      ...pv.frozenIssues,
      ...pv.highRiskTestIssues,
    ];
  }

  const violations = [
    ...gitRes.violations,
    ...evidenceRes.violations,
    ...auditRes.violations,
    ...installProblems.map((p) => `${p.name}: ${p.detail}`),
    ...parallelProblems,
    ...planIssues,
  ];
  const notVerified = [...(gitRes.notVerified ?? []), ...(evidenceRes.notVerified ?? [])];
  const waivers = gitRes.waivers ?? [], rejectedBlockers = auditRes.rejectedBlockers ?? [], warnings = gitRes.warnings ?? [];

  return {
    ok: violations.length === 0,
    baseSha: gitRes.baseSha,
    headSha: gitRes.headSha,
    violations,
    warnings,
    notVerified,
    waivers,
    rejectedBlockers,
    hasAudit: auditRes.hasAudit,
    gitRes,
    evidenceRes,
    auditRes,
  };
}

export function runFullSelfCheck({ realGit, workDir = process.cwd(), config = null, baseRef = null, env = process.env, orchestratorDir }) {
  const g = realGit ?? which('git');
  const cfg = config ?? safeLoadConfig(resolveConfigPath({ workDir }));
  const fast = runFastSelfCheck({ realGit: g, workDir, config: cfg, baseRef, orchestratorDir });
  const redCheck = runRedCheck({ realGit: g, cwd: workDir, baseSha: fast.baseSha, config: cfg, env });

  const violations = [...fast.violations, ...(redCheck.violations ?? [])];
  const notVerified = [...fast.notVerified, ...(redCheck.notVerified ?? [])];
  const updateRes = checkSkillUpdateAvailable({ workDir, orchestratorDir, realGit: g, env });
  const updateNotice = updateRes?.updateAvailable ? updateRes.notice : null;

  return {
    ...fast,
    ok: violations.length === 0,
    violations,
    warnings: fast.warnings ?? [],
    notVerified,
    redCheck,
    updateNotice,
  };
}

export function formatSelfCheckReport(res) {
  const lines = [];
  const status = res.ok ? '✓ Self-check PASSED' : '✗ Self-check FAILED';
  const base = res.baseSha ? res.baseSha.slice(0, 7) : 'unknown';
  const head = res.headSha ? res.headSha.slice(0, 7) : 'unknown';
  lines.push(`${status} (${base}..${head})`);
  if (res.updateNotice) lines.push(res.updateNotice.startsWith('! ') ? res.updateNotice : `! ${res.updateNotice}`);

  if (res.violations && res.violations.length > 0) {
    lines.push(`\nViolations (${res.violations.length}):`);
    for (const v of res.violations) lines.push(`  ✗ ${v}`);
  }
  if (res.warnings && res.warnings.length > 0) {
    lines.push(`\nWarnings (${res.warnings.length}):`);
    for (const w of res.warnings) lines.push(`  ! ${w}`);
  }
  if (res.notVerified && res.notVerified.length > 0) {
    lines.push(`\nNOT VERIFIED (${res.notVerified.length}):`);
    for (const nv of res.notVerified) lines.push(`  ? ${nv}`);
  }
  if (res.redCheck) {
    if (res.redCheck.skipped) lines.push(`\nRed-check: skipped (${res.redCheck.reason})`);
    else {
      lines.push(`\nRed-check: ${res.redCheck.checked.length} reference test(s) red`);
      for (const c of res.redCheck.checked) lines.push(`  ✓ ${c.file}`);
    }
  }
  if (res.waivers && res.waivers.length > 0) {
    lines.push(`\nActive WAIVERs (${res.waivers.length}):`);
    for (const w of res.waivers) lines.push(`  • ${w.raw || `${w.sha7}: ${w.rule}`}`);
  }
  if (res.rejectedBlockers && res.rejectedBlockers.length > 0) {
    lines.push(`\nRejected blockers (${res.rejectedBlockers.length}):`);
    for (const b of res.rejectedBlockers) lines.push(`  • ${b.id}: ${b.reason}`);
  }
  return lines.join('\n');
}

export function formatStartupNotices({ waivers = [], rejectedBlockers = [], updateNotice = null } = {}) {
  const notices = [];
  if (updateNotice) notices.push(updateNotice.startsWith('! ') ? updateNotice : `! ${updateNotice}`);
  for (const w of waivers) notices.push(`• Active WAIVER ${w.sha7}: ${w.rule} — ${w.reason}`);
  for (const b of rejectedBlockers) notices.push(`• Rejected audit blocker ${b.id}: ${b.reason || b.finding?.summary || 'rejected'}`);
  return notices;
}

export async function handleSelfCheckCli({ opts = {}, config, workDir = process.cwd(), realGit, env = process.env } = {}) {
  const g = realGit ?? which('git');
  const cfg = config ?? safeLoadConfig(resolveConfigPath({ workDir }));
  const res = runFullSelfCheck({ realGit: g, workDir, config: cfg, baseRef: opts?.base ?? null, env });
  console.log(formatSelfCheckReport(res));
  if (!res.ok) process.exitCode = 1;
  return res;
}

export async function handleAuditPlanCli({ opts = {}, config, workDir = process.cwd(), realGit, env = process.env } = {}) {
  const g = realGit ?? which('git');
  const cfg = config ?? safeLoadConfig(resolveConfigPath({ workDir }));
  try {
    const authorModel = cfg?.architect?.model ?? null;
    const res = await runPlanAudit({
      config: cfg,
      workDir,
      realGit: g,
      authorModel,
      baseRef: opts?.base ?? null,
      env,
    });
    console.log(`• Plan audit completed: ${res.audit.findings.length} findings (${res.audit.summary || 'no summary'})`);
    console.log(`• Report: ${res.auditMdPath}`);
    return res;
  } catch (err) {
    console.error(`✗ Plan audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runCheckTask({ realGit, workDir = process.cwd(), config = null, taskId, baseRef = null, orchestratorDir = orchDir }) {
  const g = realGit ?? which('git');
  const cfg = config ?? loadConfigOrDefaults(null, workDir);
  return checkTaskCommits({ realGit: g, workDir, config: cfg, taskId, baseRef, orchestratorDir });
}

export async function handleCheckTaskCli({ opts = {}, config, configPath, workDir = process.cwd(), realGit, orchestratorDir = orchDir } = {}) {
  const g = realGit ?? which('git');
  const cfg = config ?? loadConfigOrDefaults(configPath ?? opts?.configPath, workDir);
  const res = runCheckTask({ realGit: g, workDir, config: cfg, taskId: opts?.checkTask, baseRef: opts?.base ?? null, orchestratorDir });
  console.log(formatMechanicsReport(res));
  if (!res.ok) process.exitCode = 1;
  return res;
}

export { checkSkillUpdateAvailable, UPDATE_CACHE_TTL_MS, handleUpdateCli } from './update.mjs';
export { handleModelsCli } from './models.mjs';
export { handleCompactCli } from './layout.mjs';
export { handleRepairCli } from './guards-recovery.mjs';
