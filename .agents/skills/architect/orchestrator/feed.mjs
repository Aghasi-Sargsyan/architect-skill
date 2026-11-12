// Readable feed of the agents' work, the read-only `--watch` / `--status` for driving a background loop from a
// chat (including a phone through remote control), and `--follow` for watching the feed in a terminal. The feed
// lives in .agent-runs/<run>/feed.log and in the loop's own output; the agents' raw transcripts stay where agy
// keeps them.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNS_DIR } from './config.mjs';
import { lockHolder } from './guards.mjs';
import { questionText, readPendingQuestion } from './ask.mjs';
import { EVENTS_FILE, milestonesFromEvents, readEvents } from './events.mjs';
import { readPlan } from './plan.mjs';

const errText = (err) => (err instanceof Error ? err.message : String(err));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a growing text file: only complete lines (up to the last «\n»), each line once. */
export class LineTail {
  constructor(file, offset = 0) {
    this.file = file;
    this.offset = offset;
  }

  /** A tail that skips what the file already holds (a continued conversation). */
  static fromEnd(file) {
    return new this(file, existsSync(file) ? statSync(file).size : 0);
  }

  /** @returns {string[]} non-empty lines added since the last read */
  read() {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size <= this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return []; // a line still being written: read it next time
    this.offset += lastNewline + 1;
    return buf.subarray(0, lastNewline).toString('utf8').split('\n').filter((l) => l.trim());
  }
}

/** A LineTail over JSONL: each line parsed; a broken line becomes an UNREADABLE row. */
export class JsonlTail extends LineTail {
  /** @returns {object[]} rows added since the last read */
  read() {
    return super.read().map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return { type: 'UNREADABLE', status: 'UNREADABLE', content: errText(err) };
      }
    });
  }
}

/** agy JSON-quotes tool arguments ("\"/a/b\""): returns the plain value. */
function unquote(v) {
  const s = String(v ?? '');
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch (err) {
      // Not valid JSON inside the quotes: show the text between them as is.
      return err instanceof SyntaxError ? s.slice(1, -1) : s;
    }
  }
  return s;
}

export function formatTranscriptRow(row) {
  const out = [];
  if (row?.thinking) out.push(`[thoughts] ${String(row.thinking).trim()}`);
  if (row?.content) out.push(`[answer] ${String(row.content).trim()}`);
  for (const tc of row?.tool_calls ?? []) {
    const a = tc.args ?? {};
    if (tc.name === 'run_command') {
      const summary = a.toolSummary ? ` — ${unquote(a.toolSummary)}` : '';
      out.push(`▶ ${unquote(a.CommandLine)}${summary}`);
    } else if (tc.name === 'read_file' || tc.name === 'view_file') {
      const lines = a.StartLine ? ` (lines ${unquote(a.StartLine)}–${unquote(a.EndLine)})` : '';
      out.push(`📖 reads ${unquote(a.Path ?? a.AbsolutePath)}${lines}`);
    } else if (tc.name === 'edit_file' || tc.name === 'replace_file_content' || tc.name === 'multi_replace_file_content') {
      out.push(`✏️ edits ${unquote(a.Path ?? a.TargetFile)}`);
    } else if (tc.name === 'write_file' || tc.name === 'write_to_file') {
      out.push(`📝 creates ${unquote(a.Path ?? a.TargetFile)}`);
    } else if (tc.name === 'finish') {
      out.push(`🏁 finished${a.status ? `: ${unquote(a.status)}` : ''}`);
    } else {
      out.push(`· ${tc.name}`);
    }
  }
  return out;
}

/**
 * Turns agy transcript rows into feed lines. Keeps state between calls: a run_command is printed together with
 * its exit code from the following result row.
 * @returns {(rows: object[]) => string[]}
 */
