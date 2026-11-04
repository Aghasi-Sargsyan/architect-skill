// Parses PLAN.md in the architect-skill format: tasks, dependencies, model, «Менять» / Change, Frozen.
// Field names are matched case-insensitively in Russian or English (SKILL.md, task template).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TASK_RE = /^- \[( |x)\] (T-\d+): (.*)$/;
const PATH_IN_BACKTICKS_RE = /`([^`]+)`/g;
const FIELDS = {
  risk: ['риск', 'risk'],
  dependsOn: ['зависит от', 'depends on'],
  model: ['модель', 'model'],
  change: ['менять', 'change', 'files to change'],
  verify: ['проверка', 'verify', 'check'],
  testCases: ['тест-кейсы', 'test cases'],
  executor: ['исполнитель', 'executor'],
  parallelWith: ['параллельно с', 'parallel with', 'параллельно', 'parallel'],
};
const NONE_RE = /^[—–-]*\.?$/; // «—», «-» or empty: the field is not set
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

export function matchesFrozenPath(filePath, frozenList) {
  if (!filePath || !frozenList) return false;
  const list = Array.isArray(frozenList) ? frozenList : [...frozenList];
  if (!list.length) return false;
  const norm = normPath(filePath);
  for (const raw of list) {
    const pat = normPath(raw);
    if (pat === norm) return true;
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, '.*') + '$');
      if (re.test(norm)) return true;
    }
  }
  return false;
}

export function parseExecutorField(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(/[·\u00b7]/).map((s) => s.trim()).filter(Boolean);
  const handle = parts[0] || (value.match(/(@\S+)/)?.[1] ?? '');
  const env = parts[1] || '';
  const model = parts.slice(2).join(' · ') || '';
  const envNorm = (env || value).toLowerCase();
  let runner = 'agy';
  if (envNorm.includes('claude')) runner = 'claude';
  else if (envNorm.includes('codex')) runner = 'codex';
  else if (envNorm.includes('antigravity') || envNorm.includes('agy')) runner = 'agy';
  return { handle, env, runner, model };
}

function fieldKey(name) {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.keys(FIELDS).find((k) => FIELDS[k].includes(n)) ?? '';
}

/**
 * @param {string} text PLAN.md content
 * @returns {{ tasks: Array<{ id: string, title: string, done: boolean, risk: string, dependsOn: string[], model: string, change: string[], verifyCommands: string[], referenceTests: string[] }>, frozen: string[] }}
 */
export function parsePlan(text) {
  const tasks = [];
  const frozen = [];
  const rawCasesMap = new Map();
  let section = '';
  let current = null;
  let field = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      section = /^(frozen\b|заморожен)/i.test(heading) ? 'frozen' : heading.toLowerCase();
      current = null;
      continue;
    }
    if (section === 'frozen') {
      const m = line.match(/^- `([^`]+)`/);
      if (m) frozen.push(m[1]);
      continue;
    }
    const t = line.match(TASK_RE);
    if (t) {
      current = { id: t[2], title: t[3].trim(), done: t[1] === 'x', risk: '', dependsOn: [], model: '', change: [], verifyCommands: [], referenceTests: [], executor: '', executorInfo: null, parallelWith: [] };
      tasks.push(current);
      field = '';
      continue;
    }
    if (!current) continue;
    const f = line.match(/^ {2}-\s*([^:]+):\s*(.*)$/);
    if (f) {
      field = fieldKey(f[1]);
      const value = f[2].trim();
      if (field === 'risk') current.risk = value.replace(/\.$/, '').trim();
      if (field === 'dependsOn') {
        const parMatch = value.match(/\((?:parallel with|parallel|параллельно с|параллельно)[^)]*\)/i);
        if (parMatch) current.parallelWith.push(...(parMatch[0].match(/T-\d+/g) ?? []));
        const cleaned = value.replace(/\((?:parallel with|parallel|параллельно с|параллельно)[^)]*\)/gi, '');
        current.dependsOn = cleaned.match(/T-\d+/g) ?? [];
      }
      if (field === 'model') current.model = NONE_RE.test(value) ? '' : value;
      if (field === 'executor') {
        current.executor = value;
        current.executorInfo = parseExecutorField(value);
      }
      if (field === 'parallelWith') current.parallelWith.push(...(value.match(/T-\d+/g) ?? []));
      // Only the path inside backticks counts: "`tsconfig.test.json` (новый)" → tsconfig.test.json
      if (field === 'change') current.change.push(...[...value.matchAll(PATH_IN_BACKTICKS_RE)].map((m) => m[1]));
      if (field === 'verify') current.verifyCommands.push(...[...value.matchAll(PATH_IN_BACKTICKS_RE)].map((m) => m[1].trim()).filter(Boolean));
      if (field === 'testCases') {
        const list = rawCasesMap.get(current) ?? [];
        list.push(...[...value.matchAll(PATH_IN_BACKTICKS_RE)].map((m) => m[1]));
        rawCasesMap.set(current, list);
      }
      continue;
    }
    if (field === 'change') {
      const p = line.match(/^ {4,}- `([^`]+)`/);
      if (p) current.change.push(p[1]);
    }
    if (field === 'verify') {
      current.verifyCommands.push(...[...line.matchAll(PATH_IN_BACKTICKS_RE)].map((m) => m[1].trim()).filter(Boolean));
    }
    if (field === 'testCases' && /^ {4,}- /.test(line)) {
      const list = rawCasesMap.get(current) ?? [];
      list.push(...[...line.matchAll(PATH_IN_BACKTICKS_RE)].map((m) => m[1]));
      rawCasesMap.set(current, list);
    }
  }
  const testFileRe = /(?:^|\/)tests\/|\.(?:test|spec)\.[^/\s]+$/;
  for (const task of tasks) {
    const raw = rawCasesMap.get(task) ?? [];
    const seen = new Set();
    const refs = [];
    for (const p of raw) {
      const np = normPath(p);
      if (matchesFrozenPath(np, frozen) && !seen.has(np)) {
        seen.add(np);
        refs.push(p);
      }
    }
    for (const cmd of task.verifyCommands ?? []) {
      for (const tok of cmd.split(/\s+/)) {
        const cleanTok = tok.replace(/^["'`]|["'`]$/g, '');
        const ntok = normPath(cleanTok);
        if (testFileRe.test(ntok) && matchesFrozenPath(ntok, frozen) && !seen.has(ntok)) {
          seen.add(ntok);
          refs.push(cleanTok);
        }
      }
    }
    task.referenceTests = refs;
    task.parallelWith = [...new Set(task.parallelWith ?? [])];
  }
  return { tasks, frozen };
}

