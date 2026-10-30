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
};
const NONE_RE = /^[—–-]*\.?$/; // «—», «-» or empty: the field is not set

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
      current = { id: t[2], title: t[3].trim(), done: t[1] === 'x', risk: '', dependsOn: [], model: '', change: [], verifyCommands: [], referenceTests: [] };
      tasks.push(current);
      field = '';
      continue;
    }
    if (!current) continue;
    const f = line.match(/^ {2}- ([^:]+):\s*(.*)$/);
    if (f) {
      field = fieldKey(f[1]);
      const value = f[2].trim();
      if (field === 'risk') current.risk = value.replace(/\.$/, '').trim();
      if (field === 'dependsOn') current.dependsOn = value.match(/T-\d+/g) ?? [];
      if (field === 'model') current.model = NONE_RE.test(value) ? '' : value;
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
  const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const frozenNormSet = new Set(frozen.map(normPath));
  for (const task of tasks) {
    const raw = rawCasesMap.get(task) ?? [];
    const seen = new Set();
    const refs = [];
    for (const p of raw) {
      const np = normPath(p);
      if (frozenNormSet.has(np) && !seen.has(np)) {
        seen.add(np);
        refs.push(p);
      }
    }
    task.referenceTests = refs;
  }
  return { tasks, frozen };
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