export function createAgyFormatter({ workDir, home = os.homedir() }) {
  let pending = null;
  const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const rel = (p) => {
    const s = unquote(p);
    return s.startsWith(`${workDir}${path.sep}`) ? path.relative(workDir, s) : s.split(home).join('~');
  };
  const time = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 8) : '--:--:--');
  return (rows) => {
    const out = [];
    const flush = (suffix = '') => {
      if (pending) out.push(`${pending}${suffix}`);
      pending = null;
    };
    for (const r of rows) {
      if (r.status === 'ERROR') {
        flush(' ⛔');
        out.push(`${time(r.created_at)} ⛔ ${clip(String(r.content ?? '').replace(/\s+/g, ' ').split(home).join('~'), 200)}`);
        continue;
      }
      if (r.type === 'GENERIC' && pending) {
        const code = String(r.content ?? '').match(/Command exited with code (\d+)/)?.[1];
        flush(code === undefined ? '' : code === '0' ? ' ✓' : ` ✗ exit ${code}`);
        continue;
      }
      if (r.type !== 'PLANNER_RESPONSE') continue;
      for (const tc of r.tool_calls ?? []) {
        const a = tc.args ?? {};
        const t = time(r.created_at);
        if (tc.name === 'run_command') {
          flush();
          const summary = a.toolSummary ? ` — ${clip(unquote(a.toolSummary), 80)}` : '';
          pending = `${t} ▶ ${clip(unquote(a.CommandLine))}${summary}`;
        } else if (tc.name === 'read_file' || tc.name === 'view_file') {
          const lines = a.StartLine ? ` (lines ${unquote(a.StartLine)}–${unquote(a.EndLine)})` : '';
          out.push(`${t} 📖 reads ${rel(a.Path ?? a.AbsolutePath)}${lines}`);
        } else if (tc.name === 'edit_file' || tc.name === 'replace_file_content' || tc.name === 'multi_replace_file_content') {
          out.push(`${t} ✏️ edits ${rel(a.Path ?? a.TargetFile)}`);
        } else if (tc.name === 'write_file' || tc.name === 'write_to_file') {
          out.push(`${t} 📝 creates ${rel(a.Path ?? a.TargetFile)}`);
        } else if (tc.name === 'finish') {
          out.push(`${t} 🏁 finished${a.status ? `: ${unquote(a.status)}` : ''}`);
        } else {
          out.push(`${t} · ${tc.name}`);
        }
      }
    }
    return out;
  };
}

/** Newest loop run in .agent-runs (directories named by their start time), or null. */
export function latestRun(workDir) {
  const runs = path.join(workDir, RUNS_DIR);
  if (!existsSync(runs)) return null;
  const name = readdirSync(runs).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().at(-1);
  return name ? { name, dir: path.join(runs, name) } : null;
}

const runStart = (name) => Date.parse(name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(os.homedir()).join('~') : '');
const lastLines = (text, n) => text.trimEnd().split('\n').filter(Boolean).slice(-n);

/** `--status`: one short state for checking status. Read-only. */
export function statusText(workDir, now = Date.now()) {
  const run = latestRun(workDir);
  const holder = lockHolder(path.join(workDir, RUNS_DIR));
  if (holder === null) {
    const summary = run ? readIf(path.join(run.dir, 'summary.md')) : '';
    return summary ? `loop is not running; last summary:\n${summary.trimEnd()}` : 'loop is not running';
  }
  if (!run) return `loop is starting (pid ${holder})`;
  let task = '';
  if (existsSync(path.join(run.dir, EVENTS_FILE))) {
    const ev = readEvents(run.dir).filter((e) => e.type === 'task_started').at(-1);
    if (ev) task = `${ev.taskId} (${ev.risk}): ${ev.title}; Executor ${ev.model}`;
  } else {
    const raw = lastLines(readIf(path.join(run.dir, 'run.log')), 200).reverse().find((l) => l.includes('▶ T-'));
    if (raw) task = raw.replace(/^\[[^\]]*\]\s*▶\s*/, '');
  }
  const minutes = Math.max(0, Math.round((now - runStart(run.name)) / 60_000));
  const lines = [`running ${minutes} min${task ? `: ${task}` : ''}`];
  if (readPendingQuestion(workDir).question) lines.push('waiting for an answer to a permission question (see --watch)');
  const steps = lastLines(readIf(path.join(run.dir, 'feed.log')), 3);
  if (steps.length) lines.push('recent steps:', ...steps.map((s) => `  ${s}`));
  return lines.join('\n');
}

