// Asking the person whether a denied command may run. In a terminal: a prompt right there. Without one
// (--background): the question goes to .agent-runs/question.json and the answer comes back through
// `run.mjs --answer <n>` (any terminal, or the interactive Architect relaying the person's answer).
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { RUNS_DIR } from './config.mjs';
import { lockHolder } from './guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const questionPath = (workDir) => path.join(workDir, RUNS_DIR, 'question.json');
export const answerPath = (workDir) => path.join(workDir, RUNS_DIR, 'answer.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? err.message : String(err));

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const validAnswers = (question) => [...(question.options || []).map((o) => o.answer), '3'];

/** "`1`, `2` or `3`" — the answer codes for the last line of the question. */
const answersText = (codes) => {
  const quoted = codes.map((c) => `\`${c}\``);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}` : quoted.join('');
};

/** Strips control characters, newlines, and Markdown block delimiters from agent-supplied reason strings. */
export function sanitizeReason(reason) {
  if (typeof reason !== 'string') return '';
  return reason
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/`+/g, "'")
    .replace(/(?:^|\s)(?:#{1,6}|---+|\*\*\*+)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * The question as the person sees it, in Markdown format, ready to paste into a chat.
 * List numbers are the answer codes themselves: without option 1 the list starts at 2.
 */
export function questionText(question) {
  const options = (question.options || []).map((o) => (o.answer === '1'
    ? `1. **Always** — rule \`command(${o.rule})\`, with any arguments`
    : `2. **This command only** — rule \`command(${o.rule})\`; extra arguments will also pass`));
  const whoLine = question.taskTitle
    ? `**Who:** ${question.who}, task ${question.taskId} (${question.taskTitle})`
    : `**Who:** ${question.who}, task ${question.taskId}`;
  const lines = [
    '### 🔐 Command Permission',
    '',
    whoLine,
    '',
    `**Command:** \`${question.command}\``,
  ];
  const cleanReason = sanitizeReason(question.reason);
  if (cleanReason) {
    lines.push('', `**Why:** ${cleanReason}`);
  }
  lines.push(
    '',
    '**Options:**',
    ...options,
    '3. **No** — the agent will continue without it or escalate',
    '',
    `**Reply:** ${answersText(validAnswers(question))}`,
  );
  return lines.join('\n');
}

/** Removes the fixed question and answer files (after an answer, on timeout, on stop). */
export function clearQuestion(workDir) {
  rmSync(questionPath(workDir), { force: true });
  rmSync(answerPath(workDir), { force: true });
}

/**
 * Answers a pending permission request in targetDir.
 * @param {string} targetDir
 * @param {string} answer '1' | '2' | '3'
 * @returns {{ id: string, answer: string, rule: string | null, label: string, command: string }}
 */
export function answerPendingPermission(targetDir, answer) {
  const candidateFiles = [
    path.join(targetDir, 'question.json'),
    questionPath(targetDir),
  ];
  const qFile = candidateFiles.find((f) => existsSync(f));
  if (!qFile) {
    throw new Error(`No active permission request in ${targetDir}`);
  }
  const aFile = qFile.endsWith(path.join(RUNS_DIR, 'question.json'))
    ? answerPath(targetDir)
    : path.join(path.dirname(qFile), 'answer.json');

  const question = JSON.parse(readFileSync(qFile, 'utf8'));
  const valid = validAnswers(question);
  const ansStr = String(answer).trim();
  if (!valid.includes(ansStr)) {
    throw new Error(`Invalid answer "${answer}": expected 1, 2, or 3`);
  }

  let rule = null;
  let label = 'Do not allow (stop / escalate)';
  if (ansStr !== '3') {
    const opt = (question.options || []).find((o) => o.answer === ansStr);
    rule = opt?.rule ?? null;
    label = ansStr === '1' ? `Always: command(${rule})` : `This command only: command(${rule})`;
  }

  writeAtomic(aFile, `${JSON.stringify({ id: question.id, answer: ansStr, at: new Date().toISOString() })}\n`);
  return { id: question.id, answer: ansStr, rule, label, command: question.command };
}

export function resolveInterval(val, envKey, def) {
  if (val != null) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 10) return n;
  }
  const envVal = process.env[envKey];
  if (envVal != null && String(envVal).trim() !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 10) return n;
  }
  return def;
}

