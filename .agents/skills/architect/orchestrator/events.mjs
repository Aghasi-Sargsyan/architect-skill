// Structured event log (.agent-runs/<run>/events.jsonl), cross-platform binary lookup, and privacy-safe notifications.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gitRaw } from './git.mjs';

export const EVENTS_FILE = 'events.jsonl';
export const WEBHOOK_ENV_VAR = 'AGENT_LOOP_WEBHOOK_URL';
export const SHIM_MAX_BYTES = 16384;
export const SHIM_HEADER_BYTES = 512;

export function isGuardShimFile(filePath, marker = 'agent-loop guard') {
  try {
    const st = statSync(filePath, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size <= 0 || st.size > SHIM_MAX_BYTES) {
      return false;
    }
    let fd = null;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(SHIM_HEADER_BYTES);
      const bytesRead = readSync(fd, buf, 0, SHIM_HEADER_BYTES, 0);
      return buf.toString('utf8', 0, bytesRead).includes(marker);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function defaultWebhookFile(home = os.homedir()) {
  return path.join(home, '.config', 'architect', 'webhook-url');
}

export function appendEvent(runDir, event) {
  const ts = event?.ts ?? new Date().toISOString();
  const line = JSON.stringify({ ts, ...event }) + '\n';
  appendFileSync(path.join(runDir, EVENTS_FILE), line, 'utf8');
}

export function readEvents(runDir) {
  const file = path.join(runDir, EVENTS_FILE);
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, 'utf8');
    const events = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function milestonesFromEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  let task = null;
  let accepted = null;
  const reworks = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'task_started') {
      if (accepted) {
        out.push(`${accepted.task} accepted (${accepted.minutes} min); next ${event.taskId}`);
        accepted = null;
      }
      task = { id: event.taskId, startedMs: Date.parse(event.ts) };
      continue;
    }
    if (event.type === 'architect_finished' && task && event.ok !== false) {
      if (event.verdict === 'rework') {
        const count = (reworks.get(task.id) ?? 0) + 1;
        reworks.set(task.id, count);
        out.push(`${task.id}: rework ${count}`);
      } else if (event.verdict === 'accepted') {
        const elapsedMs = Math.max(0, Date.parse(event.ts) - task.startedMs);
        const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
        accepted = { task: task.id, minutes };
      }
    }
  }
  return out;
}

// EPERM/EACCES (an unreadable directory, e.g. under an OS sandbox) mean "nothing here"; any other error is thrown (fail-closed).
function statIfReadable(file) {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') return undefined;
    throw err;
  }
}

function realOrResolvedDir(dir) {
  try {
    return realpathSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'EPERM' || err?.code === 'EACCES') return path.resolve(dir);
    throw err;
  }
}

