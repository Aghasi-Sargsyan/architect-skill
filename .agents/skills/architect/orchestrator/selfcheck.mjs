// Deterministic Architect self-check (base resolution, commit scan, monotonicity, fix-frozen, WAIVER).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, commitsSince, findSquashViolations } from './git.mjs';
import { DEFAULT_TEST_FILE_PATTERNS, isTestFile, findBypasses } from './mechanics.mjs';
import { parsePlan } from './plan.mjs';
import { scanRangeCommitMessages, scanRangeProcessWarnings } from './hooks.mjs';
import { commandProblem } from './permissions.mjs';
import { effectiveBlockedScripts } from './runners.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const EVAL_FIXTURE_ANCHORS = [
  'Module `src/app.js` exports `x = 2`.',
  'replace \\`export const x = 1;\\` with \\`export const x = 2;\\`; do not modify other files.',
  'Module `src/app.js` exports `x` for module consumers.',
  'Task and invariants: \\`src/app.js\\` exports the constant \\`x\\`; do not modify other files.',
  '- Verify: \\`git show --stat HEAD\\`.',
];

const CONFIG_FILES = ['.agents/orchestrator.json', '.architect/config.json'];

function resolveProtectedConfigFiles({ cwd, orchestratorDir = here, baseFiles = [], headFiles = [] }) {
  const set = new Set(CONFIG_FILES);
  if (orchestratorDir && cwd) {
    const rel = path.relative(path.resolve(cwd), path.resolve(orchestratorDir, 'config.example.json')).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) set.add(rel);
  }
  for (const f of [...baseFiles, ...headFiles]) {
    const nf = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (nf === 'config.example.json' || nf.endsWith('/orchestrator/config.example.json')) set.add(nf);
  }
  return set;
}

const CONFIG_ARRAY_KEYS = ['bypassPatterns', 'bypassScanPaths', 'protectedConfigFiles', 'blockedNpmScripts', 'testFilePatterns', 'testPatterns', 'assertPatterns'];

const TIMER_RE = /(?:performance\.now\(|Date\.now\(|process\.hrtime\b|console\.time\()/;
const CATCH_RE = /(?:^|[^\w.])(catch\s*(?:\([^)]*\))?\s*\{([^}]*)\})/g;
const PROMISE_CATCH_RE = /(\.catch\s*\(\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)?\s*(?:=>|function[^{]*)\s*\{([^}]*)\}\s*\))/g;
const CLEANUP_RE = /\b(?:stop|abort|close)\b/i;

