// Claude Code allowlist: rules for a project, writing them into the per-project settings file, checking them.
// The runner (claude.mjs) re-exports everything here under the same names.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlShimDir } from '../control-dir.mjs';
import { allowedCommandsFor, commandProblem, isInside, realOrResolved, resolveSkillDir } from '../permissions.mjs';

export const CLAUDE_SETTINGS_SHOWN = '~/.config/architect/claude-settings.json';

const errText = (err) => (err instanceof Error ? err.message : String(err));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// The shim directory of the control directory (ADR-066): the one place under ~/.config/architect the agent may read.
const shimDirOf = (workDir, home) => realOrResolved(controlShimDir({ workDir, home }));

export function claudeSettingsPath(home = os.homedir(), workDir = null) {
  if (!workDir) return path.join(home, '.config', 'architect', 'claude-settings.json');
  const realWork = realOrResolved(workDir);
  const slug = path.basename(realWork).replace(/[^a-zA-Z0-9._-]/g, '_') || 'project';
  const hash8 = createHash('sha256').update(realWork).digest('hex').slice(0, 8);
  return path.join(home, '.config', 'architect', 'claude', `${slug}-${hash8}.json`);
}

export function toClaudeBashRule(cmd) {
  return `Bash(${String(cmd ?? '').trim().replace(/\s+/g, ' ')}:*)`;
}

export function claudeRulesFor(config, workDir, home = os.homedir(), { skillDir = null, skillFilePath = null } = {}) {
  const w = realOrResolved(workDir);
  const abs = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const allow = [...allowedCommandsFor(config).map(toClaudeBashRule), `Edit(${abs(w)}/**)`, `Write(${abs(w)}/**)`];
  const resolvedSkill = resolveSkillDir({ skillDir, skillFilePath, workDir: w });
  const external = !isInside(resolvedSkill, w);
  const shimDir = shimDirOf(w, home);
  const additionalDirectories = [...(external ? [resolvedSkill] : []), shimDir];
  if (external) allow.push(`Read(${abs(resolvedSkill)}/**)`);
  allow.push(`Read(${abs(shimDir)}/**)`);
  const deny = [
    `Edit(${abs(path.join(w, '.git', 'config'))})`, `Write(${abs(path.join(w, '.git', 'config'))})`,
    `Edit(${abs(path.join(w, '.git', 'hooks'))}/**)`, `Write(${abs(path.join(w, '.git', 'hooks'))}/**)`,
    `Edit(${abs(path.join(w, '.git', 'info'))}/**)`, `Write(${abs(path.join(w, '.git', 'info'))}/**)`,
    ...(external ? [`Edit(${abs(resolvedSkill)}/**)`, `Write(${abs(resolvedSkill)}/**)`] : []),
    ...[abs(path.join(w, '.claude')), '~/.claude', '~/.config/architect', '~/.gemini'].flatMap((p) => [`Edit(${p}/**)`, `Write(${p}/**)`]),
  ];
  return { allow, deny, additionalDirectories, sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } };
}