/**
 * Validates parallel tasks: checks that parallel targets exist, no mutual dependency in dependsOn,
 * no overlaps in Change or referenceTests, and no Frozen files in Change.
 * @param {{ tasks: Array<object>, frozen: string[] }} plan
 * @returns {string[]} problems
 */
export function checkParallelTasks(plan) {
  const problems = [];
  if (!plan?.tasks) return problems;
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));

  const pairs = new Set();
  for (const t of plan.tasks) {
    for (const targetId of t.parallelWith ?? []) {
      const target = taskMap.get(targetId);
      if (!target) {
        problems.push(`${t.id}: parallel task ${targetId} not found in plan`);
        continue;
      }
      const pairKey = t.id < targetId ? `${t.id}:${targetId}` : `${targetId}:${t.id}`;
      pairs.add(pairKey);
    }
  }

  for (const pairKey of pairs) {
    const [idA, idB] = pairKey.split(':');
    const a = taskMap.get(idA);
    const b = taskMap.get(idB);
    if (!a || !b) continue;

    if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) {
      problems.push(`parallel tasks ${idA} and ${idB} have dependency in Depends on`);
    }

    for (const task of [a, b]) {
      for (const ch of task.change ?? []) {
        if (matchesFrozenPath(ch, plan.frozen ?? [])) {
          problems.push(`parallel task ${task.id} Change contains frozen file: ${ch}`);
        }
      }
    }

    const aChange = new Set((a.change ?? []).map(normPath));
    for (const ch of b.change ?? []) {
      if (aChange.has(normPath(ch))) {
        problems.push(`parallel tasks ${idA} and ${idB} overlap in Change: ${ch}`);
      }
    }

    const aRefs = new Set((a.referenceTests ?? []).map(normPath));
    for (const ref of b.referenceTests ?? []) {
      if (aRefs.has(normPath(ref))) {
        problems.push(`parallel tasks ${idA} and ${idB} overlap in referenceTests: ${ref}`);
      }
    }
  }

  return problems;
}

export function readPlan(workDir, planPath = 'PLAN.md') {
  return parsePlan(readFileSync(path.join(workDir, planPath), 'utf8'));
}

/** Next open task whose dependencies are all done, or null. */
export function nextTask(plan, onlyId) {
  if (onlyId) {
    const t = plan.tasks.find((x) => x.id === onlyId);
    return t && !t.done ? t : null;
  }
  const done = new Set(plan.tasks.filter((t) => t.done).map((t) => t.id));
  return plan.tasks.find((t) => !t.done && t.dependsOn.every((d) => done.has(d))) ?? null;
}

const normalize = (s) => s.toLowerCase().replace(/[\s/()_-]+/g, ' ').trim();

/**
 * Resolves the task field «Модель» / Model to a runner model ID, or null if it matches none.
 * An ID in backticks must match exactly («Gemini 3.8 Flash / High (`gemini-3.8-flash-high`)»);
 * otherwise the text is compared with IDs and display names, ignoring case, spaces, «/», «-» and brackets.
 * @param {string} raw field value
 * @param {Array<{ id: string, name: string }>} models
 */
export function resolveModel(raw, models) {
  const tick = raw.match(/`([^`]+)`/);
  if (tick) return models.find((m) => m.id === tick[1].trim())?.id ?? null;
  const want = normalize(raw.replace(/\.$/, ''));
  return models.find((m) => normalize(m.id) === want || normalize(m.name) === want)?.id ?? null;
}
