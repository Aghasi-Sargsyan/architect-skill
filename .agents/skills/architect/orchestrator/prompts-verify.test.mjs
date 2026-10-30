import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS_RULE, executorPrompt, architectPrompt } from './prompts.mjs';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

test('T-043b: TOOLS_RULE forbids node -e and python -c and separates targeted test runs from pre-commit Verify', () => {
  assert.doesNotMatch(TOOLS_RULE, CYRILLIC_RE);
  assert.match(TOOLS_RULE, /\bnode -e\b/);
  assert.match(TOOLS_RULE, /\bpython -c\b/);
  assert.match(TOOLS_RULE, /single test file|targeted test/i);
  assert.match(TOOLS_RULE, /before commit/i);

  const execPrompt = executorPrompt(
    { id: 'T-043', title: 'Prompt rules', change: ['prompts.mjs'] },
    null,
    'gemini-3.8-flash-high',
    { planPath: 'PLAN.md', executorPath: 'EXECUTOR.md' },
  );
  assert.doesNotMatch(execPrompt, CYRILLIC_RE);
  assert.match(execPrompt, /\bnode -e\b/);
});

test('T-043b: architectPrompt instructs not to re-run Verify commands already confirmed in Orchestrator mechanics check', () => {
  const archPrompt = architectPrompt(
    { id: 'T-043', title: 'Prompt rules' },
    'Report text',
    'commits abcdef0 "T-043: ok"; Verify passed (`node --test prompts-s9.test.mjs` (0, 45ms)).',
    'gemini-3.8-flash-high',
    {
      planPath: 'PLAN.md',
      reviewPath: '.agents/skills/architect/references/auto-review.md',
      skillPath: '.agents/skills/architect/SKILL.md',
    },
  );
  assert.doesNotMatch(archPrompt, CYRILLIC_RE);
  assert.match(archPrompt, /do not re-run.*Verify|already verified.*Orchestrator mechanics check/i);
});
