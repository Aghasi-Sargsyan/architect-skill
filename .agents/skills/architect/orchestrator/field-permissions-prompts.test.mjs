import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_COMMANDS, commandProblem, proposeRules } from './permissions.mjs';
import { TOOLS_RULE, executorPrompt } from './prompts.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

test('T-070 (a): commandProblem and proposeRules auto-refuse npx grep and npx ls with direct grep/ls suggestedCommand instead of prompting the user', () => {
  const grepCmd = 'npx grep -n "playWin" node_modules/pixi-reels/dist/*.d.ts';
  const lsCmd = 'npx ls node_modules/pixi-reels/dist';

  const grepProb = commandProblem(grepCmd, []);
  assert.ok(grepProb, 'commandProblem must reject npx grep');
  assert.match(grepProb, /npx grep.*grep/i);

  const lsProb = commandProblem(lsCmd, []);
  assert.ok(lsProb, 'commandProblem must reject npx ls');
  assert.match(lsProb, /npx ls.*ls/i);

  const grepProp = proposeRules(grepCmd, []);
  assert.equal(grepProp.auto, true, 'proposeRules must auto-refuse npx grep without prompting user');
  assert.equal(grepProp.suggestedCommand, 'grep -n "playWin" node_modules/pixi-reels/dist/*.d.ts');

  const lsProp = proposeRules(lsCmd, []);
  assert.equal(lsProp.auto, true, 'proposeRules must auto-refuse npx ls without prompting user');
  assert.equal(lsProp.suggestedCommand, 'ls node_modules/pixi-reels/dist');

  // Legitimate npx tools (vitest, tsc) remain allowed
  assert.equal(commandProblem('npx vitest run tests/a.test.ts', []), null);
  assert.equal(commandProblem('npx tsc --noEmit', []), null);
});

test('T-070 (b): proposeRules auto-redirects "npm list ..." to "npm ls ..." while preserving the 30-item BASE_COMMANDS invariant', () => {
  assert.equal(BASE_COMMANDS.length, 30, 'BASE_COMMANDS length must remain 30');
  assert.ok(BASE_COMMANDS.includes('npm ls'));

  const prop = proposeRules('npm list pixi-reels', []);
  assert.equal(prop.auto, true, 'npm list must be auto-refused with suggestedCommand instead of pausing loop');
  assert.match(prop.reason, /npm ls/i);
  assert.equal(prop.suggestedCommand, 'npm ls pixi-reels');

  const bareProp = proposeRules('npm list', []);
  assert.equal(bareProp.auto, true);
  assert.equal(bareProp.suggestedCommand, 'npm ls');
});

test('T-070 (c): TOOLS_RULE and executorPrompt warn against find, tail, npx tsx, npm run agents, npm list, and instruct to use project commit language', () => {
  assert.match(TOOLS_RULE, /\bfind\b/);
  assert.match(TOOLS_RULE, /\btail\b/);
  assert.match(TOOLS_RULE, /\bnpx tsx\b/);
  assert.match(TOOLS_RULE, /\bnpm run agents\b/);
  assert.match(TOOLS_RULE, /\bnpm ls\b/);

  const promptText = executorPrompt(
    { id: 'T-023', title: 'Нативная геометрия 1440x810' },
    null,
    'gemini-3.8-flash-high',
    { planPath: 'PLAN.md', executorPath: 'EXECUTOR.md' },
  );
  assert.match(
    promptText,
    /commit language|English/i,
    'executorPrompt must remind Executor to write commit messages in the project commit language (e.g. English when commitLanguage is "en")',
  );

  for (const modName of ['permissions.mjs', 'prompts.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
