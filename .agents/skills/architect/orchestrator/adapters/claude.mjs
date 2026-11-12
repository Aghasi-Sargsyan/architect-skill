// Claude Code CLI adapter (`claude -p`).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail } from '../feed.mjs';
import { findExecutable } from '../events.mjs';
import { trackChild } from '../run-lock.mjs';
import { parseAgentResponse } from './agy.mjs';
import { claudeModelArgs } from './claude-models.mjs';
import { claudeSettingsPath } from './claude-permissions.mjs';

export {
  CLAUDE_SETTINGS_SHOWN, claudeAllowlistBlock, claudePermissionsCheck, claudeRulesFor, claudeSettingsPath, toClaudeBashRule, writeClaudeAllowlist,
} from './claude-permissions.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? err.message : String(err));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const TRANSIENT_RE = /\b(503|UNAVAILABLE|RESOURCE_EXHAUSTED|429|EOF|ECONNRESET|ETIMEDOUT|overloaded_error|rate_limit_error)\b/i;
const maskHome = (p, home = os.homedir()) => (p ? String(p).split(home).join('~').replace(/\\/g, '/') : null);

export function extractClaudeDeniedStep(denials = []) {
  if (!Array.isArray(denials) || denials.length === 0) return null;
  const d = denials.at(-1);
  if (d?.tool_name === 'Bash' && typeof d?.tool_input?.command === 'string') {
    const reason = typeof d?.tool_input?.description === 'string' ? d.tool_input.description.trim() : '';
    return { kind: 'command', command: d.tool_input.command, ...(reason ? { reason } : {}) };
  }
  return { kind: 'other', text: `${d?.tool_name ?? 'tool'}: ${d?.tool_input?.file_path ?? JSON.stringify(d?.tool_input ?? {}).slice(0, 200)}` };
}

export function createClaudeFormatter({ workDir, home = os.homedir() }) {
  const clip = (s, n = 160) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));
  const normW = workDir ? workDir.replaceAll('\\', '/').replace(/\/+$/, '') : '';
  const normH = home ? home.replaceAll('\\', '/').replace(/\/+$/, '') : '';
  const rel = (p) => {
    if (!p) return '';
    const norm = String(p).replaceAll('\\', '/');
    if (normW && (norm === normW || norm.startsWith(`${normW}/`))) return norm === normW ? '.' : norm.slice(normW.length + 1);
    if (normH && (norm === normH || norm.startsWith(`${normH}/`))) return norm === normH ? '~' : `~/${norm.slice(normH.length + 1)}`;
    return norm;
  };
  const time = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 8) : '--:--:--');
  return (rows) => rows.flatMap((r) => {
    if (r?.type !== 'assistant') return [];
    const t = time(r.timestamp ?? r.created_at);
    return (Array.isArray(r.message?.content) ? r.message.content : []).filter((item) => item?.type === 'tool_use').map((item) => {
      const { name, input = {} } = item;
      if (name === 'Read') return `${t} 📖 reads ${rel(input.file_path)}`;
      if (name === 'Edit' || name === 'MultiEdit') return `${t} ✏️ edits ${rel(input.file_path)}`;
      if (name === 'Write') return `${t} 📝 creates ${rel(input.file_path)}`;
      if (name === 'Bash') return `${t} ▶ ${clip(input.command)}${input.description ? ` — ${clip(input.description, 80)}` : ''}`;
      return null;
    }).filter(Boolean);
  });
}

export { listClaudeModels } from './claude-models.mjs';

export function findClaudeTranscript(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const base = path.join(home, '.claude', 'projects');
  try {
    if (!existsSync(base)) return null;
    for (const d of readdirSync(base)) {
      const p = path.join(base, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { return null; }
  return null;
}

function spawnCollect(bin, args, { cwd, env, timeoutMs, killGraceMs = 5000 }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, done = false, timer = null, killTimer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve({ stdout, stderr, ...r, signal: timedOut ? (r.signal ?? 'SIGTERM') : (r.signal ?? null) });
    };
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child);
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, killGraceMs);
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status, signal) => finish({ status, signal, error: null }));
  });
}

export function parseClaudeOutput(stdout, stderr = '', code = 0) {
  const text = String(stdout ?? '').trim();
  if (!text) return { ok: false, error: `claude output does not contain JSON (code ${code}): ${stderr || '(empty)'}` };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    return { ok: false, error: !text.includes('{') ? `claude output does not contain JSON (code ${code}): ${text.slice(0, 300)}` : `invalid JSON from claude: ${err.message}` };
  }
  if (parsed.is_error) return { ok: false, error: parsed.error || parsed.result || 'rejected by model', raw: parsed };
  let json = isObject(parsed.structured_output) && Object.keys(parsed.structured_output).length > 0 ? parsed.structured_output : null;
  if (!json && parsed.result) {
    try { json = parseAgentResponse(parsed.result).json; }
    catch (err) { return { ok: false, error: `Response does not contain a final JSON block {...}: ${err.message}`, raw: parsed }; }
  }
  return json ? { ok: true, json, raw: parsed } : { ok: false, error: 'Response does not contain a final JSON block {...}', raw: parsed };
}

// The flags runClaudeAgent passes besides -p, the model and --dangerously-skip-permissions (ADR-079).
export const REQUIRED_CLAUDE_FLAGS = [
  '--output-format', '--json-schema', '--setting-sources', '--settings', '--permission-mode', '--permission-prompts', '--session-id', '--resume',
];

