// Orchestrator config: defaults for every field (config.example.json), strict validation, and `--init`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIgnored } from './git.mjs';
import {
  CLASSIC_CONFIG_PATH,
  CLASSIC_LOCAL_CONFIG_PATH,
  COMPACT_CONFIG_PATH,
  COMPACT_LOCAL_CONFIG_PATH,
  resolveLayout,
  resolveLocalConfigPath,
} from './layout.mjs';
import { commandProblem } from './permissions.mjs';
import { effectiveBlockedScripts } from './runners.mjs';
import { installCommitMsgHook } from './hooks.mjs';

export const EXAMPLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.example.json');
export const RUNS_DIR = '.agent-runs';

export const LOCAL_ALLOWED_KEYS = ['executor', 'architect', 'auditor', 'runner', 'runnerBin', 'agyBin', 'notify'];

/**
 * Defaults = config.example.json, so the example and the code cannot drift apart.
 * bypassPatterns default to the TypeScript / JavaScript list (JavaScript regex syntax).
 */
export const DEFAULTS = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));

const KNOWN_KEYS = new Set([
  ...Object.keys(DEFAULTS),
  'workDir',
  'layout',
  'blockedScripts',
  'runner',
  'runnerBin',
  'auditor',
  'commitLanguage',
  'team',
  'fullTestCommand',
]);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** @returns {string[]} problems in local config */
export function validateLocalConfig(raw) {
  const problems = [];
  if (!isObject(raw)) {
    problems.push('local config must be a JSON object');
    return problems;
  }
  const allowed = new Set(LOCAL_ALLOWED_KEYS);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      problems.push(`local config: policy field "${k}" is not allowed in local config`);
    }
  }
  if (raw.runner !== undefined && !['agy', 'claude'].includes(raw.runner)) {
    problems.push('local config: runner — "agy" or "claude"');
  }
  if (raw.runnerBin !== undefined && (typeof raw.runnerBin !== 'string' || !raw.runnerBin)) {
    problems.push('local config: runnerBin — non-empty string');
  }
  if (raw.agyBin !== undefined && (typeof raw.agyBin !== 'string' || !raw.agyBin)) {
    problems.push('local config: agyBin — non-empty string');
  }
  for (const role of ['executor', 'architect']) {
    if (raw[role] !== undefined) {
      if (!isObject(raw[role]) || typeof raw[role].model !== 'string' || !raw[role].model) {
        problems.push(`local config: Field ${role}.model is required (non-empty string)`);
      }
    }
  }
  if (raw.notify !== undefined && typeof raw.notify !== 'boolean') {
    problems.push('local config: notify — true or false');
  }
  if (raw.auditor !== undefined) {
    if (!isObject(raw.auditor)) {
      problems.push('local config: auditor must be an object');
    } else {
      if (raw.auditor.runner !== 'claude') {
        problems.push('local config: auditor.runner — "claude"');
      }
      if (typeof raw.auditor.model !== 'string' || !raw.auditor.model) {
        problems.push('local config: Field auditor.model is required (non-empty string)');
      }
    }
  }
  return problems;
}

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
    if (typeof model !== 'string') {
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
  for (const key of ['bypassPatterns', 'testFilePatterns', 'testPatterns', 'assertPatterns']) {
    if (!isStringArray(config[key])) {
      problems.push(`Field ${key} must be an array of strings (JavaScript regular expressions)`);
    } else {
      for (const p of config[key]) {
        try {
          new RegExp(p);
        } catch (err) {
          problems.push(`${key}: "${p}" — not a regular expression (${errText(err)})`);
        }
      }
    }
  }
  if (typeof config.redCheckCommand !== 'string') {
    problems.push('Field redCheckCommand must be a string');
  } else if (config.redCheckCommand.trim()) {
    const blocked = effectiveBlockedScripts(config);
    const expanded = config.redCheckCommand.includes('{file}')
      ? config.redCheckCommand.replaceAll('{file}', 'file')
      : `${config.redCheckCommand.trim()} file`;
    const problem = commandProblem(expanded, blocked);
    if (problem) problems.push(`redCheckCommand: "${config.redCheckCommand}" — ${problem}`);
  }
  if (config.redCheckConfirmPattern !== undefined) {
    if (typeof config.redCheckConfirmPattern !== 'string') {
      problems.push('Field redCheckConfirmPattern must be a string (JavaScript regular expression, empty = not set)');
    } else if (config.redCheckConfirmPattern) {
      try {
        new RegExp(config.redCheckConfirmPattern, 'm');
      } catch (err) {
        problems.push(`redCheckConfirmPattern: "${config.redCheckConfirmPattern}" — not a regular expression (${errText(err)})`);
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
  if (config.commitLanguage !== undefined && config.commitLanguage !== null && config.commitLanguage !== '') {
    if (config.commitLanguage !== 'en') problems.push('commitLanguage — optional, "en"');
  }
  if (config.team !== undefined && typeof config.team !== 'boolean') {
    problems.push('team — optional, true or false');
  }
  if (config.fullTestCommand !== undefined) {
    if (typeof config.fullTestCommand !== 'string' || !config.fullTestCommand.trim()) {
      problems.push('fullTestCommand — optional, non-empty string');
    } else {
      const problem = commandProblem(config.fullTestCommand, effectiveBlockedScripts(config));
      if (problem) problems.push(`fullTestCommand: "${config.fullTestCommand}" — ${problem}`);
    }
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

  const norm = file.replace(/\\/g, '/');
  const sharedRel = norm.endsWith(CLASSIC_CONFIG_PATH) ? CLASSIC_CONFIG_PATH : COMPACT_CONFIG_PATH;
  const localRel = resolveLocalConfigPath(sharedRel);

  const localFile = resolveLocalConfigPath(file);
  let localRaw = null;
  if (existsSync(localFile)) {
    try {
      localRaw = JSON.parse(readFileSync(localFile, 'utf8'));
    } catch (err) {
      throw new Error(`invalid JSON in local config ${localFile} (${errText(err)}) (not JSON)`);
    }
    if (!isObject(localRaw)) throw new Error(`local config ${localFile} must be a JSON object`);
    const localProblems = validateLocalConfig(localRaw);
    if (localProblems.length) {
      throw new Error(`local config ${localFile}:\n- ${localProblems.join('\n- ')}`);
    }
  }

  const mergedRaw = { ...raw };
  if (localRaw) {
    for (const k of LOCAL_ALLOWED_KEYS) {
      if (localRaw[k] !== undefined) {
        if (isObject(localRaw[k]) && isObject(mergedRaw[k])) {
          mergedRaw[k] = { ...mergedRaw[k], ...localRaw[k] };
        } else {
          mergedRaw[k] = localRaw[k];
        }
      }
    }
  }

  const config = withDefaults(mergedRaw);
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`config ${configPath}:\n- ${problems.join('\n- ')}`);
  const paths = resolveLayout({ config, configPath });
  const effectiveBlocked = effectiveBlockedScripts(config);

  const modelSources = {
    executor: (localRaw?.executor?.model ? localRel : sharedRel),
    architect: (localRaw?.architect?.model ? localRel : sharedRel),
  };

  return {
    ...config,
    runner: config.runner ?? 'agy',
    runnerBin: config.runnerBin ?? (config.runner === 'claude' ? 'claude' : config.agyBin),
    blockedScripts: effectiveBlocked,
    blockedNpmScripts: effectiveBlocked,
    layout: paths.layout,
    paths,
    bypassRegexps: config.bypassPatterns.map((p) => new RegExp(p)),
    _modelSources: modelSources,
  };
}

/**
 * `--init`: creates the config from the example (never overwrites) and adds the runs directory
 * to .gitignore unless it is already ignored. Throws outside a git repository.
 * @returns {string[]} what was done, for the console
 */
export function initProject({ workDir, configPath = COMPACT_CONFIG_PATH, realGit, team = false, runner = null }) {
  const targetPath = configPath || COMPACT_CONFIG_PATH;
  const ignored = isIgnored(realGit, workDir, `${RUNS_DIR}/`);
  const notes = [];
  const file = path.resolve(workDir, targetPath);
  if (existsSync(file)) notes.push(`config already exists, leaving unchanged: ${targetPath}`);
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    const norm = targetPath.replace(/\\/g, '/');
    const isCompact = norm === COMPACT_CONFIG_PATH || norm.endsWith('/' + COMPACT_CONFIG_PATH) || norm.startsWith('.architect/');
    const base = { ...DEFAULTS, executor: { model: '' }, architect: { model: '' } };
    if (runner) {
      base.runner = runner;
    }
    if (team) {
      base.team = true;
      base.fullTestCommand = 'npm test';
    }
    if (isCompact) {
      writeFileSync(file, JSON.stringify({ layout: 'compact', ...base }, null, 2) + '\n');
    } else {
      writeFileSync(file, JSON.stringify(base, null, 2) + '\n');
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
  if (team) {
    const wfDir = path.join(workDir, '.github', 'workflows');
    const targetWf = path.join(wfDir, 'team-ci.yml');
    if (!existsSync(targetWf)) {
      mkdirSync(wfDir, { recursive: true });
      const orchDir = path.dirname(fileURLToPath(import.meta.url));
      const skillDir = path.dirname(orchDir);
      const tmpl = path.join(skillDir, 'templates', 'github-team-ci.yml');
      if (existsSync(tmpl)) {
        writeFileSync(targetWf, readFileSync(tmpl, 'utf8'));
        notes.push('created .github/workflows/team-ci.yml from template');
      }
    } else {
      notes.push('.github/workflows/team-ci.yml already exists, leaving unchanged');
    }

    const gitignore = path.join(workDir, '.gitignore');
    const prev = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    const toAdd = [];
    if (!prev.includes(COMPACT_LOCAL_CONFIG_PATH)) toAdd.push(COMPACT_LOCAL_CONFIG_PATH);
    if (!prev.includes(CLASSIC_LOCAL_CONFIG_PATH)) toAdd.push(CLASSIC_LOCAL_CONFIG_PATH);
    if (toAdd.length > 0) {
      const sep = prev === '' ? '' : prev.endsWith('\n') ? '' : '\n';
      appendFileSync(gitignore, `${sep}${toAdd.join('\n')}\n`);
      notes.push('added local config overlays to .gitignore');
    }
  }
  const hookRes = installCommitMsgHook({ workDir, realGit });
  if (hookRes.installed) notes.push('installed .git/hooks/commit-msg');
  else if (hookRes.skipped) notes.push(`skipped .git/hooks/commit-msg (${hookRes.reason})`);
  return notes;
}
