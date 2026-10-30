// Deterministic Architect self-check (base resolution, commit scan, monotonicity, fix-frozen, WAIVER).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git, commitsSince } from './git.mjs';
import { isTestFile, findBypasses } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';

export const EVAL_FIXTURE_ANCHORS = [
  'Module `src/app.js` exports `x = 2`.',
  'replace \\`export const x = 1;\\` with \\`export const x = 2;\\`; do not modify other files.',
  'Module `src/app.js` exports `x` for module consumers.',
  'Task and invariants: \\`src/app.js\\` exports the constant \\`x\\`; do not modify other files.',
  '- Verify: \\`git show --stat HEAD\\`.',
];

const CONFIG_FILES = [
  '.agents/orchestrator.json',
  '.architect/config.json',
  '.agents/skills/architect/orchestrator/config.example.json',
];

const CONFIG_ARRAY_KEYS = [
  'bypassPatterns',
  'bypassScanPaths',
  'protectedConfigFiles',
  'blockedNpmScripts',
];

const TIMER_RE = /(?:performance\.now\(|Date\.now\(|process\.hrtime\b|console\.time\()/;
const CATCH_RE = /(?:^|[^\w.])(catch\s*(?:\([^)]*\))?\s*\{([^}]*)\})/g;
const PROMISE_CATCH_RE = /(\.catch\s*\(\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)?\s*(?:=>|function[^{]*)\s*\{([^}]*)\}\s*\))/g;
const CLEANUP_RE = /\b(?:stop|abort|close)\b/i;

export function resolveSelfCheckBase({ realGit, cwd, baseRef = null }) {
  if (baseRef) return { sha: git(realGit, cwd, ['rev-parse', baseRef]), source: 'explicit' };
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const log = git(realGit, cwd, ['log', '--format=%H %s', 'HEAD']).split('\n').filter(Boolean);
  const isClose = (s) => /^arch:\s*(?:close cycle|закрытие цикла)\b/i.test(s);
  const closes = log.filter((l) => isClose(l.slice(41)));
  const cand = closes.find((l) => l.slice(0, 40) !== headSha);
  if (cand) return { sha: cand.slice(0, 40), source: 'close-cycle' };
  if (!closes.length) {
    try { return { sha: git(realGit, cwd, ['rev-parse', '@{u}']), source: 'upstream' }; } catch {}
  }
  return { sha: git(realGit, cwd, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0].trim(), source: 'root' };
}

export function parseWaivers(planText) {
  if (!planText || typeof planText !== 'string') return [];
  const waivers = [];
  let inDecisions = false;
  for (const line of planText.split('\n')) {
    if (line.startsWith('## ')) inDecisions = /^##\s+(?:decisions\b|решения\b)/i.test(line);
    else if (inDecisions) {
      const m = line.match(/^- WAIVER\s+([0-9a-fA-F]{7,})\s*:\s*(.+?)\s+(?:[—–]|--|-)\s+(.+)$/);
      if (m) waivers.push({ sha7: m[1], rule: m[2].trim(), reason: m[3].trim(), raw: line.trim() });
    }
  }
  return waivers;
}

export function splitDiffByFiles(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const files = [];
  let cur = null, hunk = [], hunks = [];
  const pushFile = () => {
    if (!cur) return;
    if (hunk.length) hunks.push(hunk);
    files.push({ file: cur, hunks });
    cur = null; hunk = []; hunks = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      pushFile();
      const raw = line.slice(6).split('\t')[0].trim();
      cur = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    } else if (line.startsWith('@@')) {
      if (hunk.length) { hunks.push(hunk); hunk = []; }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.push(line.slice(1));
    }
  }
  pushFile();
  return files;
}

export function findEmptyCatches(diffText) {
  const result = [];
  const scan = (text, re, file) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[2];
      const stripped = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim();
      if (stripped === '' && !CLEANUP_RE.test(body)) {
        const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
        result.push({ file, lines, line: m[1].trim() });
      }
    }
  };
  for (const { file, hunks } of splitDiffByFiles(diffText)) {
    for (const hunk of hunks) {
      const text = hunk.join('\n');
      scan(text, CATCH_RE, file);
      scan(text, PROMISE_CATCH_RE, file);
    }
  }
  return result;
}

