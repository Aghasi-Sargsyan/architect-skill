import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, nextTask, resolveModel } from './plan.mjs';
import { parseModels } from './adapters/agy.mjs';

// Synthetic plan in the PLAN.md format of the architect skill (Cycle-3 style fields included).
const PLAN = `# PLAN

## Goal / Requirements
Цель.

## Frozen
- \`EXECUTOR.md\`
- \`tests/ref.test.ts\`

## Rules
Исполнителю задачи T-NNN: перед работой прочитай EXECUTOR.md.

## Задачи

- [x] T-010: первая
  - Риск: высокий.
  - Зависит от: —.
  - Менять:
    - \`scripts/a.ts\`
    - \`AGENTS.md\`

- [ ] T-011: вторая
  - Риск: средний.
  - Зависит от: —.
  - Читать:
    - \`tsconfig.json\` — не путь из «Менять».
  - Менять:
    - \`tsconfig.test.json\` (новый)
    - \`tsconfig.json\`
  - Проверка: \`npx tsc -b\`.

- [ ] T-013: третья
  - Риск: средний.
  - Зависит от: T-011 (новый тест должен пройти проверку типов).
  - Менять:
    - \`src/core.ts\` (новый)

- [ ] T-014: четвёртая
  - Риск: высокий.
  - Зависит от: —.
  - Менять: \`scripts/b.ts\`, \`scripts/c.ts\`
`;

test('parses tasks, risk, dependencies and Frozen', () => {
  const p = parsePlan(PLAN);
  assert.deepEqual(p.frozen, ['EXECUTOR.md', 'tests/ref.test.ts']);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.done, t.risk]), [
    ['T-010', true, 'высокий'],
    ['T-011', false, 'средний'],
    ['T-013', false, 'средний'],
    ['T-014', false, 'высокий'],
  ]);
  assert.deepEqual(p.tasks[2].dependsOn, ['T-011']);
  assert.deepEqual(p.tasks[1].dependsOn, []);
});

test('«Менять» takes only paths inside backticks and ignores other fields', () => {
  const p = parsePlan(PLAN);
  assert.deepEqual(p.tasks[0].change, ['scripts/a.ts', 'AGENTS.md']);
  assert.deepEqual(p.tasks[1].change, ['tsconfig.test.json', 'tsconfig.json']);
  assert.deepEqual(p.tasks[2].change, ['src/core.ts']);
  assert.deepEqual(p.tasks[3].change, ['scripts/b.ts', 'scripts/c.ts']);
});

test('nextTask respects dependencies and --only', () => {
  const p = parsePlan(PLAN);
  assert.equal(nextTask(p)?.id, 'T-011');
  p.tasks[1].done = true;
  assert.equal(nextTask(p)?.id, 'T-013');
  assert.equal(nextTask(p, 'T-014')?.id, 'T-014');
  assert.equal(nextTask(p, 'T-010'), null, 'a done task is not runnable with --only');
  assert.equal(nextTask(p, 'T-999'), null);
});

const PLAN_EN = `# PLAN

## FROZEN
- \`tests/ref.test.ts\`

## Tasks

- [ ] T-001: first
  - risk: high.
  - Depends on: —.
  - MODEL: Gemini 3.8 Flash / High (\`gemini-3.8-flash-high\`).
  - Files to change:
    - \`src/a.py\` (new)
    - \`tests/test_a.py\`

- [ ] T-002: second
  - Risk: low.
  - Depends  on: T-001.
  - Model: —
  - Change: \`src/b.py\`
`;

test('English and case-insensitive field names, «## Tasks» and the Model field', () => {
  const p = parsePlan(PLAN_EN);
  assert.deepEqual(p.frozen, ['tests/ref.test.ts']);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.risk, t.dependsOn, t.model, t.change]), [
    ['T-001', 'high', [], 'Gemini 3.8 Flash / High (`gemini-3.8-flash-high`).', ['src/a.py', 'tests/test_a.py']],
    ['T-002', 'low', ['T-001'], '', ['src/b.py']],
  ]);
  assert.equal(parsePlan(PLAN).tasks[0].model, '', 'no Model field → empty');
});

test('agy models output is parsed; resolveModel matches an ID in backticks or a display name, fail-closed otherwise', () => {
  const models = parseModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n\n');
  assert.deepEqual(models, [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  ]);
  assert.equal(resolveModel('Gemini 3.8 Flash / High (`gemini-3.8-flash-high`).', models), 'gemini-3.8-flash-high');
  assert.equal(resolveModel('Gemini 3.8 Flash / High', models), 'gemini-3.8-flash-high');
  assert.equal(resolveModel('Claude Opus 5.5 / High.', models), 'claude-opus-5-5-high');
  assert.equal(resolveModel('gemini-3.8-flash-high', models), 'gemini-3.8-flash-high');
  assert.equal(resolveModel('Gemini 3.8 Flash / High (`gemini-3.8-flash-max`)', models), null, 'an unknown ID in backticks is not guessed from the name');
  assert.equal(resolveModel('Gemini 3.8 Flash / Low', models), null);
});

test('a dependency on an unfinished task blocks it', () => {
  const p = parsePlan(PLAN);
  p.tasks[1].done = false;
  p.tasks[3].done = true;
  assert.equal(nextTask(p)?.id, 'T-011');
  p.tasks[1].done = true;
  p.tasks[2].dependsOn = ['T-099'];
  assert.equal(nextTask(p), null);
});
