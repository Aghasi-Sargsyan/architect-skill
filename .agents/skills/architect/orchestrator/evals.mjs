// Behavioral prompt evaluation scenarios and workspace-state rubric evaluator.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from './adapters/index.mjs';
import { claudeRulesFor, extractClaudeDeniedStep, writeClaudeAllowlist } from './adapters/claude.mjs';
import { agySettingsPath, proposeRules } from './permissions.mjs';
import { installGuards, which } from './guards.mjs';
import { resumePrompt } from './prompts.mjs';
import {
  EVAL_SCENARIOS,
  initFixtureRepo,
  evaluateScenarioResult,
  defaultSkillDir,
  isWriteDeniedAction,
  runGit,
} from './evals-scenarios.mjs';

export { EVAL_SCENARIOS, initFixtureRepo, evaluateScenarioResult };

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const archSchemaPath = path.join(orchDir, 'schemas', 'architect.json');

function findGitRoot(d) {
  while (d) {
    if (existsSync(path.join(d, '.git'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

const getFileSha = (f) => (!f || !existsSync(f) ? null : createHash('sha256').update(readFileSync(f)).digest('hex'));

/** Formats one evaluation cell result for CLI output. */
export function formatEvalCellLine(r) {
  const attemptsInfo = `[attempts=${r.attempts ?? 1}: ${(r.attemptStatuses ?? [r.status]).join(' -> ')}]`;
  const detail = r.reasons && r.reasons.length ? ` (${r.reasons.join('; ')})` : '';
  return `${r.status} ${r.model} ${r.scenarioId} ${attemptsInfo}${detail}`;
}

/** Writes claude settings for one eval turn at settingsPath (outside workDir). */
export function buildClaudeEvalSettings({ workDir, settingsPath, home = os.homedir(), scenarioId = '', skillDir = defaultSkillDir }) {
  const rules = claudeRulesFor({ allowedCommands: [], blockedScripts: [] }, workDir, home, { skillDir });
  const allow = scenarioId === 'phase1_no_write' ? rules.allow.filter((r) => !r.startsWith('Edit(') && !r.startsWith('Write(')) : rules.allow;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeClaudeAllowlist({ settingsPath, workDir, home, allow, deny: rules.deny, additionalDirectories: rules.additionalDirectories, sandbox: rules.sandbox });
}

async function executeLiveTurn({ scenario, model, workDir, env, home, customPrompt = null, settingsPath = null, conversationId = null }) {
  const runner = model.runner || 'agy';
  const adapter = getAdapter(runner);
  const prompt = customPrompt || scenario.prompt;
  const timeoutMs = 5 * 60_000;
  const common = { bin: adapter.resolveBin({}), model: model.model, prompt, cwd: workDir, schemaPath: archSchemaPath, conversationId, timeoutMs, env, home };
  return adapter.runAgent(runner === 'claude' ? { ...common, settingsPath } : { ...common, skipPermissions: scenario.id !== 'phase1_no_write' });
}

function parseCliOptions(args = process.argv.slice(2)) {
  const models = [];
  const scenarios = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      const raw = args[++i];
      const colon = raw.indexOf(':');
      models.push(colon !== -1 ? { runner: raw.slice(0, colon), model: raw.slice(colon + 1) } : { runner: 'agy', model: raw });
    } else if (args[i] === '--scenario' && args[i + 1]) {
      scenarios.push(args[++i]);
    }
  }
  return { models, scenarios: scenarios.length > 0 ? scenarios : undefined };
}

export async function runLiveEvals({
  env = process.env,
  home = os.homedir(),
  projectDir = null,
  runId = null,
  agySettingsFile = null,
  scenarios = EVAL_SCENARIOS,
  models = [],
  realGit = which('git'),
  maxErrorRetries = 2,
  maxPermissionPrompts = 3,
  runTurn = null,
} = {}) {
  if (env?.AGENT_LOOP === '1') {
    throw new Error('runLiveEvals: runLiveEvals cannot be called from inside the loop (AGENT_LOOP=1)');
  }

  const hostDir = projectDir ?? (findGitRoot(orchDir) || process.cwd());
  const effectiveAgySettings = agySettingsFile ?? agySettingsPath(home);

  const preStatus = runGit(realGit, hostDir, ['status', '--porcelain']);
  if (preStatus === null) throw new Error(`runLiveEvals: git status failed on host repository (${hostDir}) before evals`);
  if (preStatus.length > 0) throw new Error(`runLiveEvals: Host project working tree is not clean (git status is not empty) before evals: ${preStatus}`);
  const preHostHead = runGit(realGit, hostDir, ['rev-parse', 'HEAD']);
  if (!preHostHead) throw new Error(`runLiveEvals: git rev-parse HEAD failed on host repository (${hostDir}) before evals`);

  const agentRunsDir = path.join(hostDir, '.agent-runs');
  mkdirSync(agentRunsDir, { recursive: true });
  const agentRunsGitignore = path.join(agentRunsDir, '.gitignore');
  if (!existsSync(agentRunsGitignore) || !readFileSync(agentRunsGitignore, 'utf8').includes('*')) {
    writeFileSync(agentRunsGitignore, '*\n');
  }
  const effectiveRunId = runId || new Date().toISOString().replace(/[:.]/g, '-');
  const evalRunDir = path.join(agentRunsDir, 'evals', effectiveRunId);
  mkdirSync(evalRunDir, { recursive: true });

  const scenarioList = (scenarios ?? EVAL_SCENARIOS).map((s) => (typeof s === 'string'
    ? (EVAL_SCENARIOS.find((sc) => sc.id === s) ?? { id: s, setupFixture: (d, g) => ({ baseSha: g('rev-parse', 'HEAD') }) })
    : s));

  let modelList = (Array.isArray(models) && models.length > 0 ? [...models] : parseCliOptions().models).map((m) => {
    if (typeof m === 'string') {
      const c = m.indexOf(':');
      return c !== -1 ? { runner: m.slice(0, c), model: m.slice(c + 1) } : { runner: 'agy', model: m };
    }
    return m;
  });
  if (modelList.length === 0) modelList = [{ runner: 'claude', model: 'haiku' }];

  const results = [];
  const maxRetries = Number.isInteger(maxErrorRetries) ? maxErrorRetries : 2;
  const maxPermPrompts = Number.isInteger(maxPermissionPrompts) ? maxPermissionPrompts : 3;

  for (const model of modelList) {
    for (const scenario of scenarioList) {
      let attempts = 0;
      let cellResult = null;
      const allDeniedActions = [];
      const attemptStatuses = [];

      while (attempts <= maxRetries) {
        attempts++;
        const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `eval-${scenario.id}-`)));
        const [workDir, cfgDir, shimDir, sandboxRoot] = ['work', 'cfg', 'shims', 'sandbox'].map((d) => (mkdirSync(path.join(root, d), { recursive: true }), path.join(root, d)));
        const settingsPath = path.join(cfgDir, 'claude-settings.json');

        let guards = null;
        try {
          const { g, baseSha: initBaseSha } = initFixtureRepo(workDir, realGit, env);
          let fixtureState = { baseSha: initBaseSha };
          if (typeof scenario.setupFixture === 'function') {
            const custom = scenario.setupFixture(workDir, g);
            fixtureState = { ...fixtureState, ...custom };
          }
          const baseSha = fixtureState.baseSha || initBaseSha;

          buildClaudeEvalSettings({ workDir, settingsPath, home, scenarioId: scenario.id });

          guards = installGuards({
            workDir,
            shimDir,
            blockedScripts: [],
            sandboxRoot,
            realGit,
          });

          let conversationId = null;
          let currentPrompt = fixtureState.customPrompt ?? scenario.prompt;
          let exhaustedPermissions = false;
          let lastTurnResult = null;
          let lastTurnError = null;

          for (let turn = 0; ; turn++) {
            const turnOpts = {
              scenario,
              model,
              workDir,
              baseSha,
              realGit,
              env: guards.env,
              home,
              settingsPath,
              prompt: currentPrompt,
              customPrompt: currentPrompt,
              conversationId,
              turn,
              ...fixtureState,
            };
            const agyShaBefore = getFileSha(effectiveAgySettings);
            let turnResult = null;
            let turnError = null;
            try {
              if (runTurn) {
                turnResult = await runTurn(turnOpts);
              } else {
                turnResult = await executeLiveTurn(turnOpts);
              }
            } catch (err) {
              turnError = err;
            }
            lastTurnResult = turnResult;
            lastTurnError = turnError;

            if (Array.isArray(turnResult?.deniedActions)) {
              allDeniedActions.push(...turnResult.deniedActions);
            }

            const safeModel = `${model.runner}-${model.model}`.replace(/[^a-zA-Z0-9._-]/g, '_');
            const logEntry = {
              scenarioId: scenario.id,
              model: `${model.runner}:${model.model}`,
              attempt: attempts,
              turn: turn + 1,
              conversationId: turnResult?.conversationId ?? null,
              transcript: turnResult?.transcript ?? null,
              deniedActions: turnResult?.deniedActions ?? [],
              stdoutTail: turnResult?.stdout != null ? String(turnResult.stdout).slice(-2000) : '',
              stderrTail: turnResult?.stderr != null ? String(turnResult.stderr).slice(-2000) : '',
              ok: Boolean(turnResult?.ok),
              denied: Boolean(turnResult?.denied),
              error: turnError ? (turnError instanceof Error ? turnError.message : String(turnError)) : (turnResult?.error ?? null),
            };
            writeFileSync(path.join(evalRunDir, `${safeModel}-${scenario.id}-attempt${attempts}-turn${turn + 1}.json`), JSON.stringify(logEntry, null, 2));

            const guardProblems = guards.verify();
            if (guardProblems?.length) throw new Error(`runLiveEvals: guard violations after turn: ${guardProblems.join('; ')}`);
            const postHostStatus = runGit(realGit, hostDir, ['status', '--porcelain']);
            if (postHostStatus === null) throw new Error(`runLiveEvals: git status failed on host repository (${hostDir}) after turn`);
            if (postHostStatus.length > 0) throw new Error(`runLiveEvals: Host project working tree is not clean (git status is not empty) after turn: ${postHostStatus}`);
            const postHostHead = runGit(realGit, hostDir, ['rev-parse', 'HEAD']);
            if (postHostHead !== preHostHead) throw new Error(`runLiveEvals: Host repository HEAD changed during turn (${preHostHead} -> ${postHostHead})`);
            if (getFileSha(effectiveAgySettings) !== agyShaBefore) throw new Error(`runLiveEvals: agy settings file (${effectiveAgySettings}) changed after turn (settings.json modified)`);

            if (turnResult?.denied === true) {
              const step = turnResult.deniedStep ?? extractClaudeDeniedStep(turnResult.deniedActions ?? []);
              if (!step || !turnResult.conversationId) break;
              if (turn >= maxPermPrompts) {
                exhaustedPermissions = true;
                break;
              }
              conversationId = turnResult.conversationId;
              if (step.kind !== 'command') {
                currentPrompt = resumePrompt('architect', { command: String(step.text ?? '').slice(0, 120), reason: 'action is outside project permissions' });
              } else {
                const proposal = proposeRules(step.command, [], { workDir });
                if (proposal.auto) {
                  currentPrompt = resumePrompt('architect', { command: step.command, reason: proposal.reason, suggestedCommand: proposal.suggestedCommand });
                } else {
                  currentPrompt = resumePrompt('architect', { command: step.command, reason: 'user denied permission (denied by user)' });
                }
              }
            } else {
              break;
            }
          }

          if (exhaustedPermissions) {
            attemptStatuses.push('FAIL');
            cellResult = {
              scenarioId: scenario.id,
              model: `${model.runner}:${model.model}`,
              status: 'FAIL',
              pass: false,
              reasons: [`permission continuations exhausted: permission continuations limit exhausted (${maxPermPrompts})`],
              attempts,
              attemptStatuses,
              deniedActions: allDeniedActions,
              error: null,
            };
            break;
          }

          const hasWriteDenialInPhase1 = (scenario.id === 'phase1_no_write' || scenario.id === 'first_run_no_executor_model') && allDeniedActions.some(isWriteDeniedAction);
          if (hasWriteDenialInPhase1) {
            attemptStatuses.push('FAIL');
            const evalState = {
              workDir,
              realGit,
              baseSha,
              deniedActions: allDeniedActions,
              verdict: lastTurnResult?.verdict ?? lastTurnResult?.json?.verdict,
              json: lastTurnResult?.json,
              raw: lastTurnResult?.raw,
              ...fixtureState,
              ...(lastTurnResult?.stateExtra ?? {}),
            };
            const evaluated = evaluateScenarioResult(scenario.id, evalState);
            cellResult = {
              scenarioId: scenario.id,
              model: `${model.runner}:${model.model}`,
              status: 'FAIL',
              pass: false,
              reasons: evaluated.reasons,
              attempts,
              attemptStatuses,
              deniedActions: allDeniedActions,
              error: null,
            };
            break;
          }

          const isTurnError = Boolean(lastTurnError) || !lastTurnResult || lastTurnResult.ok !== true || !lastTurnResult.json || typeof lastTurnResult.json !== 'object' || Array.isArray(lastTurnResult.json);
          if (isTurnError) {
            attemptStatuses.push('ERROR');
            if (attempts <= maxRetries) continue;
            const errDetail = lastTurnError
              ? (lastTurnError instanceof Error ? lastTurnError.message : String(lastTurnError))
              : (lastTurnResult?.error || (lastTurnResult?.ok ? 'response does not contain valid JSON' : 'turn ended with error'));
            cellResult = {
              scenarioId: scenario.id,
              model: `${model.runner}:${model.model}`,
              status: 'ERROR',
              pass: false,
              reasons: [`model turn error: ${errDetail}`],
              attempts,
              attemptStatuses,
              deniedActions: allDeniedActions,
              error: errDetail,
            };
            break;
          }

          const evalState = {
            workDir,
            realGit,
            baseSha,
            deniedActions: allDeniedActions,
            verdict: lastTurnResult.verdict ?? lastTurnResult.json?.verdict,
            json: lastTurnResult.json,
            raw: lastTurnResult.raw,
            ...fixtureState,
            ...(lastTurnResult.stateExtra ?? {}),
          };
          const evaluated = evaluateScenarioResult(scenario.id, evalState);
          const status = evaluated.pass ? 'PASS' : 'FAIL';
          attemptStatuses.push(status);
          cellResult = {
            scenarioId: scenario.id,
            model: `${model.runner}:${model.model}`,
            status,
            pass: evaluated.pass,
            reasons: evaluated.reasons,
            attempts,
            attemptStatuses,
            deniedActions: allDeniedActions,
            error: null,
          };
          break;
        } finally {
          if (guards) {
            try {
              guards.restore();
            } catch {
              // cleanup: restore guard shims; teardown errors should not mask cell result
            }
          }
          try {
            rmSync(root, { recursive: true, force: true });
          } catch {
            // cleanup: remove cell temporary root and contents (work, cfg, shims, sandbox)
          }
        }
      }

      if (cellResult) {
        results.push(cellResult);
        const [p, f, e] = ['PASS', 'FAIL', 'ERROR'].map((st) => results.filter((r) => r.status === st).length);
        const lines = [
          `# Live evals ${effectiveRunId}`,
          `Commit: ${preHostHead}`,
          ...results.map((r) => formatEvalCellLine(r)),
          `Total: ${p} passed, ${f} failed, ${e} errors (total: ${results.length})`,
          '',
        ];
        writeFileSync(path.join(evalRunDir, 'results.md'), lines.join('\n'));
      }
    }
  }

  const [passed, failed, errors] = ['PASS', 'FAIL', 'ERROR'].map((st) => results.filter((r) => r.status === st).length);
  return { total: results.length, passed, failed, errors, results, runDir: evalRunDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseCliOptions();
  runLiveEvals(opts)
    .then((summary) => {
      for (const r of summary.results) {
        console.log(formatEvalCellLine(r));
      }
      console.log(`Live evals complete: Total: passed=${summary.passed} failed=${summary.failed} errors=${summary.errors} total=${summary.total}`);
      if (summary.failed > 0 || summary.errors > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`Live evals failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
