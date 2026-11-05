// Commit hooks and Executor model configuration checks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

/**
 * Checks whether the Executor model is properly configured.
 * 1. If .claude/agents/executor.md exists, it must explicitly specify a model (not missing, not 'inherit').
 * 2. An explicit Executor model must be set in at least one place:
 *    - config.executor.model (when config is not from a missing file and not 'inherit')
 *    - on disk in .agents/orchestrator.json or .architect/config.json
 *    - in AGENTS.md, CLAUDE.md, or GEMINI.md ("Executor model: ...", "Модель Исполнителя: ...", "Исполнитель по умолчанию — ...")
 *    - in .claude/agents/executor.md ("model: <name>")
 * @param {{ workDir?: string, config?: object }} param0
 * @returns {Array<{ ok: boolean, name: string, detail: string }>}
 */
const normalizeModelValue = (val) => {
  if (typeof val !== 'string') return '';
  let s = val.trim().replace(/^[*_\s]+|[*_\s]+$/g, '');
  const bt = s.match(/`([^`]*)`/);
  if (bt) s = bt[1];
  return s.trim().replace(/^[*_` \t]+|[*_` \t]+$/g, '');
};

const isValidModel = (val) => {
  const s = normalizeModelValue(val);
  return Boolean(s) && s.toLowerCase() !== 'inherit' && !/^<.*>$/.test(s);
};

export function resolveExecutorModelInfo({ workDir = process.cwd(), config = null } = {}) {
  if (config?._modelSources?.executor?.endsWith('.local.json') && isValidModel(config.executor?.model)) {
    const model = normalizeModelValue(config.executor.model);
    const source = config._modelSources.executor;
    return { ok: true, model, source, detail: `${model} (source: ${source})`, problems: [] };
  }
  for (const rel of ['.architect/config.local.json', '.agents/orchestrator.local.json']) {
    const full = path.join(workDir, rel);
    if (existsSync(full)) {
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        if (isValidModel(raw?.executor?.model)) {
          const model = normalizeModelValue(raw.executor.model);
          return { ok: true, model, source: rel, detail: `${model} (source: ${rel})`, problems: [] };
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  if (config?._modelSources?.executor && isValidModel(config.executor?.model)) {
    const model = normalizeModelValue(config.executor.model);
    const source = config._modelSources.executor;
    return { ok: true, model, source, detail: `${model} (source: ${source})`, problems: [] };
  }
  if (config && !config._missingConfigFile && isValidModel(config.executor?.model)) {
    const model = normalizeModelValue(config.executor.model);
    const source = config.paths?.planPath?.startsWith('.architect') ? '.architect/config.json' : '.agents/orchestrator.json';
    return { ok: true, model, source, detail: `${model} (source: ${source})`, problems: [] };
  }
  for (const rel of ['.architect/config.json', '.agents/orchestrator.json']) {
    const full = path.join(workDir, rel);
    if (existsSync(full)) {
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        if (isValidModel(raw?.executor?.model)) {
          const model = normalizeModelValue(raw.executor.model);
          return { ok: true, model, source: rel, detail: `${model} (source: ${rel})`, problems: [] };
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const full = path.join(workDir, file);
    if (existsSync(full)) {
      const text = readFileSync(full, 'utf8');
      const m1 = text.match(/(?:Executor model|Модель Исполнителя)[*_ \t]*:[ \t]*([^\r\n]*)/i);
      const m2 = text.match(/Исполнитель по умолчанию[ \t]*[—–-][ \t]*(\S[^\r\n.]*)/i);
      const candidate = (m1 ? m1[1] : (m2 ? m2[1] : '')).trim();
      if (isValidModel(candidate)) {
        const model = normalizeModelValue(candidate);
        return { ok: true, model, source: file, detail: `${model} (source: ${file})`, problems: [] };
      }
    }
  }

  const claudeAgentPath = path.join(workDir, '.claude', 'agents', 'executor.md');
  if (existsSync(claudeAgentPath)) {
    const text = readFileSync(claudeAgentPath, 'utf8');
    const m = text.match(/^model:[ \t]*(\S.*)$/im);
    if (m && isValidModel(m[1])) {
      const model = normalizeModelValue(m[1]);
      const source = '.claude/agents/executor.md';
      return { ok: true, model, source, detail: `${model} (source: ${source})`, problems: [] };
    }
  }

  const detail = 'Executor model is not configured — set executor.model in .agents/orchestrator.json, "Executor model: ..." in AGENTS.md / CLAUDE.md / GEMINI.md, or model in .claude/agents/executor.md';
  return { ok: false, model: null, source: null, detail, problems: [detail] };
}

export function checkExecutorModelConfig({ workDir = process.cwd(), config = null } = {}) {
  const claudeAgentPath = path.join(workDir, '.claude', 'agents', 'executor.md');
  if (existsSync(claudeAgentPath)) {
    const text = readFileSync(claudeAgentPath, 'utf8');
    const m = text.match(/^model:[ \t]*(\S.*)$/im);
    if (!m || !isValidModel(m[1])) {
      return [{ ok: false, name: 'Executor model (.claude/agents/executor.md)', detail: '.claude/agents/executor.md must set an explicit "model:" (found inherit or missing)' }];
    }
  }
  const info = resolveExecutorModelInfo({ workDir, config });
  return info.ok ? [] : [{ ok: false, name: 'Executor model', detail: info.detail }];
}

/**
 * Resolves the base commit SHA for checking a task's commits outside the orchestrator loop.
 * If baseRef is provided, resolves it directly.
 * Otherwise, finds the last `^arch:\s` commit before HEAD, or parent of the first task commit, or HEAD.
 * @param {{ realGit: string, workDir: string, taskId: string, baseRef?: string|null }} param0
 * @returns {string} resolved commit SHA
 */
export function resolveBaseShaForTask({ realGit, workDir, taskId, baseRef = null }) {
  if (baseRef) {
    try {
      return git(realGit, workDir, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
    } catch {
      throw new Error(`Cannot resolve --base "${baseRef}" to a commit — ensure the branch/ref is fetched (e.g. fetch-depth: 0)`);
    }
  }
  let logOutput = '';
  try {
    logOutput = git(realGit, workDir, ['log', '--format=%H %s']);
  } catch {
    logOutput = '';
  }
  const lines = logOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  const commits = lines.map((l) => {
    const idx = l.indexOf(' ');
    return idx === -1 ? { sha: l, subject: '' } : { sha: l.slice(0, idx), subject: l.slice(idx + 1) };
  });

  if (commits.length > 0 && /^arch:\s/i.test(commits[0].subject)) return commits[0].sha;
  const archCommit = commits.slice(1).find((c) => /^arch:\s/i.test(c.subject));
  if (archCommit) return archCommit.sha;
  const taskCommitRe = new RegExp(`^${taskId}(?:\\s|\\(fix|:)`);
  const taskCommits = commits.filter((c) => taskCommitRe.test(c.subject));
  const firstTaskCommit = taskCommits.at(-1);
  if (firstTaskCommit) {
    try {
      return git(realGit, workDir, ['rev-parse', `${firstTaskCommit.sha}^`]).trim();
    } catch {
      return commits[0]?.sha ?? 'HEAD';
    }
  }
  return commits[0]?.sha ?? 'HEAD';
}

export const COMMIT_HOOK_MARKER = '// agent-loop commit-msg hook';

export function generateCommitMsgHookScript() {
  return `#!/usr/bin/env node
${COMMIT_HOOK_MARKER}
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const msgFile = process.argv[2];
if (!msgFile || !existsSync(msgFile)) process.exit(0);

const lines = readFileSync(msgFile, 'utf8').split('\\n').filter((l) => !l.startsWith('#'));
const subject = (lines.find((l) => l.trim().length > 0) || '').trim();
if (!subject) process.exit(0);
if (/^Merge\\b/.test(subject)) process.exit(0);

let root = '.';
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { root = '.'; }

let commitLanguage = null;
for (const rel of ['.agents/orchestrator.json', '.architect/config.json']) {
  const p = path.join(root, rel);
  if (existsSync(p)) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      if (cfg && cfg.commitLanguage) { commitLanguage = cfg.commitLanguage; break; }
    } catch { commitLanguage = null; }
  }
}

