// Deterministic Architect self-check (base resolution, commit scan, monotonicity, fix-frozen, WAIVER).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, commitsSince, findSquashViolations } from './git.mjs';
import { DEFAULT_TEST_FILE_PATTERNS, isTestFile, findBypasses } from './mechanics.mjs';
import { countTests, countAsserts, isUnderScanPaths, checkTestMonotonicity } from './monotonicity.mjs';
import { findTaskDirtyFiles } from './task-range.mjs';
import { parsePlan } from './plan.mjs';
import { scanRangeCommitMessages, scanRangeProcessWarnings } from './hooks.mjs';
import { commandProblem } from './permissions.mjs';
import { effectiveBlockedScripts } from './runners.mjs';
import { resolveSelfCheckRange } from './selfcheck-base.mjs';
import { readGitBlob } from './git-read.mjs';

export { resolveSelfCheckBase } from './selfcheck-base.mjs';

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

const TASK_SUBJECT_RE = /^T-\d+(?:\s*\(fix\s+\d+\))?:/;
const PLAN_SUBJECT_RE = /^arch:\s*(?:plan|план)\b/i;

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

function getModifiedOrDeletedFiles(realGit, cwd, sha) {
  const parents = git(realGit, cwd, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);
  if (!parents.length) return [];
  return git(realGit, cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=MD', parents[0], sha])
    .split('\n').map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

export function runSelfCheckGit({ realGit, cwd, config, baseRef = null, planText = null, requireFixFrozen = false, orchestratorDir = here }) {
  const range = resolveSelfCheckRange({ realGit, cwd, baseRef });
  const { baseSha, headSha, commitCount, empty } = range;
  const violations = [...range.violations];

  let effectivePlanText = planText;
  if (effectivePlanText === null) {
    effectivePlanText = '';
    for (const rel of [config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)) {
      if (existsSync(path.join(cwd, rel))) { effectivePlanText = readFileSync(path.join(cwd, rel), 'utf8'); break; }
      let blob;
      try { blob = readGitBlob(realGit, cwd, 'HEAD', rel); } catch (err) { violations.push(`cannot read ${rel} at HEAD: ${errMessage(err)}`); break; }
      if (blob.status === 'ok') { effectivePlanText = blob.text; break; }
    }
  }
  const waivers = parseWaivers(effectivePlanText), notVerified = [];
  if (baseSha === headSha) return { ok: violations.length === 0, baseSha, headSha, commitCount, empty, violations, warnings: [...range.warnings], waivers, notVerified };

  const warnings = scanRangeCommitMessages({ realGit, cwd, baseSha, headSha, commitLanguage: config?.commitLanguage });
  if (config?.team === true && warnings.length > 0) violations.push(...warnings);
  warnings.push(...range.warnings);
  const allCommits = commitsSince(realGit, cwd, baseSha);
  const nonMergeCommits = allCommits.filter((c) => !c.isMerge);
  const nonExecCommits = nonMergeCommits.filter((c) => !TASK_SUBJECT_RE.test(c.subject));
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
      const archive = readGitBlob(realGit, cwd, 'HEAD', f);
      if (archive.status === 'missing') continue;
      const content = archive.text;
      if (!RETRO_HEADER_RE.test(content) || !RULES_ADDED_RE.test(content)) {
        violations.push(`cycle closure archive ${f} is missing ## Retrospective / Ретроспектива section or "Rules: added N / removed M" line`);
      }
    }
  }
  const planIdx = allCommits.findIndex((c) => PLAN_SUBJECT_RE.test(c.subject));
  const frozenTests = new Set();
  const collectFrozen = (txt) => {
    for (const f of parsePlan(txt).frozen ?? []) {
      const nf = norm(f);
      if (isTestFile(nf, config?.testFilePatterns)) frozenTests.add(nf);
    }
  };
  for (const c of allCommits) {
    if (PLAN_SUBJECT_RE.test(c.subject)) {
      for (const p of ['PLAN.md', '.architect/PLAN.md']) {
        const planBlob = readGitBlob(realGit, cwd, c.sha, p);
        if (planBlob.status === 'ok') collectFrozen(planBlob.text);
      }
    }
  }
  if (effectivePlanText) collectFrozen(effectivePlanText);

  // 1. Content scans over all non-merge commits, task commits included (remediability check on HEAD)
  for (const c of nonMergeCommits) {
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
  violations.push(...checkTestMonotonicity({ realGit, cwd, baseSha, config, commits: allCommits, waivers }));

  for (const testFile of headFiles) {
    if (!isTestFile(testFile, config?.testFilePatterns)) continue;
    if (!isUnderScanPaths(testFile, config?.bypassScanPaths) && !frozenTests.has(testFile)) continue;
    const headContent = git(realGit, cwd, ['show', `HEAD:${testFile}`]);
    if (countAsserts(headContent, config) === 0 && (countTests(headContent, config) > 0 || frozenTests.has(testFile) || isNamedTestFile(testFile, config?.testFilePatterns))) {
      notVerified.push(`test file ${testFile} has 0 recognized assertions (NOT VERIFIED)`);
    }
  }

  const base7 = baseSha.slice(0, 7);
  const readConfigJson = (ref, label, cfgFile) => {
    const blob = readGitBlob(realGit, cwd, ref, cfgFile);
    if (blob.status === 'missing') return {};
    try {
      const parsed = JSON.parse(blob.text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
      return parsed;
    } catch (err) {
      violations.push(`config ${cfgFile} at ${label} is not valid JSON: ${errMessage(err)}`);
      return {};
    }
  };
  const protectedConfigFiles = resolveProtectedConfigFiles({ cwd, orchestratorDir, baseFiles, headFiles });
  for (const cfgFile of protectedConfigFiles) {
    let headJson = {};
    if (headFileSet.has(cfgFile)) {
      headJson = readConfigJson('HEAD', 'HEAD', cfgFile);
      if (typeof headJson.fullTestCommand === 'string' && headJson.fullTestCommand.trim()) {
        const ftProb = commandProblem(headJson.fullTestCommand, effectiveBlockedScripts(headJson));
        if (ftProb) violations.push(`config ${cfgFile} has unsafe fullTestCommand: ${ftProb}`);
      }
    }
    if (!baseFiles.includes(cfgFile)) continue;
    if (!headFileSet.has(cfgFile)) {
      violations.push(`monotonicity: config file ${cfgFile} deleted on HEAD`);
      continue;
    }
    const baseJson = readConfigJson(baseSha, base7, cfgFile);
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
    const commitsToCheck = requireFixFrozen ? nonExecCommits : allCommits.slice(planIdx + 1).filter((c) => !c.isMerge && !TASK_SUBJECT_RE.test(c.subject));

    // Only the first `arch: plan` commit of each cycle (range start or after `arch: close cycle`) is exempt.
    const cyclePlanShas = new Set();
    let planSeenInCycle = false;
    for (const c of nonMergeCommits) {
      if (CLOSE_CYCLE_RE.test(c.subject)) planSeenInCycle = false;
      else if (PLAN_SUBJECT_RE.test(c.subject) && !planSeenInCycle) { cyclePlanShas.add(c.sha); planSeenInCycle = true; }
    }

    const isProtected = (f) => {
      const nf = norm(f);
      return frozenTests.has(nf) || nf.endsWith('/eval-fixtures.mjs') || nf === 'eval-fixtures.mjs' || protectedConfigFiles.has(nf) || nf === 'config.example.json' || nf.endsWith('/orchestrator/config.example.json');
    };

    for (const c of commitsToCheck) {
      if (/^arch:\s*fix-frozen\s+(?:T-\d+|audit):\s+\S/i.test(c.subject) || cyclePlanShas.has(c.sha)) continue;
      if (waivers.some((w) => c.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))) continue;
      const mdFiles = getModifiedOrDeletedFiles(realGit, cwd, c.sha);
      const hit = mdFiles.find(isProtected);
      if (hit) violations.push(`commit ${c.sha.slice(0, 7)} touches frozen test / config / fixtures without arch: fix-frozen: "${c.subject}" (${hit})`);
    }

    const taskDirty = findTaskDirtyFiles({ realGit, cwd, baseSha, commits: allCommits, isTaskCommit: (c) => TASK_SUBJECT_RE.test(c.subject) });
    for (const { file, lastTaskCommit } of taskDirty) {
      if (!isProtected(file) || waivers.some((w) => lastTaskCommit.sha.toLowerCase().startsWith(w.sha7.toLowerCase()))) continue;
      violations.push(`task commit ${lastTaskCommit.sha.slice(0, 7)} touches frozen test / config / fixtures and the change is still on HEAD: "${lastTaskCommit.subject}" (${file})`);
    }
  }

  // 4. Rule version bump gate on SKILL.md, references/*.md, and EXECUTOR.md
  const changedFiles = [...new Set(allCommits.flatMap((c) => c.files.map(norm)))];
  if (!changedFiles.some((f) => f === '.version' || f.endsWith('/.version'))) {
    const readBlob = (ref, f) => {
      const blob = readGitBlob(realGit, cwd, ref, f);
      return blob.status === 'ok' ? blob.text : '';
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

  return { ok: violations.length === 0, baseSha, headSha, commitCount, empty, violations, warnings, waivers, notVerified };
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
  } catch (err) {
    violations.push(`cannot inspect PLAN.md for new WAIVER lines: ${errMessage(err)}`);
  }

  const sc = runSelfCheckGit({ realGit, cwd, config, baseRef: baseSha, requireFixFrozen: true });
  violations.push(...sc.violations);

  return { ok: violations.length === 0, violations };
}
