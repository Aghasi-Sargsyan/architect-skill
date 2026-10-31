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
 *    - in AGENTS.md or CLAUDE.md ("Executor model: ...", "Модель Исполнителя: ...", "Исполнитель по умолчанию — ...")
 *    - in .claude/agents/executor.md ("model: <name>")
 * @param {{ workDir?: string, config?: object }} param0
 * @returns {Array<{ ok: boolean, name: string, detail: string }>}
 */
const isValidModel = (val) => {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  return Boolean(s) && s.toLowerCase() !== 'inherit' && !/^<.*>$/.test(s);
};

export function checkExecutorModelConfig({ workDir = process.cwd(), config = null } = {}) {
  const problems = [];
  const claudeAgentPath = path.join(workDir, '.claude', 'agents', 'executor.md');
  let claudeModel = null;
  let hasClaudeFile = false;

  if (existsSync(claudeAgentPath)) {
    hasClaudeFile = true;
    const text = readFileSync(claudeAgentPath, 'utf8');
    const m = text.match(/^model:\s*(.+)$/im);
    if (!m || !isValidModel(m[1])) {
      problems.push({
        ok: false,
        name: 'Executor model (.claude/agents/executor.md)',
        detail: '.claude/agents/executor.md must set an explicit "model:" (found inherit or missing)',
      });
      return problems;
    }
    claudeModel = m[1].trim();
  }

  let configured = false;

  if (config && !config._missingConfigFile && isValidModel(config.executor?.model)) {
    configured = true;
  }

  if (!configured) {
    for (const rel of ['.agents/orchestrator.json', '.architect/config.json']) {
      const full = path.join(workDir, rel);
      if (existsSync(full)) {
        try {
          const raw = JSON.parse(readFileSync(full, 'utf8'));
          if (isValidModel(raw?.executor?.model)) {
            configured = true;
            break;
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    }
  }

  if (!configured) {
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const full = path.join(workDir, file);
      if (existsSync(full)) {
        const text = readFileSync(full, 'utf8');
        const m1 = text.match(/(?:Executor model|Модель Исполнителя)\s*:\s*([^\n]+)/i);
        const m2 = text.match(/Исполнитель по умолчанию\s*[—–-]\s*([^\n.]+)/i);
        const candidate = (m1 ? m1[1] : (m2 ? m2[1] : '')).trim();
        if (isValidModel(candidate)) {
          configured = true;
          break;
        }
      }
    }
  }

  if (!configured && hasClaudeFile && isValidModel(claudeModel)) {
    configured = true;
  }

  if (!configured) {
    problems.push({
      ok: false,
      name: 'Executor model',
      detail: 'Executor model is not configured — set executor.model in .agents/orchestrator.json, "Executor model: ..." in AGENTS.md, or model in .claude/agents/executor.md',
    });
  }

  return problems;
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
      return git(realGit, workDir, ['rev-parse', baseRef]).trim();
    } catch {
      return baseRef;
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
  if (hooksPath) {
    return { installed: false, skipped: true, reason: `core.hooksPath is configured (${hooksPath})` };
  }
  const hookFile = path.join(workDir, '.git', 'hooks', 'commit-msg');
  if (existsSync(hookFile)) {
    const content = readFileSync(hookFile, 'utf8');
    if (!content.includes(COMMIT_HOOK_MARKER)) {
      return { installed: false, skipped: true, reason: 'existing custom .git/hooks/commit-msg' };
    }
  }
  mkdirSync(path.dirname(hookFile), { recursive: true });
  writeFileSync(hookFile, generateCommitMsgHookScript(), { mode: 0o755 });
  return { installed: true, skipped: false, hookPath: hookFile };
}

export function checkCommitMsgHook({ workDir = process.cwd(), realGit }) {
  const hooksPath = getCoreHooksPath({ realGit, workDir });
  if (hooksPath) {
    return { ok: false, name: 'commit-msg hook', detail: `core.hooksPath is configured (${hooksPath})` };
  }
  const hookFile = path.join(workDir, '.git', 'hooks', 'commit-msg');
  if (!existsSync(hookFile)) {
    return { ok: false, name: 'commit-msg hook', detail: 'commit-msg hook is not installed (run with --install-hooks)' };
  }
  const content = readFileSync(hookFile, 'utf8');
  if (!content.includes(COMMIT_HOOK_MARKER)) {
    return { ok: false, name: 'commit-msg hook', detail: 'existing custom .git/hooks/commit-msg without agent-loop marker' };
  }
  return { ok: true, name: 'commit-msg hook', detail: 'installed (.git/hooks/commit-msg)' };
}

export function validateCommitMessage({ subject, commitLanguage = null, stagedFiles = [], planDiff = '' } = {}) {
  const s = String(subject ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!s) return { ok: true, error: null };

  if (commitLanguage === 'en' && /[^\P{L}\p{Script=Latin}]/u.test(s)) {
    return { ok: false, error: `commit subject contains non-Latin characters (commitLanguage is "${commitLanguage}")` };
  }

  if (/^t-\d+/i.test(s) && !/^T-\d+(?: \(fix \d+\))?: \S/.test(s)) {
    return { ok: false, error: 'malformed T-NNN commit subject: must match /^T-\\d+(?: \\(fix \\d+\\))?: \\S/' };
  }

  if (/^(?:arch:|arch\s|arch$)/i.test(s)) {
    if (!/^arch: \S/.test(s)) {
      return { ok: false, error: 'malformed arch commit subject: must match /^arch: \\S/' };
    }
    if (/^arch:\s*fix-frozen\b/i.test(s) && !/^arch:\s*fix-frozen\s+(?:T-\d+|audit):\s+\S/.test(s)) {
      return { ok: false, error: 'malformed arch: fix-frozen commit subject' };
    }
    if (/^arch:\s*accept\b/i.test(s) && !/^arch:\s*accept\s+T-\d+\b/.test(s)) {
      return { ok: false, error: 'malformed arch: accept commit subject: must start with arch: accept T-NNN' };
    }
  }

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
    return warnings;
  }
  const shas = logOut.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const sha of shas) {
    let subject = '';
    let files = [];
    try {
      subject = git(realGit, dir, ['show', '-s', '--format=%s', sha]);
      files = git(realGit, dir, ['show', '--name-only', '--no-renames', '--format=', sha]).split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      continue;
    }
    let planDiff = '';
    if (files.length === 1) {
      const f = files[0].replace(/\\/g, '/').replace(/^\.\//, '');
      if (f === 'PLAN.md' || f === '.architect/PLAN.md' || f.endsWith('/PLAN.md')) {
        try { planDiff = git(realGit, dir, ['show', '-U0', sha, '--', files[0]]); } catch { planDiff = ''; }
      }
    }
    const res = validateCommitMessage({ subject, commitLanguage, stagedFiles: files, planDiff });
    if (!res.ok) {
      warnings.push(`commit ${sha.slice(0, 7)}: ${res.error} ("${subject}")`);
    }
  }
  return warnings;
}
