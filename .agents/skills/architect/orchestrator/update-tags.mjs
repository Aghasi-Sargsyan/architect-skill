// Release-tag resolution for --update and the update notice (C-39, ADR-076).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import { resolveInstalledSkillDir } from './layout.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SKILL_REPO_URL = 'https://github.com/Aghasi-Sargsyan/architect-skill.git';
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Release tag format: exactly `vMAJOR.MINOR.PATCH` with decimal numbers (`v3.55.0`).
 * Anything else (`v3.55`, `v3.55.0-rc1`, `x3.55.0`, branch refs) is not a release.
 */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Picks the newest release tag from `git ls-remote --tags <repo>` output.
 * - Lines are `<sha>\trefs/tags/<name>` or `<sha>\trefs/tags/<name>^{}` (peeled annotated tag).
 * - Only names matching RELEASE_TAG_RE count; order is numeric by (major, minor, patch): v3.10.0 > v3.9.0.
 * - For an annotated tag the peeled commit SHA (`^{}` line) wins over the tag-object SHA,
 *   whatever the line order; a lightweight tag uses its own SHA.
 * - SHAs are returned lower-case; a line whose SHA is not 40 hex characters is ignored.
 * @param {string} lsRemoteOutput
 * @returns {{ tag: string, sha: string } | null} null when no release tag is present
 */
export function pickLatestReleaseTag(lsRemoteOutput) {
  const found = new Map();
  for (const line of String(lsRemoteOutput ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const [rawSha, ref] = parts;
    if (!/^[0-9a-fA-F]{40}$/.test(rawSha) || !ref.startsWith('refs/tags/')) continue;
    const peeled = ref.endsWith('^{}');
    const name = ref.slice('refs/tags/'.length, peeled ? -3 : undefined);
    const match = RELEASE_TAG_RE.exec(name);
    if (!match) continue;
    const prev = found.get(name);
    if (prev?.peeled && !peeled) continue;
    found.set(name, { sha: rawSha.toLowerCase(), peeled, version: [Number(match[1]), Number(match[2]), Number(match[3])] });
  }
  let best = null;
  for (const [tag, entry] of found) {
    if (!best || compareVersions(entry.version, best.version) > 0) best = { tag, sha: entry.sha, version: entry.version };
  }
  return best ? { tag: best.tag, sha: best.sha } : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Resolves the newest release tag of a remote repository with one
 * `git ls-remote --tags <repoUrl>` call (env GIT_TERMINAL_PROMPT=0, timeout `timeoutMs`).
 * Never throws: a spawn error, timeout, or non-zero exit is `unreachable`.
 * @param {{ realGit: string, repoUrl: string, timeoutMs?: number, env?: Record<string, string | undefined> }} opts
 * @returns {{ ok: true, tag: string, sha: string }
 *   | { ok: false, reason: 'unreachable' | 'no-release-tags', detail: string }}
 */
export function resolveLatestReleaseTag({ realGit, repoUrl, timeoutMs = 10000, env = process.env }) {
  const res = spawnSync(realGit, ['ls-remote', '--tags', repoUrl], {
    timeout: timeoutMs,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { ok: false, reason: 'unreachable', detail: res.error.message };
  }
  if (res.status !== 0) {
    const detail = (res.stderr ?? '').trim() || `git ls-remote exited with ${res.status ?? res.signal}`;
    return { ok: false, reason: 'unreachable', detail };
  }
  const latest = pickLatestReleaseTag(res.stdout ?? '');
  if (!latest) {
    return { ok: false, reason: 'no-release-tags', detail: `no release tags (vMAJOR.MINOR.PATCH) in ${repoUrl}` };
  }
  return { ok: true, tag: latest.tag, sha: latest.sha };
}

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
 * Checks whether a newer release tag exists upstream than the installed skill commit.
 * Non-blocking, fails open on network errors, caches result for 24h.
 * `offline: true` never spawns git: it answers from a valid cache or reports no update
 * (`force` then only skips the cache).
 * @param {{
 *   workDir?: string,
 *   orchestratorDir?: string,
 *   repoUrl?: string,
 *   realGit?: string,
 *   nowMs?: number,
 *   ttlMs?: number,
 *   env?: Record<string, string | undefined>,
 *   force?: boolean,
 *   offline?: boolean,
 * }} [param0]
 * @returns {{
 *   updateAvailable: boolean,
 *   localSha?: string,
 *   remoteSha?: string | null,
 *   remoteTag?: string | null,
 *   notice: string | null,
 *   cached?: boolean,
 *   cacheError?: string,
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
  offline = false,
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
          remoteTag: cache.remoteTag ?? null,
          notice: cache.notice ?? null,
          cached: true,
        };
      }
    } catch (err) {
      rmSync(cacheFile, { force: true });
    }
  }

  if (offline) {
    return { updateAvailable: false, localSha, remoteSha: null, remoteTag: null, notice: null, cached: false };
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

  // fail open: unreachable remote, timeout or no release tags means no notice
  const latest = resolveLatestReleaseTag({ realGit: g, repoUrl: targetRepo, timeoutMs: 1500, env: env ?? process.env });
  if (!latest.ok) {
    return { updateAvailable: false, localSha, remoteSha: null, notice: null, cached: false };
  }
  const remoteSha = latest.sha;
  const remoteTag = latest.tag;

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
    ? `! skill update available: ${ver} (${shortLocal} -> ${remoteTag} ${shortRemote}) — run "/architect update" or "node .agents/skills/architect/orchestrator/run.mjs --update" (when no loop is running)`
    : null;

  const cacheData = {
    checkedAt: now,
    localSha,
    remoteSha,
    remoteTag,
    ver,
    updateAvailable,
    notice,
  };
  let cacheError = null;
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf8');
  } catch (err) {
    cacheError = err instanceof Error ? err.message : String(err);
  }

  return {
    updateAvailable,
    localSha,
    remoteSha,
    remoteTag,
    notice,
    cached: false,
    ...(cacheError ? { cacheError } : {}),
  };
}