const flagListed = (help, flag) => new RegExp(`(?<![\\w-])${flag}(?=[\\s,=<[]|$)`, 'm').test(help);

export function checkClaudeEnv(claudeBin = 'claude') {
  const issues = [];
  const resolved = claudeBin.includes(path.sep) ? (existsSync(claudeBin) ? claudeBin : null) : findExecutable(claudeBin);
  if (!resolved) return { ok: false, issues: [`Claude Code CLI not found in PATH: ${claudeBin}`] };
  try {
    const r = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) issues.push(`Failed to run "${claudeBin} --version": ${r.error ? r.error.message : `exit ${r.status}`}`);
  } catch (err) {
    issues.push(`Failed to run "${claudeBin} --version": ${err.message}`);
  }
  try {
    const r = spawnSync(resolved, ['--help'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) {
      issues.push(`Failed to run "${claudeBin} --help": ${r.error ? r.error.message : `exit ${r.status}`}`);
    } else {
      const help = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      const missing = REQUIRED_CLAUDE_FLAGS.filter((f) => !flagListed(help, f));
      if (missing.length) issues.push(`Claude Code CLI does not support ${missing.join(', ')} (checked "${claudeBin} --help") — update Claude Code`);
    }
  } catch (err) {
    issues.push(`Failed to run "${claudeBin} --help": ${err.message}`);
  }
  return { ok: issues.length === 0, issues };
}

export async function runClaudeAgent({
  bin, model, prompt, cwd, schemaPath, env, skipPermissions, timeoutMs,
  killGraceMs = 5000, maxAttempts = 3, conversationId = null, settingsPath = null,
  log, onTranscriptRows, home = os.homedir(),
}) {
  const actualSettings = settingsPath ?? (cwd ? claudeSettingsPath(home, cwd) : claudeSettingsPath(home));
  let schemaJson = '';
  if (schemaPath) {
    try {
      schemaJson = JSON.stringify(JSON.parse(readFileSync(schemaPath, 'utf8')));
    } catch (err) {
      return { ok: false, error: `failed to read schemaPath (${schemaPath}): ${errText(err)}`, conversationId, transcript: null, attempts: 0, seconds: 0 };
    }
  }

  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptSessionId = conversationId ? null : randomUUID(), activeId = conversationId || attemptSessionId;
    const args = [
      '-p', prompt, ...claudeModelArgs(model), '--output-format', 'json', '--json-schema', schemaJson,
      '--setting-sources', '', '--settings', actualSettings, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      ...(conversationId ? ['--resume', conversationId] : ['--session-id', attemptSessionId]),
      ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ];

    let foundFile = findClaudeTranscript(activeId, home);
    const existedBefore = Boolean(foundFile);
    let tail = foundFile ? (conversationId && existedBefore ? JsonlTail.fromEnd(foundFile) : new JsonlTail(foundFile)) : null;

    let conv = null;
    const pump = () => {
      if (!tail) {
        foundFile = findClaudeTranscript(conv || activeId, home);
        if (foundFile) tail = conversationId && existedBefore ? JsonlTail.fromEnd(foundFile) : new JsonlTail(foundFile);
      }
      const rows = tail ? tail.read() : [];
      if (rows.length) onTranscriptRows?.(rows);
    };

    const watcher = onTranscriptRows ? setInterval(pump, 1000) : null;
    const r = await spawnCollect(bin, args, { cwd, env, timeoutMs, killGraceMs }).finally(() => watcher && clearInterval(watcher));
    log?.(`claude attempt ${attempt}: exit=${r.status} signal=${r.signal ?? '-'} ${elapsed()}s`);
    if (r.error) lastError = `failed to start ${bin}: ${r.error.message}`;
    let raw = null;
    if (!r.error) {
      try { raw = JSON.parse(r.stdout); } catch (err) { lastError = `stdout is not JSON (${errText(err)}); stderr: ${String(r.stderr).slice(0, 400)}`; }
    }
    conv = raw?.session_id ?? conversationId ?? attemptSessionId ?? null;

    if (onTranscriptRows) {
      if (!tail) {
        foundFile = findClaudeTranscript(conv || activeId, home);
        if (foundFile) tail = conversationId && existedBefore ? JsonlTail.fromEnd(foundFile) : new JsonlTail(foundFile);
      }
      pump();
    }
    if (!foundFile) foundFile = findClaudeTranscript(conv || activeId, home);
    const transcript = foundFile ? maskHome(foundFile, home) : null;

    if (Array.isArray(raw?.permission_denials) && raw.permission_denials.length > 0) {
      return {
        ok: false, denied: true, conversationId: conv, transcript, deniedActions: raw.permission_denials,
        deniedStep: extractClaudeDeniedStep(raw.permission_denials), error: 'agent lacked permissions (Claude Code allowlist)', attempts: attempt, seconds: elapsed(),
      };
    }

    if (!r.error) {
      const parsedRes = parseClaudeOutput(r.stdout, r.stderr, r.status);
      if (parsedRes.ok) return { ok: true, json: parsedRes.json, raw: parsedRes.raw, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() };
      lastError = parsedRes.error;
    }

    const transient = r.signal !== 'SIGTERM' && TRANSIENT_RE.test(`${r.stderr} ${lastError}`);
    if (!transient || attempt === maxAttempts) {
      return { ok: false, error: lastError || `exit ${r.status}: ${String(r.stderr).slice(0, 400)}`, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() };
    }
    await sleep(15000 * attempt);
  }
  return { ok: false, error: lastError, conversationId: null, transcript: null, attempts: maxAttempts, seconds: elapsed() };
}