export function findTestTimers(diffText) {
  const result = [];
  for (const { file, hunks } of splitDiffByFiles(diffText)) {
    if (!isTestFile(file)) continue;
    for (const hunk of hunks) {
      for (const line of hunk) {
        if (TIMER_RE.test(line)) result.push({ file, line: line.trim() });
      }
    }
  }
  return result;
}

function countTests(content) {
  return (content.match(/\b(?:test|it)\s*\(/g) ?? []).length;
}

function countAsserts(content) {
  return (content.match(/\bassert\./g) ?? []).length;
}

function isUnderScanPaths(file, scanPaths) {
  if (!scanPaths || !scanPaths.length) return true;
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return scanPaths.some((p) => {
    const np = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return norm === np || norm.startsWith(np + '/');
  });
}

function getModifiedOrDeletedFiles(realGit, cwd, sha) {
  try {
    const parents = git(realGit, cwd, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);
    if (!parents.length) return [];
    return git(realGit, cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=MD', parents[0], sha])
      .split('\n').map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  } catch {
    return [];
  }
}

export function runSelfCheckGit({ realGit, cwd, config, baseRef = null, planText = null, requireFixFrozen = false }) {
  const { sha: baseSha } = resolveSelfCheckBase({ realGit, cwd, baseRef });
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const violations = [];

  let effectivePlanText = planText;
  if (effectivePlanText === null) {
    try { effectivePlanText = readFileSync(path.join(cwd, 'PLAN.md'), 'utf8'); } catch {
      try { effectivePlanText = git(realGit, cwd, ['show', 'HEAD:PLAN.md']); } catch { effectivePlanText = ''; }
    }
  }
  const waivers = parseWaivers(effectivePlanText);
  if (baseSha === headSha) return { ok: true, baseSha, headSha, violations, waivers };

  const allCommits = commitsSince(realGit, cwd, baseSha);
  const nonExecCommits = allCommits.filter((c) => !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));
  const bypassPatterns = config?.bypassRegexps ?? (config?.bypassPatterns ?? []).map((p) => new RegExp(p));
  const headFiles = git(realGit, cwd, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const headFileSet = new Set(headFiles);

  // 1. Content scans over non-executor commits (remediability check on HEAD)
  for (const c of nonExecCommits) {
    const diff = git(realGit, cwd, ['show', c.sha]);
    for (const fileDiff of splitDiffByFiles(diff)) {
      if (!isUnderScanPaths(fileDiff.file, config?.bypassScanPaths)) continue;
      if (!headFileSet.has(fileDiff.file)) continue;
      const headContent = git(realGit, cwd, ['show', `HEAD:${fileDiff.file}`]);

      const fileDiffText = [
        `+++ b/${fileDiff.file}`,
        ...fileDiff.hunks.flatMap((h) => ['@@ -1,0 +1,0 @@', ...h.map((l) => `+${l}`)]),
      ].join('\n');

      for (const added of findBypasses(fileDiffText, bypassPatterns)) {
        if (headContent.includes(added)) {
          violations.push(`bypass in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${added.slice(0, 100)}`);
        }
      }
      for (const catchItem of findEmptyCatches(fileDiffText)) {
        if (catchItem.lines.length > 0 && catchItem.lines.every((l) => headContent.includes(l))) {
          violations.push(`empty catch in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${catchItem.lines.join(' ')}`);
        }
      }
      for (const timer of findTestTimers(fileDiffText)) {
        if (headContent.includes(timer.line)) {
          violations.push(`test timer in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${timer.line}`);
        }
      }
    }
  }

  // 2. Monotonicity checks
  const baseFiles = git(realGit, cwd, ['ls-tree', '-r', '--name-only', baseSha]).split('\n').filter(Boolean);
  const baseTestFiles = baseFiles.filter((f) => isTestFile(f) && isUnderScanPaths(f, config?.bypassScanPaths));

  for (const testFile of baseTestFiles) {
    if (!headFileSet.has(testFile)) {
      if (!allCommits.some((c) => /\bADR-\d+\b/.test(c.subject))) {
        violations.push(`test file deleted without ADR in commit message: ${testFile}`);
      }
    } else {
      const baseContent = git(realGit, cwd, ['show', `${baseSha}:${testFile}`]);
      const headContent = git(realGit, cwd, ['show', `HEAD:${testFile}`]);
      const baseTests = countTests(baseContent);
      const headTests = countTests(headContent);
      if (headTests < baseTests) {
        violations.push(`monotonicity: in ${testFile} test/it count decreased from ${baseTests} to ${headTests}`);
      }
      const baseAsserts = countAsserts(baseContent);
      const headAsserts = countAsserts(headContent);
      if (headAsserts < baseAsserts) {
        violations.push(`monotonicity: in ${testFile} assert count decreased from ${baseAsserts} to ${headAsserts}`);
      }
    }
  }

  for (const cfgFile of CONFIG_FILES) {
    if (!baseFiles.includes(cfgFile)) continue;
    if (!headFileSet.has(cfgFile)) {
      violations.push(`monotonicity: config file ${cfgFile} deleted on HEAD`);
      continue;
    }
    let baseJson = {}, headJson = {};
    try { baseJson = JSON.parse(git(realGit, cwd, ['show', `${baseSha}:${cfgFile}`])); } catch {}
    try { headJson = JSON.parse(git(realGit, cwd, ['show', `HEAD:${cfgFile}`])); } catch {}
    for (const key of CONFIG_ARRAY_KEYS) {
      const baseArr = Array.isArray(baseJson[key]) ? baseJson[key] : [];
      const headArr = Array.isArray(headJson[key]) ? headJson[key] : [];
      for (const item of baseArr) {
        if (!headArr.includes(item)) {
          violations.push(`monotonicity: in ${cfgFile} array ${key} missing element "${item}" present in base`);
        }
      }
    }
  }

  const fixturePath = headFiles.find((f) => f.endsWith('/eval-fixtures.mjs') || f === 'eval-fixtures.mjs');
  if (fixturePath) {
    const fixturesText = git(realGit, cwd, ['show', `HEAD:${fixturePath}`]);
    for (const anchor of EVAL_FIXTURE_ANCHORS) {
      if (!fixturesText.includes(anchor)) {
        violations.push(`monotonicity: eval-fixtures.mjs missing anchor: ${anchor}`);
      }
    }
  }

  // 3. Fix-frozen check after plan commit
  const planIdx = allCommits.findIndex((c) => /^arch:\s*(?:plan|план)\b/i.test(c.subject));
  if (requireFixFrozen || planIdx !== -1) {
    const commitsToCheck = requireFixFrozen ? nonExecCommits : allCommits.slice(planIdx + 1).filter((c) => !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));
    const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const frozenTests = new Set();
    if (planIdx !== -1) {
      try {
        const planAtCommit = parsePlan(git(realGit, cwd, ['show', `${allCommits[planIdx].sha}:PLAN.md`]));
        for (const f of planAtCommit.frozen ?? []) {
          const nf = norm(f);
          if (isTestFile(nf)) frozenTests.add(nf);
        }
      } catch {}
    }
    if (effectivePlanText) {
      try {
        const planAtHead = parsePlan(effectivePlanText);
        for (const f of planAtHead.frozen ?? []) {
          const nf = norm(f);
          if (isTestFile(nf)) frozenTests.add(nf);
        }
      } catch {}
    }

    const isProtected = (f) => {
      const nf = norm(f);
      return frozenTests.has(nf) || nf.endsWith('/eval-fixtures.mjs') || nf === 'eval-fixtures.mjs' || CONFIG_FILES.includes(nf);
    };

    for (const c of commitsToCheck) {
      if (/^arch:\s*fix-frozen\s+(?:T-\d+|audit):\s+\S/.test(c.subject)) continue;
      if (waivers.some((w) => c.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))) continue;
      const mdFiles = getModifiedOrDeletedFiles(realGit, cwd, c.sha);
      const hit = mdFiles.find(isProtected);
      if (hit) {
        violations.push(`commit ${c.sha.slice(0, 7)} touches frozen test / config / fixtures without arch: fix-frozen: "${c.subject}" (${hit})`);
      }
    }
  }

  return { ok: violations.length === 0, baseSha, headSha, violations, waivers };
}

export function checkPostReviewSelfCheck({ realGit, cwd, baseSha, config }) {
  const violations = [];
  try {
    const diff = git(realGit, cwd, ['diff', '-U0', baseSha, 'HEAD', '--', 'PLAN.md']);
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (/^\+\s*-\s*WAIVER\b/.test(line)) {
          violations.push(`new WAIVER line added during automated cycle is forbidden: ${line.slice(1).trim()}`);
        }
      }
    }
  } catch {}

  const sc = runSelfCheckGit({ realGit, cwd, config, baseRef: baseSha, requireFixFrozen: true });
  violations.push(...sc.violations);

  return { ok: violations.length === 0, violations };
}
