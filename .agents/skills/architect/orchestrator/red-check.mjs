// Reference-test red-check (ADR-073, C-34): a reference test is red only after a confirmed test-case failure.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git, commitsSince } from './git.mjs';
import { readGitBlob } from './git-read.mjs';
import { runTaskVerification } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';
import { resolveEscalationResume } from './check.mjs';
import { isHighRisk, isExecutableCodeFile, hasStructuralVerificationMarker } from './plan-validate.mjs';

const REPORTER_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'red-check-reporter.mjs')).href;
const REPORTER_PREFIX = 'ARCHITECT_RED_CHECK ';
const NOT_IMPLEMENTED_RE = /not implemented/i;

function isFileNewOrModifiedSince(realGit, cwd, baseSha, file) {
  const normFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const fullPath = path.join(cwd, normFile);
  if (!existsSync(fullPath)) return false;

  const existedAtBase = git(realGit, cwd, ['ls-tree', baseSha, normFile]).trim().length > 0;
  if (!existedAtBase) {
    return true;
  }

  return git(realGit, cwd, ['diff', '--name-only', baseSha, '--', normFile]).trim().length > 0;
}

/** Last reporter line of the output as `{ result, rest }`; `result` is null when absent or not valid JSON. */
function parseReporterResult(output) {
  const lines = output.split('\n');
  const idx = lines.findLastIndex((l) => l.startsWith(REPORTER_PREFIX));
  if (idx < 0) return { result: null, rest: output };
  const rest = lines.filter((_, i) => i !== idx).join('\n');
  try {
    const parsed = JSON.parse(lines[idx].slice(REPORTER_PREFIX.length));
    const valid = Array.isArray(parsed?.caseFailures) && Array.isArray(parsed?.otherFailures);
    return { result: valid ? parsed : null, rest };
  } catch {
    return { result: null, rest };
  }
}

/** 'assertion' | 'not-implemented' | 'error' plus the first failure that makes it 'error'. */
function classifyCaseFailures(caseFailures) {
  const isAssertion = (f) => f.code === 'ERR_ASSERTION';
  const isStub = (f) => NOT_IMPLEMENTED_RE.test(f.message ?? '');
  if (caseFailures.every(isAssertion)) return { failure: 'assertion' };
  const other = caseFailures.find((f) => !isAssertion(f) && !isStub(f));
  if (other) return { failure: 'error', errorName: other.errorName ?? 'Error' };
  return { failure: 'not-implemented' };
}

/** Violation for a non-zero exit that is not a confirmed test-case failure (structured result first, text markers second). */
function unconfirmedViolation(file, result, detail) {
  if (/ERR_MODULE_NOT_FOUND/.test(detail)) return `reference test ${file} failed to load (ERR_MODULE_NOT_FOUND): ${detail.slice(-200)}`;
  if (/SyntaxError/.test(detail)) return `reference test ${file} has syntax error (SyntaxError): ${detail.slice(-200)}`;
  return result === null
    ? `reference test ${file} red not confirmed: no red-check reporter result`
    : `reference test ${file} red not confirmed: failure outside a test case (load error, top-level throw or process.exit)`;
}

