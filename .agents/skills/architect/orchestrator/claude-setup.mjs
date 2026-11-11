// Claude Code project setup: runner choice for `--init`, skill discovery link, and non-blocking `--check` warnings.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runner for a config created by `--init`.
 * Returns `'claude'` only when `env.CLAUDECODE === '1'` AND `hasBin('agy')` is false AND `hasBin('claude')` is true.
 * Otherwise returns `null`, and `initProject` keeps today's output (no `runner` key, so the default stays `agy`).
 * The defaults (`env = {}`, `hasBin = () => false`) never detect anything: only the CLI entry passes `process.env`.
 * @param {{ env?: Record<string, string | undefined>, hasBin?: (bin: string) => boolean }} param0
 * @returns {'claude' | null}
 */
export function detectInitRunner({ env = {}, hasBin = () => false } = {}) {
  if (env?.CLAUDECODE === '1' && !hasBin('agy') && Boolean(hasBin('claude'))) {
    return 'claude';
  }
  return null;
}

/**
 * Makes an `.agents/skills/architect` install discoverable by Claude Code through a relative symlink
 * `<workDir>/.claude/skills/architect -> ../../.agents/skills/architect`.
 *
 * Returns `{ created: false, reason }` and changes nothing when any of these holds:
 * - neither `env.CLAUDECODE === '1'` nor `runner === 'claude'`;
 * - `skillDir` is null/empty, or `realpathSync(skillDir)` is not `<realpathSync(workDir)>/.agents/skills/architect`;
 * - `<workDir>/.claude/skills/architect` already exists according to `lstatSync` (a directory, a file, a valid
 *   or a dangling symlink) — it is never overwritten or deleted.
 * Otherwise creates `<workDir>/.claude/skills` (recursive) and the symlink (`symlinkSync(target, link, 'dir')`)
 * and returns `{ created: true, reason }` where `reason` contains `.claude/skills/architect`.
 * Filesystem errors other than "link path does not exist" propagate (fail-closed).
 * @param {{ workDir: string, skillDir: string | null, env?: Record<string, string | undefined>, runner?: string | null }} param0
 * @returns {{ created: boolean, reason: string }}
 */
export function ensureClaudeSkillLink({ workDir, skillDir, env = {}, runner = null } = {}) {
  const isClaude = env?.CLAUDECODE === '1' || runner === 'claude';
  if (!isClaude) {
    return { created: false, reason: 'not inside Claude Code or claude runner' };
  }
  if (!skillDir) {
    return { created: false, reason: 'skill directory is not specified' };
  }

  const realSkill = realpathSync(skillDir);
  const expectedAgentsDir = path.join(realpathSync(workDir), '.agents', 'skills', 'architect');
  if (realSkill !== expectedAgentsDir) {
    return { created: false, reason: `skill directory is not ${expectedAgentsDir}` };
  }

  const linkPath = path.join(workDir, '.claude', 'skills', 'architect');
  let linkExists = false;
  try {
    lstatSync(linkPath);
    linkExists = true;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      linkExists = false;
    } else {
      throw err;
    }
  }
  if (linkExists) {
    return { created: false, reason: `link path already exists: ${linkPath}` };
  }

  mkdirSync(path.dirname(linkPath), { recursive: true });
  const target = path.join('..', '..', '.agents', 'skills', 'architect');
  symlinkSync(target, linkPath, 'dir');
  return { created: true, reason: 'linked .claude/skills/architect -> ../../.agents/skills/architect' };
}

/**
 * Non-blocking Claude Code setup warnings for `--check` (printed as `! <name>: <detail>`, never affecting the exit code).
 *
 * 1. `{ name: 'Claude Code skill', detail }` — only when `runner === 'claude'` or `<workDir>/.claude` exists
 *    (`lstatSync`), and neither `<workDir>/.claude/skills/architect/SKILL.md` nor
 *    `<home>/.claude/skills/architect/SKILL.md` exists (`existsSync`, links followed).
 *    `detail` contains "not discoverable" and `.claude/skills/architect`.
 * 2. `{ name: 'CLAUDE.md', detail }` — only when `<workDir>/AGENTS.md` exists and contains `EXECUTOR.md`, at least one
 *    Claude memory file exists among `<workDir>/CLAUDE.md`, `<workDir>/.claude/CLAUDE.md`, `<workDir>/CLAUDE.local.md`,
 *    and none of the existing ones has a line matching `/^\s*@(?:\.\/)?AGENTS\.md\s*$/m` or contains `EXECUTOR.md`.
 *    Claude Code skips `AGENTS.md` when a `CLAUDE.md` exists; `detail` contains `@AGENTS.md`.
 * Warnings come in this order; otherwise returns `[]`. `home` defaults to `os.homedir()`.
 * @param {{ workDir: string, runner?: string | null, home?: string }} param0
 * @returns {Array<{ name: string, detail: string }>}
 */
export function checkClaudeSetup({ workDir, runner = null, home } = {}) {
  const warnings = [];
  const effectiveHome = home ?? os.homedir();

  let dotClaudeExists = false;
  try {
    lstatSync(path.join(workDir, '.claude'));
    dotClaudeExists = true;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      dotClaudeExists = false;
    } else {
      throw err;
    }
  }

  if (runner === 'claude' || dotClaudeExists) {
    const projectSkill = path.join(workDir, '.claude', 'skills', 'architect', 'SKILL.md');
    const userSkill = path.join(effectiveHome, '.claude', 'skills', 'architect', 'SKILL.md');
    if (!existsSync(projectSkill) && !existsSync(userSkill)) {
      warnings.push({
        name: 'Claude Code skill',
        detail: 'skill is not discoverable by Claude Code (missing .claude/skills/architect/SKILL.md)',
      });
    }
  }

  const agentsPath = path.join(workDir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const agentsText = readFileSync(agentsPath, 'utf8');
    if (agentsText.includes('EXECUTOR.md')) {
      const memoryFiles = [
        path.join(workDir, 'CLAUDE.md'),
        path.join(workDir, '.claude', 'CLAUDE.md'),
        path.join(workDir, 'CLAUDE.local.md'),
      ];
      const existing = memoryFiles.filter((f) => existsSync(f));
      if (existing.length > 0) {
        const importPattern = /^\s*@(?:\.\/)?AGENTS\.md\s*$/m;
        const covered = existing.some((f) => {
          const content = readFileSync(f, 'utf8');
          return importPattern.test(content) || content.includes('EXECUTOR.md');
        });
        if (!covered) {
          warnings.push({
            name: 'CLAUDE.md',
            detail: 'Claude memory file hides AGENTS.md; import @AGENTS.md or include EXECUTOR.md instructions',
          });
        }
      }
    }
  }

  return warnings;
}
