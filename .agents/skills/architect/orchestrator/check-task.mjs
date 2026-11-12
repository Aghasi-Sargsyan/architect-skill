// `--check-task` core (ADR-064, C-08): checks every commit of one task since its base, outside the loop.
// Pure over its inputs: loads no config and never imports cli.mjs.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git, commitsSince, porcelain, resolveMergeBase, findSquashViolations } from './git.mjs';
import { resolveLayout } from './layout.mjs';
import { checkParallelTasks, parsePlan } from './plan.mjs';
import { checkTaskRange } from './task-range.mjs';
import { resolveBaseShaForTask, scanRangeCommitMessages } from './hooks.mjs';
import { runTaskVerification } from './mechanics.mjs';

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const fail = (violation) => ({ ok: false, violations: [violation], commits: [], headSha: '', headSubject: '', changedFiles: [] });

/**
 * Plan text in its owner state: the newest non-merge `arch: ` commit of the range that touched a plan file,
 * else the base (then the merge-base). Working-tree PLAN.md is read only when git has no plan at all.
 * @returns {{ planText: string|null, layout: object }}
 */
function readOwnerPlan({ realGit, workDir, cfg, commits, baseSha, mergeBase }) {
  let layout = cfg.paths ?? resolveLayout({ config: cfg });
  const candidates = [layout.planPath, 'PLAN.md', '.architect/PLAN.md'];
  const useRel = (ref, rels) => {
    for (const rel of rels) {
      if (!git(realGit, workDir, ['ls-tree', '--full-tree', '--name-only', ref, '--', rel])) continue;
      const text = git(realGit, workDir, ['show', `${ref}:${rel}`]);
      if (text) {
        layout = resolveLayout({ config: { ...cfg, layout: rel.startsWith('.architect') ? 'compact' : 'classic' } });
        return text;
      }
    }
    return null;
  };
  const owner = commits.findLast((c) => !c.isMerge && c.subject.startsWith('arch: ') && c.files.some((f) => candidates.includes(normPath(f))));
  let planText = owner ? useRel(owner.sha, candidates.filter((rel) => owner.files.some((f) => normPath(f) === rel))) : null;
  for (const ref of [baseSha, mergeBase]) {
    if (planText) break;
    planText = useRel(ref, candidates);
  }
  const planFile = path.join(workDir, layout.planPath);
  if (!planText && existsSync(planFile)) planText = readFileSync(planFile, 'utf8');
  return { planText, layout };
}

/**
 * Checks all commits of task `taskId` since the task base (or since `baseRef` via the merge-base).
 * @param {{ realGit: string, workDir: string, config: object, taskId: string, baseRef?: string|null, orchestratorDir?: string }} opts
 * @returns {{ ok: boolean, violations: string[], commits: object[], headSha: string, headSubject: string, changedFiles: string[] }}
 */
export function checkTaskCommits({ realGit, workDir, config: cfg, taskId, baseRef = null, orchestratorDir }) {
  let baseSha;
  try {
    baseSha = resolveBaseShaForTask({ realGit, workDir, taskId, baseRef });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const mergeBase = resolveMergeBase(realGit, workDir, baseSha, 'HEAD');
  const commits = commitsSince(realGit, workDir, mergeBase);

  const { planText, layout } = readOwnerPlan({ realGit, workDir, cfg, commits, baseSha, mergeBase });
  if (!planText) return fail(`${layout.planPath} not found in base ${baseSha}`);
  const plan = parsePlan(planText);
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return fail(`task ${taskId} not found in base ${layout.planPath}`);

  const bypassPatterns = cfg.bypassRegexps ?? (cfg.bypassPatterns ?? []).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  const range = checkTaskRange({
    realGit,
    cwd: workDir,
    task,
    baseSha: mergeBase,
    frozen: plan.frozen,
    scanPaths: cfg.bypassScanPaths,
    bypassPatterns,
    protectedConfigFiles: cfg.protectedConfigFiles,
    testFilePatterns: cfg.testFilePatterns,
    configPath: '',
    orchestratorDir,
  });
  const violations = [...range.violations];

  const status = porcelain(realGit, workDir);
  if (status) violations.push(`working tree is not clean:\n${status}`);
  violations.push(...findSquashViolations({ realGit, cwd: workDir, baseSha: mergeBase, headSha: 'HEAD', commits }));
  if (task.unparsedVerify) {
    violations.push(`${taskId}: Verify field has text without backticks (commands must be in backticks)`);
  }
  violations.push(...checkParallelTasks(plan));
  violations.push(...scanRangeCommitMessages({ realGit, cwd: workDir, baseSha: mergeBase, headSha: 'HEAD', commitLanguage: cfg?.commitLanguage }));

  if (range.taskCommits.length > 0 && violations.length === 0 && (task.verifyCommands ?? []).length > 0) {
    const vRes = runTaskVerification({ task, workDir, config: cfg });
    if (!vRes.ok) {
      violations.push(`verification failed: ${vRes.failedCommand ?? vRes.command ?? 'command'} (${vRes.kind}: ${vRes.outputTail || vRes.reason || 'exit ' + vRes.exitCode})`);
    }
  }

  const taskShas = new Set(range.taskCommits.map((c) => c.sha));
  return {
    ok: violations.length === 0,
    violations,
    commits,
    headSha: range.headSha,
    headSubject: git(realGit, workDir, ['log', '-1', '--format=%s']),
    changedFiles: Array.from(new Set(commits.filter((c) => taskShas.has(c.sha)).flatMap((c) => c.files))),
  };
}