export function printStatus({ workDir = process.cwd(), planPath = 'PLAN.md', out = process.stdout } = {}) {
  const runsDir = path.join(workDir, RUNS_DIR);
  const holder = lockHolder(runsDir);
  const running = holder !== null;
  const run = latestRun(workDir);

  let tasks = [];
  try {
    const plan = readPlan(workDir, planPath);
    tasks = plan.tasks ?? [];
  } catch { tasks = []; }
  const doneCount = tasks.filter((t) => t.done).length;
  const totalTasks = tasks.length;
  const remaining = tasks.filter((t) => !t.done).map((t) => t.id).join(', ') || 'none';

  let active = 'none';
  if (run) {
    if (existsSync(path.join(run.dir, EVENTS_FILE))) {
      const ev = readEvents(run.dir).filter((e) => e.type === 'task_started').at(-1);
      if (ev) active = `${ev.taskId} (${ev.risk}): ${ev.title}; Executor ${ev.model}`;
    } else {
      const raw = lastLines(readIf(path.join(run.dir, 'run.log')), 200).reverse().find((l) => l.includes('▶ T-'));
      if (raw) active = raw.replace(/^\[[^\]]*\]\s*▶\s*/, '');
    }
  }

  const hasQuestion = Boolean(readPendingQuestion(workDir).question);
  const summary = run ? readIf(path.join(run.dir, 'summary.md')).trimEnd() : '';

  out.write('=== Agent loop ===\n');
  out.write(`Status:    ${running ? 'RUNNING' : 'STOPPED'}\n`);
  if (running && active !== 'none') {
    out.write(`Active:    ${active}\n`);
  }
  out.write(`Progress:  ${doneCount}/${totalTasks} accepted\n`);
  out.write(`Remaining: ${remaining}\n`);
  if (hasQuestion) {
    out.write('Waiting for permission confirmation:\n');
  }
  if (!running && summary) {
    const stopLine = summary.split('\n')[0].replace(/^■\s*(?:Stop|Стоп):\s*/i, '');
    out.write(`Stop:      ${stopLine}\n`);
  }
  return { running, doneCount, totalTasks, active, holder };
}

const TASK_START_RE = /^\[(\d\d):(\d\d):(\d\d)\] ▶ (T-\d+)/;
export const VERDICT_RE = /(✓\s+T-\d+|↻\s+T-\d+|■\s+(?:Стоп|Stop):|(?:Архитектор|Architect):\s*(?:accepted|rework|escalated|needs_user))/i;
const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/**
 * Task milestones of a run, from its run.log: a review round after which the loop goes on. «accepted» counts
 * together with the next task's start (one event, not two); «rework» counts at once. A verdict that ends the
 * loop (the last task accepted, needs_user) is not a milestone: the stop itself reports it.
 * @returns {string[]} one line per milestone, oldest first
 */
export function milestones(runLog) {
  const out = [];
  let task = null;
  let accepted = null;
  const reworks = new Map();
  for (const line of runLog.split('\n')) {
    const start = line.match(TASK_START_RE);
    if (start) {
      if (accepted) out.push(`${accepted.task} accepted (${accepted.minutes} min); next ${start[4]}`);
      accepted = null;
      task = { id: start[4], at: seconds(start[1], start[2], start[3]) };
      continue;
    }
    const verdict = line.match(VERDICT_RE);
    if (!verdict || !task) continue;
    const timeMatch = line.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
    if (line.match(/(?:Архитектор|Architect):\s+rework/i) || line.includes('↻')) {
      reworks.set(task.id, (reworks.get(task.id) ?? 0) + 1);
      out.push(`${task.id}: rework ${reworks.get(task.id)}`);
    } else if (line.match(/(?:Архитектор|Architect):\s+accepted/i) || line.includes('✓')) {
      const [h = '00', m = '00', s = '00'] = timeMatch ? timeMatch.slice(1) : [];
      const elapsed = (seconds(h, m, s) - task.at + 86_400) % 86_400; // past midnight too
      accepted = { task: task.id, minutes: Math.max(1, Math.round(elapsed / 60)) };
    }
  }
  return out;
}

export function resolveInterval(val, envKey, def) {
  for (const v of [val, process.env[envKey]]) {
    if (v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 10) return Number(v);
  }
  return def;
}

/**
 * `--watch`: waits for an event of the background loop — a permission question (exit 2), a stop (exit 3), a task
 * milestone after `since` (exit 4) — or the end of the window (exit 0, one line). No periodic wake-ups, nothing
 * written. Codes 0, 2 and 4 end with «(milestones: N)»: passing N back as `since` loses no milestone between two calls.
 * Without `since` counting starts now. Right after --background the child may not hold the lock yet, so a
 * missing lock counts as a stop only after `graceMs`.
 * @returns {Promise<{ code: 0 | 2 | 3 | 4, text: string }>}
 */