export function resolveSelfCheckBase({ realGit, cwd, baseRef = null }) {
  if (baseRef) {
    try { return { sha: git(realGit, cwd, ['rev-parse', `${baseRef}^{commit}`]), source: 'explicit' }; } catch {
      // cleanup: abort base resolution with fail-closed hint
      throw new Error(`Cannot resolve --base "${baseRef}" to a commit — ensure the branch/ref is fetched (e.g. fetch-depth: 0)`);
    }
  }
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const log = git(realGit, cwd, ['log', '--format=%H %s', 'HEAD']).split('\n').filter(Boolean);
  const isClose = (s) => /^arch:\s*(?:close cycle|закрытие цикла)\b/i.test(s);
  const closes = log.filter((l) => isClose(l.slice(41)));
  const cand = closes.find((l) => l.slice(0, 40) !== headSha);
  if (cand) return { sha: cand.slice(0, 40), source: 'close-cycle' };
  if (!closes.length) {
    try { return { sha: git(realGit, cwd, ['rev-parse', '@{u}']), source: 'upstream' }; } catch { /* cleanup: abort upstream resolution */ }
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

export function findTestTimers(diffText, testFilePatterns) {
  const result = [];
  for (const { file, hunks } of splitDiffByFiles(diffText)) {
    if (!isTestFile(file, testFilePatterns)) continue;
    for (const hunk of hunks) {
      for (const line of hunk) {
        if (TIMER_RE.test(line)) result.push({ file, line: line.trim() });
      }
    }
  }
  return result;
}

const DEFAULT_TEST_PATTERNS = ['\\b(?:test|it)\\s*\\(', '^\\s*def\\s+test_'];
const DEFAULT_ASSERT_PATTERNS = ['\\bassert\\.', '\\bexpect\\s*\\(', '^\\s*assert\\s+\\S'];

function countByPatterns(content, patterns, fallback) {
  const list = Array.isArray(patterns) && patterns.length > 0 ? patterns : fallback;
  let total = 0;
  for (const p of list) total += (content.match(new RegExp(p instanceof RegExp ? p.source : String(p), 'gm')) ?? []).length;
  return total;
}

const countTests = (content, config) => countByPatterns(content, config?.testPatterns, DEFAULT_TEST_PATTERNS);
const countAsserts = (content, config) => countByPatterns(content, config?.assertPatterns, DEFAULT_ASSERT_PATTERNS);

function isVersionGreater(vHead, vBase) {
  if (!vHead) return false;
  if (!vBase) return true;
  const [h, b] = [vHead, vBase].map((v) => String(v).split('.').map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < Math.max(h.length, b.length); i++) {
    const diff = (h[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function isNamedTestFile(filePath, patterns = DEFAULT_TEST_FILE_PATTERNS) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const list = (Array.isArray(patterns) && patterns.length > 0 ? patterns : DEFAULT_TEST_FILE_PATTERNS)
    .filter((p) => String(p) !== '(?:^|/)tests/' && !String(p).endsWith('/'));
  return list.some((p) => (p instanceof RegExp ? p : new RegExp(p)).test(normalized));
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
  } catch { /* cleanup: abort diff-tree read */ return []; }
}

export function runSelfCheckGit({ realGit, cwd, config, baseRef = null, planText = null, requireFixFrozen = false, orchestratorDir = here }) {
  const { sha: baseSha } = resolveSelfCheckBase({ realGit, cwd, baseRef });
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const violations = [];

  let effectivePlanText = planText;
  if (effectivePlanText === null) {
    for (const rel of [config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)) {
      try { effectivePlanText = readFileSync(path.join(cwd, rel), 'utf8'); break; } catch {
        try { effectivePlanText = git(realGit, cwd, ['show', `HEAD:${rel}`]); break; } catch { /* cleanup: abort plan candidate */ }
      }
    }
    if (effectivePlanText === null) effectivePlanText = '';
  }
  const waivers = parseWaivers(effectivePlanText), notVerified = [];
  if (baseSha === headSha) return { ok: true, baseSha, headSha, violations, warnings: [], waivers, notVerified };

  const warnings = scanRangeCommitMessages({ realGit, cwd, baseSha, headSha, commitLanguage: config?.commitLanguage });
  if (config?.team === true && warnings.length > 0) violations.push(...warnings);
  const allCommits = commitsSince(realGit, cwd, baseSha);
  const nonExecCommits = allCommits.filter((c) => !c.isMerge && !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));
  violations.push(...findSquashViolations({ realGit, cwd, baseSha, headSha, commits: allCommits }));
  const bypassPatterns = config?.bypassRegexps ?? (config?.bypassPatterns ?? []).map((p) => new RegExp(p));
  const headFiles = git(realGit, cwd, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean), headFileSet = new Set(headFiles);
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  warnings.push(...scanRangeProcessWarnings(allCommits, { isTestFile, isUnderScanPaths, config, norm }));

  const CLOSE_CYCLE_RE = /^arch:\s*(?:close cycle|закрытие цикла)\b/i, ARCHIVE_PLAN_RE = /(?:^|\/)(?:docs|\.architect)\/plans\/[^/]+\.md$/;
  const RETRO_HEADER_RE = /^##\s+.*(?:Ретроспектива(?![а-яёА-ЯЁ])|Retrospective\b)/im, RULES_ADDED_RE = /\bRules:\s*added\s+\d+\s*\/\s*removed\s+\d+/i;
  const checkedArchives = new Set();
  for (const c of nonExecCommits) {
    if (!CLOSE_CYCLE_RE.test(c.subject)) continue;
    for (const rawFile of c.files) {
      const f = norm(rawFile);
      if (!ARCHIVE_PLAN_RE.test(f) || !headFileSet.has(f) || checkedArchives.has(f)) continue;
      checkedArchives.add(f);
      let content = '';
      try { content = git(realGit, cwd, ['show', `HEAD:${f}`]); } catch { /* cleanup: abort reading archive */ continue; }
      if (!RETRO_HEADER_RE.test(content) || !RULES_ADDED_RE.test(content)) {
        violations.push(`cycle closure archive ${f} is missing ## Retrospective / Ретроспектива section or "Rules: added N / removed M" line`);
      }
    }
  }
  const planIdx = allCommits.findIndex((c) => /^arch:\s*(?:plan|план)\b/i.test(c.subject));
  const frozenTests = new Set();
  const collectFrozen = (txt) => {
    try {
      for (const f of parsePlan(txt).frozen ?? []) {
        const nf = norm(f);
        if (isTestFile(nf, config?.testFilePatterns)) frozenTests.add(nf);
      }
    } catch { /* cleanup: abort plan parsing */ }
  };
  for (const c of allCommits) {
    if (/^arch:\s*(?:plan|план)\b/i.test(c.subject)) {
      for (const p of ['PLAN.md', '.architect/PLAN.md']) {
        try { collectFrozen(git(realGit, cwd, ['show', `${c.sha}:${p}`])); } catch { /* cleanup: abort plan reading */ }
      }
    }
  }
  if (effectivePlanText) collectFrozen(effectivePlanText);

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

      for (const added of findBypasses(fileDiffText, bypassPatterns, config?.testFilePatterns)) {
        if (headContent.includes(added)) violations.push(`bypass in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${added.slice(0, 100)}`);
      }
      for (const catchItem of findEmptyCatches(fileDiffText)) {
        if (catchItem.lines.length > 0 && catchItem.lines.every((l) => headContent.includes(l))) {
          violations.push(`empty catch in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${catchItem.lines.join(' ')}`);
        }
      }
      for (const timer of findTestTimers(fileDiffText, config?.testFilePatterns)) {
        if (headContent.includes(timer.line)) violations.push(`test timer in ${fileDiff.file} from commit ${c.sha.slice(0, 7)} still on HEAD: ${timer.line}`);
      }
    }
  }

  // 2. Monotonicity checks
  const baseFiles = git(realGit, cwd, ['ls-tree', '-r', '--name-only', baseSha]).split('\n').filter(Boolean);
  const baseTestFiles = baseFiles.filter((f) => isTestFile(f, config?.testFilePatterns) && isUnderScanPaths(f, config?.bypassScanPaths));
  const monoWaivedFiles = new Set(allCommits.filter((c) => waivers.some((w) => /\bmonotonicity\b/i.test(w.rule) && c.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))).flatMap((c) => c.files.map(norm)));

  for (const testFile of baseTestFiles) {
    if (!headFileSet.has(testFile)) {
      if (!allCommits.some((c) => c.files.map(norm).includes(norm(testFile)) && /\bADR-\d+\b/.test(c.subject)) && !monoWaivedFiles.has(norm(testFile))) {
        violations.push(`test file deleted without ADR in commit message: ${testFile}`);
      }
    } else if (!monoWaivedFiles.has(norm(testFile))) {
      const baseContent = git(realGit, cwd, ['show', `${baseSha}:${testFile}`]), headContent = git(realGit, cwd, ['show', `HEAD:${testFile}`]);
      const baseTests = countTests(baseContent, config), headTests = countTests(headContent, config);
      if (headTests < baseTests) violations.push(`monotonicity: in ${testFile} test/it count decreased from ${baseTests} to ${headTests}`);
      const baseAsserts = countAsserts(baseContent, config), headAsserts = countAsserts(headContent, config);
      if (headAsserts < baseAsserts) violations.push(`monotonicity: in ${testFile} assert count decreased from ${baseAsserts} to ${headAsserts}`);
    }
  }

  for (const testFile of headFiles) {
    if (!isTestFile(testFile, config?.testFilePatterns)) continue;
    if (!isUnderScanPaths(testFile, config?.bypassScanPaths) && !frozenTests.has(testFile)) continue;
    const headContent = git(realGit, cwd, ['show', `HEAD:${testFile}`]);
    if (countAsserts(headContent, config) === 0 && (countTests(headContent, config) > 0 || frozenTests.has(testFile) || isNamedTestFile(testFile, config?.testFilePatterns))) {
      notVerified.push(`test file ${testFile} has 0 recognized assertions (NOT VERIFIED)`);
    }
  }

  const protectedConfigFiles = resolveProtectedConfigFiles({ cwd, orchestratorDir, baseFiles, headFiles });
  for (const cfgFile of protectedConfigFiles) {
    if (headFileSet.has(cfgFile)) {
      let hCfg = {};
      try { hCfg = JSON.parse(git(realGit, cwd, ['show', `HEAD:${cfgFile}`])); } catch { /* cleanup: abort head config parse */ hCfg = {}; }
      if (typeof hCfg.fullTestCommand === 'string' && hCfg.fullTestCommand.trim()) {
        const ftProb = commandProblem(hCfg.fullTestCommand, effectiveBlockedScripts(hCfg));
        if (ftProb) violations.push(`config ${cfgFile} has unsafe fullTestCommand: ${ftProb}`);
      }
    }
    if (!baseFiles.includes(cfgFile)) continue;
    if (!headFileSet.has(cfgFile)) {
      violations.push(`monotonicity: config file ${cfgFile} deleted on HEAD`);
      continue;
    }
    let baseJson = {}, headJson = {};
    try { baseJson = JSON.parse(git(realGit, cwd, ['show', `${baseSha}:${cfgFile}`])); } catch { /* cleanup: abort parse base config */ baseJson = {}; }
    try { headJson = JSON.parse(git(realGit, cwd, ['show', `HEAD:${cfgFile}`])); } catch { /* cleanup: abort parse head config */ headJson = {}; }
    for (const key of CONFIG_ARRAY_KEYS) {
      const baseArr = Array.isArray(baseJson[key]) ? baseJson[key] : [], headArr = Array.isArray(headJson[key]) ? headJson[key] : [];
      for (const item of baseArr) if (!headArr.includes(item)) violations.push(`monotonicity: in ${cfgFile} array ${key} missing element "${item}" present in base`);
    }
  }

  const fixturePath = headFiles.find((f) => f.endsWith('/eval-fixtures.mjs') || f === 'eval-fixtures.mjs');
  if (fixturePath) {
    const fixturesText = git(realGit, cwd, ['show', `HEAD:${fixturePath}`]);
    for (const anchor of EVAL_FIXTURE_ANCHORS) {
      if (!fixturesText.includes(anchor)) violations.push(`monotonicity: eval-fixtures.mjs missing anchor: ${anchor}`);
    }
  }

  // 3. Fix-frozen check after plan commit
  if (requireFixFrozen || planIdx !== -1) {
    const commitsToCheck = requireFixFrozen ? nonExecCommits : allCommits.slice(planIdx + 1).filter((c) => !c.isMerge && !/^T-\d+(?:\s*\(fix\s+\d+\))?:/.test(c.subject));

    const isProtected = (f) => {
      const nf = norm(f);
      return frozenTests.has(nf) || nf.endsWith('/eval-fixtures.mjs') || nf === 'eval-fixtures.mjs' || protectedConfigFiles.has(nf) || nf === 'config.example.json' || nf.endsWith('/orchestrator/config.example.json');
    };

    for (const c of commitsToCheck) {
      if (/^arch:\s*(?:fix-frozen\s+(?:T-\d+|audit):\s+\S|(?:plan|план)\b)/i.test(c.subject)) continue;
      if (waivers.some((w) => c.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))) continue;
      const mdFiles = getModifiedOrDeletedFiles(realGit, cwd, c.sha);
      const hit = mdFiles.find(isProtected);
      if (hit) violations.push(`commit ${c.sha.slice(0, 7)} touches frozen test / config / fixtures without arch: fix-frozen: "${c.subject}" (${hit})`);
    }
  }

  // 4. Rule version bump gate on SKILL.md, references/*.md, and EXECUTOR.md
  const changedFiles = [...new Set(allCommits.flatMap((c) => c.files.map(norm)))];
  if (!changedFiles.some((f) => f === '.version' || f.endsWith('/.version'))) {
    const base7 = baseSha.slice(0, 7);
    const readBlob = (ref, f) => {
      try { return git(realGit, cwd, ['show', `${ref}:${f}`]); } catch { /* cleanup: abort reading blob */ return ''; }
    };
    if (changedFiles.some((f) => f === 'SKILL.md' || f.endsWith('/SKILL.md') || /(?:^|\/)references\/[^/]+\.md$/.test(f))) {
      const sf = changedFiles.find((f) => f === 'SKILL.md' || f.endsWith('/SKILL.md')) ?? headFiles.find((f) => f.endsWith('/SKILL.md') || f === 'SKILL.md') ?? 'SKILL.md';
      const hVer = readBlob('HEAD', sf).match(/^#\s+Architect Prompt v([0-9.]+)/m)?.[1] ?? null;
      const bVer = readBlob(baseSha, sf).match(/^#\s+Architect Prompt v([0-9.]+)/m)?.[1] ?? null;
      if (!isVersionGreater(hVer, bVer)) violations.push(`skill rule files changed since ${base7} without bumping version in ${sf} (still v${hVer ?? 'unknown'})`);
    }
    if (changedFiles.some((f) => f === 'EXECUTOR.md' || f.endsWith('/EXECUTOR.md'))) {
      const ef = changedFiles.find((f) => f.endsWith('/EXECUTOR.md') || f === 'EXECUTOR.md') ?? headFiles.find((f) => f.endsWith('/EXECUTOR.md') || f === 'EXECUTOR.md') ?? 'EXECUTOR.md';
      const hVer = readBlob('HEAD', ef).match(/<!--\s*executor-policy-version:\s*([0-9.]+)\s*-->/)?.[1] ?? null;
      const bVer = readBlob(baseSha, ef).match(/<!--\s*executor-policy-version:\s*([0-9.]+)\s*-->/)?.[1] ?? null;
      if (!isVersionGreater(hVer, bVer)) violations.push(`EXECUTOR.md changed since ${base7} without bumping version in ${ef} (still ${hVer ?? 'unknown'})`);
    }
  }

  return { ok: violations.length === 0, baseSha, headSha, violations, warnings, waivers, notVerified };
}

export function checkPostReviewSelfCheck({ realGit, cwd, baseSha, config }) {
  const violations = [];
  try {
    const diff = git(realGit, cwd, ['diff', '-U0', baseSha, 'HEAD', '--', 'PLAN.md', '.architect/PLAN.md']);
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++') && /^\+\s*-\s*WAIVER\b/.test(line)) {
        violations.push(`new WAIVER line added during automated cycle is forbidden: ${line.slice(1).trim()}`);
      }
    }
  } catch { /* cleanup: abort diff inspection */ }

  const sc = runSelfCheckGit({ realGit, cwd, config, baseRef: baseSha, requireFixFrozen: true });
  violations.push(...sc.violations);

  return { ok: violations.length === 0, violations };
}