function isUnderAny(dir, roots) {
  const real = realOrResolvedDir(dir);
  return roots.some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

export function findExecutable(bin, envPath = process.env.PATH, { excludeUnder = [] } = {}) {
  if (!bin || typeof bin !== 'string') return null;
  if (path.isAbsolute(bin) || bin.includes('/') || (path.sep === '\\' && bin.includes('\\'))) {
    const st = statIfReadable(bin);
    return st && st.isFile() && (st.mode & 0o111) !== 0 ? bin : null;
  }
  const excluded = excludeUnder.map(realOrResolvedDir);
  const dirs = String(envPath ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    if (excluded.length > 0 && isUnderAny(dir, excluded)) continue;
    const gitFile = path.join(dir, 'git');
    if (isGuardShimFile(gitFile)) {
      continue;
    }
    const candidate = path.join(dir, bin);
    if (isGuardShimFile(candidate)) {
      continue;
    }
    const st = statIfReadable(candidate);
    if (st && st.isFile() && (st.mode & 0o111) !== 0) return candidate;
  }
  return null;
}

export function resolveWebhookUrl({ env = process.env, home = os.homedir(), webhookFile } = {}) {
  const envVal = env?.[WEBHOOK_ENV_VAR]?.trim();
  if (envVal && (envVal.startsWith('http://') || envVal.startsWith('https://'))) {
    return envVal;
  }
  const file = webhookFile ?? defaultWebhookFile(home);
  if (existsSync(file)) {
    try {
      const content = readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
        break;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** One line naming the channels a question or stop can reach the person through; never the webhook URL. */
export function deliveryChannels({ config, env = process.env, home = os.homedir(), webhookFile, platform = process.platform } = {}) {
  const parts = ['questions reach the chat only through --watch'];
  if (!config?.notify) return [...parts, 'notifications: off'].join('; ');
  if (platform === 'darwin') parts.push('macOS notification: on (delivery is not confirmed by macOS)');
  parts.push(resolveWebhookUrl({ env, home, webhookFile }) ? 'webhook: configured' : 'webhook: not configured');
  return parts.join('; ');
}

export function classifyStopReason(stopReason = '') {
  const str = String(stopReason ?? '');
  const m = str.match(/^(T-\d+):/);
  const taskId = m ? m[1] : 'none';

  // Backward compatibility with legacy object expectations (events.test.mjs)
  if (str.includes('сбой Исполнителя')) {
    return { category: 'executor_failed', status: 'failed', taskId };
  }
  if (str.includes('закрытие цикла и ретро')) {
    return { category: 'all_accepted', status: 'ok', taskId: 'none' };
  }
  if (str.startsWith('нужно разрешение:')) {
    return { category: 'permission_prompt', status: 'question', taskId };
  }

  // Dual-language (EN + RU) classifications returning string categories (events-en.test.mjs)
  if (/escalat|эскалирован/i.test(str)) {
    return 'stop_escalation';
  }
  if (/user decision|решения пользователя/i.test(str)) {
    return 'stop_needs_user';
  }
  if (/permission|timeout|тайм-аут/i.test(str)) {
    return 'stop_permission_timeout';
  }
  if (/mechanics|механик/i.test(str)) {
    return 'stop_mechanics';
  }
  if (/rework limit|лимит доработок/i.test(str)) {
    return 'stop_rework_limit';
  }
  if (/all planned tasks accepted|все задачи плана приняты|все задачи приняты/i.test(str)) {
    return 'all_accepted';
  }

  // Other classifications
  if (/accepted \(--only\)|принята \(--only\)/i.test(str)) return 'only_accepted';
  if (/stopped by user|остановлено пользователем/i.test(str)) return 'paused_by_user';
  if (/not found among uncompleted tasks|нет такой открытой задачи/i.test(str)) return 'no_open_tasks';
  if (/blocked by dependencies|заблокированы зависимостями/i.test(str)) return 'blocked_by_deps';
  if (/fill it in|поле «Менять»/i.test(str)) return 'empty_change';
  if (/guards were tampered with|изменены защиты/i.test(str)) return 'guards_tampered';
  if (/Executor failed/i.test(str)) return 'executor_failed';
  if (/Architect failed|сбой Архитектора/i.test(str)) return 'architect_failed';
  if (/post-review violation|нарушение после ревью/i.test(str)) return 'review_violation';
  if (/orchestrator error|ошибка оркестратора/i.test(str)) return 'orchestrator_error';

  return 'unknown_stop';
}

export function formatWebhookBody(opts = {}) {
  const { eventType = 'stop', taskId = 'none', status = 'stopped', category = 'unknown_stop', role = null, event, message } = opts;
  const commitMatch = message ? String(message).match(/(?:Архитектор|Architect):\s*accepted\s*\(commit\s+([0-9a-fA-F]+)\)/i) : null;
  const commit = commitMatch ? commitMatch[1] : (opts.commit ?? null);
  if (event || message) {
    return {
      event: event ?? eventType,
      taskId: /^T-\d+$/.test(String(taskId ?? '')) ? String(taskId) : 'none',
      commit,
      message: message ?? '',
    };
  }
  const safeTaskId = /^T-\d+$/.test(String(taskId ?? '')) ? String(taskId) : 'none';
  const safeStatus = ['ok', 'stopped', 'failed', 'question'].includes(status) ? status : 'stopped';
  const safeCategory = /^[a-z0-9_]+$/.test(String(category ?? '')) ? String(category) : 'unknown_stop';
  if (eventType === 'question') {
    const safeRole = role === 'architect' || role === 'Архитектор' ? 'architect' : 'executor';
    return `agent-loop: question task=${safeTaskId} status=question category=permission_prompt role=${safeRole}`;
  }
  return `agent-loop: stop task=${safeTaskId} status=${safeStatus} category=${safeCategory}`;
}

export function notifyOperator({ title = 'Agent loop stopped', text = '' } = {}) {
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
  } catch {
    /* cleanup: abort notification on failure */
  }
}

export async function sendNotification({
  config,
  text = '',
  eventType = 'stop',
  taskId,
  status,
  category,
  role,
  env = process.env,
  home = os.homedir(),
  webhookFile,
  fetchFn = globalThis.fetch,
  platform = process.platform,
  execOsascript,
  log,
} = {}) {
  if (!config?.notify) {
    return { osascriptSent: false, webhookSent: false, webhookBody: null };
  }
  let osascriptSent = false;
  if (platform === 'darwin') {
    try {
      if (execOsascript) {
        execOsascript(text);
      } else {
        const title = eventType === 'question' ? 'Permission confirmation required' : 'Agent loop stopped';
        execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
      }
      osascriptSent = true;
      log?.('notification: macOS sent');
    } catch (err) {
      log?.(`notification not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let webhookSent = false;
  let webhookBody = null;
  const url = resolveWebhookUrl({ env, home, webhookFile });
  if (!url) log?.('webhook: not configured');
  if (url && typeof fetchFn === 'function') {
    const classified = classifyStopReason(text);
    const body = formatWebhookBody({
      eventType: eventType === 'question' || (typeof classified === 'object' ? classified?.category === 'permission_prompt' : classified === 'stop_permission_timeout') ? 'question' : 'stop',
      taskId: taskId ?? (typeof classified === 'object' ? classified?.taskId : text.match(/^(T-\d+)/)?.[1] ?? 'none'),
      status: status ?? (typeof classified === 'object' ? classified?.status : (classified === 'all_accepted' ? 'ok' : 'stopped')),
      category: category ?? (typeof classified === 'object' ? classified?.category : classified),
      role,
    });
    webhookBody = body;
    try {
      await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body,
      });
      webhookSent = true;
      log?.('webhook: sent');
    } catch (err) {
      log?.(`webhook not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { osascriptSent, webhookSent, webhookBody };
}

/**
 * Writes the stop report of a loop run: the working-tree state the agents left (stop.status.txt, stop.diff),
 * the `run_stopped` event and summary.md, and logs the stop text. Moved from run.mjs without behavior change.
 * @param {{ realGit: string, workDir: string, runDir: string, stopReason: string, summary: string[], log: (msg: string) => void }} opts
 */
export function writeStopReport({ realGit, workDir, runDir, stopReason, summary, log }) {
  // What the agents left behind, so a stop never needs a manual `git diff` to see the state.
  let state = '';
  try {
    state = gitRaw(realGit, workDir, ['status', '--porcelain', '--untracked-files=all']);
    if (state.trim()) {
      writeFileSync(path.join(runDir, 'stop.status.txt'), state.endsWith('\n') ? state : `${state}\n`);
      const rawDiff = gitRaw(realGit, workDir, ['diff', 'HEAD']);
      writeFileSync(path.join(runDir, 'stop.diff'), rawDiff.endsWith('\n') || !rawDiff ? rawDiff : `${rawDiff}\n`);
    }
  } catch (err) {
    log(`working tree state not saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  const classified = classifyStopReason(stopReason);
  const category = typeof classified === 'object' && classified ? classified.category : classified;
  const status = typeof classified === 'object' && classified ? classified.status : (category === 'all_accepted' || stopReason.includes('accepted') ? 'ok' : 'stopped');
  const taskId = typeof classified === 'object' && classified ? classified.taskId : (stopReason.match(/^(T-\d+)/)?.[1] ?? 'none');
  appendEvent(runDir, { type: 'run_stopped', category, status, taskId, stopReason, summary, dirty: Boolean(state) });
  const text = `■ Stop: ${stopReason}\nSummary: ${summary.join('; ') || '—'}${state ? '\nWorking tree dirty: stop.status.txt and stop.diff in run directory' : ''}\nLog: ${runDir}`;
  log(text);
  writeFileSync(path.join(runDir, 'summary.md'), `${text}\n`);
}
