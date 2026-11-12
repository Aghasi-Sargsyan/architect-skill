// Reference tests for T-119 (ADR-071, retro of cycle 35: T-117 listed skill docs in Change): readiness rejects an
// open task whose Change lists a file that is always frozen for the Executor (layout.mjs isAlwaysFrozenFile), so such
// work goes to an Architect commit instead of failing mechanics after the Executor has spent a run on it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan.mjs';
import { validatePlan } from './plan-validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The repository root holds the skill in a subfolder (e.g. .agents/skills/architect): skill-root files resolve against it.
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const skillRel = path.relative(repoRoot, path.dirname(here)).split(path.sep).join('/');
let tmp = null;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

const planWith = (tasks) => parsePlan([
  '# PLAN',
  '',
  '## Tasks',
  '',
  ...tasks.flatMap(({ id, done = false, change }) => [
    `- [${done ? 'x' : ' '}] ${id}: task ${id}`,
    '  - Risk: low.',
    '  - Depends on: —',
    `  - Change: ${change.map((p) => `\`${p}\``).join(', ')}.`,
    '  - Verify: `npm test`',
  ]),
  '',
].join('\n'));
const frozenIssues = (pv) => pv.changeIssues.filter((m) => m.includes('always frozen for the Executor'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('T-119: skill rules and skill-root docs in Change are rejected, one issue per path, naming the task and the path', () => {
  assert.ok(skillRel && !skillRel.startsWith('..'), `skill folder under the repository root (got "${skillRel}")`);
  const paths = [
    `${skillRel}/references/orchestrator.md`,
    `${skillRel}/README.ru.md`,
    `${skillRel}/CHANGELOG.md`,
    `${skillRel}/SKILL.md`,
  ];
  const pv = validatePlan(planWith([{ id: 'T-901', change: paths }]), { workDir: repoRoot });
  assert.equal(pv.ok, false);
  const issues = frozenIssues(pv);
  assert.equal(issues.length, paths.length, issues.join('\n'));
  for (const p of paths) {
    assert.ok(issues.some((m) => new RegExp(`^task T-901: ${escape(p)} is always frozen for the Executor`).test(m)), `${p}: ${issues.join('\n')}`);
  }
  assert.ok(issues.every((m) => m.includes('arch:')), 'the message sends the edit to an Architect commit');
});

test('T-119: always-frozen project files (EXECUTOR.md, orchestrator config, CI workflows) are rejected in any project', () => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-pv-frozen-')));
  const paths = ['EXECUTOR.md', './.agents/orchestrator.json', '.architect/config.json', '.github/workflows/ci.yml'];
  const pv = validatePlan(planWith([{ id: 'T-902', change: paths }]), { workDir: tmp });
  assert.equal(pv.ok, false);
  const issues = frozenIssues(pv);
  assert.equal(issues.length, 4, issues.join('\n'));
  assert.ok(issues.some((m) => m.startsWith('task T-902: .agents/orchestrator.json is always frozen')), `"./" is normalized: ${issues.join('\n')}`);
  assert.ok(issues.some((m) => m.startsWith('task T-902: .github/workflows/ci.yml is always frozen')), issues.join('\n'));
});

test('T-119: ordinary code, nested docs, root README, package.json and AGENTS.md stay allowed', () => {
  const paths = [
    `${skillRel}/orchestrator/feed.mjs`,
    `${skillRel}/orchestrator/notes.md`,
    'README.md',
    'package.json',
    'AGENTS.md',
  ];
  const pv = validatePlan(planWith([{ id: 'T-903', change: paths }]), { workDir: repoRoot });
  assert.deepEqual(pv.changeIssues, []);
  assert.equal(pv.ok, true);
});

test('T-119: closed tasks are history and are not re-validated; the PLAN.md rule keeps working alongside', () => {
  const pv = validatePlan(planWith([
    { id: 'T-904', done: true, change: [`${skillRel}/SKILL.md`] },
    { id: 'T-905', change: ['PLAN.md', `${skillRel}/SKILL.md`] },
  ]), { workDir: repoRoot });
  assert.equal(pv.changeIssues.some((m) => m.includes('T-904')), false, pv.changeIssues.join('\n'));
  assert.equal(pv.changeIssues.length, 2, pv.changeIssues.join('\n'));
  assert.ok(pv.changeIssues.some((m) => m.startsWith('task T-905: PLAN.md must not be listed in Change')));
  assert.equal(frozenIssues(pv).length, 1);
});
