// Self-update module: updates installed skill folder, syncs EXECUTOR.md, and refreshes git hooks.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockHolder, which } from './guards.mjs';
import { resolveSkillUpdateTargets } from './skill-targets.mjs';
import { installCommitMsgHook } from './hooks.mjs';
import { DEFAULT_SKILL_REPO_URL, readSkillVersion, resolveLatestReleaseTag } from './update-tags.mjs';

export { DEFAULT_SKILL_REPO_URL, UPDATE_CACHE_TTL_MS, readSkillVersion, checkSkillUpdateAvailable } from './update-tags.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

function assertNoEscapingSymlinks(rootDir) {
  const realRoot = realpathSync(rootDir);
  const visit = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        let targetReal = '';
        try { targetReal = realpathSync(full); } catch {
          throw new Error(`cloned skill directory contains broken symlink: ${path.relative(rootDir, full)}`);
        }
        if (targetReal !== realRoot && !targetReal.startsWith(`${realRoot}${path.sep}`)) {
          throw new Error(`cloned skill directory contains symlink escaping skill root: ${path.relative(rootDir, full)}`);
        }
      } else if (lst.isDirectory()) {
        visit(full);
      }
    }
  };
  visit(rootDir);
}

/**
 * Updates the installed architect skill in workDir from repoUrl.
 * Without `ref` (argument or ARCHITECT_UPDATE_REF) installs the newest release tag (vMAJOR.MINOR.PATCH).
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, ref?: string, realGit?: string, force?: boolean }} param0
 */
export async function updateSkill({ workDir = process.cwd(), orchestratorDir, repoUrl, ref, realGit, force = false } = {}) {
  if (process.env.AGENT_LOOP === '1') {
    throw new Error('cannot update skill from inside the agent loop (AGENT_LOOP=1)');
  }

  const effectiveOrchDir = orchestratorDir ?? orchDir;
  const { targets: targetDirs, skipped: skippedDirs } = resolveSkillUpdateTargets({
    workDir,
    orchestratorDir: effectiveOrchDir,
  });

  if (targetDirs.length === 0) {
    throw new Error(`no installed architect skill found in ${workDir} (checked .agents/skills/architect and .claude/skills/architect)`);
  }

  const beforeVersion = readSkillVersion(targetDirs[0]);
  const g = realGit ?? which('git');
  const targetRepo = repoUrl ?? process.env.ARCHITECT_SKILL_REPO_URL ?? DEFAULT_SKILL_REPO_URL;

  if (!force) {
    const activePid = lockHolder(path.join(workDir, '.agent-runs'));
    if (activePid !== null) {
      throw new Error(`cannot update skill while orchestrator loop is running (PID ${activePid} in .agent-runs/.lock); wait for the loop to finish or re-run with --update --force`);
    }
  }

  if (!force && g && existsSync(path.join(workDir, '.git'))) {
    const checkPaths = [
      ...targetDirs,
      path.join(workDir, 'EXECUTOR.md'),
      path.join(workDir, '.architect', 'EXECUTOR.md'),
    ].filter((p) => existsSync(p));
    if (checkPaths.length > 0) {
      const res = spawnSync(g, ['status', '--porcelain', '--untracked-files=no', '--', ...checkPaths], { cwd: workDir, encoding: 'utf8' });
      if (res.status === 0 && res.stdout && res.stdout.trim()) {
        const dirtyFiles = res.stdout.trim().split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
        if (dirtyFiles.length > 0) {
          throw new Error('uncommitted changes in skill files (' + dirtyFiles.join(', ') + '); commit or revert them first, or re-run with --update --force');
        }
      }
    }
  }

  const targetRef = ref ?? process.env.ARCHITECT_UPDATE_REF ?? null;
  let tag = null;
  if (!targetRef) {
    const latest = resolveLatestReleaseTag({ realGit: g, repoUrl: targetRepo });
    if (!latest.ok) {
      throw new Error(latest.reason === 'no-release-tags'
        ? `no release tags (vMAJOR.MINOR.PATCH) in ${targetRepo}; to update from a branch set ARCHITECT_UPDATE_REF=<branch>`
        : `cannot reach ${targetRepo} to find the latest release tag: ${latest.detail}`);
    }
    tag = latest.tag;
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'architect-skill-update-'));
  try {
    const cloneDir = path.join(tmpDir, 'repo');
    if (tag) {
      execFileSync(g, ['clone', '--depth', '1', '--branch', tag, targetRepo, cloneDir], { stdio: 'pipe' });
    } else {
      execFileSync(g, ['clone', targetRepo, cloneDir], { stdio: 'pipe' });
      execFileSync(g, ['checkout', '--detach', targetRef], { cwd: cloneDir, stdio: 'pipe' });
    }
    const commitSha = execFileSync(g, ['rev-parse', '--short', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    if (!/^[0-9a-fA-F]{7,40}$/.test(commitSha)) {
      throw new Error(`invalid commit SHA from cloned repository: "${commitSha}"`);
    }

    let sourceSkillDir = path.join(cloneDir, '.agents', 'skills', 'architect');
    if (!existsSync(sourceSkillDir)) sourceSkillDir = path.join(cloneDir, '.claude', 'skills', 'architect');
    if (!existsSync(sourceSkillDir) && existsSync(path.join(cloneDir, 'SKILL.md'))) sourceSkillDir = cloneDir;

    const skillMd = path.join(sourceSkillDir, 'SKILL.md'), execMd = path.join(sourceSkillDir, 'EXECUTOR.md');
    if (!existsSync(skillMd) || !existsSync(execMd)) {
      throw new Error(`cloned skill repository is missing SKILL.md or EXECUTOR.md (looked in ${sourceSkillDir})`);
    }
    assertNoEscapingSymlinks(sourceSkillDir);

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

    const cachePath = path.join(workDir, '.agent-runs', '.update-check.json');
    rmSync(cachePath, { force: true });

    return {
      ok: true,
      beforeVersion,
      afterVersion,
      commitSha,
      tag,
      targetDirs,
      skippedDirs,
      hookResult,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * CLI handler for --update.
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, realGit?: string, force?: boolean, print?: (msg: string) => void }} param0
 */
export async function handleUpdateCli({ workDir = process.cwd(), orchestratorDir, repoUrl, realGit, force = false, print = console.log } = {}) {
  try {
    const res = await updateSkill({ workDir, orchestratorDir, repoUrl, realGit, force });
    print(`• Architect Skill updated: ${res.afterVersion} (${res.commitSha})`);
    for (const d of res.targetDirs) {
      print(`  updated: ${path.relative(workDir, d) || d}`);
    }
    for (const d of res.skippedDirs ?? []) {
      print(`  skipped (outside project): ${path.relative(workDir, d) || d}`);
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
    return { ok: false, error: msg };
  }
}
