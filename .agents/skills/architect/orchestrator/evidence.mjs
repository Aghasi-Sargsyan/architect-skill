// Eval evidence verification and referenceTests red-check.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git, commitsSince } from './git.mjs';
import { runTaskVerification } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';
import { splitDiffByFiles } from './selfcheck.mjs';

const COUNTER_RE = /\b\d+\/\d+\s+PASS\b/;
const EVAL_KEYWORD_RE = /(?:\b(?:evals?|live)\b|замер)/i;
const VALID_EVAL_RE = /\beval\s+(20\d{2}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\s+@\s+([0-9a-fA-F]{7,40}):\s*(\d+\/\d+)\s+PASS\b/g;

function isPlanFile(file) {
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm === 'PLAN.md' || norm === '.architect/PLAN.md') return true;
  if ((norm.startsWith('docs/plans/') || norm.startsWith('.architect/plans/')) && norm.endsWith('.md')) return true;
  return false;
}

function hasUnanchoredEvalCounter(str) {
  if (!COUNTER_RE.test(str) || !EVAL_KEYWORD_RE.test(str)) return false;
  const stripped = str.replace(new RegExp(VALID_EVAL_RE.source, 'g'), '');
  return COUNTER_RE.test(stripped) && EVAL_KEYWORD_RE.test(stripped);
}