if (commitLanguage === 'en' && /[^\\P{L}\\p{Script=Latin}]/u.test(subject)) {
  console.error(\`commit-msg: commit subject contains non-Latin characters (commitLanguage is "\${commitLanguage}"): "\${subject}"\`);
  process.exit(1);
}

if (/^t-\\d+/i.test(subject) && !/^T-\\d+(?: \\(fix \\d+\\))?: \\S/.test(subject)) {
  console.error(\`commit-msg: malformed T-NNN commit subject: "\${subject}" (must match T-NNN: ... or T-NNN (fix N): ...)\`);
  process.exit(1);
}

if (/^(?:arch:|arch\\s|arch$)/i.test(subject)) {
  if (!/^arch: \\S/.test(subject)) {
    console.error(\`commit-msg: malformed arch commit subject: "\${subject}" (must match arch: ...)\`);
    process.exit(1);
  }
  if (/^arch:\\s*fix-frozen\\b/i.test(subject) && !/^arch:\\s*fix-frozen\\s+(?:T-\\d+|audit):\\s+\\S/.test(subject)) {
    console.error(\`commit-msg: malformed arch: fix-frozen commit subject: "\${subject}" (must match arch: fix-frozen T-NNN: ...)\`);
    process.exit(1);
  }
  if (/^arch:\\s*accept\\b/i.test(subject) && !/^arch:\\s*accept\\s+T-\\d+\\b/.test(subject)) {
    console.error(\`commit-msg: malformed arch: accept commit subject: "\${subject}" (must start with arch: accept T-NNN)\`);
    process.exit(1);
  }
}

let stagedFiles = [];
try {
  stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).split('\\n').map((f) => f.trim()).filter(Boolean);
} catch { stagedFiles = []; }

if (stagedFiles.length === 1) {
  const f = stagedFiles[0].replace(/\\\\/g, '/');
  if (f === 'PLAN.md' || f === '.architect/PLAN.md' || f.endsWith('/PLAN.md')) {
    let diff = '';
    try { diff = execFileSync('git', ['diff', '--cached', '-U0', '--', stagedFiles[0]], { cwd: root, encoding: 'utf8' }); } catch { diff = ''; }
    const diffLines = diff.split('\\n');
    const added = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removed = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const onlyMarksTaskDone = added.length > 0 &&
      added.every((l) => /^\\+\\s*-\\s*\\[x\\]\\s*T-\\d+:/i.test(l)) &&
      removed.every((l) => /^-\\s*-\\s*\\[ \\]\\s*T-\\d+:/i.test(l));
    if (onlyMarksTaskDone && !/^arch:\\s*(?:accept|приёмка)\\s+T-\\d+\\b/i.test(subject)) {
      console.error(\`commit-msg: commit marking task [x] in PLAN.md must start with "arch: accept T-NNN" or "arch: приёмка T-NNN": "\${subject}"\`);
      process.exit(1);
    }
  }
}
process.exit(0);
`;
}

function getCoreHooksPath({ realGit, workDir }) {
  try {
    return git(realGit, workDir, ['config', '--get', 'core.hooksPath']).trim() || null;
  } catch {
    return null;
  }
}

export function installCommitMsgHook({ workDir = process.cwd(), realGit }) {
  const hooksPath = getCoreHooksPath({ realGit, workDir });
  if (hooksPath) return { installed: false, skipped: true, reason: `core.hooksPath is configured (${hooksPath})` };
  const hookFile = path.join(workDir, '.git', 'hooks', 'commit-msg');
  if (existsSync(hookFile) && !readFileSync(hookFile, 'utf8').includes(COMMIT_HOOK_MARKER)) {
    return { installed: false, skipped: true, reason: 'existing custom .git/hooks/commit-msg' };
  }
  mkdirSync(path.dirname(hookFile), { recursive: true });
  writeFileSync(hookFile, generateCommitMsgHookScript(), { mode: 0o755 });
  return { installed: true, skipped: false, hookPath: hookFile };
}

export function checkCommitMsgHook({ workDir = process.cwd(), realGit }) {
  const hooksPath = getCoreHooksPath({ realGit, workDir });
  if (hooksPath) return { ok: false, name: 'commit-msg hook', detail: `core.hooksPath is configured (${hooksPath})` };
  const hookFile = path.join(workDir, '.git', 'hooks', 'commit-msg');
  if (!existsSync(hookFile)) return { ok: false, name: 'commit-msg hook', detail: 'commit-msg hook is not installed (run with --install-hooks)' };
  if (!readFileSync(hookFile, 'utf8').includes(COMMIT_HOOK_MARKER)) {
    return { ok: false, name: 'commit-msg hook', detail: 'existing custom .git/hooks/commit-msg without agent-loop marker' };
  }
  return { ok: true, name: 'commit-msg hook', detail: 'installed (.git/hooks/commit-msg)' };
}

export function validateCommitMessage({ subject, commitLanguage = null, stagedFiles = [], planDiff = '', isMerge = false } = {}) {
  const s = String(subject ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!s || isMerge || /^Merge\b/.test(s)) return { ok: true, error: null };

  if (commitLanguage === 'en' && /[^\P{L}\p{Script=Latin}]/u.test(s)) {
    return { ok: false, error: `commit subject contains non-Latin characters (commitLanguage is "${commitLanguage}")` };
  }

  const isTask = /^T-\d+(?: \(fix \d+\))?: \S/.test(s);
  const isArch = /^arch: \S/.test(s);

  if (/^t-\d+/i.test(s) && !isTask) return { ok: false, error: 'malformed T-NNN commit subject: must match /^T-\\d+(?: \\(fix \\d+\\))?: \\S/' };
  if (/^(?:arch:|arch\s|arch$)/i.test(s)) {
    if (!isArch) return { ok: false, error: 'malformed arch commit subject: must match /^arch: \\S/' };
    if (/^arch:\s*fix-frozen\b/i.test(s) && !/^arch:\s*fix-frozen\s+(?:T-\d+|audit):\s+\S/.test(s)) {
      return { ok: false, error: 'malformed arch: fix-frozen commit subject' };
    }
    if (/^arch:\s*accept\b/i.test(s) && !/^arch:\s*accept\s+T-\d+\b/.test(s)) {
      return { ok: false, error: 'malformed arch: accept commit subject: must start with arch: accept T-NNN' };
    }
  }

  if (!isTask && !isArch) return { ok: false, error: 'commit subject must start with T-NNN: or arch:' };

  const files = Array.isArray(stagedFiles) ? stagedFiles : [];
  if (files.length === 1) {
    const f = files[0].replace(/\\/g, '/').replace(/^\.\//, '');
    if (f === 'PLAN.md' || f === '.architect/PLAN.md' || f.endsWith('/PLAN.md')) {
      const diffLines = planDiff ? planDiff.split('\n') : [];
      const added = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      const removed = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
      const onlyMarksTaskDone = added.length > 0 &&
        added.every((l) => /^\+\s*-\s*\[x\]\s*T-\d+:/i.test(l)) &&
        removed.every((l) => /^-\s*-\s*\[ \]\s*T-\d+:/i.test(l));
      if (onlyMarksTaskDone && !/^arch:\s*(?:accept|приёмка)\s+T-\d+\b/i.test(s)) {
        return { ok: false, error: 'commit marking task [x] in PLAN.md must start with "arch: accept T-NNN" or "arch: приёмка T-NNN"' };
      }
    }
  }

  return { ok: true, error: null };
}

export function scanRangeCommitMessages({ realGit, workDir = process.cwd(), cwd = workDir, baseSha, headSha = 'HEAD', commitLanguage = null }) {
  const dir = cwd || workDir;
  const warnings = [];
  if (!baseSha || baseSha === headSha) return warnings;
  let logOut = '';
  try {
    logOut = git(realGit, dir, ['rev-list', '--reverse', `${baseSha}..${headSha}`]);
  } catch {
    /* cleanup: abort reading revisions */
    return warnings;
  }
  const shas = logOut.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const sha of shas) {
    let subject = '', files = [], isMerge = false;
    try {
      subject = git(realGit, dir, ['show', '-s', '--format=%s', sha]);
      const parents = git(realGit, dir, ['show', '-s', '--format=%P', sha]).trim().split(/\s+/).filter(Boolean);
      isMerge = parents.length > 1;
      files = git(realGit, dir, ['show', '--name-only', '--no-renames', '--format=', sha]).split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      /* cleanup: abort inspecting commit */
      continue;
    }
    let planDiff = '';
    if (files.length === 1) {
      const f = files[0].replace(/\\/g, '/').replace(/^\.\//, '');
      if (f === 'PLAN.md' || f === '.architect/PLAN.md' || f.endsWith('/PLAN.md')) {
        try { planDiff = git(realGit, dir, ['show', '-U0', sha, '--', files[0]]); } catch { /* cleanup: abort plan diff */ planDiff = ''; }
      }
    }
    const res = validateCommitMessage({ subject, commitLanguage, stagedFiles: files, planDiff, isMerge });
    if (!res.ok) warnings.push(`commit ${sha.slice(0, 7)}: ${res.error} ("${subject}")`);
  }
  return warnings;
}

export function scanRangeProcessWarnings(allCommits, { isTestFile, isUnderScanPaths, config, norm } = {}) {
  const warnings = [];
  if (!Array.isArray(allCommits) || allCommits.length === 0) return warnings;
  const n = norm ?? ((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  const isTest = isTestFile ?? (() => false);
  const isUnder = isUnderScanPaths ?? (() => true);
  const warnedTasks = new Set();
  const TASK_RE = /^(T-\d+)(?:\s*\(fix\s+\d+\))?:/;
  const CLOSE_RE = /^arch:\s*(?:close cycle|закрытие цикла)\b/i;
  const ARCH_IGNORED_RE = /^arch:\s*(?:plan|план|accept|приёмка|close cycle|закрытие цикла|fix-frozen|init|update)\b/i;

  for (let i = 0; i < allCommits.length; i++) {
    const m = allCommits[i].subject.match(TASK_RE);
    if (!m) continue;
    const taskId = m[1];
    if (warnedTasks.has(taskId)) continue;
    if (!allCommits.slice(i + 1).some((c) => CLOSE_RE.test(c.subject))) continue;
    const acceptRe = new RegExp(`^arch:\\s*(?:accept|приёмка)\\s+${taskId}\\b`, 'i');
    if (!allCommits.some((c) => acceptRe.test(c.subject))) {
      warnedTasks.add(taskId);
      warnings.push(`task ${taskId} has no "arch: accept ${taskId}" / "arch: приёмка ${taskId}" commit before cycle close`);
    }
  }

  for (const c of allCommits) {
    if (!/^arch:/i.test(c.subject) || ARCH_IGNORED_RE.test(c.subject)) continue;
    if (c.files.some((tf) => isTest(n(tf), config?.testFilePatterns))) continue;
    for (const rawFile of c.files) {
      const f = n(rawFile);
      if (isUnder(f, config?.bypassScanPaths) && !isTest(f, config?.testFilePatterns) && !f.endsWith('.md') && !f.endsWith('.json')) {
        warnings.push(`commit ${c.sha.slice(0, 7)} ("${c.subject}") modifies ${f} in bypassScanPaths without test changes or NOT VERIFIED`);
      }
    }
  }

  return warnings;
}
