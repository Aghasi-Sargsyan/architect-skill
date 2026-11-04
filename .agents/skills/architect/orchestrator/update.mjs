// Self-update module: updates installed skill folder, syncs EXECUTOR.md, and refreshes git hooks.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { resolveInstalledSkillDir } from './layout.mjs';
import { installCommitMsgHook } from './hooks.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SKILL_REPO_URL = 'https://github.com/Aghasi-Sargsyan/architect-skill.git';
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, realGit?: string, force?: boolean }} param0
 */
export async function updateSkill({ workDir = process.cwd(), orchestratorDir, repoUrl, realGit, force = false } = {}) {
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

    const cachePath = path.join(workDir, '.agent-runs', '.update-check.json');
    rmSync(cachePath, { force: true });

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
 * @param {{ workDir?: string, orchestratorDir?: string, repoUrl?: string, realGit?: string, force?: boolean, print?: (msg: string) => void }} param0
 */
export async function handleUpdateCli({ workDir = process.cwd(), orchestratorDir, repoUrl, realGit, force = false, print = console.log } = {}) {
  try {
    const res = await updateSkill({ workDir, orchestratorDir, repoUrl, realGit, force });
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
    return { ok: false, error: msg };
  }
}

/**
 * Checks whether an update for the installed skill is available from upstream repository.
 * Non-blocking, fails open on network errors, caches result for 24h.
 * @param {{
 *   workDir?: string,
 *   orchestratorDir?: string,
 *   repoUrl?: string,
 *   realGit?: string,
 *   nowMs?: number,
 *   ttlMs?: number,
 *   env?: Record<string, string | undefined>,
 *   force?: boolean,
 * }} [param0]
 * @returns {{
 *   updateAvailable: boolean,
 *   localSha?: string,
 *   remoteSha?: string | null,
 *   notice: string | null,
 *   cached?: boolean,
 * }}
 */
export function checkSkillUpdateAvailable({
  workDir = process.cwd(),
  orchestratorDir,
  repoUrl,
  realGit,
  nowMs,
  ttlMs = UPDATE_CACHE_TTL_MS,
  env = process.env,
  force = false,
} = {}) {
  const effectiveOrchDir = orchestratorDir ?? orchDir;
  let targetSkillDir = null;
  const candidates = [
    path.join(workDir, '.agents', 'skills', 'architect'),
    path.join(workDir, '.claude', 'skills', 'architect'),
  ];
  const resolved = resolveInstalledSkillDir(workDir, effectiveOrchDir);
  if (resolved) candidates.push(resolved);
  for (const c of candidates) {
    if (existsSync(c)) {
      targetSkillDir = c;
      break;
    }
  }

  let ver = 'unknown';
  let localSha = '';
  if (targetSkillDir) {
    const versionFile = path.join(targetSkillDir, '.version');
    if (existsSync(versionFile)) {
      try {
        const content = readFileSync(versionFile, 'utf8').trim();
        const match = content.match(/^(.*?)(?:\s+\(([0-9a-fA-F]+)\))?\s*$/);
        if (match && match[1]) ver = match[1].trim();
        if (match && match[2]) localSha = match[2].trim();
      } catch (err) {
        // failed reading .version file: fall back to readSkillVersion
        ver = readSkillVersion(targetSkillDir);
      }
    } else {
      ver = readSkillVersion(targetSkillDir);
    }
  }

  const now = typeof nowMs === 'number' ? nowMs : Number(new Date());
  const effectiveTtl = typeof ttlMs === 'number' ? ttlMs : UPDATE_CACHE_TTL_MS;
  const cacheFile = path.join(workDir, '.agent-runs', '.update-check.json');

  if (!force && existsSync(cacheFile)) {
    try {
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
      const shaMatches = cache?.localSha === localSha ||
        (!localSha && Boolean(cache?.localSha && cache?.remoteSha && cache.localSha === cache.remoteSha.slice(0, 7)));
      if (
        cache &&
        typeof cache.checkedAt === 'number' &&
        (now - cache.checkedAt) >= 0 &&
        (now - cache.checkedAt) < effectiveTtl &&
        shaMatches
      ) {
        return {
          updateAvailable: Boolean(cache.updateAvailable),
          localSha: cache.localSha,
          remoteSha: cache.remoteSha ?? null,
          notice: cache.notice ?? null,
          cached: true,
        };
      }
    } catch (err) {
      rmSync(cacheFile, { force: true });
    }
  }

  const isTestOrDisabled = Boolean(
    process.env.NODE_TEST_CONTEXT ||
    process.env.ARCHITECT_NO_UPDATE_CHECK === '1' ||
    (env && env.ARCHITECT_NO_UPDATE_CHECK === '1')
  );
  const allowNetwork = Boolean(force || repoUrl);
  if (isTestOrDisabled && !allowNetwork) {
    return {
      updateAvailable: false,
      localSha,
      remoteSha: null,
      notice: null,
      cached: false,
    };
  }

  const g = realGit ?? which('git');
  if (!g) {
    return { updateAvailable: false, localSha, remoteSha: null, notice: null, cached: false };
  }
  const targetRepo = repoUrl ?? env?.ARCHITECT_SKILL_REPO_URL ?? process.env.ARCHITECT_SKILL_REPO_URL ?? DEFAULT_SKILL_REPO_URL;

  let stdout = '';
  try {
    const childEnv = {
      ...(env ?? process.env),
      GIT_TERMINAL_PROMPT: '0',
    };
    const res = spawnSync(g, ['ls-remote', targetRepo, 'HEAD'], {
      timeout: 1500,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && res.stdout) {
      stdout = res.stdout;
    } else {
      return { updateAvailable: false, localSha, remoteSha: null, notice: null, cached: false };
    }
  } catch (err) {
    // git ls-remote failed or timed out: fail open
    return { updateAvailable: false, localSha, remoteSha: null, notice: null, cached: false };
  }

  const remoteSha = stdout.trim().split(/\s+/)[0] || '';
  if (!remoteSha || !/^[0-9a-fA-F]{7,40}$/.test(remoteSha)) {
    return { updateAvailable: false, localSha, remoteSha: null, notice: null, cached: false };
  }

  if (!localSha) {
    const anc = spawnSync(g, ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: workDir, stdio: 'ignore' });
    if (anc.status === 0) localSha = remoteSha.slice(0, 7);
  }

  const isMatch = Boolean(
    localSha &&
    (remoteSha.toLowerCase().startsWith(localSha.toLowerCase()) ||
     localSha.toLowerCase().startsWith(remoteSha.toLowerCase()))
  );
  const updateAvailable = !isMatch;
  const shortLocal = localSha ? localSha.slice(0, 7) : 'unknown';
  const shortRemote = remoteSha.slice(0, 7);
  const notice = updateAvailable
    ? `! skill update available: ${ver} (${shortLocal} -> ${shortRemote}) — run "/architect update" or "node .agents/skills/architect/orchestrator/run.mjs --update"`
    : null;

  const cacheData = {
    checkedAt: now,
    localSha,
    remoteSha,
    ver,
    updateAvailable,
    notice,
  };
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf8');
  } catch (err) {
    /* cleanup: abort cache write on read-only fs */
  }

  return {
    updateAvailable,
    localSha,
    remoteSha,
    notice,
    cached: false,
  };
}
