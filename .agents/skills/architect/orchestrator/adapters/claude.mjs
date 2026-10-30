// Claude Code CLI adapter (`claude -p`).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail } from '../feed.mjs';
import { findExecutable } from '../events.mjs';
import { allowedCommandsFor, commandProblem, isInside, realOrResolved, resolveSkillDir } from '../permissions.mjs';
import { parseAgentResponse } from './agy.mjs';

export const CLAUDE_SETTINGS_SHOWN = '~/.config/architect/claude-settings.json';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? err.message : String(err));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const TRANSIENT_RE = /\b(503|UNAVAILABLE|RESOURCE_EXHAUSTED|429|EOF|ECONNRESET|ETIMEDOUT|overloaded_error|rate_limit_error)\b/i;
const maskHome = (p, home = os.homedir()) => (p ? String(p).split(home).join('~').replace(/\\/g, '/') : null);

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
  const additionalDirectories = external ? [resolvedSkill] : [];
  if (external) allow.push(`Read(${abs(resolvedSkill)}/**)`);
  const deny = [
    `Edit(${abs(path.join(w, '.git', 'config'))})`, `Write(${abs(path.join(w, '.git', 'config'))})`,
    `Edit(${abs(path.join(w, '.git', 'hooks'))}/**)`, `Write(${abs(path.join(w, '.git', 'hooks'))}/**)`,
    `Edit(${abs(path.join(w, '.git', 'info'))}/**)`, `Write(${abs(path.join(w, '.git', 'info'))}/**)`,
    ...(external ? [`Edit(${abs(resolvedSkill)}/**)`, `Write(${abs(resolvedSkill)}/**)`] : []),
    ...[abs(path.join(w, '.claude')), '~/.claude', '~/.config/architect', '~/.gemini'].flatMap((p) => [`Edit(${p}/**)`, `Write(${p}/**)`]),
  ];
  return { allow, deny, additionalDirectories, sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } };
}

export function writeClaudeAllowlist({ settingsPath = null, workDir = null, home = os.homedir(), allow = [], deny = [], additionalDirectories = [] }) {
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
    if (json.permissions[k] !== undefined && !Array.isArray(json.permissions[k])) {
      throw new Error(`${CLAUDE_SETTINGS_SHOWN}: permissions.${k} is not an array, file not modified`);
    }
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
  const addedAllow = merge('allow', allow), addedDeny = merge('deny', effectiveDeny);
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
  return { addedAllow, addedDeny, backup: existed && newText !== prevText };
}

function checkClaudePathTarget(kind, targetPath, { workDir, home, deny, skillDir, skillFilePath }) {
  const t = realOrResolved(targetPath.replace(/\/\*\*?$/, ''));
  const realWork = realOrResolved(workDir), realHome = realOrResolved(home);
  if (isInside(realHome, t)) return 'home directory or above';
  if (t !== realWork && isInside(realWork, t)) return 'parent directory of project';
  if (kind === 'Read') {
    const s1 = resolveSkillDir({ skillDir, skillFilePath, workDir: realWork }), s2 = resolveSkillDir({ workDir: realWork });
    return (!isInside(t, realWork) && !isInside(t, s1) && !isInside(t, s2)) ? 'reading outside project and skill directory is forbidden' : null;
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
  if (json.sandbox?.enabled !== true || json.sandbox?.autoAllowBashIfSandboxed !== false || json.sandbox?.allowUnsandboxedCommands !== false) {
    return { ok: false, name, detail: 'OS sandbox is disabled, autoAllowBashIfSandboxed is not false or allowUnsandboxedCommands is not false' };
  }
  if (json.permissions?.blockReadsOutsideWorkingDirectories !== true) {
    return { ok: false, name, detail: 'reading outside project is not blocked (permissions.blockReadsOutsideWorkingDirectories is not true)' };
  }
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
  for (const d of additionalDirs) {
    const rd = realOrResolved(d);
    if (!isInside(rd, realWork) && !isInside(rd, resolvedSkill) && !isInside(rd, defaultSkill)) {
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
  return {
    ok: true,
    name,
    detail: `Bash(…) rules: ${bashCount}, OS sandbox enabled, reading outside project blocked, writing to project without .git and .claude, no unsafe rules`,
  };
}

export function extractClaudeDeniedStep(denials = []) {
  if (!Array.isArray(denials) || denials.length === 0) return null;
  const d = denials.at(-1);
  if (d?.tool_name === 'Bash' && typeof d?.tool_input?.command === 'string') return { kind: 'command', command: d.tool_input.command };
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

export const listClaudeModels = () => [
  { id: 'sonnet', name: 'Claude Sonnet' }, { id: 'opus', name: 'Claude Opus' }, { id: 'haiku', name: 'Claude Haiku' },
];

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
      '-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', schemaJson,
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

export function claudeAllowlistBlock(rulesOrPerms = {}) {
  const allow = rulesOrPerms.allow ?? rulesOrPerms.permissions?.allow ?? [];
  const deny = rulesOrPerms.deny ?? rulesOrPerms.permissions?.deny ?? [];
  const dirs = rulesOrPerms.additionalDirectories ?? rulesOrPerms.permissions?.additionalDirectories ?? [];
  const sandbox = rulesOrPerms.sandbox ?? { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false };
  const permissions = { blockReadsOutsideWorkingDirectories: true, allow, deny, ...(Array.isArray(dirs) && dirs.length ? { additionalDirectories: dirs } : {}) };
  return JSON.stringify({ sandbox, permissions }, null, 2);
}
