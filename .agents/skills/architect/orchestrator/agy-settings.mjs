// The shared Antigravity settings file (~/.gemini/antigravity-cli/settings.json): read, merge, check.
// The settings-file functions of permissions.mjs move here (C-21, ADR-066); permissions.mjs re-exports them.
// The modules import each other: names from permissions.mjs are used only inside function bodies.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGY_SETTINGS_SHOWN, agySettingsPath, isInside, maskPaths, realOrResolved, ruleProblem, rulesFor,
} from './permissions.mjs';

const FILE_RULE_KIND_RE = /^(write_file|read_file)\((.*)\)$/;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * CONTRACT (C-21, ADR-066): is `rule` a file rule of another project in the shared settings file?
 * A rule `write_file(T)` or `read_file(T)` is foreign when realOrResolved(T) is exactly the root of a git
 * project (`T/.git` exists — a directory or a worktree file) and that root is not the current project
 * (realOrResolved(workDir)), not inside it and not above it, and is not the home directory or above it.
 * Anything else (another kind of rule, a subdirectory of a project, a directory without .git, a parent
 * of the current project) is not foreign: the function returns null and `ruleProblem` decides.
 * @param {string} rule
 * @param {{ workDir: string, home: string }} ctx
 * @returns {string | null} a note for the check output, e.g. "write_file of another project (<T>)"; it contains "another project"
 */
export function foreignProjectRule(rule, ctx) {
  const m = String(rule).match(FILE_RULE_KIND_RE);
  if (!m || !path.isAbsolute(m[2])) return null;
  const [, kind, target] = m;
  const t = realOrResolved(target);
  const realWork = realOrResolved(ctx.workDir);
  if (isInside(t, realWork) || isInside(realWork, t) || isInside(realOrResolved(ctx.home), t)) return null;
  if (!existsSync(path.join(t, '.git'))) return null;
  return `${kind} of another project (${t})`;
}

/** Reads the allow and deny rules from the settings file. Never returns other fields of the file. */
export function readAgyRules(settingsPath) {
  const none = { exists: existsSync(settingsPath), allow: [], deny: [], error: null };
  if (!none.exists) return none;
  let json;
  try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (err) { return { ...none, error: `not JSON (${errText(err)})` }; }
  const perms = isObject(json) && isObject(json.permissions) ? json.permissions : {};
  for (const key of ['allow', 'deny']) if (perms[key] !== undefined && !Array.isArray(perms[key])) return { ...none, error: `permissions.${key} is not an array` };
  const strings = (v) => (v ?? []).filter((r) => typeof r === 'string');
  return { ...none, allow: strings(perms.allow), deny: strings(perms.deny) };
}

/** Unsafe allow rules, each with the reason. Another project's file rules in the shared file are not unsafe. */
export const unsafeRules = (allow, ctx) => allow.flatMap((rule) => {
  const problem = ruleProblem(rule, ctx);
  return problem && foreignProjectRule(rule, ctx) === null ? [`${rule} — ${problem}`] : [];
});

/**
 * Merges rules into settings.json keeping every existing entry; backs up an existing file.
 * The file is shared by all projects: rules are never removed (`pruneCtx` only selects the answer shape).
 */