export function writeClaudeAllowlist({ settingsPath = null, workDir = null, home = os.homedir(), allow = [], deny = [], additionalDirectories = [], pruneCtx = null }) {
  const actualSettings = settingsPath ?? (workDir ? claudeSettingsPath(home, workDir) : claudeSettingsPath(home));
  const existed = existsSync(actualSettings);
  let json = {}, prevText = null;
  if (existed) {
    try { prevText = readFileSync(actualSettings, 'utf8'); json = JSON.parse(prevText); }
    catch (err) { throw new Error(`${CLAUDE_SETTINGS_SHOWN} is not JSON, file not modified (${errText(err)})`); }
    if (!isObject(json)) throw new Error(`${CLAUDE_SETTINGS_SHOWN} is not a JSON object, file not modified`);
  }
  json.sandbox = { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false };
  if (!isObject(json.permissions)) json.permissions = {};
  json.permissions.blockReadsOutsideWorkingDirectories = true;
  for (const k of ['allow', 'deny', 'additionalDirectories']) {
    if (json.permissions[k] !== undefined && !Array.isArray(json.permissions[k])) throw new Error(`${CLAUDE_SETTINGS_SHOWN}: permissions.${k} is not an array, file not modified`);
  }
  const realWork = workDir ? realOrResolved(workDir) : null;
  const inferredWork = realWork ?? allow.map((r) => typeof r === 'string' && r.match(/^(?:Edit|Write)\(\/\/(.+?)\/\*\*?\)$/)?.[1]).filter(Boolean).map((p) => realOrResolved('/' + p.replace(/^\/+/, '')))[0] ?? null;
  const toAbs = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const extraDirs = [...additionalDirectories];
  const effectiveDeny = [...deny];
  for (const r of allow) {
    const m = typeof r === 'string' && r.match(/^Read\(\/\/(.+?)\/\*\*?\)$/);
    if (!m) continue;
    const d = realOrResolved('/' + m[1].replace(/^\/+/, ''));
    if (!inferredWork || !isInside(d, inferredWork)) {
      if (!extraDirs.some((x) => realOrResolved(x) === d)) extraDirs.push(d);
      for (const p of [`Edit(${toAbs(d)}/**)`, `Write(${toAbs(d)}/**)`]) if (!effectiveDeny.includes(p)) effectiveDeny.push(p);
    }
  }
  const merge = (key, rules) => {
    const current = json.permissions[key] ?? [], added = rules.filter((r) => !current.includes(r));
    if (added.length) json.permissions[key] = [...current, ...added];
    return added;
  };
  const addedDeny = merge('deny', effectiveDeny);
  let removedAllow;
  if (pruneCtx !== null) {
    const curAllow = json.permissions.allow ?? [];
    const pCfg = pruneCtx.config ?? { blockedScripts: pruneCtx.blockedScripts ?? pruneCtx.blockedNpmScripts ?? [] };
    const pWork = pruneCtx.workDir ?? inferredWork;
    const pHome = pruneCtx.home ?? home;
    const pDeny = json.permissions.deny ?? [];
    removedAllow = curAllow.filter((r) => claudeRuleProblem(r, { config: pCfg, workDir: pWork, home: pHome, deny: pDeny, skillDir: pruneCtx.skillDir, skillFilePath: pruneCtx.skillFilePath }) !== null);
    if (removedAllow.length) json.permissions.allow = curAllow.filter((r) => !removedAllow.includes(r));
  }
  const addedAllow = merge('allow', allow);
  if (extraDirs.length > 0) {
    const currentDirs = json.permissions.additionalDirectories ?? [];
    const addedDirs = extraDirs.filter((d) => !currentDirs.some((cd) => realOrResolved(cd) === realOrResolved(d)));
    if (addedDirs.length || !json.permissions.additionalDirectories) json.permissions.additionalDirectories = [...currentDirs, ...addedDirs];
  }
  const newText = `${JSON.stringify(json, null, 2)}\n`;
  if (!existed || newText !== prevText) {
    mkdirSync(path.dirname(actualSettings), { recursive: true });
    const mode = existed ? statSync(actualSettings).mode & 0o777 : 0o600;
    if (existed) copyFileSync(actualSettings, `${actualSettings}.bak`);
    const tmp = `${actualSettings}.agent-loop-tmp`;
    writeFileSync(tmp, newText, { mode });
    renameSync(tmp, actualSettings);
  }
  return pruneCtx !== null ? { addedAllow, addedDeny, removedAllow, backup: existed && newText !== prevText } : { addedAllow, addedDeny, backup: existed && newText !== prevText };
}

