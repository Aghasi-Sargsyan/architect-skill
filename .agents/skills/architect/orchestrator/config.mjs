// Orchestrator config: defaults for every field (config.example.json), strict validation, and `--init`.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIgnored } from './git.mjs';
import { CLASSIC_CONFIG_PATH, COMPACT_CONFIG_PATH, resolveLayout } from './layout.mjs';
import { commandProblem } from './permissions.mjs';
import { effectiveBlockedScripts } from './runners.mjs';

export const EXAMPLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.example.json');
export const RUNS_DIR = '.agent-runs';

/**
 * Defaults = config.example.json, so the example and the code cannot drift apart.
 * bypassPatterns default to the TypeScript / JavaScript list (JavaScript regex syntax).
 */
export const DEFAULTS = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));

const KNOWN_KEYS = new Set([...Object.keys(DEFAULTS), 'workDir', 'layout', 'blockedScripts', 'runner', 'runnerBin', 'auditor']);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** @returns {string[]} problems; empty when the config is usable */
export function validateConfig(config) {
  const problems = [];
  for (const k of Object.keys(config)) if (!KNOWN_KEYS.has(k)) problems.push(`unknown field "${k}"`);
  if (config.layout !== undefined && !['classic', 'compact'].includes(config.layout)) {
    problems.push('layout — "classic" or "compact"');
  }
  if (config.runner !== undefined && !['agy', 'claude'].includes(config.runner)) {
    problems.push('runner — "agy" or "claude"');
  }
  if (config.runnerBin !== undefined && (typeof config.runnerBin !== 'string' || !config.runnerBin)) {
    problems.push('runnerBin — non-empty string');
  }
  if (typeof config.agyBin !== 'string' || !config.agyBin) problems.push('agyBin — non-empty string');
  for (const role of ['executor', 'architect']) {
    const model = isObject(config[role]) ? config[role].model : undefined;
    if (typeof model !== 'string' || !model) {
      problems.push(`Field ${role}.model is required (non-empty string from "agy models")`);
    }
  }
  if (!['allowlist', 'skip'].includes(config.permissions)) problems.push('permissions — "allowlist" or "skip"');
  if (config.blockedScripts !== undefined && !isStringArray(config.blockedScripts)) {
    problems.push('Field blockedScripts must be an array of strings');
  }
  if (!isStringArray(config.blockedNpmScripts)) {
    problems.push('Field blockedNpmScripts must be an array of strings');
  }
  if (!isStringArray(config.allowedCommands)) {
    problems.push('Field allowedCommands must be an array of strings (commands with subcommand, e.g. "npm run lint")');
  } else {
    const blocked = effectiveBlockedScripts(config);
    for (const c of config.allowedCommands) {
      const problem = commandProblem(c, blocked);
      if (problem) problems.push(`allowedCommands: "${c}" — ${problem}`);
    }
  }
  if (!isStringArray(config.protectedConfigFiles)) {
    problems.push('Field protectedConfigFiles must be an array of strings');
  }
  if (!isStringArray(config.bypassScanPaths)) {
    problems.push('Field bypassScanPaths must be an array of strings');
  }
  if (!isStringArray(config.bypassPatterns)) {
    problems.push('Field bypassPatterns must be an array of strings (JavaScript regular expressions)');
  } else {
    for (const p of config.bypassPatterns) {
      try {
        new RegExp(p);
      } catch (err) {
        problems.push(`bypassPatterns: "${p}" — not a regular expression (${errText(err)})`);
      }
    }
  }
  if (!Number.isInteger(config.maxFixRounds) || config.maxFixRounds < 0) problems.push('maxFixRounds — integer ≥ 0');
  if (!Number.isInteger(config.maxPermissionPrompts) || config.maxPermissionPrompts < 0) {
    problems.push('maxPermissionPrompts — integer ≥ 0');
  }
  if (typeof config.answerTimeoutMinutes !== 'number' || !(config.answerTimeoutMinutes > 0)) {
    problems.push('answerTimeoutMinutes — number > 0');
  }
  if (typeof config.timeoutMinutes !== 'number' || !(config.timeoutMinutes > 0)) {
    problems.push('timeoutMinutes — number > 0');
  }
  if (!Number.isInteger(config.verifyTimeoutMs) || config.verifyTimeoutMs <= 0) {
    problems.push('verifyTimeoutMs — integer > 0');
  }
  if (typeof config.notify !== 'boolean') problems.push('notify — true or false');
  if (config.auditor !== undefined) {
    if (!isObject(config.auditor)) {
      problems.push('auditor must be an object');
    } else {
      if (config.auditor.runner !== 'claude') {
        problems.push('auditor.runner — "claude"');
      }
      if (typeof config.auditor.model !== 'string' || !config.auditor.model) {
        problems.push('Field auditor.model is required (non-empty string)');
      }
    }
  }
  if (config.workDir !== undefined && (typeof config.workDir !== 'string' || !config.workDir)) {
    problems.push('workDir must be a non-empty string');
  }
  return problems;
}

