// Model inspection and configuration module for --models and --set-model.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAdapter } from './adapters/index.mjs';
import { syncClaudeAgentFile } from './adapters/claude-models.mjs';
import { resolveExecutorModelInfo } from './hooks.mjs';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/**
 * Extracts effort level ('low' | 'medium' | 'high' | 'xhigh' | 'max') from model name or id.
 */
export function extractEffort({ id = '', name = '' } = {}) {
  if (typeof name === 'string' && name) {
    const parenMatch = name.match(/\(([^)]+)\)/);
    if (parenMatch) {
      const inside = parenMatch[1].trim().toLowerCase();
      if (EFFORT_LEVELS.includes(inside)) return inside;
      const word = inside.split(/[\s-]+/).find((w) => EFFORT_LEVELS.includes(w));
      if (word) return word;
    }
  }
  if (typeof id === 'string' && id) {
    const suffixMatch = id.match(/-([a-z0-9]+)$/i);
    if (suffixMatch && EFFORT_LEVELS.includes(suffixMatch[1].toLowerCase())) {
      return suffixMatch[1].toLowerCase();
    }
  }
  return null;
}

export function normalizeModelValue(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim().replace(/^[*_\s]+|[*_\s]+$/g, '');
  const bt = s.match(/`([^`]*)`/);
  if (bt) s = bt[1];
  return s.trim().replace(/^[*_` \t]+|[*_` \t]+$/g, '');
}

export function isValidModel(val) {
  const s = normalizeModelValue(val);
  return Boolean(s) && s.toLowerCase() !== 'inherit' && !/^<.*>$/.test(s);
}

function validateModelName(model) {
  const s = normalizeModelValue(model);
  if (!s || /^<.*>$/.test(s)) {
    throw new Error('model must be a non-empty model identifier, not placeholder');
  }
  if (s.toLowerCase() === 'inherit') {
    throw new Error('model must be a specific model name, not "inherit"');
  }
  if (!MODEL_ID_RE.test(s)) {
    throw new Error(`model id must match ${MODEL_ID_RE} (letters, digits and . _ : / @ -, no spaces or quotes)`);
  }
  return s;
}

/**
 * Resolves configured model for the Architect role from local and shared configs.
 */
export function resolveArchitectModelInfo({ workDir = process.cwd(), config = null } = {}) {
  if (config?._modelSources?.architect?.endsWith('.local.json') && isValidModel(config.architect?.model)) {
    const model = normalizeModelValue(config.architect.model);
    const source = config._modelSources.architect;
    return { ok: true, model, source, detail: `${model} (source: ${source})` };
  }
  for (const rel of ['.architect/config.local.json', '.agents/orchestrator.local.json']) {
    const full = path.join(workDir, rel);
    if (existsSync(full)) {
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        if (isValidModel(raw?.architect?.model)) {
          const model = normalizeModelValue(raw.architect.model);
          return { ok: true, model, source: rel, detail: `${model} (source: ${rel})` };
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  if (config?._modelSources?.architect && isValidModel(config.architect?.model)) {
    const model = normalizeModelValue(config.architect.model);
    const source = config._modelSources.architect;
    return { ok: true, model, source, detail: `${model} (source: ${source})` };
  }
  if (config && !config._missingConfigFile && isValidModel(config.architect?.model)) {
    const model = normalizeModelValue(config.architect.model);
    const source = config.paths?.planPath?.startsWith('.architect') ? '.architect/config.json' : '.agents/orchestrator.json';
    return { ok: true, model, source, detail: `${model} (source: ${source})` };
  }
  for (const rel of ['.architect/config.json', '.agents/orchestrator.json']) {
    const full = path.join(workDir, rel);
    if (existsSync(full)) {
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        if (isValidModel(raw?.architect?.model)) {
          const model = normalizeModelValue(raw.architect.model);
          return { ok: true, model, source: rel, detail: `${model} (source: ${rel})` };
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  const detail = 'Architect model is not configured — set architect.model in .agents/orchestrator.json or .architect/config.json';
  return { ok: false, model: null, source: null, detail };
}

/**
 * Lists available models from the active runner with effort information.
 */
export async function listAvailableModels({
  workDir = process.cwd(),
  config = null,
  env = process.env,
  listRunnerModels = null,
} = {}) {
  let runner = config?.runner;
  let bin = config?.runnerBin;
  if (!runner) {
    for (const rel of ['.architect/config.local.json', '.agents/orchestrator.local.json', '.architect/config.json', '.agents/orchestrator.json']) {
      const full = path.join(workDir, rel);
      if (existsSync(full)) {
        try {
          const raw = JSON.parse(readFileSync(full, 'utf8'));
          if (raw?.runner) {
            runner = raw.runner;
            bin = raw.runnerBin;
            break;
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    }
  }
  runner = runner ?? 'agy';
  const adapter = getAdapter(runner);
  bin = bin ?? adapter.resolveBin(config ?? {});
  const raw = listRunnerModels
    ? await listRunnerModels({ runner, bin, env })
    : await adapter.listModels({ bin, env });

  return {
    runner,
    models: (raw ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      effort: extractEffort(m),
      runner,
    })),
  };
}

/**
 * Updates model for executor or architect role in local or shared config files.
 */
export function setRoleModel({ workDir = process.cwd(), role, model, local = false } = {}) {
  if (role !== 'executor' && role !== 'architect') {
    throw new Error('role must be "executor" or "architect"');
  }
  const validModel = validateModelName(model);

  let targetRel;
  if (local) {
    if (existsSync(path.join(workDir, '.architect', 'config.local.json'))) {
      targetRel = '.architect/config.local.json';
    } else if (existsSync(path.join(workDir, '.agents', 'orchestrator.local.json'))) {
      targetRel = '.agents/orchestrator.local.json';
    } else if (existsSync(path.join(workDir, '.architect', 'config.json'))) {
      targetRel = '.architect/config.local.json';
    } else {
      targetRel = '.agents/orchestrator.local.json';
    }
  } else {
    if (existsSync(path.join(workDir, '.architect', 'config.json'))) {
      targetRel = '.architect/config.json';
    } else {
      targetRel = '.agents/orchestrator.json';
    }
  }

  const fullTarget = path.join(workDir, targetRel);
  mkdirSync(path.dirname(fullTarget), { recursive: true });
  let raw = {};
  let prevConfigText = null;
  if (existsSync(fullTarget)) {
    try {
      prevConfigText = readFileSync(fullTarget, 'utf8');
      raw = JSON.parse(prevConfigText);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  raw[role] = { ...(raw[role] || {}), model: validModel };
  const nextConfigText = JSON.stringify(raw, null, 2) + '\n';
  writeFileSync(fullTarget, nextConfigText);
  const updatedFiles = [targetRel];
  let changed = nextConfigText !== prevConfigText;

  if (!local && role === 'executor') {
    // The config is the source of truth; for the executor, ok also needs a synced doc line or agent file.
    changed = false;
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const docPath = path.join(workDir, name);
      if (existsSync(docPath)) {
        const text = readFileSync(docPath, 'utf8');
        let replaced = false;
        let updatedText = text.replace(
          /((?:Executor model|Модель Исполнителя)[*_ \t]*:[ \t]*)(`?[^\r\n`]+`?)([^\r\n]*)/i,
          (_, prefix, val, rest) => {
            replaced = true;
            const hasBackticks = val.trim().startsWith('`') && val.trim().endsWith('`');
            return `${prefix}${hasBackticks ? `\`${validModel}\`` : validModel}${rest}`;
          },
        );
        if (!replaced) {
          updatedText = updatedText.replace(
            /(Исполнитель по умолчанию[ \t]*[—–-][ \t]*)([^\r\n]+?)(?=\.(?:[ \t\r\n]|$))/i,
            (_, prefix, val) => {
              replaced = true;
              const hasBackticks = val.trim().startsWith('`') && val.trim().endsWith('`');
              return `${prefix}${hasBackticks ? `\`${validModel}\`` : validModel}`;
            },
          );
        }
        if (replaced) {
          if (updatedText !== text) {
            writeFileSync(docPath, updatedText);
            changed = true;
          }
          updatedFiles.push(name);
        }
      }
    }

    const claudeAgent = path.join(workDir, '.claude', 'agents', 'executor.md');
    if (existsSync(claudeAgent)) {
      const text = readFileSync(claudeAgent, 'utf8');
      const synced = syncClaudeAgentFile(text, validModel);
      if (synced !== null) {
        if (synced !== text) {
          writeFileSync(claudeAgent, synced);
          changed = true;
        }
        updatedFiles.push('.claude/agents/executor.md');
      }
    }
  }

  return { ok: changed, role, model: validModel, updatedFiles };
}

/**
 * Handles --models and --set-model CLI invocations.
 */
export async function handleModelsCli({
  workDir = process.cwd(),
  opts = {},
  listRunnerModels = null,
  print = console.log,
} = {}) {
  if (process.env.AGENT_LOOP === '1') {
    throw new Error('orchestrator cannot be run from inside the agent loop (AGENT_LOOP=1)');
  }

  if (opts.setModel) {
    const { role, model } = opts.setModel;
    const res = setRoleModel({ workDir, role, model, local: Boolean(opts.local) });
    print(res.ok
      ? `• ${res.role}.model set to ${res.model} (${res.updatedFiles.join(', ')})`
      : `• ${res.role}.model ${res.model}: nothing changed — no matching model line to update (${res.updatedFiles.join(', ')})`);
    return res;
  }

  const executor = resolveExecutorModelInfo({ workDir });
  const architect = resolveArchitectModelInfo({ workDir });

  print(`executor:  ${executor.model ?? 'not set'}`);
  print(`architect: ${architect.model ?? 'not set'}`);

  const available = await listAvailableModels({ workDir, listRunnerModels });
  for (let i = 0; i < available.models.length; i++) {
    const m = available.models[i];
    print(`${i + 1}. ${m.id}\t${m.name}`);
  }

  return {
    ok: true,
    runner: available.runner,
    current: { executor, architect },
    models: available.models,
  };
}