function isFileNewOrModifiedSince(realGit, cwd, baseSha, file) {
  const normFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const fullPath = path.join(cwd, normFile);
  if (!existsSync(fullPath)) return false;

  let existedAtBase = false;
  try {
    const treeOut = git(realGit, cwd, ['ls-tree', baseSha, normFile]);
    existedAtBase = treeOut.trim().length > 0;
  } catch {
    existedAtBase = false;
  }

  if (!existedAtBase) {
    return true;
  }

  try {
    const diff = git(realGit, cwd, ['diff', '--name-only', baseSha, '--', normFile]);
    return diff.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Verifies that eval strings in PLAN.md and docs/plans/*.md match results.md
 * and that no unanchored eval counters are introduced in commits or on HEAD.
 */
export function checkEvalEvidence({ realGit, cwd = process.cwd(), baseSha }) {
  const violations = [];
  const notVerified = [];

  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  if (baseSha === headSha) {
    return { ok: true, violations, notVerified };
  }

  const allCommits = commitsSince(realGit, cwd, baseSha);
  const nonExecCommits = allCommits.filter((c) => !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));

  // Check commit messages of non-executor commits
  for (const c of nonExecCommits) {
    if (hasUnanchoredEvalCounter(c.subject)) {
      violations.push(`commit ${c.sha.slice(0, 7)} message has unanchored eval counter: "${c.subject}"`);
    }
  }

  const headFiles = git(realGit, cwd, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const headFileSet = new Set(headFiles);
  const headContentMap = new Map();
  function getHeadContent(file) {
    if (!headContentMap.has(file)) {
      try {
        headContentMap.set(file, git(realGit, cwd, ['show', `HEAD:${file}`]));
      } catch {
        headContentMap.set(file, null);
      }
    }
    return headContentMap.get(file);
  }

  const addedLinesOnHead = [];
  for (const c of nonExecCommits) {
    const diff = git(realGit, cwd, ['show', c.sha]);
    for (const fileDiff of splitDiffByFiles(diff)) {
      if (!isPlanFile(fileDiff.file)) continue;
      if (!headFileSet.has(fileDiff.file)) continue;
      const headContent = getHeadContent(fileDiff.file);
      if (!headContent) continue;
      for (const hunk of fileDiff.hunks) {
        for (const line of hunk) {
          if (!line.trim()) continue;
          if (headContent.includes(line)) {
            addedLinesOnHead.push({ file: fileDiff.file, line });
          }
        }
      }
    }
  }

  // Check unanchored counters on HEAD
  for (const { file, line } of addedLinesOnHead) {
    if (hasUnanchoredEvalCounter(line)) {
      violations.push(`unanchored eval counter in ${file} on HEAD: "${line.trim()}"`);
    }
  }

  // Collect and verify valid eval proof lines on HEAD
  const validProofs = [];
  for (const { file, line } of addedLinesOnHead) {
    const matches = [...line.matchAll(new RegExp(VALID_EVAL_RE.source, 'g'))];
    for (const m of matches) {
      validProofs.push({ file, runId: m[1], sha7: m[2], expectedXY: m[3] });
    }
  }

  const evalsDir = path.join(cwd, '.agent-runs', 'evals');
  const hasEvalsDir = existsSync(evalsDir);
  const checkedProofs = new Set();

  for (const { file, runId, sha7, expectedXY } of validProofs) {
    const proofKey = `${runId}:${sha7}:${expectedXY}`;
    if (checkedProofs.has(proofKey)) continue;
    checkedProofs.add(proofKey);

    if (!hasEvalsDir) {
      notVerified.push(`eval run ${runId} cannot be verified: directory .agent-runs/evals does not exist (NOT VERIFIED)`);
      continue;
    }

    const resultsFile = path.join(evalsDir, runId, 'results.md');
    if (!existsSync(resultsFile)) {
      violations.push(`missing results.md for eval run ${runId} at ${resultsFile}`);
      continue;
    }

    const resultsContent = readFileSync(resultsFile, 'utf8');

    // Check Total: X passed ... (total: Y) or Итого:
    let actualPassed = null;
    let actualTotal = null;
    const totalEn = resultsContent.match(/^Total:\s*(\d+)\s+passed[^\n]*\(total:\s*(\d+)\)/im);
    if (totalEn) {
      actualPassed = totalEn[1];
      actualTotal = totalEn[2];
    } else {
      const totalRu = resultsContent.match(/^Итого:\s*(\d+)[^\n]*?(?:\/|\(всего:\s*|из\s*)(\d+)/im);
      if (totalRu) {
        actualPassed = totalRu[1];
        actualTotal = totalRu[2];
      }
    }

    if (actualPassed === null || actualTotal === null) {
      violations.push(`eval run ${runId} results.md missing Total summary line`);
    } else {
      const actualXY = `${actualPassed}/${actualTotal}`;
      if (actualXY !== expectedXY) {
        violations.push(`eval run ${runId} results mismatch: expected ${expectedXY} but results.md recorded ${actualXY}`);
      }
    }

    // Check Commit: <sha> line
    const commitMatch = resultsContent.match(/^Commit:\s*(.+)$/im);
    if (!commitMatch) {
      notVerified.push(`eval run ${runId} legacy results.md without Commit: line (NOT VERIFIED)`);
    } else {
      const commitVal = commitMatch[1].trim();
      if (/\(dirty\)/i.test(commitVal)) {
        notVerified.push(`eval run ${runId} recorded with dirty commit "${commitVal}" (NOT VERIFIED)`);
      } else {
        const commitSha = commitVal.split(/\s+/)[0];
        if (!commitSha.toLowerCase().startsWith(sha7.toLowerCase()) && !sha7.toLowerCase().startsWith(commitSha.toLowerCase())) {
          violations.push(`eval run ${runId} commit mismatch: expected sha ${sha7} but results.md recorded ${commitSha}`);
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    notVerified,
  };
}

/**
 * Runs reference tests for open high-risk tasks before Executor runs (red-check).
 */
export function runRedCheck({ realGit, cwd = process.cwd(), baseSha, plan, config = {}, env = process.env }) {
  const commits = commitsSince(realGit, cwd, baseSha);
  const execCommit = commits.find((c) => /^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));
  if (execCommit) {
    return {
      ok: true,
      skipped: true,
      reason: `Executor commit present in range (${execCommit.subject}): red-check skipped`,
      violations: [],
      checked: [],
    };
  }

  let parsedPlan = plan;
  if (!parsedPlan) {
    try {
      parsedPlan = parsePlan(readFileSync(path.join(cwd, 'PLAN.md'), 'utf8'));
    } catch {
      try {
        parsedPlan = parsePlan(git(realGit, cwd, ['show', 'HEAD:PLAN.md']));
      } catch {
        parsedPlan = { tasks: [], frozen: [] };
      }
    }
  }

  const isHighRisk = (r) => /^(?:high|высокий)$/i.test(String(r ?? '').trim());
  const highRiskTasks = (parsedPlan.tasks ?? []).filter((t) => !t.done && isHighRisk(t.risk));

  const checked = [];
  const violations = [];
  const seenFiles = new Set();

  for (const task of highRiskTasks) {
    for (const file of task.referenceTests ?? []) {
      const normFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
      if (seenFiles.has(normFile)) continue;
      seenFiles.add(normFile);

      if (!isFileNewOrModifiedSince(realGit, cwd, baseSha, normFile)) {
        continue;
      }

      const synthTask = {
        id: task.id,
        verifyCommands: [`node --test ${normFile}`],
      };
      const res = runTaskVerification({
        task: synthTask,
        workDir: cwd,
        env,
        config,
      });

      if (res.kind === 'disallowed') {
        violations.push(`reference test ${normFile} command disallowed: ${res.reason}`);
      } else if (res.kind === 'timeout') {
        violations.push(`reference test ${normFile} timed out`);
      } else if (res.ok || res.kind === 'passed') {
        violations.push(`reference test ${normFile} passed with exit 0 (green before implementation) — expected red`);
      } else {
        const output = res.outputTail ?? '';
        if (/ERR_MODULE_NOT_FOUND/.test(output)) {
          violations.push(`reference test ${normFile} failed to load (ERR_MODULE_NOT_FOUND): ${output.slice(-200)}`);
        } else if (/SyntaxError/.test(output)) {
          violations.push(`reference test ${normFile} has syntax error (SyntaxError): ${output.slice(-200)}`);
        } else {
          checked.push({
            file,
            status: 'red',
            exitCode: res.exitCode ?? 1,
            outputTail: res.outputTail,
          });
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    skipped: false,
    violations,
    checked,
  };
}
