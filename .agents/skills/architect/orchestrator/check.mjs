// `--check`: is this machine and project ready for the loop? Runs no task.
// Prints no absolute paths, tokens or personal settings: only names, versions and counts.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitRaw, head, isIgnored, porcelain } from './git.mjs';
import { checkParallelTasks, matchesFrozenPath, nextTask, parsePlan, readPlan, resolveModel } from './plan.mjs';
import { DEFAULTS, RUNS_DIR } from './config.mjs';
import { isAlwaysFrozenFile, isSkillAtWorkDirRoot, resolveInstalledSkillDir, resolveLayout } from './layout.mjs';
import { acquireLock, defaultSandboxRoot, installGuards, lockHolder } from './guards.mjs';
import { findExecutable, readEvents } from './events.mjs';
import { getAdapter } from './adapters/index.mjs';
import { agySettingsPath } from './permissions.mjs';
import { checkCommitMsgHook, checkExecutorModelConfig, resolveExecutorModelInfo } from './hooks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_NODE = 22;
const MIN_GIT = [2, 31]; // `rev-parse --path-format=absolute` in the git shim

const probePrompt = (file) => `This is an orchestrator permission probe, not a task: do not read PLAN.md or EXECUTOR.md, do not modify other files.\n1. Run exactly two commands in terminal in sequence: "git status --short" and "git rev-parse --short HEAD". Do not run any other commands.\n2. Using your file writing tool (not terminal), create file ${file} with a single line: one\n3. Using your file editing tool, replace one with two in this file.\nFinal answer — strictly following JSON schema: git_status, rev_parse, write and edit — "ok" if step succeeded, "denied" if permissions blocked it, otherwise "failed"; note — one line about what went wrong, or empty string.`;

const insideRoot = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);

/** Resolves the runner binary (absolute path or a name on PATH); null if missing or not executable. */
export function findBinary(bin, envPath = process.env.PATH) {
  return findExecutable(bin, envPath);
}

/**
 * Verifies skill installation layout, EXECUTOR.md copy parity, and AGENTS.md orchestrator command flags.
 * @returns {Array<{ name: string, detail: string }>}
 */
export function checkSkillInstallation({ workDir = process.cwd(), layout = resolveLayout({}), orchestratorDir } = {}) {
  const problems = [];
  if (isSkillAtWorkDirRoot(workDir, orchestratorDir)) {
    problems.push({ name: 'skill directory', detail: 'putting the skill in the repository root is not supported — install it into a subfolder (e.g. .agents/skills/architect/ or .claude/skills/architect/)' });
  }
  const skillDir = resolveInstalledSkillDir(workDir, orchestratorDir);
  if (skillDir && existsSync(path.join(skillDir, 'EXECUTOR.md'))) {
    const projectExecPath = path.join(workDir, layout.executorPath), skillExecPath = path.join(skillDir, 'EXECUTOR.md');
    if (!existsSync(projectExecPath)) problems.push({ name: 'EXECUTOR.md', detail: `${layout.executorPath} not found in working directory (must match skill EXECUTOR.md)` });
    else if (!readFileSync(projectExecPath).equals(readFileSync(skillExecPath))) problems.push({ name: 'EXECUTOR.md', detail: `${layout.executorPath} does not match skill EXECUTOR.md byte-for-byte` });
  }
  const agentsPath = path.join(workDir, 'AGENTS.md');
  if (existsSync(agentsPath) && readFileSync(agentsPath, 'utf8').includes('npm run agents')) {
    const txt = readFileSync(agentsPath, 'utf8');
    if (!txt.includes('--check') || !txt.includes('--self-check')) problems.push({ name: 'AGENTS.md', detail: 'AGENTS.md documents "npm run agents" but is missing --check or --self-check' });
  }
  return problems;
}

/**
 * Resolves whether the loop can resume an escalated task on a matching dirty working tree.
 */
