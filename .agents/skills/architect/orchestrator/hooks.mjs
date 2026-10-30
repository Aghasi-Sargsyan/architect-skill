// Commit hooks and Executor model configuration checks.
import { existsSync, readFileSync } from 'node:fs';
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
export function checkExecutorModelConfig({ workDir = process.cwd(), config = null } = {}) {
  const problems = [];
  const claudeAgentPath = path.join(workDir, '.claude', 'agents', 'executor.md');
  let claudeModel = null;
  let hasClaudeFile = false;

  if (existsSync(claudeAgentPath)) {
    hasClaudeFile = true;
    const text = readFileSync(claudeAgentPath, 'utf8');
    const m = text.match(/^model:\s*(.+)$/im);
    if (!m || m[1].trim().toLowerCase() === 'inherit') {
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

  if (config && !config._missingConfigFile && config.executor?.model) {
    const m = String(config.executor.model).trim();
    if (m && m.toLowerCase() !== 'inherit') configured = true;
  }

  if (!configured) {
    for (const rel of ['.agents/orchestrator.json', '.architect/config.json']) {
      const full = path.join(workDir, rel);
      if (existsSync(full)) {
        try {
          const raw = JSON.parse(readFileSync(full, 'utf8'));
          const m = raw?.executor?.model;
          if (typeof m === 'string' && m.trim() && m.trim().toLowerCase() !== 'inherit') {
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
        if (candidate && candidate.toLowerCase() !== 'inherit') {
          configured = true;
          break;
        }
      }
    }
  }

  if (!configured && hasClaudeFile && claudeModel && claudeModel.toLowerCase() !== 'inherit') {
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
