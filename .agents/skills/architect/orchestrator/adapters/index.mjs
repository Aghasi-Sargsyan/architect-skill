// Unified runner adapter registry (D2): agy and claude.
import { listModels, runAgent, validateAnswer, checkAgyEnv } from './agy.mjs';
import {
  CLAUDE_SETTINGS_SHOWN,
  claudeAllowlistBlock,
  claudePermissionsCheck,
  claudeRulesFor,
  claudeSettingsPath,
  createClaudeFormatter,
  listClaudeModels,
  runClaudeAgent,
  toClaudeBashRule,
  writeClaudeAllowlist,
  checkClaudeEnv,
} from './claude.mjs';
import { createAgyFormatter } from '../feed.mjs';
import {
  AGY_SETTINGS_SHOWN,
  agySettingsPath,
  allowlistBlock,
  permissionsCheck,
  rulesFor,
  writeAgyAllowlist,
} from '../permissions.mjs';

export const SUPPORTED_RUNNERS = ['agy', 'claude'];

export function getAdapter(configOrRunner = 'agy') {
  const name = typeof configOrRunner === 'string' ? configOrRunner : (configOrRunner?.runner ?? 'agy');
  if (!SUPPORTED_RUNNERS.includes(name)) {
    throw new Error(`Unsupported runner "${name}" (unknown runner). Supported: ${SUPPORTED_RUNNERS.join(', ')}`);
  }
  if (name === 'agy') {
    return {
      name: 'agy',
      displayName: 'Antigravity',
      defaultBin: 'agy',
      capabilities: {
        sandbox: 'none',
        supportsModelList: true,
        supportsJsonSchema: true,
        supportsContinue: true,
      },
      resolveBin: (cfg = {}) => cfg.runnerBin || cfg.agyBin || 'agy',
      listModels,
      runAgent,
      validateAnswer,
      createFormatter: createAgyFormatter,
      permissions: {
        name: 'allowlist Antigravity',
        settingsShown: AGY_SETTINGS_SHOWN,
        settingsPath: agySettingsPath,
        rulesFor,
        allowlistBlock,
        writeAllowlist: writeAgyAllowlist,
        check: permissionsCheck,
        toAllowRule: (r) => `command(${r})`,
      },
    };
  }
  return {
    name: 'claude',
    displayName: 'Claude Code',
    defaultBin: 'claude',
    capabilities: {
      sandbox: 'os-seatbelt-bwrap',
      supportsModelList: false,
      supportsJsonSchema: true,
      supportsContinue: true,
    },
    resolveBin: (cfg = {}) => cfg.runnerBin || 'claude',
    listModels: listClaudeModels,
    runAgent: runClaudeAgent,
    validateAnswer,
    createFormatter: createClaudeFormatter,
    permissions: {
      name: 'allowlist Claude Code',
      settingsShown: CLAUDE_SETTINGS_SHOWN,
      settingsPath: claudeSettingsPath,
      rulesFor: claudeRulesFor,
      allowlistBlock: claudeAllowlistBlock,
      writeAllowlist: writeClaudeAllowlist,
      check: claudePermissionsCheck,
      toAllowRule: toClaudeBashRule,
    },
  };
}

export function parseRunnerSpec(spec) {
  if (spec == null || typeof spec !== 'string' || !spec.trim()) {
    throw new Error('Empty model specification');
  }
  const trimmed = spec.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return { runner: 'agy', model: trimmed };
  }
  const runner = trimmed.slice(0, colonIdx).trim();
  const model = trimmed.slice(colonIdx + 1).trim();
  if (!runner) {
    throw new Error(`Invalid specification "${spec}": empty runner name before ":"`);
  }
  if (!model) {
    throw new Error(`Invalid specification "${spec}": empty model ID after "${runner}:"`);
  }
  return { runner, model };
}

export function checkRunnerEnv(runnerOrConfig) {
  const runner = typeof runnerOrConfig === 'string' ? runnerOrConfig : (runnerOrConfig?.runner ?? 'agy');
  if (!SUPPORTED_RUNNERS.includes(runner)) {
    return { ok: false, issues: [`runner "${runner}" is not supported yet (supported: ${SUPPORTED_RUNNERS.join(', ')})`] };
  }
  const adapter = getAdapter(runnerOrConfig);
  const bin = adapter.resolveBin(typeof runnerOrConfig === 'object' ? runnerOrConfig : {});
  return runner === 'agy' ? checkAgyEnv(bin) : checkClaudeEnv(bin);
}

export async function checkModelAccess({ runner = 'agy', model, ...cfg }, env = process.env) {
  if (!SUPPORTED_RUNNERS.includes(runner)) {
    return { ok: false, detail: `runner "${runner}" is not supported yet (supported: ${SUPPORTED_RUNNERS.join(', ')})` };
  }
  const adapter = getAdapter({ runner, ...cfg });
  const bin = adapter.resolveBin(cfg);
  try {
    const models = await adapter.listModels({ bin, env });
    const found = models.some((m) => m.id === model);
    if (!found) {
      return { ok: false, detail: `model "${model}" is not in available models for ${adapter.displayName}` };
    }
    return { ok: true, detail: `model "${model}" available` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function checkAdapterPermissions(runnerOrConfig, options = {}) {
  const runner = typeof runnerOrConfig === 'string' ? runnerOrConfig : (runnerOrConfig?.runner ?? 'agy');
  if (!SUPPORTED_RUNNERS.includes(runner)) {
    return { ok: false, issues: [`runner "${runner}" is not supported yet (supported: ${SUPPORTED_RUNNERS.join(', ')})`] };
  }
  const adapter = getAdapter(runnerOrConfig);
  const res = adapter.permissions.check(typeof runnerOrConfig === 'object' ? { ...runnerOrConfig, ...options } : options);
  return res.ok ? { ok: true, issues: [] } : { ok: false, issues: [res.detail] };
}

export function writeAdapterAllowlist(runnerOrConfig, options = {}) {
  const runner = typeof runnerOrConfig === 'string' ? runnerOrConfig : (runnerOrConfig?.runner ?? 'agy');
  if (!SUPPORTED_RUNNERS.includes(runner)) {
    throw new Error(`runner "${runner}" does not support writing allowlist`);
  }
  const adapter = getAdapter(runnerOrConfig);
  return adapter.permissions.writeAllowlist(options);
}