/** Merges a raw config over DEFAULTS (executor/architect one level deep). */
export function withDefaults(raw) {
  const hasAnyModel = Boolean(raw?.executor?.model || raw?.architect?.model);
  const nested = (k) => {
    if (raw[k] === undefined) return { ...DEFAULTS[k] };
    if (isObject(raw[k])) {
      if (!hasAnyModel && !raw[k].model) return { ...raw[k] };
      return { ...DEFAULTS[k], ...raw[k] };
    }
    return raw[k];
  };
  const base = { ...DEFAULTS, ...raw, executor: nested('executor'), architect: nested('architect') };
  if (raw?.auditor !== undefined) {
    base.auditor = isObject(raw.auditor) ? { ...raw.auditor } : raw.auditor;
  } else {
    delete base.auditor;
  }
  return base;
}

/**
 * Reads, merges and validates the config; throws with every problem listed.
 * @returns {object} config plus `bypassRegexps` (compiled bypassPatterns)
 */
export function loadConfig(configPath) {
  let file = path.resolve(configPath);
  if (existsSync(file) && statSync(file).isDirectory()) {
    const compact = path.join(file, COMPACT_CONFIG_PATH);
    const classic = path.join(file, CLASSIC_CONFIG_PATH);
    if (existsSync(compact)) file = compact;
    else if (existsSync(classic)) file = classic;
    else {
      throw new Error(`Configuration not found: missing config ${configPath} — run the orchestrator with --init: it creates a config from config.example.json and adds ${RUNS_DIR}/ to .gitignore`);
    }
  }
  if (!existsSync(file)) {
    throw new Error(`Configuration not found: missing config ${configPath} — run the orchestrator with --init: it creates a config from config.example.json and adds ${RUNS_DIR}/ to .gitignore`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`invalid JSON in config ${configPath} (${errText(err)}) (not JSON)`);
  }
  if (!isObject(raw)) throw new Error(`config ${configPath} must be a JSON object`);
  const config = withDefaults(raw);
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`config ${configPath}:\n- ${problems.join('\n- ')}`);
  const paths = resolveLayout({ config, configPath });
  const effectiveBlocked = effectiveBlockedScripts(config);
  return {
    ...config,
    runner: config.runner ?? 'agy',
    runnerBin: config.runnerBin ?? (config.runner === 'claude' ? 'claude' : config.agyBin),
    blockedScripts: effectiveBlocked,
    blockedNpmScripts: effectiveBlocked,
    layout: paths.layout,
    paths,
    bypassRegexps: config.bypassPatterns.map((p) => new RegExp(p)),
  };
}

/**
 * `--init`: creates the config from the example (never overwrites) and adds the runs directory
 * to .gitignore unless it is already ignored. Throws outside a git repository.
 * @returns {string[]} what was done, for the console
 */
export function initProject({ workDir, configPath = COMPACT_CONFIG_PATH, realGit }) {
  const targetPath = configPath || COMPACT_CONFIG_PATH;
  const ignored = isIgnored(realGit, workDir, `${RUNS_DIR}/`);
  const notes = [];
  const file = path.resolve(workDir, targetPath);
  if (existsSync(file)) notes.push(`config already exists, leaving unchanged: ${targetPath}`);
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    const norm = targetPath.replace(/\\/g, '/');
    const isCompact = norm === COMPACT_CONFIG_PATH || norm.endsWith('/' + COMPACT_CONFIG_PATH) || norm.startsWith('.architect/');
    if (isCompact) {
      writeFileSync(file, JSON.stringify({ layout: 'compact', ...DEFAULTS }, null, 2) + '\n');
    } else {
      copyFileSync(EXAMPLE_PATH, file);
    }
    notes.push(`created ${targetPath} — verify models, blockedNpmScripts, allowedCommands, bypassScanPaths and bypassPatterns`);
  }
  if (ignored) notes.push(`${RUNS_DIR}/ is already ignored by git`);
  else {
    const gitignore = path.join(workDir, '.gitignore');
    const prev = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    const sep = prev === '' ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(gitignore, `${sep}# Agent orchestrator runs (prompts, reports, lock)\n${RUNS_DIR}/\n`);
    notes.push(`added ${RUNS_DIR}/ to .gitignore`);
  }
  return notes;
}
