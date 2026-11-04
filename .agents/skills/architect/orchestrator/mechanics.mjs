// Deterministic checks the orchestrator runs itself, without a model.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, commitsSince, porcelain, resolveMergeBase, findSquashViolations } from './git.mjs';
import { alwaysFrozenFiles, isAlwaysFrozenFile } from './layout.mjs';
import { which } from './guards.mjs';
import { BASE_COMMANDS, commandProblem } from './permissions.mjs';
import { matchesFrozenPath } from './plan.mjs';

function matchesProtectedConfig(file, patterns) {
  if (!patterns || !patterns.length) return false;
  const normalized = file.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return patterns.some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(normalized) || re.test(base);
  });
}

export const DEFAULT_TEST_FILE_PATTERNS = [
  '(?:^|/)tests/',
  '\\.(?:test|spec)\\.[^/]+$',
  '(?:^|/)test_[^/]+\\.py$',
  '(?:^|/)[^/]+_test\\.(?:py|go)$',
];

/**
 * Returns true if filePath matches any testFilePatterns entry.
 * @param {string} filePath
 * @param {Array<string|RegExp>} [patterns]
 * @returns {boolean}
 */
export function isTestFile(filePath, patterns = DEFAULT_TEST_FILE_PATTERNS) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const list = Array.isArray(patterns) && patterns.length > 0 ? patterns : DEFAULT_TEST_FILE_PATTERNS;
  return list.some((p) => (p instanceof RegExp ? p : new RegExp(p)).test(normalized));
}

const PROTO_BYPASS_RE = /(?:prototype|globalThis|__proto__)/;
const TEST_SKIP_ONLY_RE = /\b(?:describe|it|test|suite|context|bench|t)(?:\s*\.\s*(?:concurrent|sequential|todo|shuffle|scoped|serial|each|for))*(?:\s*\([^)]*\))?\s*\.\s*(?:skip|only)\s*\(/;

/**
 * Added lines of a unified diff that match any bypass pattern (config.bypassPatterns).
 * Patterns see the line without its leading "+"; file headers ("+++ b/...") are skipped.
 * Prototype/globalThis/__proto__ mutation patterns are skipped for test files.
 * @param {string} diffText
 * @param {RegExp[]} patterns
 * @param {Array<string|RegExp>} [testFilePatterns]
 * @returns {string[]}
 */
export function findBypasses(diffText, patterns, testFilePatterns) {
  if (!patterns.length) return [];
  const nonProtoPatterns = patterns.filter((re) => !PROTO_BYPASS_RE.test(re.source));

  let activePatterns = patterns;
  const result = [];

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const raw = line.slice(6);
      const tabIdx = raw.indexOf('\t');
      let currentFile = (tabIdx === -1 ? raw : raw.slice(0, tabIdx)).trim();
      if (currentFile.startsWith('"') && currentFile.endsWith('"')) {
        currentFile = currentFile.slice(1, -1);
      }
      activePatterns = isTestFile(currentFile, testFilePatterns) ? nonProtoPatterns : patterns;
      continue;
    }
    if (line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('+')) {
      const added = line.slice(1);
      if (activePatterns.some((re) => (re.source === '\\.(skip|only)\\(' ? TEST_SKIP_ONLY_RE.test(added) : re.test(added)))) {
        result.push(added);
      }
    }
  }

  return result;
}

/**
 * Checks the Executor's work on one task: only `T-NNN:` / `T-NNN (fix N):` commits,
 * files in Change, Frozen untouched, no bypasses in added lines under scanPaths, clean tree.
 */