function checkClaudePathTarget(kind, targetPath, { workDir, home, deny, skillDir, skillFilePath }) {
  const t = realOrResolved(targetPath.replace(/\/\*\*?$/, ''));
  const realWork = realOrResolved(workDir), realHome = realOrResolved(home);
  if (isInside(realHome, t)) return 'home directory or above';
  if (t !== realWork && isInside(realWork, t)) return 'parent directory of project';
  if (kind === 'Read') {
    const s1 = resolveSkillDir({ skillDir, skillFilePath, workDir: realWork }), s2 = resolveSkillDir({ workDir: realWork });
    return (!isInside(t, realWork) && !isInside(t, s1) && !isInside(t, s2) && !isInside(t, shimDirOf(realWork, home))) ? 'reading outside project and skill directory is forbidden' : null;
  }
  for (const [sub, msg] of [['.gemini', 'writing to ~/.gemini — agent could modify its permissions'], ['.claude', 'writing to ~/.claude — agent could modify its permissions'], [path.join('.config', 'architect'), 'writing to ~/.config/architect']]) {
    if (isInside(t, path.join(realHome, sub))) return msg;
  }
  const toAbs = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const gitDir = path.join(realWork, '.git');
  if (isInside(t, gitDir)) return 'writing to project .git';
  if (isInside(gitDir, t)) {
    for (const pat of [`${kind}(${toAbs(path.join(gitDir, 'config'))})`, `${kind}(${toAbs(path.join(gitDir, 'hooks'))}/**)`, `${kind}(${toAbs(path.join(gitDir, 'info'))}/**)`]) {
      if (!deny.includes(pat)) return `covers project .git without deny ${pat}`;
    }
  }
  const claudeDir = path.join(realWork, '.claude'), claudePat = `${kind}(${toAbs(claudeDir)}/**)`;
  if (isInside(t, claudeDir)) return 'writing to project .claude';
  if (isInside(claudeDir, t) && !deny.includes(claudePat)) return `covers project .claude without deny ${claudePat}`;
  return !isInside(t, realWork) ? 'writing outside the current project — remove other project rule or run loops one at a time' : null;
}

function claudeRuleProblem(r, { config, workDir, home, deny, skillDir, skillFilePath }) {
  if (['Bash', 'Edit', 'Write', 'Read'].includes(r) || /^(Bash|Edit|Write|Read)\(\*\)$/.test(r)) return `"${r}" allows everything`;
  const bashMatch = r.match(/^Bash\((.*)\)$/);
  if (bashMatch) return commandProblem(bashMatch[1].replace(/:\*$/, ''), config.blockedScripts ?? config.blockedNpmScripts ?? []);
  const fileMatch = r.match(/^(Edit|Write|Read)\((.*)\)$/);
  if (fileMatch) {
    const [, kind, target] = fileMatch;
    if (target.startsWith('~/')) return 'only //... absolute patterns are allowed in allow — ~/… patterns are forbidden';
    if (target.startsWith('/')) {
      if (!target.startsWith('//')) return 'path with single "/" is relative to settings file folder, not root — use //';
      return checkClaudePathTarget(kind, '/' + target.slice(2), { workDir, home, deny, skillDir, skillFilePath });
    }
    return 'relative path';
  }
  return 'unknown rule';
}