/**
 * Asks and waits. Supports both direct orchestrator step mode and interactive question mode.
 */
export async function askPermission(optsOrQuestion, maybeOpts) {
  const twoArg = Boolean(maybeOpts && typeof maybeOpts === 'object');
  const opts = twoArg ? { ...maybeOpts, question: optsOrQuestion } : (optsOrQuestion ?? {});
  const isDirect = twoArg || (!opts.question && Boolean(opts.proposal));
  const command = opts.step?.command ?? opts.command ?? '';
  const who = opts.who ?? (opts.role === 'executor' ? 'Executor' : opts.role === 'architect' ? 'Architect' : 'Agent');
  const taskId = opts.taskId ?? opts.question?.taskId ?? '';
  const taskTitle = opts.taskTitle ?? opts.task?.title ?? opts.question?.taskTitle;
  const reason = opts.step?.reason ?? opts.reason ?? opts.question?.reason;
  const question = opts.question ?? {
    id: `${taskId || 'perm'}-${Date.now()}-q`,
    who,
    taskId,
    command,
    ...(taskTitle ? { taskTitle } : {}),
    ...(reason ? { reason } : {}),
    options: opts.proposal?.options ?? [],
  };

  const workDir = opts.workDir ?? opts.runDir;
  const runDir = opts.runDir ?? workDir;
  const orchestratorDir = opts.orchestratorDir ?? here;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = resolveInterval(opts.pollMs, 'AGENT_LOOP_ASK_POLL_MS', opts.tty ? 100 : 2000);
  const valid = validAnswers(question);

  const tty = Boolean(opts.tty || opts.interactive);
  if (tty) {
    const own = opts.rl ?? createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (;;) {
        const a = (await own.question(`\n${questionText(question)}\nReply (${valid.join('/')}): `)).trim();
        if (valid.includes(a)) {
          if (isDirect) {
            if (a === '3') return { allow: false, reason: 'denied by user' };
            const opt = (question.options || []).find((o) => o.answer === a);
            return { allow: true, rule: opt?.rule, label: opt?.rule };
          }
          return a;
        }
      }
    } finally {
      if (!opts.rl) own.close();
    }
  }

  const qFile = opts.workDir ? questionPath(workDir) : path.join(runDir, 'question.json');
  const aFile = opts.workDir ? answerPath(workDir) : path.join(runDir, 'answer.json');

  // The caller's id is only a label: the id in question.json carries a random part that exists nowhere but in
  // this process and the file, so an answer placed before the question cannot match it.
  const label = question.id;
  const asked = { ...question, id: `${label}-${randomBytes(12).toString('hex')}` };
  rmSync(aFile, { force: true });
  writeAtomic(qFile, `${JSON.stringify(asked, null, 2)}\n`);
  if (runDir && runDir !== path.dirname(qFile)) {
    copyFileSync(qFile, path.join(runDir, `${label}.question.json`));
  }

  const runAbs = path.resolve(orchestratorDir, 'run.mjs');
  const relRun = workDir ? path.relative(path.resolve(workDir), runAbs) : '';
  const runCmdPath = (relRun && !relRun.startsWith('..') && !path.isAbsolute(relRun) ? relRun : runAbs).replace(/\\/g, '/');

  const rendered = questionText(question);
  if (opts.out?.write) opts.out.write(`${rendered}\n`);
  opts.log?.(`permission request:\n${rendered}\n  reply: npm run agents -- --answer <${valid.join('|')}> (or node ${runCmdPath} --answer …)`);
  opts.notify?.(`permission required: ${question.command}`);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (existsSync(aFile)) {
        let answer = null;
        try {
          answer = JSON.parse(readFileSync(aFile, 'utf8'));
        } catch (err) {
          opts.log?.(`answer.json cannot be read (${errText(err)}) — waiting for reply`);
        }
        if (answer && answer.id === asked.id && valid.includes(answer.answer)) {
          if (runDir && runDir !== path.dirname(aFile)) {
            copyFileSync(aFile, path.join(runDir, `${label}.answer.json`));
          }
          if (isDirect) {
            if (answer.answer === '3') return { allow: false, reason: 'denied by user' };
            const opt = (question.options || []).find((o) => o.answer === answer.answer);
            return { allow: true, rule: opt?.rule, label: opt?.rule };
          }
          return answer.answer;
        }
        rmSync(aFile, { force: true });
      }
      await sleep(pollMs);
    }
    if (isDirect) return { allow: false, reason: 'permission wait timeout' };
    return null;
  } finally {
    if (opts.workDir) clearQuestion(workDir);
    else {
      rmSync(qFile, { force: true });
      rmSync(aFile, { force: true });
    }
  }
}

