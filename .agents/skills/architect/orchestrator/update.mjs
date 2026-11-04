// Self-update module: updates installed skill folder, syncs EXECUTOR.md, and refreshes git hooks.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { resolveInstalledSkillDir } from './layout.mjs';
import { installCommitMsgHook } from './hooks.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SKILL_REPO_URL = 'https://github.com/Aghasi-Sargsyan/architect-skill.git';

/**
 * Reads skill prompt version and executor policy version from a skill directory.
 * @param {string} skillDir
 * @returns {string} e.g. "v3.30 / 1.8"
 */
export function readSkillVersion(skillDir) {
  let skillVer = 'unknown';
  let execVer = 'unknown';
  if (skillDir && existsSync(skillDir)) {
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (existsSync(skillMd)) {
      const match = readFileSync(skillMd, 'utf8').match(/^# Architect Prompt\s+(v?[0-9.]+)/m);
      if (match) skillVer = match[1];
    }
    const execMd = path.join(skillDir, 'EXECUTOR.md');
    if (existsSync(execMd)) {
      const match = readFileSync(execMd, 'utf8').match(/<!--\s*executor-policy-version:\s*([0-9.]+)\s*-->/);
      if (match) execVer = match[1];
    }
  }
  return `${skillVer} / ${execVer}`;
}

/**
 * Updates the installed architect skill in workDir from repoUrl.
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, realGit?: string }} param0
 */
export async function updateSkill({ workDir = process.cwd(), orchestratorDir, repoUrl, realGit } = {}) {
  if (process.env.AGENT_LOOP === '1') {
    throw new Error('cannot update skill from inside the agent loop (AGENT_LOOP=1)');
  }

  const effectiveOrchDir = orchestratorDir ?? orchDir;
  const targetDirs = [];
  const seen = new Set();
  const candidates = [
    path.join(workDir, '.agents', 'skills', 'architect'),
    path.join(workDir, '.claude', 'skills', 'architect'),
  ];
  const resolved = resolveInstalledSkillDir(workDir, effectiveOrchDir);
  if (resolved) candidates.push(resolved);

  for (const c of candidates) {
    if (existsSync(c)) {
      const abs = path.resolve(c);
      if (!seen.has(abs)) {
        seen.add(abs);
        targetDirs.push(abs);
      }
    }
  }

  if (targetDirs.length === 0) {
    throw new Error(`no installed architect skill found in ${workDir} (checked .agents/skills/architect and .claude/skills/architect)`);
  }

  const beforeVersion = readSkillVersion(targetDirs[0]);
  const g = realGit ?? which('git');
  const targetRepo = repoUrl ?? process.env.ARCHITECT_SKILL_REPO_URL ?? DEFAULT_SKILL_REPO_URL;

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'architect-skill-update-'));
  try {
    const cloneDir = path.join(tmpDir, 'repo');
    execFileSync(g, ['clone', '--depth', '1', targetRepo, cloneDir], { stdio: 'pipe' });
    const commitSha = execFileSync(g, ['rev-parse', '--short', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();

    let sourceSkillDir = path.join(cloneDir, '.agents', 'skills', 'architect');
    if (!existsSync(sourceSkillDir)) {
      sourceSkillDir = path.join(cloneDir, '.claude', 'skills', 'architect');
    }
    if (!existsSync(sourceSkillDir) && existsSync(path.join(cloneDir, 'SKILL.md'))) {
      sourceSkillDir = cloneDir;
    }

    const skillMd = path.join(sourceSkillDir, 'SKILL.md');
    const execMd = path.join(sourceSkillDir, 'EXECUTOR.md');
    if (!existsSync(skillMd) || !existsSync(execMd)) {
      throw new Error(`cloned skill repository is missing SKILL.md or EXECUTOR.md (looked in ${sourceSkillDir})`);
    }

    const afterVersion = readSkillVersion(sourceSkillDir);

    for (const dir of targetDirs) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      cpSync(sourceSkillDir, dir, {
        recursive: true,
        filter: (src) => !src.split(path.sep).includes('.git'),
      });
      writeFileSync(path.join(dir, '.version'), `${afterVersion} (${commitSha})\n`);
    }

    const rootExec = path.join(workDir, 'EXECUTOR.md');
    if (existsSync(rootExec)) {
      cpSync(execMd, rootExec);
    }
    const compactExec = path.join(workDir, '.architect', 'EXECUTOR.md');
    if (existsSync(compactExec)) {
      cpSync(execMd, compactExec);
    }

    const hookResult = installCommitMsgHook({ workDir, realGit: g });

    return {
      ok: true,
      beforeVersion,
      afterVersion,
      commitSha,
      targetDirs,
      hookResult,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * CLI handler for --update.
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, realGit?: string, print?: (msg: string) => void }} param0
 */
export async function handleUpdateCli({ workDir = process.cwd(), orchestratorDir, repoUrl, realGit, print = console.log } = {}) {
  try {
    const res = await updateSkill({ workDir, orchestratorDir, repoUrl, realGit });
    print(`• Architect Skill updated: ${res.afterVersion} (${res.commitSha})`);
    for (const d of res.targetDirs) {
      print(`  updated: ${path.relative(workDir, d) || d}`);
    }
    if (res.hookResult?.installed) {
      print('• installed .git/hooks/commit-msg');
    } else if (res.hookResult?.reason) {
      print(`• commit-msg hook: ${res.hookResult.reason}`);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print(`✗ Update failed: ${msg}`);
    process.exitCode = 1;
    return { ok: false, error: msg };
  }
}