export function checkExecutorRun(opts) {
  const {
    realGit: rawGit,
    cwd = process.cwd(),
    base,
    baseSha = base,
    task,
    frozen,
    scanPaths: rawScanPaths,
    codePaths,
    bypassPatterns = [],
    protectedConfigFiles = [],
    testFilePatterns = opts.config?.testFilePatterns,
    configPath = '',
    orchestratorDir,
    report,
  } = opts;

  const realGit = rawGit || which('git') || 'git';
  const violations = [];

  if (report) {
    if (report.status !== 'done') violations.push(`Executor status "${report?.status}" !== "done"`);
    if (report.check_passed !== true) violations.push('check_passed !== true in Executor report');
    if (report.self_check !== true) violations.push('self_check !== true in Executor report');
    if (typeof report.retry_count === 'number' && report.retry_count > 2) violations.push(`retry_count=${report?.retry_count} exceeds limit 2`);
  }

  const diffBase = resolveMergeBase(realGit, cwd, baseSha, 'HEAD');
  const commits = commitsSince(realGit, cwd, diffBase);
  const subjectRe = new RegExp(`^${task.id}( \\(fix [0-9]+\\))?: `);
  const taskCommits = commits.filter((c) => !c.isMerge);
  if (taskCommits.length === 0) {
    violations.push('no new commit on HEAD (baseSha === headSha): no task commits found');
  }

  const effectiveFrozen = [...(frozen ?? []), ...alwaysFrozenFiles(configPath, { workDir: cwd, orchestratorDir })];
  const isHighRisk = /^(высокий|high)$/i.test((task.risk ?? '').trim());
  const taskChange = task.change ?? task.changeFiles ?? [];
  const scanPaths = rawScanPaths ?? codePaths ?? [];

  for (const c of commits) {
    if (c.isMerge && c.files.length === 0) continue;
    const short = c.sha.slice(0, 7);
    if (!subjectRe.test(c.subject)) {
      violations.push(`foreign commit ${short}: HEAD commit message "${c.subject}" does not start with "${task.id}:"`);
    }
    if (c.files.length === 0) {
      violations.push(`commit contains no files: ${short}`);
    }
    for (const f of c.files) {
      const nf = f.replace(/\\/g, '/').replace(/^\.\//, '');
      if (nf === 'PLAN.md' || nf === '.architect/PLAN.md') {
        violations.push(`${short} modifies ${f}: task commits must not modify PLAN.md`);
      }
      if (matchesFrozenPath(f, effectiveFrozen) || isAlwaysFrozenFile(f, { configPath, workDir: cwd, orchestratorDir })) {
        violations.push(`${short} touches Frozen — touched Frozen: ${f}`);
      } else {
        if (!isHighRisk && matchesProtectedConfig(f, protectedConfigFiles)) {
          violations.push(`${short} touches verification config outside high-risk task: ${f}`);
        }
        if (!taskChange.includes(f)) {
          violations.push(`${short} touches file outside Change list — outside task "Change" list: ${f}`);
        }
      }
    }
  }

  const status = porcelain(realGit, cwd);
  if (status) {
    violations.push(`working tree is not clean after Executor:\n${status}`);
  }

  if (commits.length && scanPaths.length && bypassPatterns.length) {
    const diff = git(realGit, cwd, ['diff', '-U0', diffBase, 'HEAD', '--', ...scanPaths]);
    for (const added of findBypasses(diff, bypassPatterns, testFilePatterns)) {
      violations.push(`check bypassing in diff (check bypass): ${added.slice(0, 120)}`);
    }
  }

  const squashViolations = findSquashViolations({ realGit, cwd, baseSha: diffBase, headSha: 'HEAD', commits });
  violations.push(...squashViolations);

  const allFiles = new Set(commits.flatMap((c) => c.files));
  if (Array.isArray(task.testFiles) && task.testFiles.length > 0) {
    const missingTests = task.testFiles.filter((tf) => !allFiles.has(tf));
    if (missingTests.length > 0) {
      violations.push(`expected tests from task not touched/created: ${missingTests.join(', ')}`);
    }
  }
  if (task.requireTests) {
    violations.push('high-risk task requires changes in tests or Frozen test-cases');
  }

  let headSha = commits.length > 0 ? commits.at(-1).sha : '';
  let headSubject = commits.length > 0 ? commits.at(-1).subject : '';
  if (!headSha) {
    try { headSha = git(realGit, cwd, ['rev-parse', 'HEAD']); } catch { headSha = ''; }
  }
  if (!headSubject) {
    try { headSubject = git(realGit, cwd, ['log', '-1', '--format=%s']); } catch { headSubject = ''; }
  }
  const changedFiles = Array.from(new Set(commits.flatMap((c) => c.files)));

  return {
    ok: violations.length === 0,
    violations,
    commits,
    headSha,
    headSubject,
    changedFiles,
  };
}

/**
 * Checks the Architect's review: clean tree, new commits only `arch: ...`,
 * and on "accepted" the task still exists in PLAN.md and is marked [x] (no cycle closure).
 */
export function checkArchitectRun({ realGit, cwd, base, task, verdict, plan }) {
  const violations = [];
  const commits = commitsSince(realGit, cwd, base);
  for (const c of commits) {
    if (!c.subject.startsWith('arch: ')) violations.push(`non-arch commit appeared after review: ${c.sha.slice(0, 7)}: "${c.subject}"`);
  }
  const t = plan.tasks.find((x) => x.id === task.id);
  if (!t) {
    violations.push(`${task.id} disappeared from PLAN.md (cycle closure in automated mode is forbidden)`);
  } else if (verdict === 'accepted' && !t.done) {
    violations.push(`verdict is "accepted", but ${task.id} is not marked [x] in PLAN.md`);
  }
  if (verdict === 'accepted' && commits.length === 0) violations.push('verdict is "accepted", but no acceptance commit (arch:)');
  const status = porcelain(realGit, cwd);
  if (status) violations.push(`working tree is not clean after review:\n${status}`);
  return { violations, commits };
}

export function inspectFailedExecutorTurn({
  realGit: rawGit,
  cwd = process.cwd(),
  base,
  baseSha = base,
  task,
  frozen = [],
  scanPaths,
  bypassPatterns,
  protectedConfigFiles = [],
  testFilePatterns,
  config,
  configPath = '',
  orchestratorDir,
}) {
  const realGit = rawGit || which('git') || 'git';
  const commits = commitsSince(realGit, cwd, baseSha);
  const dirtyStatus = porcelain(realGit, cwd);
  const dirtyFiles = dirtyStatus ? dirtyStatus.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : [];

  const issues = [];
  if (dirtyFiles.length > 0) {
    issues.push(`uncommitted changes in working tree: ${dirtyFiles.join(', ')}`);
  }

  const effectiveFrozen = [...(frozen ?? []), ...alwaysFrozenFiles(configPath, { workDir: cwd, orchestratorDir })];
  const taskChange = new Set(task.change ?? task.changeFiles ?? []);

  const touchedFrozen = [];
  const outsideChange = [];
  for (const f of dirtyFiles) {
    if (matchesFrozenPath(f, effectiveFrozen) || isAlwaysFrozenFile(f, { configPath, workDir: cwd, orchestratorDir })) {
      touchedFrozen.push(f);
    } else if (!taskChange.has(f)) {
      outsideChange.push(f);
    }
  }
  if (touchedFrozen.length > 0) {
    issues.push(`touched Frozen: ${touchedFrozen.join(', ')}`);
  }
  if (outsideChange.length > 0) {
    issues.push(`touched files outside task "Change" list: ${outsideChange.join(', ')}`);
  }

  let mechViolations = [];
  if (commits.length > 0) {
    const mech = checkExecutorRun({
      realGit,
      cwd,
      base: baseSha,
      baseSha,
      task,
      frozen,
      scanPaths,
      bypassPatterns,
      protectedConfigFiles,
      testFilePatterns: testFilePatterns ?? config?.testFilePatterns,
      configPath,
      orchestratorDir,
    });
    mechViolations = mech.violations;
    issues.push(...mechViolations);
  }

  const hasCommits = commits.length > 0;
  const ok = hasCommits && mechViolations.length === 0;
  const clean = issues.length === 0;

  const commitDescriptions = commits.map((c) => `${c.sha.slice(0, 7)} "${c.subject}"`);
  const summaryText = ok
    ? `pre-failure commit mechanics: ok (${commits.length} commit(s): ${commitDescriptions.join(', ')})`
    : `pre-failure commit mechanics: violation (${(mechViolations.length > 0 ? mechViolations : issues).join('; ')})`;

  return {
    clean,
    issues,
    hasCommits,
    ok,
    commits,
    violations: mechViolations,
    summaryText: hasCommits ? summaryText : '',
  };
}

export function formatMechanicsReport(mech) {
  const lines = [
    '=== Mechanics check (deterministic, outside LLM) ===',
    `HEAD: ${mech.headSha ? mech.headSha.slice(0, 7) : ''} ${mech.headSubject || ''}`.trimEnd(),
    `Files in commit: ${(mech.changedFiles || []).join(', ') || '(none)'}`,
    `Passed: ${mech.ok ? 'YES' : 'NO'}`,
  ];
  if (mech.violations && mech.violations.length) {
    lines.push('Violations:');
    for (const v of mech.violations) {
      lines.push(`- ${v}`);
    }
  }
  return lines.join('\n');
}

const words = (cmd) => String(cmd).trim().split(/\s+/).filter(Boolean);
const startsWithWords = (cmd, prefix) => {
  const a = words(cmd);
  const b = words(prefix);
  return b.length > 0 && b.length <= a.length && b.every((w, i) => w === a[i]);
};

function splitCommandArgs(cmd) {
  const tokens = [];
  const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = re.exec(cmd)) !== null) tokens.push(match[1] ?? match[2] ?? match[0]);
  return tokens;
}

