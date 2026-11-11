// Frozen reference test for T-025 (D2 adapter interface, post-failure commit mechanical check, and K2 .claude/settings*.json guard).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, SUPPORTED_RUNNERS } from './index.mjs';
import { DEFAULTS, loadConfig, validateConfig, withDefaults } from '../config.mjs';
import { installGuards, which } from '../guards.mjs';
import { inspectFailedExecutorTurn } from '../mechanics.mjs';
import { agySettingsPath, ruleProblem, rulesFor, writeAgyAllowlist } from '../permissions.mjs';
import { readEvents } from '../events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(here, '..', 'run.mjs');
const realGit = which('git');

let root;
let work;
let home;
let env;

const g = (...args) => execFileSync(realGit, args, { cwd: work, encoding: 'utf8', env }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-adapter-s3-')));
  work = path.join(root, 'work');
  home = path.join(root, 'home');
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
  g('init', '-q', '-b', 'master');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('D2: getAdapter returns uniform adapter contract for agy and claude, and config validates runner / runnerBin', () => {
  assert.deepEqual(SUPPORTED_RUNNERS, ['agy', 'claude']);

  const agy = getAdapter('agy');
  assert.equal(agy.name, 'agy');
  assert.equal(agy.displayName, 'Antigravity');
  assert.equal(agy.capabilities.sandbox, 'none');
  assert.equal(agy.capabilities.supportsModelList, true);
  assert.equal(agy.resolveBin({ agyBin: '/custom/agy' }), '/custom/agy');
  assert.equal(agy.resolveBin({ runnerBin: '/override/agy', agyBin: '/custom/agy' }), '/override/agy');
  assert.equal(agy.permissions.toAllowRule('npm run lint'), 'command(npm run lint)');

  const claude = getAdapter({ runner: 'claude' });
  assert.equal(claude.name, 'claude');
  assert.equal(claude.displayName, 'Claude Code');
  assert.equal(claude.capabilities.sandbox, 'os-seatbelt-bwrap');
  assert.equal(claude.capabilities.supportsModelList, false);
  assert.equal(claude.resolveBin({ runner: 'claude' }), 'claude');
  assert.equal(claude.resolveBin({ runner: 'claude', runnerBin: '/opt/homebrew/bin/claude' }), '/opt/homebrew/bin/claude');
  assert.equal(claude.permissions.toAllowRule('npm run lint'), 'Bash(npm run lint:*)');

  assert.throws(() => getAdapter('unknown-runner'), /неизвестный раннер|unknown runner/i);
  assert.match(validateConfig(withDefaults({ runner: 'invalid' })).join('\n'), /runner/);
  assert.match(validateConfig(withDefaults({ runnerBin: '' })).join('\n'), /runnerBin/);

  const cfgPath = path.join(work, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({ runner: 'claude', runnerBin: '/opt/claude' }));
  const loaded = loadConfig(cfgPath);
  assert.equal(loaded.runner, 'claude');
  assert.equal(loaded.runnerBin, '/opt/claude');
});

test('K2, В1, В2: rulesFor includes deny write_file(<workDir>/.claude); installGuards / verifyGuards check .claude/settings*.json, CLAUDE.local.md, and .mcp.json, save .before/.after into runDir on mismatch, and restore() never overwrites them', () => {
  const rules = rulesFor(DEFAULTS, work);
  const gitDeny = `write_file(${path.join(work, '.git')})`;
  const claudeDeny = `write_file(${path.join(work, '.claude')})`;
  assert.deepEqual(rules.deny, [gitDeny, claudeDeny]);

  // Missing deny write_file(<workDir>/.claude) makes write_file(<workDir>) unsafe
  const onlyGitDenyCtx = { blockedScripts: [], workDir: work, home, deny: [gitDeny] };
  assert.match(String(ruleProblem(`write_file(${work})`, onlyGitDenyCtx)), /deny write_file\(<workDir>\/\.claude\)/);
  assert.match(String(ruleProblem(`write_file(${path.join(work, '.claude', 'settings.local.json')})`, { ...onlyGitDenyCtx, deny: rules.deny })), /запись в \.claude|writing to project \.claude/);
  assert.match(String(ruleProblem(`write_file(${path.join(home, '.claude', 'settings.json')})`, { ...onlyGitDenyCtx, deny: rules.deny })), /~\/\.claude/);

  writeFileSync(path.join(work, 'a.txt'), 'init\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');

  // Guard snapshot test 1 (В1, В2): files did NOT exist before turn, then .claude/settings.local.json, CLAUDE.local.md, and .mcp.json appeared
  const runDir1 = path.join(root, 'run-1');
  const guards1 = installGuards({ workDir: work, shimDir: path.join(runDir1, 'shims'), blockedScripts: [], realGit });
  assert.deepEqual(guards1.verify(), []);
  mkdirSync(path.join(work, '.claude'), { recursive: true });
  writeFileSync(path.join(work, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
  writeFileSync(path.join(work, 'CLAUDE.local.md'), 'injected instructions\n');
  writeFileSync(path.join(work, '.mcp.json'), '{"mcpServers":{}}\n');

  const problems1 = guards1.verify();
  assert.match(problems1.join('\n'), /\.claude\/settings\.local\.json (?:создан|was created)/);
  assert.match(problems1.join('\n'), /CLAUDE\.local\.md (?:создан|was created)/);
  assert.match(problems1.join('\n'), /\.mcp\.json (?:создан|was created)/);
  // .after copies saved in runDir1, no .before since they did not exist
  assert.equal(existsSync(path.join(runDir1, '.claude__settings.local.json.before')), false);
  assert.equal(readFileSync(path.join(runDir1, '.claude__settings.local.json.after'), 'utf8'), '{"permissions":{"allow":["Bash(*)"]}}\n');
  assert.equal(readFileSync(path.join(runDir1, 'CLAUDE.local.md.after'), 'utf8'), 'injected instructions\n');
  assert.equal(readFileSync(path.join(runDir1, '.mcp.json.after'), 'utf8'), '{"mcpServers":{}}\n');

  // В1: restore() must NOT delete or overwrite them silently
  guards1.restore();
  assert.equal(existsSync(path.join(work, '.claude', 'settings.local.json')), true, 'restore() must not silently delete .claude/settings.local.json');
  rmSync(path.join(work, 'CLAUDE.local.md'));
  rmSync(path.join(work, '.mcp.json'));

  // Guard snapshot test 2 (В1): .claude/settings.local.json existed before turn, then was modified -> both .before and .after saved in runDir2, and restore() leaves the modified file in place for user decision
  const originalContent = '{"permissions":{"allow":["Bash(node --test:*)"]}}\n';
  const modifiedContent = '{"permissions":{"allow":["Bash(node --test:*)","Bash(npm test:*)"]}}\n';
  writeFileSync(path.join(work, '.claude', 'settings.local.json'), originalContent);
  const runDir2 = path.join(root, 'run-2');
  const guards2 = installGuards({ workDir: work, shimDir: path.join(runDir2, 'shims'), blockedScripts: [], realGit });
  assert.deepEqual(guards2.verify(), []);
  writeFileSync(path.join(work, '.claude', 'settings.local.json'), modifiedContent);
  assert.match(guards2.verify().join('\n'), /\.claude\/settings\.local\.json (?:изменён|was modified)/);
  assert.equal(readFileSync(path.join(runDir2, '.claude__settings.local.json.before'), 'utf8'), originalContent);
  assert.equal(readFileSync(path.join(runDir2, '.claude__settings.local.json.after'), 'utf8'), modifiedContent);
  guards2.restore();
  assert.equal(readFileSync(path.join(work, '.claude', 'settings.local.json'), 'utf8'), modifiedContent, 'В1: restore() must not silently revert .claude/settings.local.json');

  // Guard snapshot test 3: deletion is also detected and .before is saved
  const runDir3 = path.join(root, 'run-3');
  const guards3 = installGuards({ workDir: work, shimDir: path.join(runDir3, 'shims'), blockedScripts: [], realGit });
  rmSync(path.join(work, '.claude', 'settings.local.json'));
  assert.match(guards3.verify().join('\n'), /\.claude\/settings\.local\.json (?:удалён|was removed)/);
  assert.equal(readFileSync(path.join(runDir3, '.claude__settings.local.json.before'), 'utf8'), modifiedContent);
  assert.equal(existsSync(path.join(runDir3, '.claude__settings.local.json.after')), false);
  guards3.restore();
});

test('D2 (user requirement): when Executor turn fails without final JSON after making commits, orchestrator runs checkExecutorRun on those commits and logs the result before stopping', () => {
  writeFileSync(path.join(work, 'src.js'), 'export const x = 1;\n');
  writeFileSync(path.join(work, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.6 -->\n');
  writeFileSync(path.join(work, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n\n- [ ] T-025: test task\n  - Risk: высокий.\n  - Change: `src.js`\n  - Test cases: structural verification\n');
  writeFileSync(path.join(work, '.gitignore'), '.agent-runs/\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  // 1. Direct unit test of inspectFailedExecutorTurn:
  const base0 = g('rev-parse', 'HEAD');
  const task = { id: 'T-025', risk: 'высокий', change: ['src.js'] };
  const noCommits = inspectFailedExecutorTurn({ realGit, cwd: work, base: base0, task, frozen: ['EXECUTOR.md'], scanPaths: ['.'], bypassPatterns: [/any/] });
  assert.equal(noCommits.hasCommits, false);

  // Make a clean commit and inspect
  writeFileSync(path.join(work, 'src.js'), 'export const x = 2;\n');
  g('add', 'src.js');
  g('commit', '-q', '-m', 'T-025: clean update');
  const cleanCheck = inspectFailedExecutorTurn({ realGit, cwd: work, base: base0, task, frozen: ['EXECUTOR.md'], scanPaths: ['.'], bypassPatterns: [/any/] });
  assert.equal(cleanCheck.hasCommits, true);
  assert.equal(cleanCheck.ok, true);
  assert.equal(cleanCheck.violations.length, 0);
  assert.match(cleanCheck.summaryText, /(?:механика по коммитам до сбоя: ok \(1 коммит\.:|pre-failure commit mechanics: ok \(1 commit\(s\):) [0-9a-f]{7} [«"]T-025: clean update[»"]\)/);

  // 2. End-to-end run.mjs test: fake-agy commits a violation (touches outside Change) and then exits with "jetski: no output produced" (no JSON answer)
  const fakeAgy = path.join(root, 'fake-agy-crash-after-commit');
  writeFileSync(
    fakeAgy,
    `#!/bin/sh
if [ "$1" = "models" ]; then printf 'gemini-3.8-flash-high\\tFlash\\ngemini-4-argon-high\\tArgon\\n'; exit 0; fi
echo 'unallowed' >rogue.txt
git add rogue.txt
git commit -q -m "T-025: rogue commit before crash"
printf '%s' '{"status":"ERROR","response":"jetski: no output produced","conversation_id":"conv-crash"}'
`,
  );
  chmodSync(fakeAgy, 0o755);

  const config = { ...DEFAULTS, agyBin: fakeAgy, notify: false };
  mkdirSync(path.join(work, '.agents'), { recursive: true });
  writeFileSync(path.join(work, '.agents', 'orchestrator.json'), JSON.stringify(config));
  g('add', '.agents/orchestrator.json');
  g('commit', '-q', '-m', 'arch: setup config');
  writeAgyAllowlist({ settingsPath: agySettingsPath(home), ...rulesFor(config, work) });

  const r = spawnSync(process.execPath, [RUN, '--only', 'T-025'], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
  const runsDir = path.join(work, '.agent-runs');
  const runFolder = readdirSync(runsDir).find((d) => /^\d{4}-\d{2}-\d{2}T/.test(d));
  assert.ok(runFolder, `expected a run folder in .agent-runs, stderr: ${r.stderr}`);
  const runDir = path.join(runsDir, runFolder);

  const summary = readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  assert.match(summary, /T-025: (?:сбой Исполнителя|Executor failed)[\s\S]*(?:механика по коммитам до сбоя: нарушение|pre-failure commit mechanics: violation)[\s\S]*(?:трогает файл вне «Менять»|touches file outside Change[^:]*): rogue\.txt/);
  assert.ok(existsSync(path.join(runDir, 'T-025-exec.violations.txt')), 'violations file must be written when failed turn left bad commits');

  const events = readEvents(runDir);
  const mechEvent = events.find((e) => e.type === 'mechanics_checked');
  assert.ok(mechEvent, 'events.jsonl must record mechanics_checked even when Executor failed without JSON');
  assert.equal(mechEvent.partial, true);
  assert.equal(mechEvent.ok, false);
  assert.equal(mechEvent.commitsCount, 1);
});