/**
 * `--answer <n>`: passes the person's answer to the waiting loop. Throws when there is no question or the
 * answer is not one of its options. Returns the question for the console.
 */
export function writeAnswer({ workDir, answer }) {
  if (!existsSync(questionPath(workDir))) {
    throw new Error(`the loop is not asking anything (is not asking anything: missing ${RUNS_DIR}/question.json)`);
  }
  const question = JSON.parse(readFileSync(questionPath(workDir), 'utf8'));
  const valid = validAnswers(question);
  if (!valid.includes(answer)) {
    throw new Error(`answer "${answer}" is not one of the options ${valid.join(', ')}`);
  }
  writeAtomic(answerPath(workDir), `${JSON.stringify({ id: question.id, answer, at: new Date().toISOString() })}\n`);
  return question;
}

const isQuestion = (q) => q !== null && typeof q === 'object' && !Array.isArray(q)
  && typeof q.id === 'string' && typeof q.command === 'string' && Array.isArray(q.options)
  && q.options.every((o) => o !== null && typeof o === 'object' && typeof o.answer === 'string');

/**
 * CONTRACT: the permission question the running loop waits on. Read-only.
 * - no `<workDir>/.agent-runs/question.json` → `{ question: null, stale: false }`;
 * - the file exists but lockHolder(`<workDir>/.agent-runs`) is null (no lock or a dead PID) →
 *   `{ question: null, stale: true }` — the file is left in place;
 * - live holder, but the file is not JSON, or not an object with a string `id`, a string `command` and an
 *   `options` array whose every item is an object with a string `answer` →
 *   `{ question: null, stale: false, error: '<one-line reason>' }`;
 * - otherwise `{ question: <parsed object>, stale: false }`.
 * @param {string} workDir
 * @returns {{ question: object | null, stale: boolean, error?: string }}
 */
export function readPendingQuestion(workDir) {
  const file = questionPath(workDir);
  if (!existsSync(file)) return { question: null, stale: false };
  if (lockHolder(path.join(workDir, RUNS_DIR)) === null) return { question: null, stale: true };
  let question;
  try {
    question = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { question: null, stale: false }; // answered and withdrawn meanwhile
    return { question: null, stale: false, error: `${RUNS_DIR}/question.json is unreadable: ${errText(err).replace(/\s+/g, ' ')}` };
  }
  if (!isQuestion(question)) {
    return { question: null, stale: false, error: `${RUNS_DIR}/question.json has no valid id, command and options` };
  }
  return { question, stale: false };
}

/**
 * CONTRACT: `--answer <n>` from the CLI. Throws unless readPendingQuestion(workDir) returns a question:
 * error → message contains `cannot be read` and the reason; stale → contains `is not asking anything` and
 * `not running`; no question → contains `is not asking anything`. Then delegates to writeAnswer (same return
 * value and the same error for an answer that is not one of the options). Writes nothing when it throws.
 * @param {{ workDir: string, answer: string }} args
 * @returns {object} the question
 */
export function submitAnswer({ workDir, answer }) {
  const { question, stale, error } = readPendingQuestion(workDir);
  if (error) throw new Error(`the permission question cannot be read: ${error}`);
  if (stale) throw new Error(`the loop is not asking anything (the loop is not running: ${RUNS_DIR}/question.json is left over)`);
  if (!question) throw new Error(`the loop is not asking anything (missing ${RUNS_DIR}/question.json)`);
  return writeAnswer({ workDir, answer });
}
