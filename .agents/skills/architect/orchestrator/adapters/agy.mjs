// Adapter: run one agent turn through the Antigravity CLI (`agy -p`) and return the parsed JSON answer.
// Other environments (claude -p, gemini -p, codex exec) implement the same runAgent signature.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail } from '../feed.mjs';
import { findExecutable } from '../events.mjs';
import { trackChild } from '../run-lock.mjs';

const TRANSIENT_RE = /\b(503|UNAVAILABLE|RESOURCE_EXHAUSTED|429|EOF|ECONNRESET|ETIMEDOUT|Eligibility check failed)\b/i;
const PERMISSION_RE = /cannot prompt|auto-denied/i;
const DENIED_COMMAND_RE = /permission check failed for unsandboxed "([\s\S]*?)": user denied permission/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Where agy keeps each conversation; `home` is a parameter so tests can use a fake HOME. */
export const brainDir = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli', 'brain');
export const transcriptPath = (conversationId, home = os.homedir()) => path.join(brainDir(home), conversationId, '.system_generated', 'logs', 'transcript.jsonl');
export const maskHome = (p, home = os.homedir()) => String(p).split(home).join('~');

const unquote = (v) => {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); /* close */ }
  }
  return s;
};

/**
 * The step that was denied, from the agent's transcript (newest ERROR step about a permission).
 * @returns {{ kind: 'command', command: string, reason?: string } | { kind: 'other', text: string } | null}
 */
export function deniedFromTranscript(conversationId, home = os.homedir()) {
  const file = conversationId ? transcriptPath(conversationId, home) : '';
  if (!file || !existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch (err) {
      // A line still being written or broken: not a denied step; older lines are checked next.
      row = { status: 'UNREADABLE', content: errText(err) };
    }
    if (row.status !== 'ERROR') continue;
    const text = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
    const m = text.match(DENIED_COMMAND_RE);
    if (m) {
      let cand = null;
      for (let j = i - 1; j >= 0; j--) {
        let prev;
        try { prev = JSON.parse(lines[j]); } catch { continue; /* close */ }
        if (!Array.isArray(prev?.tool_calls)) continue;
        for (const tc of prev.tool_calls) {
          if (tc?.name !== 'run_command') continue;
          let a = tc?.args;
          if (typeof a === 'string') {
            try { a = JSON.parse(a); } catch { a = tc.args; }
          }
          if (unquote(a?.CommandLine) === m[1]) {
            cand = { step: prev, tc, args: a };
            break;
          }
          if (!cand) cand = { step: prev, tc, args: a };
        }
        if (cand && unquote(cand.args?.CommandLine) === m[1]) break;
      }
      let reason = '';
      if (cand) {
        const summary = unquote(cand.args?.toolSummary);
        if (summary) reason = summary.slice(0, 160);
        else {
          const fallback = typeof cand.step?.thinking === 'string' && cand.step.thinking.trim()
            ? cand.step.thinking : (typeof cand.step?.content === 'string' ? cand.step.content : '');
          const line = fallback.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
          if (line) reason = line.slice(0, 160);
        }
      }
      reason = reason.trim();
      return reason ? { kind: 'command', command: m[1], reason } : { kind: 'command', command: m[1] };
    }
    if (/permission/i.test(text)) return { kind: 'other', text: text.slice(0, 300) };
  }
  return null;
}

/** Scans newest-to-oldest rows for a completed `finish` tool call and returns its args, or null. */
export function finishFromTranscript(conversationId, home = os.homedir()) {
  const file = conversationId ? transcriptPath(conversationId, home) : '';
  if (!file || !existsSync(file)) return null;
  let lines = null;
  try { lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); } catch (err) { return null; /* unreadable or locked */ }
  for (let i = lines.length - 1; i >= 0; i--) {
    let row = null;
    try { row = JSON.parse(lines[i]); } catch (err) { continue; /* skip partial line */ }
    if (row?.status !== 'DONE' || !Array.isArray(row.tool_calls)) continue;
    for (const tc of row.tool_calls) {
      if (tc?.name !== 'finish') continue;
      let a = tc.args;
      if (typeof a === 'string') try { a = JSON.parse(a); } catch (err) { a = null; /* invalid args */ }
      if (a && typeof a === 'object' && typeof (a.status ?? a.verdict) === 'string') return a;
    }
  }
  return null;
}

