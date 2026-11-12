// Eval evidence verification and referenceTests red-check.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git, commitsSince } from './git.mjs';
import { splitDiffByFiles } from './selfcheck.mjs';

export { runRedCheck } from './red-check.mjs';

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
  const nonExecCommits = allCommits.filter((c) => !c.isMerge && !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));

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