function extractOutputTail(stdout, stderr) {
  const combined = `${stdout || ''}${stderr || ''}`.trimEnd();
  const tailLines = combined.split('\n').slice(-40).join('\n');
  return tailLines.length > 4000 ? tailLines.slice(-4000) : tailLines;
}

/**
 * Runs task verification commands with shell:false and timeout.
 * Rejects disallowed commands, env prefixes, and shell operators.
 */
export function runTaskVerification({ task, workDir = process.cwd(), env = process.env, config = {}, timeoutMs = config?.verifyTimeoutMs ?? 120000, validateOnly = false }) {
  const commands = task?.verifyCommands ?? [];
  if (!commands.length) return { ok: true, kind: 'passed', results: [] };
  const blockedScripts = config.blockedScripts ?? config.blockedNpmScripts ?? [];
  const allowed = [...BASE_COMMANDS, ...(config.allowedCommands ?? [])];
  for (const rawCmd of commands) {
    const trimmed = String(rawCmd).trim();
    const firstTok = trimmed.split(/\s+/)[0] ?? '';
    if (!firstTok) return { ok: false, kind: 'disallowed', command: rawCmd, reason: 'empty command', results: [] };
    if (firstTok.includes('=')) {
      return { ok: false, kind: 'disallowed', command: rawCmd, reason: 'environment variable prefix (KEY=VALUE) is forbidden: Verify commands must be self-contained', results: [] };
    }
    const problem = commandProblem(rawCmd, blockedScripts);
    if (problem !== null) return { ok: false, kind: 'disallowed', command: rawCmd, reason: problem, results: [] };
    if (!allowed.some((prefix) => startsWithWords(rawCmd, prefix))) {
      return { ok: false, kind: 'disallowed', command: rawCmd, reason: `command "${rawCmd}" is not covered by allowed commands or BASE_COMMANDS`, results: [] };
    }
  }
  if (validateOnly) return { ok: true, kind: 'passed', results: [] };
  const results = [];
  const { NODE_TEST_CONTEXT: _ntc, ...childEnv } = env ?? {};
  for (const rawCmd of commands) {
    const tokens = splitCommandArgs(rawCmd);
    const start = Date.now();
    const res = spawnSync(tokens[0], tokens.slice(1), { cwd: workDir, env: childEnv, shell: false, encoding: 'utf8', timeout: timeoutMs });
    const durationMs = Date.now() - start;
    const timedOut = Boolean(res.error?.code === 'ETIMEDOUT' || (res.signal === 'SIGTERM' && res.status === null));
    const outputTail = extractOutputTail(res.stdout, res.stderr || (res.error ? String(res.error) : ''));
    if (timedOut) {
      results.push({ command: rawCmd, exitCode: null, durationMs, timedOut: true });
      return { ok: false, kind: 'timeout', failedCommand: rawCmd, exitCode: null, timedOut: true, outputTail, results };
    }
    if (res.status !== 0) {
      const exitCode = res.status ?? 1;
      results.push({ command: rawCmd, exitCode, durationMs, timedOut: false });
      return { ok: false, kind: 'failed', failedCommand: rawCmd, exitCode, timedOut: false, outputTail, results };
    }
    results.push({ command: rawCmd, exitCode: 0, durationMs, timedOut: false });
  }
  return { ok: true, kind: 'passed', results };
}