/** spawn() as a promise with collected output and a timeout (SIGTERM -> SIGKILL). */
function spawnCollect(bin, args, { cwd, env, timeoutMs, killGraceMs = 5000 }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let timer = null;
    let killTimer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, ...r, signal: timedOut ? (r.signal ?? 'SIGTERM') : r.signal ?? null });
    };
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status, signal) => finish({ status, signal, error: null }));
  });
}

/**
 * Conversation directory created since `sinceMs` and absent from `existingDirs`, or null.
 */
export function newestConversation(sinceMs, home, existingDirs = null) {
  const dir = brainDir(home);
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    if (existingDirs?.has(name)) continue;
    const st = statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (st && st.isDirectory() && st.birthtimeMs >= sinceMs - 1000 && (!best || st.birthtimeMs > best.birthtimeMs)) best = { name, birthtimeMs: st.birthtimeMs };
  }
  return best?.name ?? null;
}

/**
 * Parses agy CLI stdout/stderr into structured response object.
 * @param {string} stdout
 * @param {string} stderr
 * @param {number} code
 */
export function parseAgyOutput(stdout, stderr = '', code = 0) {
  const text = String(stdout ?? '').trim();
  if (!text) return { ok: false, error: `agy output does not contain JSON (code ${code}): ${stderr || '(empty)'}` };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!text.includes('{')) return { ok: false, error: `agy output does not contain JSON (code ${code}): ${text.slice(0, 300)}` };
    return { ok: false, error: `invalid JSON from agy: ${err.message}` };
  }
  if (parsed.status === 'ERROR') return { ok: false, error: parsed.error || parsed.response || 'rejected by model', raw: parsed };
  try {
    const { json, discardedPrefixLength } = parseAgentResponse(parsed.response ?? text);
    return { ok: true, json, raw: parsed, discardedPrefixLength };
  } catch (err) {
    return { ok: false, error: `Response does not contain a final JSON block {...}: ${err.message}`, raw: parsed };
  }
}

/**
 * Checks Antigravity runner environment.
 * @param {string} agyBin
 */
