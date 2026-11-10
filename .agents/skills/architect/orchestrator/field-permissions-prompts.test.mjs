import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_COMMANDS, commandProblem, proposeRules } from './permissions.mjs';
import { TOOLS_RULE, autoRefusalPrompt, executorPrompt } from './prompts.mjs';

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

test('T-080: TOOLS_RULE forbids read_file on binary/non-text assets and recommends ls, and autoRefusalPrompt suggests ls on find refusal and reminds about git commit --only', () => {
  assert.match(
    TOOLS_RULE,
    /binary|non-text|\.ico/i,
    'TOOLS_RULE must explicitly forbid calling read_file on binary/non-text assets (e.g. .ico, images, audio, archives)',
  );
  assert.match(
    TOOLS_RULE,
    /\bls\b/,
    'TOOLS_RULE must mention ls as an allowed directory listing command instead of find',
  );

  const findRefusal = autoRefusalPrompt('executor', {
    command: 'find reference/shining-crown-native -maxdepth 3 -not -path "*/831*"',
    reason: '"find" is forbidden in the terminal: use built-in file tools for reading and modifying files',
  });
  assert.match(
    findRefusal,
    /\bls\b/,
    'autoRefusalPrompt for find must suggest using allowed "ls" command to list directories',
  );
  assert.match(
    findRefusal,
    /--only/,
    'autoRefusalPrompt for executor must remind to use "git commit --only" when committing task changes',
  );

  for (const modName of ['permissions.mjs', 'prompts.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});

test('T-084: proposeRules auto-refuses commands whose rule is already in allow, FILE_BINARIES blocks shasum/sha256sum/md5, autoRefusalPrompt advises avoiding globs, and run.mjs passes allow and tty: Boolean(rl)', () => {
  // 1. shasum, sha256sum, md5 are blocked as terminal file binaries (use built-in tools / precomputed manifest values)
  for (const hashCmd of [
    'shasum -a 256 vendor/amusnet/classic-5x3-lines/shining-crown/paytable/sprite.jpg',
    'sha256sum vendor/amusnet/classic-5x3-lines/shining-crown/paytable/sprite.jpg',
    'md5 vendor/amusnet/classic-5x3-lines/shining-crown/paytable/sprite.jpg',
  ]) {
    const prob = commandProblem(hashCmd, []);
    assert.ok(prob, `commandProblem must reject ${hashCmd}`);
    assert.match(prob, /built-in file tools/i);
    const prop = proposeRules(hashCmd, []);
    assert.equal(prop.auto, true, `proposeRules must auto-refuse ${hashCmd}`);
    assert.equal(prop.fileTool, true);
  }
  assert.equal(BASE_COMMANDS.length, 30, 'BASE_COMMANDS 30-item invariant must remain intact');

  // 2. When command(git grep) or Bash(git grep:*) is already in allow, proposeRules auto-refuses instead of re-asking
  const cssGrep = "git grep -oE 'url\\([^)]+\\)' vendor/amusnet/_platform/game-ui/assets/*.css";
  const jsGrep = "git grep -a -oE 'import\\([^)]+\\)' vendor/amusnet/_platform/game-ui/assets/*.js";

  const withoutAllow = proposeRules(cssGrep, []);
  assert.equal(withoutAllow.auto, false, 'without existing allow list, proposeRules still proposes options');

  const withAgyAllow = proposeRules(cssGrep, [], { allow: ['command(git status)', 'command(git grep)'] });
  assert.equal(withAgyAllow.auto, true, 'when command(git grep) is already in allow, proposeRules must auto-refuse');
  assert.match(withAgyAllow.reason, /already in allowlist/i);
  assert.match(withAgyAllow.reason, /command\(git grep\)/);

  const withClaudeAllow = proposeRules(jsGrep, [], { allow: ['Bash(git grep:*)'] });
  assert.equal(withClaudeAllow.auto, true, 'when Bash(git grep:*) is already in allow, proposeRules must auto-refuse');
  assert.match(withClaudeAllow.reason, /already in allowlist/i);

  // Exact full-command match in allow is also auto-refused
  const exactAllow = proposeRules('pnpm test', [], { allow: ['command(pnpm test)'] });
  assert.equal(exactAllow.auto, true);
  assert.match(exactAllow.reason, /already in allowlist/i);

  // Command not in allow still prompts the user normally
  const notInAllow = proposeRules('npm run lint -- --fix', [], { allow: ['command(git grep)'] });
  assert.equal(notInAllow.auto, false);
  assert.equal(notInAllow.options[0].rule, 'npm run lint');

  // 3. autoRefusalPrompt for already-allowlisted command advises passing directory/file path without unquoted globs
  const refusalText = autoRefusalPrompt('executor', {
    command: cssGrep,
    reason: withAgyAllow.reason,
  });
  assert.match(refusalText, /directory|glob|\*\.css/i);
  assert.match(refusalText, /--only/);

  // 4. run.mjs passes allow from settings and tty: Boolean(rl) (not process.stdin.isTTY) to askPermission
  const runSrc = readFileSync(path.join(orchDir, 'run.mjs'), 'utf8');
  assert.match(runSrc, /proposeRules\([^)]*allow:/, 'run.mjs must pass existing allow rules to proposeRules');
  assert.match(runSrc, /tty:\s*Boolean\(rl\)/, 'run.mjs must pass tty: Boolean(rl) so non-pause PTY runs write question.json');
  assert.ok(!runSrc.includes('tty: Boolean(process.stdin.isTTY)'), 'run.mjs must not use process.stdin.isTTY for askPermission tty');

  for (const modName of ['permissions.mjs', 'prompts.mjs', 'run.mjs']) {
    const lines = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lines <= 400, `${modName} must stay <= 400 lines (got ${lines})`);
  }
});