export function claudePermissionsCheck({ config, settingsPath = null, workDir, home = os.homedir(), skillDir = null, skillFilePath = null }) {
  const name = 'allowlist Claude Code';
  const actualSettings = settingsPath ?? (workDir ? claudeSettingsPath(home, workDir) : claudeSettingsPath(home));
  if (!existsSync(actualSettings)) return { ok: false, name, detail: `settings.json not found (${actualSettings}) — execute: npm run agents -- --write-permissions` };
  let json;
  try { json = JSON.parse(readFileSync(actualSettings, 'utf8')); }
  catch (err) { return { ok: false, name, detail: `invalid JSON in ${actualSettings}: ${errText(err)}` }; }
  if (!isObject(json)) return { ok: false, name, detail: `invalid JSON in ${actualSettings}: not a JSON object` };
  if (json.sandbox?.enabled !== true || json.sandbox?.autoAllowBashIfSandboxed !== false || json.sandbox?.allowUnsandboxedCommands !== false) return { ok: false, name, detail: 'OS sandbox is disabled, autoAllowBashIfSandboxed is not false or allowUnsandboxedCommands is not false' };
  if (json.permissions?.blockReadsOutsideWorkingDirectories !== true) return { ok: false, name, detail: 'reading outside project is not blocked (permissions.blockReadsOutsideWorkingDirectories is not true)' };
  const perms = isObject(json.permissions) ? json.permissions : {};
  for (const k of ['allow', 'deny', 'additionalDirectories']) {
    if (perms[k] !== undefined && !Array.isArray(perms[k])) return { ok: false, name, detail: `${actualSettings}: permissions.${k} is not an array` };
  }
  const allow = Array.isArray(perms.allow) ? perms.allow.filter((r) => typeof r === 'string') : [];
  const deny = Array.isArray(perms.deny) ? perms.deny.filter((r) => typeof r === 'string') : [];
  const additionalDirs = Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories.filter((d) => typeof d === 'string') : [];
  const unsafe = [];
  for (const r of allow) {
    const problem = claudeRuleProblem(r, { config, workDir, home, deny, skillDir, skillFilePath });
    if (problem) unsafe.push(`${r} — ${problem}`);
  }
  const realWork = realOrResolved(workDir);
  const resolvedSkill = resolveSkillDir({ skillDir, skillFilePath, workDir: realWork });
  const defaultSkill = resolveSkillDir({ workDir: realWork });
  const shimDir = shimDirOf(realWork, home);
  for (const d of additionalDirs) {
    const rd = realOrResolved(d);
    if (!isInside(rd, realWork) && !isInside(rd, resolvedSkill) && !isInside(rd, defaultSkill) && rd !== shimDir) {
      unsafe.push(`additionalDirectories(${d}) — directory outside project and skill directory`);
    }
  }
  if (unsafe.length) return { ok: false, name, detail: `contains unsafe rule in allow: ${unsafe.join(', ')}` };
  const wanted = claudeRulesFor(config, workDir, home, { skillDir, skillFilePath });
  const missingEditWrite = wanted.allow.filter((r) => (r.startsWith('Edit(') || r.startsWith('Write(')) && !allow.includes(r));
  if (missingEditWrite.length) return { ok: false, name, detail: `missing Edit/Write rules for project (${missingEditWrite.join(', ')}) — execute: npm run agents -- --write-permissions` };
  const missingGitDeny = wanted.deny.filter((r) => r.includes('.git') && !deny.includes(r));
  if (missingGitDeny.length) return { ok: false, name, detail: `missing deny rule for .git (${missingGitDeny.join(', ')}) — execute: npm run agents -- --write-permissions` };
  const missingDirs = (wanted.additionalDirectories ?? []).filter((d) => !additionalDirs.some((ad) => realOrResolved(ad) === realOrResolved(d))).map((d) => `additionalDirectories: ${d}`);
  const missing = [...wanted.allow.filter((r) => !allow.includes(r)), ...wanted.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`), ...missingDirs];
  if (missing.length) return { ok: false, name, detail: `missing required rules in ${actualSettings} (${missing.length}): ${missing.join(', ')} — execute: npm run agents -- --write-permissions` };
  const bashCount = allow.filter((r) => r.startsWith('Bash(')).length;
  return { ok: true, name, detail: `Bash(…) rules: ${bashCount}, OS sandbox enabled, reading outside project blocked, writing to project without .git and .claude, no unsafe rules` };
}

export function claudeAllowlistBlock(rulesOrPerms = {}) {
  const allow = rulesOrPerms.allow ?? rulesOrPerms.permissions?.allow ?? [];
  const deny = rulesOrPerms.deny ?? rulesOrPerms.permissions?.deny ?? [];
  const dirs = rulesOrPerms.additionalDirectories ?? rulesOrPerms.permissions?.additionalDirectories ?? [];
  const sandbox = rulesOrPerms.sandbox ?? { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false };
  const permissions = { blockReadsOutsideWorkingDirectories: true, allow, deny, ...(Array.isArray(dirs) && dirs.length ? { additionalDirectories: dirs } : {}) };
  return JSON.stringify({ sandbox, permissions }, null, 2);
}
