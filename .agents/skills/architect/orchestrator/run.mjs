// Orchestrator: Executor → mechanical checks → Architect review, one PLAN.md task at a time. Never pushes.
// Usage: node run.mjs [config.json] [--init | --write-permissions | --check | --dry-run | --background] [--pause] [--only T-NNN]
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlan, nextTask } from './plan.mjs';
import { git, head, commitsSince } from './git.mjs';
import { checkExecutorRun, checkArchitectRun, inspectFailedExecutorTurn, runTaskVerification } from './mechanics.mjs';
import { acquireLock, freshShimDir, installGuards, which } from './guards.mjs';
import { installStopHandlers } from './run-lock.mjs';
import { RUNS_DIR } from './config.mjs';
import { resolveConfigPath, reviewFilePath, skillFilePath } from './layout.mjs';
import { EMPTY_CHANGE, UNPARSED_VERIFY, modelResolver, readiness, resolveEscalationResume } from './check.mjs';
import { commandProblem, proposeRules, readAgyRules, realOrResolved } from './permissions.mjs';
import { handleWritePermissionsCli } from './permissions-cli.mjs';
import { dispatchCliSubcommand } from './cli-dispatch.mjs';
import { askPermission, clearQuestion } from './ask.mjs';
import { getAdapter } from './adapters/index.mjs';
import { appendEvent, sendNotification, writeStopReport } from './events.mjs';
import { architectPrompt, executorPrompt, resumePrompt } from './prompts.mjs';
import { parseArgs, nodeVersionProblem, runFastSelfCheck, runFullSelfCheck, formatSelfCheckReport, formatStartupNotices, safeLoadConfig } from './cli.mjs';
import { readCommittedWaivers } from './waivers.mjs';
import { resolveTaskBase, checkTaskRange, checkResumedTask, formatRangeSummary } from './task-range.mjs';
import { checkTestMonotonicity } from './monotonicity.mjs';
import { commitAcceptance } from './accept.mjs';
import { startBackground } from './background.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const nodeErr = nodeVersionProblem(process.versions.node);
  if (nodeErr) throw new Error(nodeErr);
  // An agent inside the loop must not start another loop or touch the permission settings.
  if (process.env.AGENT_LOOP === '1') throw new Error('orchestrator cannot be run from inside the agent loop (AGENT_LOOP=1)');
  const configPath = resolveConfigPath({ workDir: process.cwd(), configPath: opts.configPath, init: opts.init });
  const realGit = which('git', process.env.PATH, { excludeUnder: [process.cwd()] });
  const sub = await dispatchCliSubcommand({
    opts,
    configPath,
    realGit,
    cwd: process.cwd(),
    loadConfig: () => safeLoadConfig(configPath),
    writePermissions: handleWritePermissionsCli,
  });
  if (sub.handled) return;
  const { config, layout, workDir } = sub;
  const adapter = getAdapter(config);
  const runnerBin = adapter.resolveBin(config);
  const { permissions } = config;
  const scanPaths = config.bypassScanPaths;
  const executorModelFor = modelResolver(config);
  const runsDir = path.join(workDir, RUNS_DIR);
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  // Preflight without model calls: the same checks for --dry-run, the loop and --background (before it detaches).
  const ready = readiness({ config, workDir, realGit, only: opts.only, modelFor: executorModelFor });
  const notReady = ready.filter((r) => !r.ok);
  if (opts.dryRun) {
    console.log(`Executor: ${config.executor.model}; Architect: ${config.architect.model}; permissions: ${permissions}`);
    for (const r of ready) console.log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`);
    const sc = runFullSelfCheck({ realGit, workDir, config });
    console.log(formatSelfCheckReport(sc));
    if (!sc.ok) process.exitCode = 1;
    const task = existsSync(path.join(workDir, layout.planPath)) ? nextTask(readPlan(workDir, layout.planPath), opts.only) : null;
    if (task) {
      const preVerify = runTaskVerification({ task, config, validateOnly: true });
      if (!preVerify.ok) {
        console.log(`✗ ${task.id}: Verify: disallowed command "${preVerify.command}" — ${preVerify.reason}`);
        console.log('not ready to start — fix ✗ above');
        process.exitCode = 1;
        return;
      }
    }
    console.log(notReady.length || !sc.ok ? 'not ready to start — fix ✗ above' : 'ready to start');
    if (notReady.length) process.exitCode = 1;
    if (task) {
      let chosen;
      try { chosen = executorModelFor(task); } catch (err) { chosen = { error: err instanceof Error ? err.message : String(err) }; }
      console.log(`\n--- Executor prompt for ${task.id} ---\n${executorPrompt(task, null, chosen.model ?? '<undefined>', layout)}`);
    }
    return;
  }
  if (notReady.length) throw new Error(`not ready to start:\n${notReady.map((r) => `✗ ${r.name}: ${r.detail}`).join('\n')}`);

  const fastSc = runFastSelfCheck({ realGit, workDir, config });
  if (!fastSc.ok) throw new Error(`not ready to start:\n${fastSc.violations.map((v) => `✗ self-check: ${v}`).join('\n')}`);

  if (opts.background) {
    // The detached child gets the same arguments without --background and takes the lock itself.
    const args = process.argv.slice(2).filter((a) => a !== '--background');
    const res = await startBackground({ workDir, runsDir, args, scriptPath: fileURLToPath(import.meta.url), config });
    console.log(res.text);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  const releaseLock = acquireLock(runsDir);
  const runDir = path.join(runsDir, stamp());
  mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, 'run.log');
  const feedFile = path.join(runDir, 'feed.log');
  // feed.log: the orchestrator's milestones and the agents' steps in plain words (--watch, --status, the terminal).
  const feed = (line) => { console.log(line); appendFileSync(feedFile, `${line}\n`); };
  // Local time everywhere: the agents' steps in the feed carry local time too.
  const log = (msg) => {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    console.log(line);
    appendFileSync(logFile, `${line}\n`);
    appendFileSync(feedFile, `${line}\n`);
  };

  const guards = installGuards({ workDir, shimDir: freshShimDir({ workDir }), backupDir: runDir, blockedNpmScripts: config.blockedNpmScripts, realGit });
  for (const note of guards.notes) log(note);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearQuestion(workDir); guards.restore(); releaseLock();
  };
  installStopHandlers({ cleanup });

  // One agent run. A denied command does not end it: unsafe commands get an automatic «no», others are asked
  // about (terminal or --answer); either way the same conversation continues, at most maxPermissionPrompts times.
  const agent = async (role, model, prompt, label, task = null) => {
    const who = role === 'executor' ? 'Executor' : 'Architect';
    const format = adapter.createFormatter({ workDir: realOrResolved(workDir) });
    const taskId = label.split('-').slice(0, 2).join('-');
    let res;
    let conversationId = null;
    let current = prompt;
    for (let turn = 0; ; turn++) {
      const turnLabel = turn ? `${label}-cont${turn}` : label;
      writeFileSync(path.join(runDir, `${turnLabel}.prompt.txt`), current);
      res = await adapter.runAgent({
        bin: runnerBin, model, prompt: current, cwd: workDir, env: guards.env, conversationId,
        schemaPath: path.join(here, 'schemas', `${role}.json`),
        skipPermissions: permissions === 'skip',
        timeoutMs: config.timeoutMinutes * 60_000,
        log: (m) => log(`${turnLabel}: ${m}`),
        onTranscriptRows: (rows) => { for (const line of format(rows)) feed(`${line.slice(0, 8)} ${who}: ${line.slice(9)}`); },
      });
      writeFileSync(path.join(runDir, `${turnLabel}.result.json`), JSON.stringify(res, null, 2));
      if (!res.denied) break;
      const step = res.deniedStep;
      if (!step || !res.conversationId) return { ...res, error: `${res.error} (could not determine rejected command)` };
      if (guards.verify().length) return res; // the caller reports the tampering
      if (turn >= config.maxPermissionPrompts) return { ...res, error: `${res.error} (permission retry limit reached: ${turn})` };
      conversationId = res.conversationId;
      if (step.kind !== 'command') {
        log(`${turnLabel}: permission denied (${step.text.slice(0, 120)}) — agent continues without it`);
        current = resumePrompt(role, { command: step.text.slice(0, 120), reason: 'action is outside project permissions' });
        continue;
      }
      const proposal = proposeRules(step.command, config.blockedNpmScripts, { workDir, allow: readAgyRules(adapter.permissions.settingsPath(os.homedir(), workDir)).allow });
      if (proposal.auto) {
        log(`${turnLabel}: auto-refused "${step.command}" — ${proposal.reason}; agent continues`);
        current = resumePrompt(role, { command: step.command, reason: proposal.reason, suggestedCommand: proposal.suggestedCommand });
        continue;
      }
      const answer = await askPermission({
        question: {
          id: `${turnLabel}-q`, who, taskId, command: step.command, options: proposal.options,
          ...(task?.title ? { taskTitle: task.title } : {}),
          ...(step.reason ? { reason: step.reason } : {}),
        },
        workDir, runDir, rl, tty: Boolean(rl), timeoutMs: config.answerTimeoutMinutes * 60_000, log,
        notify: (t) => { void sendNotification({ config, text: t, eventType: 'question', taskId, role, log }); },
      });
      if (answer === null) return { ...res, error: `no answer to permission question for "${step.command}" within ${config.answerTimeoutMinutes} min` };
      if (answer === '3') {
        log(`${turnLabel}: user denied "${step.command}"; agent continues`);
        current = resumePrompt(role, { command: step.command, reason: 'denied by user' });
        continue;
      }
      const rule = proposal.options.find((o) => o.answer === answer).rule;
      const unsafe = commandProblem(rule, config.blockedNpmScripts); // proposeRules checked it; re-check right before writing
      if (unsafe) return { ...res, error: `rule command(${rule}) rejected: ${unsafe}` };
      const allowRule = adapter.permissions.toAllowRule(rule);
      adapter.permissions.writeAllowlist({ settingsPath: adapter.permissions.settingsPath(os.homedir(), workDir), allow: [allowRule] });
      log(`${turnLabel}: allowed ${allowRule}; agent continues`);
      current = resumePrompt(role, { command: step.command, ruleText: allowRule });
    }
    if (!res.ok) return res;
    const invalid = role === 'executor'
      ? adapter.validateAnswer(res.json, ['task_id', 'status', 'report_markdown'], { status: ['done', 'escalation'] })
      : adapter.validateAnswer(res.json, ['task_id', 'verdict', 'summary'], { verdict: ['accepted', 'rework', 'needs_user'] });
    return invalid ? { ok: false, error: invalid, attempts: res.attempts, seconds: res.seconds } : res;
  };

  const summary = [];
  let stopReason = 'Done: all planned tasks accepted';
  const rl = opts.pause ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    log(`start: ${workDir}; Executor ${config.executor.model}; Architect ${config.architect.model}; permissions ${permissions}`);
    appendEvent(runDir, { type: 'run_started', workDir, executorModel: config.executor.model, architectModel: config.architect.model, permissions });

    const fullSc = runFullSelfCheck({ realGit, workDir, config });
    for (const nv of fullSc.notVerified ?? []) log(`not verified: ${nv}`);
    const startupNotices = formatStartupNotices(fullSc);
    for (const notice of startupNotices) log(notice);
    if (startupNotices.length > 0) summary.push(...startupNotices);

    if (!fullSc.ok) {
      stopReason = `self-check violations: ${fullSc.violations.join('; ')}`;
    } else {
      outer: for (;;) {
        const plan = readPlan(workDir, layout.planPath);
        const task = nextTask(plan, opts.only);
        if (!task) {
          const open = plan.tasks.filter((t) => !t.done);
          if (opts.only) stopReason = `Task --only ${opts.only} not found among uncompleted tasks in ${layout.planPath}`;
          else if (open.length) stopReason = `open tasks blocked by dependencies: ${open.map((t) => t.id).join(', ')}`;
          break;
        }
        // Without Change list every Executor commit would be a violation found only after the commit: stop before any agent runs.
        if (!task.change.length) { stopReason = `${task.id}: ${EMPTY_CHANGE} — fill it in ${layout.planPath}`; break; }
        if (task.unparsedVerify) { stopReason = `${task.id}: ${UNPARSED_VERIFY} — wrap commands in backticks in ${layout.planPath}`; break; }
        const chosen = executorModelFor(task);
        if (chosen.error) { stopReason = `${task.id}: ${chosen.error}`; break; }
        const executorModel = chosen.model;
        const preVerify = runTaskVerification({ task, config, validateOnly: true });
        if (!preVerify.ok) {
          stopReason = `${task.id}: mechanics violation (disallowed Verify command): ${preVerify.command} — ${preVerify.reason}`;
          break outer;
        }
        // The task range (ADR-064) is shared by the resume check, the post-Executor check and the reviewer summary.
        const rangeOpts = { realGit, cwd: workDir, task, frozen: plan.frozen, scanPaths, bypassPatterns: config.bypassRegexps, protectedConfigFiles: config.protectedConfigFiles, testFilePatterns: config.testFilePatterns, configPath, orchestratorDir: here };
        const resumeStop = checkResumedTask(rangeOpts);
        if (resumeStop) {
          writeFileSync(path.join(runDir, `${task.id}-resume.violations.txt`), resumeStop.violations.join('\n'));
          stopReason = resumeStop.text;
          break outer;
        }
        log(`▶ ${task.id} (${task.risk}): ${task.title}; Executor ${executorModel}`);
        appendEvent(runDir, { type: 'task_started', taskId: task.id, risk: task.risk, title: task.title, model: executorModel });
        let rework = null;
        for (let round = 0; ; round++) {
          const execBase = head(realGit, workDir);
          const label = round === 0 ? `${task.id}-exec` : `${task.id}-fix${round}`;
          let promptLayout = layout;
          if (round === 0) {
            const esc = resolveEscalationResume({ realGit, workDir, task, layout, currentRunDir: runDir });
            if (esc.ok) promptLayout = { ...layout, escalationReport: esc.reportText };
          }
          const ex = await agent('executor', executorModel, executorPrompt(task, rework, executorModel, promptLayout), label, task);
          const exTampered = guards.verify();
          if (exTampered.length) { stopReason = `${task.id}: guards were tampered with after Executor — ${exTampered.join('; ')}`; break outer; }
          if (!ex.ok) {
            const postFail = inspectFailedExecutorTurn({ realGit, cwd: workDir, base: execBase, task, frozen: plan.frozen, scanPaths, bypassPatterns: config.bypassRegexps, protectedConfigFiles: config.protectedConfigFiles, configPath });
            if (postFail.hasCommits) {
              log(`  ${postFail.summaryText}`);
              appendEvent(runDir, { type: 'mechanics_checked', taskId: task.id, round, ok: postFail.ok, partial: true, commitsCount: postFail.commits.length, violations: postFail.violations });
              if (postFail.violations.length > 0) writeFileSync(path.join(runDir, `${label}.violations.txt`), postFail.violations.join('\n'));
              stopReason = `${task.id}: Executor failed — ${ex.error} (${postFail.summaryText})`;
            } else stopReason = `${task.id}: Executor failed — ${ex.error}`;
            break outer;
          }
          appendEvent(runDir, { type: 'executor_finished', taskId: task.id, round, ok: true, status: ex.json.status, seconds: ex.seconds, attempts: ex.attempts });
          writeFileSync(path.join(runDir, `${label}.report.md`), String(ex.json.report_markdown));
          log(`  Executor: ${ex.json.status}, ${ex.seconds}s, attempts ${ex.attempts}`);
          if (ex.json.status === 'escalation') { stopReason = `${task.id}: Executor escalation (report ${label}.report.md)`; break outer; }

          const mech = checkExecutorRun({ realGit, cwd: workDir, base: execBase, task, frozen: plan.frozen, scanPaths, bypassPatterns: config.bypassRegexps, protectedConfigFiles: config.protectedConfigFiles, configPath });
          appendEvent(runDir, { type: 'mechanics_checked', taskId: task.id, round, ok: mech.violations.length === 0, commitsCount: mech.commits.length, violations: mech.violations });
          if (mech.violations.length) {
            writeFileSync(path.join(runDir, `${label}.violations.txt`), mech.violations.join('\n'));
            const dirtyCheck = mech.commits.length === 0 ? inspectFailedExecutorTurn({ realGit, cwd: workDir, base: execBase, task, frozen: plan.frozen, scanPaths, bypassPatterns: config.bypassRegexps, protectedConfigFiles: config.protectedConfigFiles, configPath }) : null;
            const canRetryNoCommit = dirtyCheck && round + 1 <= config.maxFixRounds && !dirtyCheck.issues.some((x) => x.includes('Frozen') || x.includes('outside task'));
            if (canRetryNoCommit) {
              log(`  mechanics: recoverable no-commit turn (round ${round + 1}/${config.maxFixRounds}) — requesting rework`);
              rework = { round: round + 1, instructions: `Mechanics check failed before any task commit was created:\n${mech.violations.join('\n')}\nStage and commit only allowed files from Change ("${task.id}: ...") and leave a clean working tree.` };
              continue;
            }
            stopReason = `${task.id}: mechanics violation (attempt ${round + 1}/${config.maxFixRounds}): ${mech.violations.join('; ')}`;
            break outer;
          }
          const taskBase = resolveTaskBase({ realGit, cwd: workDir, taskId: task.id });
          const range = checkTaskRange({ ...rangeOpts, baseSha: taskBase.baseSha });
          if (range.violations.length) {
            writeFileSync(path.join(runDir, `${label}.violations.txt`), range.violations.join('\n'));
            stopReason = `${task.id}: task range violation: ${range.violations.join('; ')} — see references/auto-review.md "Task recovery"`;
            break outer;
          }
          const verifyRes = runTaskVerification({ task, workDir, env: guards.env, config, timeoutMs: config.verifyTimeoutMs });
          if (verifyRes.kind === 'disallowed') {
            const v = `Verify command disallowed: ${verifyRes.command} — ${verifyRes.reason}`;
            writeFileSync(path.join(runDir, `${label}.violations.txt`), v);
            log(`  mechanics: disallowed Verify command — ${verifyRes.command} (${verifyRes.reason})`);
            stopReason = `${task.id}: mechanics violation (disallowed Verify command): ${verifyRes.command} — ${verifyRes.reason}`;
            break outer;
          }
          if (verifyRes.kind === 'failed' || verifyRes.kind === 'timeout') {
            log(`  Verify: ${verifyRes.kind} — ${verifyRes.failedCommand}${verifyRes.timedOut ? ' (timeout)' : ` (exit ${verifyRes.exitCode})`}`);
            appendEvent(runDir, { type: 'verify_checked', taskId: task.id, round, ok: false, kind: verifyRes.kind, command: verifyRes.failedCommand, exitCode: verifyRes.exitCode, timedOut: verifyRes.timedOut });
            if (verifyRes.kind === 'timeout') { stopReason = `${task.id}: Verify timed out (environment): ${verifyRes.failedCommand}`; break outer; }
            if (round + 1 > config.maxFixRounds) {
              stopReason = `${task.id}: rework limit (${config.maxFixRounds}) exhausted`;
              break outer;
            }
            const failDetail = `Verification command failed with exit code ${verifyRes.exitCode}: \`${verifyRes.failedCommand}\``;
            rework = { round: round + 1, instructions: `${failDetail}\nOutput:\n${verifyRes.outputTail}` };
            continue;
          }
          appendEvent(runDir, { type: 'verify_checked', taskId: task.id, round, ok: true, resultsCount: verifyRes.results.length });
          const verifyText = `; Verify passed (${verifyRes.results.map((r) => `\`${r.command}\` (0, ${r.durationMs}ms)`).join(', ') || 'none'})`;
          const mechText = `${formatRangeSummary(range, { scanPaths, bypassPatterns: config.bypassRegexps })}${verifyText}.`;
          log(`  mechanics: ok (${mech.commits.length} commit.); Verify: passed (${verifyRes.results.length})`);

          const reviewHead = head(realGit, workDir);
          const reviewLabel = `${task.id}-review${round}`;
          const ar = await agent('architect', config.architect.model, architectPrompt(task, String(ex.json.report_markdown), mechText, executorModel, { planPath: layout.planPath, reviewPath: reviewFilePath(workDir, here), skillPath: skillFilePath(workDir, here) }), reviewLabel, task);
          const arTampered = guards.verify();
          if (arTampered.length) { stopReason = `${task.id}: guards were tampered with after Architect — ${arTampered.join('; ')}`; break outer; }
          if (!ar.ok) { stopReason = `${task.id}: Architect failed — ${ar.error}`; break outer; }
          const verdict = ar.json.verdict;
          appendEvent(runDir, { type: 'architect_finished', taskId: task.id, round, ok: true, verdict, seconds: ar.seconds, attempts: ar.attempts });
          writeFileSync(path.join(runDir, `${reviewLabel}.summary.md`), String(ar.json.summary));
          log(`  Architect: ${verdict}, ${ar.seconds}s, attempts ${ar.attempts} — ${String(ar.json.summary).slice(0, 160)}`);
          const amech = checkArchitectRun({ realGit, cwd: workDir, expectedHead: reviewHead });
          if (amech.violations.length) { stopReason = `${task.id}: post-review violation — ${amech.violations[0]}`; break outer; }
          if (verdict === 'accepted') {
            // The review is read-only: the orchestrator checks test monotonicity over the whole task range, then marks [x] and commits.
            const mono = checkTestMonotonicity({ realGit, cwd: workDir, baseSha: taskBase.baseSha, config, commits: commitsSince(realGit, workDir, taskBase.baseSha), waivers: readCommittedWaivers({ realGit, cwd: workDir, config }) });
            if (mono.length) { stopReason = `${task.id}: pre-acceptance violation — ${mono[0]}`; break outer; }
            const acc = commitAcceptance({ realGit, cwd: workDir, planPath: layout.planPath, taskId: task.id, expectedHead: reviewHead, commitLanguage: config.commitLanguage });
            if (!acc.ok) { stopReason = `${task.id}: acceptance commit failed — ${acc.error}`; break outer; }
            log(`  acceptance: ${acc.subject} (${acc.sha.slice(0, 7)})`);
          }
          summary.push(`${task.id}: ${verdict}${round ? ` after ${round} rework round(s)` : ''}`);
          if (verdict === 'accepted') break;
          if (verdict === 'needs_user') { stopReason = `${task.id}: Architect requests user decision — ${ar.json.summary}`; break outer; }
          if (round + 1 > config.maxFixRounds) { stopReason = `${task.id}: rework limit (${config.maxFixRounds}) exhausted`; break outer; }
          const issues = Array.isArray(ar.json.issues) ? ar.json.issues.join('\n') : '';
          rework = { round: round + 1, instructions: String(ar.json.rework_instructions || issues) };
          writeFileSync(path.join(runDir, `${reviewLabel}.rework.md`), rework.instructions);
        }
        if (opts.only) { stopReason = `${opts.only}: accepted (--only)`; break; }
        if (rl) {
          const answer = (await rl.question(`${task.id} accepted. Enter — next task, q — stop: `)).trim().toLowerCase();
          if (answer === 'q') { stopReason = `stopped by user after ${task.id}`; break; }
        }
      }
    }
  } catch (err) {
    stopReason = `orchestrator error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    rl?.close();
    try {
      writeStopReport({ realGit, workDir, runDir, stopReason, summary, log });
    } finally {
      // The lock goes last: --watch and --follow read a released lock as «feed.log and summary.md are complete».
      cleanup();
    }
    await sendNotification({ config, text: stopReason, eventType: 'stop', log });
  }
}

main().catch((err) => {
  console.error(`agent-loop: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