/**
 * Runs the reference tests of open high-risk tasks before the Executor runs (red-check).
 * Red is a non-zero exit with at least one failed test case and no failure of the whole file; a custom
 * `redCheckCommand` is red only when `redCheckConfirmPattern` matches its output.
 * @returns {{ ok: boolean, skipped: boolean, reason?: string, violations: string[], notVerified: string[], checked: object[] }}
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
      notVerified: [],
      checked: [],
    };
  }

  let parsedPlan = plan;
  if (!parsedPlan) {
    const planCandidates = [config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean);
    for (const rel of planCandidates) {
      const fullPath = path.join(cwd, rel);
      if (existsSync(fullPath)) {
        parsedPlan = parsePlan(readFileSync(fullPath, 'utf8'));
        break;
      }
      let blob;
      try {
        blob = readGitBlob(realGit, cwd, 'HEAD', rel);
      } catch (err) {
        return {
          ok: false,
          skipped: false,
          violations: [`cannot read ${rel} at HEAD: ${err instanceof Error ? err.message : String(err)}`],
          notVerified: [],
          checked: [],
        };
      }
      if (blob.status === 'ok') {
        parsedPlan = parsePlan(blob.text);
        break;
      }
    }
    if (!parsedPlan) {
      parsedPlan = { tasks: [], frozen: [] };
    }
  }

  for (const t of (parsedPlan.tasks ?? []).filter((task) => !task.done)) {
    const resume = resolveEscalationResume({ realGit, workDir: cwd, task: t, layout: config?.paths });
    if (resume.ok) {
      return {
        ok: true,
        skipped: true,
        reason: `resuming ${t.id} after escalation on dirty working tree: red-check skipped`,
        violations: [],
        notVerified: [],
        checked: [],
      };
    }
  }

  const highRiskTasks = (parsedPlan.tasks ?? []).filter((t) => !t.done && isHighRisk(t.risk));

  const checked = [];
  const violations = [];
  const notVerified = [];
  const seenFiles = new Set();
  const rawCmdTemplate = config?.redCheckCommand ?? 'node --test {file}';
  const cmdTpl = typeof rawCmdTemplate === 'string' ? rawCmdTemplate.trim() : '';
  const isDefaultNodeTest = /^node\s+--test(?:\s+\{file\})?$/.test(cmdTpl);
  const confirmPattern = typeof config?.redCheckConfirmPattern === 'string' ? config.redCheckConfirmPattern : '';
  const notConfirmed = (file, reason) => {
    violations.push(`reference test ${file} red not confirmed: ${reason}`);
    notVerified.push(`reference test ${file}: red not confirmed (NOT VERIFIED)`);
  };

  for (const task of highRiskTasks) {
    if ((task.referenceTests ?? []).length === 0) {
      if ((task.change ?? []).some(isExecutableCodeFile) && !hasStructuralVerificationMarker(task)) {
        notVerified.push(`high-risk task ${task.id} has no frozen referenceTests in PLAN.md (NOT VERIFIED)`);
        violations.push(`high-risk task ${task.id} with executable code in Change has no frozen referenceTests in PLAN.md`);
      }
      continue;
    }
    for (const file of task.referenceTests ?? []) {
      const normFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
      if (seenFiles.has(normFile)) continue;
      seenFiles.add(normFile);

      if (!isFileNewOrModifiedSince(realGit, cwd, baseSha, normFile)) {
        continue;
      }

      if (!cmdTpl || (isDefaultNodeTest && !/\.(?:m|c)?js$/i.test(normFile))) {
        notVerified.push(`reference test ${normFile} red-check skipped: no suitable redCheckCommand configured (NOT VERIFIED)`);
        continue;
      }

      let verifyCmd;
      if (isDefaultNodeTest) {
        verifyCmd = `node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER_URL} --test-reporter-destination=stderr ${normFile}`;
      } else {
        verifyCmd = cmdTpl.includes('{file}')
          ? cmdTpl.replaceAll('{file}', normFile)
          : `${cmdTpl} ${normFile}`;
      }

      const synthTask = {
        id: task.id,
        verifyCommands: [verifyCmd],
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
        const entry = { file, status: 'red', exitCode: res.exitCode ?? 1, outputTail: res.outputTail };
        if (isDefaultNodeTest) {
          const { result, rest } = parseReporterResult(output);
          if (result && result.caseFailures.length > 0 && result.otherFailures.length === 0) {
            const { failure, errorName } = classifyCaseFailures(result.caseFailures);
            checked.push({ ...entry, failure });
            if (failure === 'error') {
              notVerified.push(`reference test ${normFile} is red on ${errorName}, not on an assertion (NOT VERIFIED)`);
            }
          } else {
            const violation = unconfirmedViolation(normFile, result, rest);
            violations.push(violation);
            notVerified.push(`reference test ${normFile}: red not confirmed (NOT VERIFIED)`);
          }
        } else if (!confirmPattern) {
          notConfirmed(normFile, 'redCheckConfirmPattern is not configured for custom redCheckCommand');
        } else {
          let matched = false;
          try {
            matched = new RegExp(confirmPattern, 'm').test(output);
          } catch (err) {
            notConfirmed(normFile, `redCheckConfirmPattern is not a valid regular expression (${err instanceof Error ? err.message : String(err)})`);
            continue;
          }
          if (matched) checked.push({ ...entry, failure: 'pattern' });
          else notConfirmed(normFile, 'output does not match redCheckConfirmPattern');
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    skipped: false,
    violations,
    notVerified,
    checked,
  };
}