export function writeAgyAllowlist({ settingsPath, allow, deny = [], pruneCtx = null }) {
  const existed = existsSync(settingsPath);
  let json = {};
  if (existed) {
    try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (err) { throw new Error(`${AGY_SETTINGS_SHOWN} is not JSON, file unchanged (${errText(err)})`); }
    if (!isObject(json)) throw new Error(`${AGY_SETTINGS_SHOWN} is not a JSON object, file unchanged`);
  }
  if (json.permissions === undefined) json.permissions = {};
  if (!isObject(json.permissions)) throw new Error(`${AGY_SETTINGS_SHOWN}: permissions is not an object, file unchanged`);
  for (const key of ['allow', 'deny']) if (json.permissions[key] !== undefined && !Array.isArray(json.permissions[key])) throw new Error(`${AGY_SETTINGS_SHOWN}: permissions.${key} is not an array, file unchanged`);
  const merge = (key, rules) => {
    const current = json.permissions[key] ?? [], added = rules.filter((r) => !current.includes(r));
    if (added.length) json.permissions[key] = [...current, ...added];
    return added;
  };
  const addedDeny = merge('deny', deny);
  const addedAllow = merge('allow', allow);
  const shape = (backup) => (pruneCtx !== null ? { addedAllow, addedDeny, removedAllow: [], backup } : { addedAllow, addedDeny, backup });
  if (!addedAllow.length && !addedDeny.length) return shape(false);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const mode = existed ? statSync(settingsPath).mode & 0o777 : 0o600;
  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  const tmp = `${settingsPath}.agent-loop-tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode });
  renameSync(tmp, settingsPath);
  return shape(existed);
}

/** Checks that write_file rule exists for project and deny exists for .git. */
export function checkProjectWriteRule(workDir, settingsPath = agySettingsPath()) {
  if (!existsSync(settingsPath)) return { ok: false, issue: 'settings.json not found' };
  let json;
  try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (err) { return { ok: false, issue: `invalid JSON in settings.json: ${errText(err)}` }; }
  const perms = isObject(json) && isObject(json.permissions) ? json.permissions : {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [], deny = Array.isArray(perms.deny) ? perms.deny : [];
  const realWork = realOrResolved(workDir);
  if (!allow.includes(`write_file(${realWork})`)) return { ok: false, issue: `missing write_file rule for project (${realWork}) — execute: npm run agents -- --write-permissions` };
  const gitPath = path.join(realWork, '.git');
  if (!deny.includes(`write_file(${gitPath})`) && !deny.includes(`write_file(${gitPath}/**)`)) {
    return { ok: false, issue: `missing deny rule write_file(${gitPath}/**) — execute: npm run agents -- --write-permissions` };
  }
  return { ok: true, issue: null };
}

/** Checks project permissions against settings.json. */
export function checkPermissions(config, workDir, home = os.homedir()) {
  const settingsPath = agySettingsPath(home);
  const issues = [];
  const realWork = realOrResolved(workDir);
  const ctx = { blockedNpmScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], blockedScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], workDir: realWork, home: realOrResolved(home), deny: [] };
  const { exists, allow, deny, error } = readAgyRules(settingsPath);
  if (!exists) return { ok: false, issues: ['settings.json not found'], warnings: [] };
  if (error) return { ok: false, issues: [`invalid JSON in settings.json: ${error}`], warnings: [] };
  ctx.deny = deny;
  const writeRes = checkProjectWriteRule(workDir, settingsPath);
  if (!writeRes.ok) issues.push(writeRes.issue);
  for (const u of unsafeRules(allow, ctx)) issues.push(`contains unsafe rule in allow: ${maskPaths(u, ctx)}`);
  const wanted = rulesFor(config, realWork);
  const missing = [...wanted.allow.filter((r) => !allow.includes(r)), ...wanted.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`)];
  if (missing.length) issues.push(`missing required rules in settings.json (${missing.length}): ${missing.join(', ')}`);
  return { ok: issues.length === 0, issues, warnings: [] };
}

/** Static check of settings file: validates required and unsafe rules. */
export function permissionsCheck({ config, settingsPath, workDir, home = os.homedir(), skillDir = null, skillFilePath = null }) {
  const name = 'allowlist Antigravity';
  const blocked = config.blockedScripts ?? config.blockedNpmScripts ?? [];
  const ctx = { blockedNpmScripts: blocked, blockedScripts: blocked, workDir: realOrResolved(workDir), home: realOrResolved(home), deny: [], skillDir, skillFilePath };
  const mask = (s) => maskPaths(s, ctx);
  const { exists, allow, deny, error } = readAgyRules(settingsPath);
  if (!exists) return { ok: false, name, detail: `${AGY_SETTINGS_SHOWN} is missing — run with --write-permissions (--init prints the ready block)` };
  if (error) return { ok: false, name, detail: `${AGY_SETTINGS_SHOWN}: ${error}` };
  ctx.deny = deny;
  const unsafe = unsafeRules(allow, ctx);
  if (unsafe.length) return { ok: false, name, detail: mask(`unsafe rules — remove them from ${AGY_SETTINGS_SHOWN}:\n    ${unsafe.join('\n    ')}`) };
  const wanted = rulesFor(config, ctx.workDir);
  const missing = [...wanted.allow.filter((r) => !allow.includes(r)), ...wanted.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`)];
  if (missing.length) return { ok: false, name, detail: mask(`missing rules: ${missing.join(', ')} — run with --write-permissions`) };
  const foreign = allow.filter((r) => foreignProjectRule(r, ctx) !== null).length;
  const foreignNote = foreign > 0 ? `; other projects' file rules: ${foreign} (shared settings file)` : '';
  return { ok: true, name, detail: `command(…) rules: ${allow.filter((r) => r.startsWith('command(')).length}, project write without .git, no unsafe rules${foreignNote}` };
}