export function checkAgyEnv(agyBin = 'agy') {
  const issues = [];
  const resolved = agyBin.includes(path.sep) ? (existsSync(agyBin) ? agyBin : null) : findExecutable(agyBin);
  if (!resolved) {
    issues.push(`Antigravity CLI not found: ${agyBin}`);
    return { ok: false, issues };
  }
  try {
    const r = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) {
      issues.push(`Failed to run "${agyBin} --version": ${r.error ? r.error.message : `exit ${r.status}`}`);
    }
  } catch (err) {
    issues.push(`Failed to run "${agyBin} --version": ${err.message}`);
  }
  if (process.platform === 'darwin') {
    try {
      const ps = spawnSync('pgrep', ['-f', 'language_server_macos'], { encoding: 'utf8', timeout: 3000 });
      if (ps.status !== 0 || !ps.stdout.trim()) {
        issues.push('Antigravity server is not running (no language_server_macos* process). Open the Antigravity app before running the loop.');
      }
    } catch (err) {
      issues.push(`Failed to check the Antigravity server: ${errText(err)}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * One agent turn, or the continuation of a conversation (`conversationId`). A permission denial is reported as
 * `denied` before anything else — even when the model still produced a valid answer in that turn — so the caller
 * can continue the same conversation instead of giving up.
 * @param {{ bin: string, model: string, prompt: string, cwd: string, schemaPath: string, env: NodeJS.ProcessEnv,
 *           skipPermissions: boolean, timeoutMs: number, maxAttempts?: number, conversationId?: string | null,
 *           log?: (msg: string) => void, onTranscriptRows?: (rows: object[]) => void, home?: string }} opts
 * @returns {Promise<{ ok: true, json: any, raw: any, conversationId: string | null, transcript: string | null, attempts: number, seconds: number } |
 *           { ok: false, denied?: boolean, deniedStep?: object | null, conversationId?: string | null, transcript?: string | null, error: string, attempts: number, seconds: number }>}
 */
export async function runAgent({ bin, model, prompt, cwd, schemaPath, env, skipPermissions, timeoutMs, killGraceMs = 5000, maxAttempts = 3, conversationId = null, log, onTranscriptRows, home = os.homedir() }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', schemaPath];
  if (conversationId) args.push('--conversation', conversationId);
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let tail = conversationId ? JsonlTail.fromEnd(transcriptPath(conversationId, home)) : null;
    const bDir = brainDir(home);
    const existingDirs = !conversationId && existsSync(bDir) ? new Set(readdirSync(bDir)) : null;
    const attemptStart = Date.now();
    const pump = () => {
      if (!tail) {
        const id = newestConversation(attemptStart, home, existingDirs);
        if (id) tail = new JsonlTail(transcriptPath(id, home));
      }
      const rows = tail ? tail.read() : [];
      if (rows.length) onTranscriptRows?.(rows);
    };
    const watcher = onTranscriptRows ? setInterval(pump, 2000) : null;
    const r = await spawnCollect(bin, args, { cwd, env, timeoutMs, killGraceMs }).finally(() => clearInterval(watcher));
    log?.(`agy attempt ${attempt}: exit=${r.status} signal=${r.signal ?? '-'} ${elapsed()}s`);
    if (r.error) lastError = `failed to start ${bin}: ${r.error.message}`;
    let raw = null;
    if (!r.error) {
      try { raw = JSON.parse(r.stdout); } catch (err) { lastError = `stdout is not JSON (${errText(err)}); stderr: ${String(r.stderr).slice(0, 400)}`; }
    }
    const conv = raw?.conversation_id ?? conversationId ?? null;
    if (onTranscriptRows) {
      if (!tail && conv) tail = new JsonlTail(transcriptPath(conv, home));
      pump(); // the last steps (finish, the denied one) written after the previous tick
    }
    const transcript = conv ? maskHome(transcriptPath(conv, home), home) : null;
    const deniedActions = Array.isArray(raw?.denied_actions) ? raw.denied_actions : [];
    if (PERMISSION_RE.test(String(r.stderr)) || deniedActions.length) {
      return {
        ok: false, denied: true, conversationId: conv, transcript, deniedActions, deniedStep: deniedFromTranscript(conv, home),
        error: `agent lacked permissions (Antigravity allowlist): ${String(r.stderr).slice(0, 300)}`, attempts: attempt, seconds: elapsed(),
      };
    }
    if (raw && raw.status === 'SUCCESS') {
      try {
        const { json, discardedPrefixLength } = parseAgentResponse(raw.response);
        if (discardedPrefixLength > 0) {
          log?.(`agy: discarded prefix of ${discardedPrefixLength} chars before final JSON`);
        }
        return { ok: true, json, raw, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() };
      } catch (err) {
        lastError = `response does not match JSON schema (${errText(err)}): ${String(raw.response).slice(0, 400)}`;
      }
    } else if (raw) {
      if (r.status === 0) {
        const finishArgs = finishFromTranscript(conv, home);
        if (finishArgs) {
          let json = finishArgs;
          try { const p = parseAgentResponse(raw.response ?? ''); if (p?.json && typeof p.json === 'object') json = p.json; }
          catch (err) { json = finishArgs; /* fallback */ }
          log?.(`  agy: recovered completed finish response after status ${raw.status}`);
          return { ok: true, json, raw, recoveredAfterFinish: true, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() };
        }
      }
      const resp = (raw.response != null ? String(raw.response) : '').trim();
      const err = (r.stderr != null ? String(r.stderr) : '').trim();
      const detail = resp || err || JSON.stringify(raw);
      lastError = `status ${raw.status}: ${detail.slice(0, 400)}`;
    }
    const transient = r.signal !== 'SIGTERM' && TRANSIENT_RE.test(`${r.stderr} ${lastError}`);
    if (!transient || attempt === maxAttempts) {
      return { ok: false, error: lastError || `exit ${r.status}: ${String(r.stderr).slice(0, 400)}`, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() };
    }
    await sleep(15000 * attempt);
  }
  return { ok: false, error: lastError, attempts: maxAttempts, seconds: elapsed() };
}

/** Parses `agy models` output: one «<id>\t<display name>» line per model; other lines are ignored. */
export function parseModels(text) {
  return String(text)
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 2 && parts[0].trim())
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
}

/**
 * Lists the runner's models; throws if the list cannot be read or is empty (callers fail closed).
 * @returns {Array<{ id: string, name: string }>}
 */
export function listModels({ bin, env, timeoutMs = 60_000 }) {
  const r = spawnSync(bin, ['models'], { env, encoding: 'utf8', timeout: timeoutMs });
  if (r.error || r.status !== 0) {
    throw new Error(`failed to get model list ("${bin} models"): ${r.error ? r.error.message : `exit ${r.status}`} ${String(r.stderr ?? '').slice(0, 300)}`.trim());
  }
  const models = parseModels(r.stdout);
  if (!models.length) throw new Error(`"${bin} models" returned an empty list`);
  return models;
}

/** Validates the fields the orchestrator relies on; extra fields from the model are ignored. */
export function validateAnswer(json, required, enums = {}) {
  if (!json || typeof json !== 'object') return 'response is not an object';
  for (const k of required) if (!(k in json)) return `response missing field ${k}`;
  for (const [k, values] of Object.entries(enums)) if (!values.includes(json[k])) return `field ${k}=${JSON.stringify(json[k])} is outside ${values.join('|')}`;
  return null;
}

const isJsonObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks if idx in trimmed is nested inside an unclosed JSON object or array prefix.
 */
function isNestedInUnclosedJson(trimmed, idx) {
  const before = trimmed.slice(0, idx);
  const trimmedBefore = before.trimEnd();
  if (!/[:\,\[]$/.test(trimmedBefore)) {
    return false;
  }

  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop();
      } else if (ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop();
      }
    }
  }
  if (stack.length === 0) return false;
  const top = stack[stack.length - 1];
  if (top === '{') {
    if (trimmedBefore.endsWith(':') && /"(?:[^"\\]|\\.)*"\s*:$/.test(trimmedBefore)) return true;
    if (trimmedBefore.endsWith(',')) return true;
  } else if (top === '[') {
    if (trimmedBefore.endsWith('[') || trimmedBefore.endsWith(',')) return true;
  }
  return false;
}

/**
 * Parses the agent's JSON response, allowing intermediate text preceding a final JSON object.
 * Throws SyntaxError if input is empty, does not end with '}', is not an object, or is nested in an unclosed JSON structure.
 * @param {string} rawResponse
 * @returns {{ json: any, discardedPrefixLength: number }}
 */
export function parseAgentResponse(rawResponse) {
  const trimmed = String(rawResponse ?? '').trim();
  if (!trimmed || !trimmed.endsWith('}')) throw new SyntaxError('Agent response must end with "}"');
  let whole = null;
  try { whole = JSON.parse(trimmed); } catch { whole = null; }
  if (isJsonObject(whole)) return { json: whole, discardedPrefixLength: 0 };
  for (let idx = 1; idx < trimmed.length; idx++) {
    if (trimmed[idx] !== '{') continue;
    let parsed;
    try { parsed = JSON.parse(trimmed.slice(idx)); } catch { continue; }
    if (isJsonObject(parsed) && !isNestedInUnclosedJson(trimmed, idx)) {
      return { json: parsed, discardedPrefixLength: idx };
    }
  }
  throw new SyntaxError('No valid JSON object found at the end of agent response');
}