export async function watch({ workDir, minutes = 25, since = null, pollMs, graceMs }) {
  const effPollMs = resolveInterval(pollMs, 'AGENT_LOOP_WATCH_POLL_MS', 2000);
  const effGraceMs = resolveInterval(graceMs, 'AGENT_LOOP_WATCH_GRACE_MS', 2000);
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  const runs = path.join(workDir, RUNS_DIR);
  const current = () => {
    const run = latestRun(workDir);
    if (!run) return { name: null, list: [] };
    const list = existsSync(path.join(run.dir, EVENTS_FILE))
      ? milestonesFromEvents(readEvents(run.dir))
      : milestones(readIf(path.join(run.dir, 'run.log')));
    return { name: run.name, list };
  };
  const first = current();
  // A `since` beyond this run's count belongs to an earlier run: start from now.
  let base = since !== null && since <= first.list.length ? since : first.list.length;
  let baseRun = first.name;
  for (;;) {
    const now = current();
    // Right after --background the previous run may still be the newest folder: a new run counts from zero.
    if (now.name !== baseRun) {
      baseRun = now.name;
      base = 0;
    }
    const seen = now.list;
    const isRu = seen.some((s) => /[А-Яа-яЁё]/.test(s));
    const count = isRu ? `(вех: ${seen.length})` : `(milestones: ${seen.length})`;
    const pending = readPendingQuestion(workDir);
    if (pending.error) return { code: 3, text: `permission question cannot be read: ${pending.error}` };
    if (pending.question) {
      const answers = [...pending.question.options.map((o) => o.answer), '3'].join('|');
      return { code: 2, text: `${questionText(pending.question)}\n\npass the user's answer: --answer <${answers}> ${count}` };
    }
    if (lockHolder(runs) === null && Date.now() - started >= effGraceMs) {
      const run = latestRun(workDir);
      const summary = run ? readIf(path.join(run.dir, 'summary.md')).trimEnd() : '';
      return { code: 3, text: summary || 'loop is not running' };
    }
    if (seen.length > base) return { code: 4, text: `${seen.slice(base).join('\n')} ${count}` };
    if (Date.now() >= deadline) return { code: 0, text: `${statusText(workDir).split('\n')[0]} ${count}` };
    await sleep(effPollMs);
  }
}

const runTime = (name) => new Date(runStart(name)).toTimeString().slice(0, 8);

/**
 * `--follow`: the feed of the current run from its start, then new lines as they come, in a terminal. A newer run
 * folder (the next --background) gets a separator line and is followed instead. Ends when no loop runs (a missing
 * lock counts after `graceMs`, as in --watch) with the run's summary — unless the feed already holds the
 * «■ Stop:» block, which run.mjs writes there too, so it is never printed twice. Read-only, no lock.
 */
export async function follow({ workDir, print = console.log, pollMs, graceMs }) {
  const effPollMs = resolveInterval(pollMs, 'AGENT_LOOP_FOLLOW_POLL_MS', 1000);
  const effGraceMs = resolveInterval(graceMs, 'AGENT_LOOP_FOLLOW_GRACE_MS', 2000);
  const runs = path.join(workDir, RUNS_DIR);
  const started = Date.now();
  const home = os.homedir();
  let run = latestRun(workDir);
  let tail = run ? new LineTail(path.join(run.dir, 'feed.log')) : null;
  let sawStop = false;
  const drain = () => {
    for (const line of tail ? tail.read() : []) {
      if (line.includes('■ Stop:') || line.includes('■ Стоп:')) sawStop = true;
      print(line.split(home).join('~'));
    }
  };
  for (;;) {
    drain();
    const newest = latestRun(workDir);
    if (newest && newest.name !== run?.name) {
      if (run) print(`── new run ${runTime(newest.name)} ──`);
      run = newest;
      tail = new LineTail(path.join(run.dir, 'feed.log'));
      sawStop = false;
      continue;
    }
    if (lockHolder(runs) === null && Date.now() - started >= effGraceMs) {
      drain();
      const summary = run && !sawStop ? readIf(path.join(run.dir, 'summary.md')).trimEnd() : '';
      if (summary) print(summary);
      if (!run) print('no loop runs yet');
      return;
    }
    await sleep(effPollMs);
  }
}

/**
 * The read-only views (`--status`, `--watch`, `--follow`) in one place, so run.mjs stays small.
 * @returns {Promise<boolean>} true when one of them ran
 */
export async function runView(opts, workDir) {
  if (opts.status) { console.log(statusText(workDir)); return true; }
  if (opts.watch !== null) {
    const event = await watch({ workDir, minutes: opts.watch, since: opts.since });
    console.log(event.text);
    process.exitCode = event.code;
    return true;
  }
  if (opts.follow) { await follow({ workDir }); return true; }
  return false;
}