export function resolveEscalationResume({ realGit, workDir, task, layout = null, currentRunDir = null }) {
  const runsDir = path.join(workDir, RUNS_DIR);
  if (!existsSync(runsDir)) return { ok: false, reason: 'no runs directory' };
  const dirs = readdirSync(runsDir).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().filter((d) => {
    const dirPath = path.join(runsDir, d);
    return !(currentRunDir && (dirPath === currentRunDir || path.resolve(dirPath) === path.resolve(currentRunDir))) &&
      (existsSync(path.join(dirPath, 'summary.md')) || existsSync(path.join(dirPath, 'stop.status.txt')));
  });
  if (!dirs.length) return { ok: false, reason: 'no previous runs found' };
  const runDir = path.join(runsDir, dirs.at(-1));

  const events = readEvents(runDir);
  const stopEvt = events.find((e) => e.type === 'run_stopped');
  let isEscalation = false;
  if (stopEvt) {
    isEscalation = (stopEvt.category === 'stop_escalation' || stopEvt.status === 'escalation') && (stopEvt.taskId === task.id || String(stopEvt.stopReason).startsWith(`${task.id}:`));
  } else if (existsSync(path.join(runDir, 'summary.md'))) {
    const sum = readFileSync(path.join(runDir, 'summary.md'), 'utf8');
    isEscalation = sum.includes(`${task.id}: Executor escalation`) || sum.includes(`${task.id}: эскалация`);
  }
  if (!isEscalation) return { ok: false, reason: `last run did not stop on escalation for ${task.id}` };

  const statusPath = path.join(runDir, 'stop.status.txt'), diffPath = path.join(runDir, 'stop.diff');
  if (!existsSync(statusPath) || !existsSync(diffPath)) return { ok: false, reason: 'missing stop.status.txt or stop.diff in last run' };

  const files = readdirSync(runDir);
  const reportFile = files.find((f) => f.startsWith(`${task.id}-`) && f.endsWith('.report.md'));
  if (!reportFile) return { ok: false, reason: `missing escalation report for ${task.id}` };
  const reportText = readFileSync(path.join(runDir, reportFile), 'utf8');

  const curStatus = gitRaw(realGit, workDir, ['status', '--porcelain', '--untracked-files=all']);
  const savedStatus = readFileSync(statusPath, 'utf8');
  const stripRuns = (s) => s.split('\n').filter((l) => !l.includes(RUNS_DIR)).join('\n');
  if (stripRuns(curStatus).trim() !== stripRuns(savedStatus).trim()) return { ok: false, reason: 'working tree status does not match stop.status.txt' };

  const curRawDiff = gitRaw(realGit, workDir, ['diff', 'HEAD']);
  const savedDiff = readFileSync(diffPath, 'utf8');
  const normCurDiff = curRawDiff.endsWith('\n') || !curRawDiff ? curRawDiff : `${curRawDiff}\n`;
  if (normCurDiff !== savedDiff) return { ok: false, reason: 'working tree diff does not match stop.diff' };

  const dirtyLines = stripRuns(curStatus).split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (!dirtyLines.length) return { ok: false, reason: 'working tree is clean' };
  const dirtyFiles = dirtyLines.map((l) => {
    const f = l.trimStart().replace(/^[^\s]+\s+/, '').trim();
    return f.includes(' -> ') ? f.split(' -> ').pop().trim() : f;
  });

  const taskChange = new Set((task.change ?? []).map((p) => p.replace(/^\.\//, '')));
  for (const f of dirtyFiles) {
    if (!taskChange.has(f.replace(/^\.\//, ''))) return { ok: false, reason: `dirty file "${f}" is outside task Change list` };
  }
  const planPath = path.join(workDir, layout?.planPath ?? 'PLAN.md');
  const planFrozen = existsSync(planPath) ? (parsePlan(readFileSync(planPath, 'utf8')).frozen ?? []) : [];
  for (const f of dirtyFiles) {
    const norm = f.replace(/^\.\//, '');
    if (matchesFrozenPath(norm, planFrozen) || isAlwaysFrozenFile(norm, { workDir })) return { ok: false, reason: `dirty file "${f}" is in Frozen` };
  }
  return { ok: true, taskId: task.id, runDir, reportText };
}

/**
 * Checks that need no model: OS, Node, git, repository, PLAN.md, ignore rule, clean tree, permissions mode.
 * @returns {Array<{ ok: boolean, name: string, detail: string }>}
 */
export function localChecks({ config, workDir, realGit, platform = process.platform, nodeVersion = process.versions.node, orchestratorDir, only = null }) {
  const out = [];
  const add = (ok, name, detail) => out.push({ ok, name, detail });
  add(platform !== 'win32', 'OS', platform === 'win32' ? 'Windows is not supported (git/npm wrappers are sh scripts)' : platform === 'linux' ? 'linux (untested, use at your own risk — officially supported: macOS)' : platform);
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  add(nodeMajor >= MIN_NODE, 'Node.js', `v${nodeVersion}${nodeMajor >= MIN_NODE ? '' : ` — requires ${MIN_NODE}+`}`);
  const gv = git(realGit, workDir, ['--version']).match(/(\d+)\.(\d+)/);
  const gitOk = Boolean(gv) && (Number(gv[1]) > MIN_GIT[0] || (Number(gv[1]) === MIN_GIT[0] && Number(gv[2]) >= MIN_GIT[1]));
  add(gitOk, 'git', gv ? `${gv[1]}.${gv[2]}${gitOk ? '' : ` — requires ${MIN_GIT.join('.')}+`}` : 'version not recognized');

  const inside = spawnSync(realGit, ['rev-parse', '--is-inside-work-tree'], { cwd: workDir, encoding: 'utf8' });
  const repo = inside.status === 0 && inside.stdout.trim() === 'true';
  add(repo, 'git repository', repo ? path.basename(workDir) : 'working directory is not in a git repository');
  if (!repo) return out;

  const layout = config?.paths ?? resolveLayout({ config });

  if (!existsSync(path.join(workDir, layout.planPath))) add(false, 'PLAN.md', 'not found in working directory');
  else {
    const planText = readFileSync(path.join(workDir, layout.planPath), 'utf8');
    const plan = parsePlan(planText);
    const open = plan.tasks.filter((t) => !t.done);
    add(plan.tasks.length > 0, 'PLAN.md', plan.tasks.length
      ? `tasks ${plan.tasks.length}, open ${open.length}, Frozen ${plan.frozen.length}`
      : 'no tasks matching "- [ ] T-NNN: …" — check template format in SKILL.md');
    const noChange = open.filter((t) => t.change.length === 0).map((t) => t.id);
    if (open.length) add(noChange.length === 0, 'Change («Менять») field', noChange.length ? `empty for ${noChange.join(', ')}` : 'present for all open tasks');
    const hasExecutor = existsSync(path.join(workDir, layout.executorPath));
    const hasFrozenHeading = /^##\s+(frozen\b|заморожен)/im.test(planText);
    if ((hasExecutor || hasFrozenHeading) && !plan.frozen.includes(layout.executorPath) && !plan.frozen.includes('EXECUTOR.md')) {
      add(false, 'Frozen', `section ## Frozen is missing ${layout.executorPath}`);
    }
    for (const p of checkParallelTasks(plan)) add(false, 'parallel tasks', p);
  }
  for (const p of checkSkillInstallation({ workDir, layout, orchestratorDir })) add(false, p.name, p.detail);
  const modelInfo = resolveExecutorModelInfo({ workDir, config });
  for (const p of checkExecutorModelConfig({ workDir, config })) {
    if (p.name !== 'Executor model') add(false, p.name, p.detail);
  }
  add(modelInfo.ok, 'Executor model', modelInfo.detail);
  const ignored = isIgnored(realGit, workDir, `${RUNS_DIR}/`);
  add(ignored, `${RUNS_DIR}/ in .gitignore`, ignored ? 'yes' : 'no — run with --init');
  for (const rel of ['.architect/config.local.json', '.agents/orchestrator.local.json']) {
    if (existsSync(path.join(workDir, rel))) {
      const ign = isIgnored(realGit, workDir, rel);
      add(ign, `${rel} in .gitignore`, ign ? 'yes' : 'no — local config must be gitignored');
    }
  }
  const dirty = porcelain(realGit, workDir);
  let treeOk = !dirty;
  let treeDetail = dirty ? `changes: ${dirty.split('\n').length} — loop starts only with a clean tree` : 'yes';
  if (dirty) {
    const planFile = path.join(workDir, layout.planPath);
    if (existsSync(planFile)) {
      const plan = parsePlan(readFileSync(planFile, 'utf8'));
      const curTask = nextTask(plan, only);
      if (curTask) {
        const res = resolveEscalationResume({ realGit, workDir, task: curTask, layout });
        if (res.ok) { treeOk = true; treeDetail = `resuming ${curTask.id} after escalation (matches stop snapshot)`; }
      }
    }
  }
  add(treeOk, 'clean working tree', treeDetail);
  const skipOk = config.permissions !== 'skip' || insideRoot(workDir, defaultSandboxRoot());
  add(skipOk, 'permissions', skipOk ? config.permissions : '"skip" is allowed only in sandbox within temporary directory');
  return out;
}

/**
 * Checks against the runner: binary, `agy models`, configured models and the open tasks' «Модель».
 * @returns {Array<{ ok: boolean, name: string, detail: string }>}
 */
export function runnerChecks({ config, workDir, env = process.env }) {
  const out = [];
  const add = (ok, name, detail) => out.push({ ok, name, detail });
  const adapter = getAdapter(config);
  const runnerBin = adapter.resolveBin(config);
  const bin = findBinary(runnerBin);
  add(Boolean(bin), `runner ${path.basename(runnerBin)}`, bin ? 'found' : `not found in PATH — install ${adapter.displayName} or specify ${adapter.name === 'agy' ? 'agyBin' : 'runnerBin'}`);
  if (config?.auditor) {
    const auditorBin = findBinary('claude', env.PATH);
    add(Boolean(auditorBin), 'auditor claude', auditorBin ? 'found' : 'not found in PATH — install claude CLI for plan audit');
  }
  if (!bin) return out;
  let models;
  try {
    models = adapter.listModels({ bin, env });
  } catch (err) {
    add(false, 'model list', err instanceof Error ? err.message : String(err));
    return out;
  }
  add(true, 'model list', `models ${models.length}`);
  for (const role of ['executor', 'architect']) {
    const id = config[role]?.model;
    const known = Boolean(id) && models.some((m) => m.id === id);
    const detail = !id ? `not set in config — choose a model from "${path.basename(runnerBin)} models"` : (known ? id : `${id} is not in "${path.basename(runnerBin)} models"`);
    add(known, `${role}.model`, detail);
  }
  const layout = config?.paths ?? resolveLayout({ config });
  if (existsSync(path.join(workDir, layout.planPath))) {
    for (const t of readPlan(workDir, layout.planPath).tasks.filter((x) => !x.done && x.model)) {
      const id = resolveModel(t.model, models);
      add(Boolean(id), `${t.id}: Model`, id ?? `"${t.model}" not found — loop will stop before this task`);
    }
  }
  return out;
}

/**
 * One cheap agent turn under the loop's guards: may the agent run the allowlisted commands, create a file
 * and edit it, headless? The file goes to the git-ignored runs directory; write and edit are judged by the file
 * on disk, not by the agent's answer.
 */
export async function probePermissions({ config, workDir, realGit }) {
  const adapter = getAdapter(config);
  const runnerBin = adapter.resolveBin(config);
  const runsDir = path.join(workDir, RUNS_DIR);
  const release = acquireLock(runsDir);
  const dir = path.join(runsDir, `check-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const probeFile = path.join(dir, 'probe-write.txt');
  const guards = installGuards({ workDir, shimDir: path.join(dir, 'shims'), blockedNpmScripts: config.blockedNpmScripts, realGit });
  const name = 'permission probe';
  try {
    const before = head(realGit, workDir);
    const res = await adapter.runAgent({
      bin: findBinary(runnerBin) ?? runnerBin, model: config.executor.model, prompt: probePrompt(path.relative(workDir, probeFile)),
      cwd: workDir, env: guards.env, schemaPath: path.join(here, 'schemas', 'probe.json'), skipPermissions: false, timeoutMs: 10 * 60_000, maxAttempts: 2,
    });
    writeFileSync(path.join(dir, 'probe.result.json'), JSON.stringify(res, null, 2));
    const tampered = guards.verify();
    if (tampered.length) return { ok: false, name, detail: `agent modified guards — ${tampered.join('; ')}`, notes: guards.notes };
    if (!res.ok) return { ok: false, name, detail: res.error, notes: guards.notes };
    const steps = ['git_status', 'rev_parse', 'write', 'edit'];
    const invalid = adapter.validateAnswer(res.json, steps, Object.fromEntries(steps.map((s) => [s, ['ok', 'denied', 'failed']])));
    if (invalid) return { ok: false, name, detail: invalid, notes: guards.notes };
    const written = existsSync(probeFile);
    const edited = written && readFileSync(probeFile, 'utf8').trim() === 'two';
    const untouched = head(realGit, workDir) === before && !porcelain(realGit, workDir);
    const ok = res.json.git_status === 'ok' && res.json.rev_parse === 'ok' && written && edited && untouched;
    const denied = (v) => (v === 'denied' ? ` — no rule in ${adapter.permissions.name}, run with --write-permissions` : '');
    const problems = [
      res.json.git_status !== 'ok' && `git status: ${res.json.git_status}${denied(res.json.git_status)}`,
      res.json.rev_parse !== 'ok' && `git rev-parse: ${res.json.rev_parse}${denied(res.json.rev_parse)}`,
      !written && `file was not created (agent: ${res.json.write}) — requires write_file for project, run with --write-permissions`,
      written && !edited && `file was not edited (agent: ${res.json.edit})`, !untouched && 'agent modified repository', res.json.note && `agent: ${String(res.json.note).slice(0, 200)}`,
    ].filter(Boolean);
    const detail = ok ? `commands, file write, and file edit are allowed (${res.seconds}s)` : problems.join('; ');
    return { ok, name, detail, notes: guards.notes };
  } finally {
    guards.restore();
    release();
  }
}

export const EMPTY_CHANGE = 'Change field is empty or not recognized (paths must be in backticks)';

/**
 * Executor model per task: the task field «Модель» / Model wins over executor.model. `agy models` is read once,
 * only when a task names a model; an unknown model is an error (fail closed). A failed listing throws.
 * @returns {(task: { model: string }) => { model?: string, error?: string }}
 */
export function modelResolver(config, env = process.env) {
  let models = null;
  const adapter = getAdapter(config);
  const runnerBin = adapter.resolveBin(config);
  return (task) => {
    if (task?.executorInfo?.runner && task.executorInfo.runner !== (config.runner ?? 'agy')) {
      const taskEnv = task.executorInfo.env || task.executorInfo.runner;
      return { error: `task assigned to ${taskEnv}, but local runner is ${config.runner ?? 'agy'}` };
    }
    const hasConfigModel = Boolean(config.executor?.model);
    const candidate = task.model || (!hasConfigModel ? task.executorInfo?.model : null);
    if (!candidate) {
      if (!config.executor?.model) return { error: `not set in config — choose a model from "${path.basename(runnerBin)} models"` };
      return { model: config.executor.model };
    }
    models ??= adapter.listModels({ bin: runnerBin, env });
    const id = resolveModel(candidate, models);
    return id ? { model: id } : { error: `model "${candidate}" from Model field not found in "${path.basename(runnerBin)} models"` };
  };
}

/**
 * Can the loop start right now? Everything --check verifies except model calls (no probe), plus the lock and the
 * next task: it exists, has «Менять», and its model resolves. Used by --dry-run, by the loop and by --background
 * before it detaches, so problems reach the person at the prompt.
 * @returns {Array<{ ok: boolean, name: string, detail: string }>}
 */
export function readiness({ config, workDir, realGit, only = null, settingsPath = null, modelFor = null }) {
  const adapter = getAdapter(config);
  const runnerBin = adapter.resolveBin(config);
  const resolvedSettings = settingsPath ?? adapter.permissions.settingsPath(os.homedir(), workDir);
  const modelResolverFn = modelFor ?? modelResolver(config);
  const results = localChecks({ config, workDir, realGit, only });
  const add = (ok, name, detail) => results.push({ ok, name, detail });
  if (config.permissions === 'allowlist') results.push(adapter.permissions.check({ config, settingsPath: resolvedSettings, workDir }));
  const bin = findBinary(runnerBin);
  add(Boolean(bin), `runner ${path.basename(runnerBin)}`, bin ? 'found' : `not found in PATH — install ${adapter.displayName} or specify ${adapter.name === 'agy' ? 'agyBin' : 'runnerBin'}`);
  const holder = lockHolder(path.join(workDir, RUNS_DIR));
  add(holder === null, 'another loop', holder === null ? 'not running' : `already running (pid ${holder})`);
  const layout = config?.paths ?? resolveLayout({ config });
  if (!existsSync(path.join(workDir, layout.planPath))) return results;
  const task = nextTask(readPlan(workDir, layout.planPath), only);
  if (!task) {
    add(false, 'next task', only ? `${only}: no such open task` : 'no open tasks with satisfied dependencies');
    return results;
  }
  add(task.change.length > 0, `${task.id}: Change`, task.change.length ? task.change.join(', ') : EMPTY_CHANGE);
  if (task?.executorInfo?.runner && task.executorInfo.runner !== (config.runner ?? 'agy')) {
    const taskEnv = task.executorInfo.env || task.executorInfo.runner;
    add(false, `${task.id}: Executor model`, `task assigned to ${taskEnv}, but local runner is ${config.runner ?? 'agy'}`);
    return results;
  }
  let chosen;
  try {
    chosen = modelResolverFn(task);
  } catch (err) {
    chosen = { error: err instanceof Error ? err.message : String(err) };
  }
  add(Boolean(chosen.model), `${task.id}: Executor model`, chosen.model ?? String(chosen.error));
  return results;
}

/** Runs every check and prints ✓ / ✗ lines. @returns {Promise<boolean>} true when all passed */
export async function runCheckCommand({ config, workDir, realGit, settingsPath = null, print = console.log }) {
  const adapter = getAdapter(config);
  const resolvedSettings = settingsPath ?? adapter.permissions.settingsPath(os.homedir(), workDir);
  const results = [...localChecks({ config, workDir, realGit })];
  results.push(checkCommitMsgHook({ workDir, realGit }));
  if (config.permissions === 'allowlist') results.push(adapter.permissions.check({ config, settingsPath: resolvedSettings, workDir }));
  results.push(...runnerChecks({ config, workDir }));
  for (const r of results) print(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`);
  const allOk = results.every((r) => r.ok);
  if (config.permissions !== 'allowlist') print('– permission probe: skipped (permissions is not "allowlist")');
  else if (!allOk) print('– permission probe: skipped — fix the ✗ items above first');
  else {
    print('… permission probe: one short Executor run (git status, git rev-parse, file write and edit in .agent-runs/)');
    const probe = await probePermissions({ config, workDir, realGit });
    for (const note of probe.notes) print(`– ${note}`);
    print(`${probe.ok ? '✓' : '✗'} ${probe.name}: ${probe.detail}`);
    return probe.ok;
  }
  return allOk;
}

/**
 * Runs local and runner checks on a directory.
 * @returns {{ ok: boolean, checks: Array<{ ok: boolean, name: string, detail: string }> }}
 */
export function runCheck({ workDir = process.cwd(), home = os.homedir(), config = null, realGit = null }) {
  const rGit = realGit ?? findBinary('git') ?? 'git';
  const cfg = config ?? DEFAULTS;
  const checks = localChecks({ config: cfg, workDir, realGit: rGit });
  const repoCheck = checks.find((c) => (c.name === 'git repository' || c.name === 'git-репозиторий') && c.ok);
  if (repoCheck) {
    try { checks.push(...runnerChecks({ config: cfg, workDir })); } catch { /* ignore */ }
  }
  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

/**
 * Formats check results as human-readable report.
 * @param {{ ok: boolean, checks: Array<{ ok: boolean, name: string, detail: string }> } | Array<{ ok: boolean, name: string, detail: string }>} chk
 * @returns {string}
 */
export function formatCheckReport(chk) {
  const lines = ['=== Environment check ===', ''];
  const checks = Array.isArray(chk) ? chk : (chk?.checks ?? []);
  for (const c of checks) lines.push(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  lines.push('', checks.length > 0 && checks.every((c) => c.ok) ? 'Summary: READY' : 'Summary: NOT READY (fix the [FAIL] items above)');
  return lines.join('\n');
}
