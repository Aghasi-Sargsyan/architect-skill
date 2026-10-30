import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeRules, commandProblem } from './permissions.mjs';
import { alwaysFrozenFiles, isAlwaysFrozenFile, reviewFilePath, skillFilePath } from './layout.mjs';
import { checkExecutorRun } from './mechanics.mjs';
import {
  TOOLS_RULE,
  ANSWER_FORMAT,
  suggestAllowedCommand,
  autoRefusalPrompt,
  resumePrompt,
  executorPrompt,
  architectPrompt,
} from './prompts.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'));
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-prompts-s4-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('T-030 (Ф4): suggestAllowedCommand and proposeRules suggest stripping leading directory flag ONLY when its realpath matches workDir, and phrase reason about command form', () => {
  const workDir = path.join(tmp, 'proj');
  const otherDir = path.join(tmp, 'other');
  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const linkToWork = path.join(tmp, 'proj-link');
  symlinkSync(workDir, linkToWork);

  const blocked = ['ship'];

  // commandProblem keeps its allowlist rule validation wording for backward compatibility with S1/S2 tests
  assert.match(String(commandProblem(`git -C ${workDir} show --stat HEAD`, blocked)), /слишком широкое|rule is too broad/);

  // 1. Leading flag pointing to workDir (exact path or symlink with matching realpath): suggestedCommand is returned
  for (const [cmd, expected] of [
    [`git -C ${workDir} show --stat HEAD`, 'git show --stat HEAD'],
    [`git -C ${linkToWork} status --short`, 'git status --short'],
    [`git --work-tree=${workDir} --git-dir=${path.join(workDir, '.git')} diff HEAD~1`, 'git diff HEAD~1'],
    [`npm --prefix ${workDir} test`, 'npm test'],
    [`pnpm -C ${workDir} test`, 'pnpm test'],
    [`yarn --cwd ${workDir} test`, 'yarn test'],
    [`make -C ${workDir} test`, 'make test'],
  ]) {
    assert.equal(suggestAllowedCommand(cmd, blocked, { workDir }), expected, cmd);
    const prop = proposeRules(cmd, blocked, { workDir });
    assert.equal(prop.auto, true, cmd);
    assert.equal(prop.suggestedCommand, expected, cmd);
    assert.doesNotMatch(prop.reason, /слишком широкое правило|rule is too broad/i, 'agent-facing reason must describe command form, not allowlist rule width');
    assert.match(prop.reason, /ведущ|перед подкомандой|подкоманд|leading flag|subcommand/i, cmd);
  }

  // 2. Leading flag pointing to a DIFFERENT directory (../other, /tmp/other) or missing workDir: suggestedCommand MUST be null!
  for (const differentCmd of [
    'git -C ../other show --stat HEAD',
    `git -C ${otherDir} show --stat HEAD`,
    `npm --prefix ${otherDir} test`,
    'git -c core.pager=cat show --stat HEAD',
    `npm --prefix ${workDir} run ship`, // stripped command is blocked!
  ]) {
    assert.equal(suggestAllowedCommand(differentCmd, blocked, { workDir }), null, `must NOT suggest command for: ${differentCmd}`);
    const prop = proposeRules(differentCmd, blocked, { workDir });
    assert.equal(prop.auto, true, differentCmd);
    assert.equal(prop.suggestedCommand ?? null, null, `proposeRules must NOT suggest command for: ${differentCmd}`);
  }
  assert.equal(proposeRules(`git -C ${workDir} show --stat HEAD`, blocked).suggestedCommand ?? null, null, 'without workDir, suggestedCommand must be null');

  // 3. autoRefusalPrompt / resumePrompt includes the suggestedCommand when present, and omits it when null
  const withHint = autoRefusalPrompt('architect', {
    command: `git -C ${workDir} show --stat HEAD`,
    reason: proposeRules(`git -C ${workDir} show --stat HEAD`, blocked, { workDir }).reason,
    suggestedCommand: 'git show --stat HEAD',
  });
  assert.match(withHint, /git show --stat HEAD/);
  assert.match(withHint, /рабочей папке|без ведущего флага|working directory|without the leading flag/i);
  assert.doesNotMatch(withHint, /слишком широкое правило|rule is too broad/i);

  const viaResume = resumePrompt('architect', {
    command: `git -C ${workDir} show --stat HEAD`,
    reason: proposeRules(`git -C ${workDir} show --stat HEAD`, blocked, { workDir }).reason,
    suggestedCommand: 'git show --stat HEAD',
  });
  assert.equal(viaResume, withHint);

  const withoutHint = autoRefusalPrompt('executor', {
    command: 'git -C ../other show --stat HEAD',
    reason: proposeRules('git -C ../other show --stat HEAD', blocked, { workDir }).reason,
    suggestedCommand: null,
  });
  assert.doesNotMatch(withoutHint, /git show --stat HEAD/);
  assert.match(withoutHint, /продолжай с того места без этой команды или эскалируй|continue from where you stopped without this command or escalate/);
});

test('T-030 (D4, Ф5): reviewFilePath and architectPrompt point to references/auto-review.md instead of loading full SKILL.md', () => {
  const repoRoot = path.resolve(orchDir, '..', '..', '..', '..');
  const revRel = reviewFilePath(repoRoot, orchDir);
  assert.equal(revRel, '.agents/skills/architect/references/auto-review.md');

  const extWork = path.join(tmp, 'ext-project');
  mkdirSync(extWork, { recursive: true });
  const revAbs = reviewFilePath(extWork, orchDir);
  assert.ok(path.isAbsolute(revAbs), 'outside workDir, reviewFilePath must return an absolute path');
  assert.ok(revAbs.endsWith('/references/auto-review.md'));

  assert.ok(TOOLS_RULE.length > 20);
  assert.equal(typeof ANSWER_FORMAT.executor, 'function');
  assert.equal(typeof ANSWER_FORMAT.architect, 'string');

  const execText = executorPrompt({ id: 'T-030' }, null, 'gemini-3.8-flash-high', { planPath: '.architect/PLAN.md', executorPath: '.architect/EXECUTOR.md' });
  assert.match(execText, /\.architect\/EXECUTOR\.md/);
  assert.match(execText, /T-030/);

  const archText = architectPrompt(
    { id: 'T-030' },
    'Отчёт',
    'ok (1 коммит.)',
    'gemini-3.8-flash-high',
    { planPath: 'PLAN.md', reviewPath: revRel, skillPath: skillFilePath(repoRoot, orchDir) },
  );
  assert.match(archText, /references\/auto-review\.md/, 'architectPrompt must reference references/auto-review.md');
  assert.match(archText, /T-030/);
  assert.match(archText, /(?:Закрытие цикла.*не выполняй|do NOT perform.*Cycle Closure)/is);
});

test('T-030 (Ф8): isAlwaysFrozenFile and checkExecutorRun portably protect *.md in skill root and references/** for any skill installation directory', () => {
  for (const skillInstallRel of ['.agents/skills/architect', '.claude/skills/architect', 'tools/architect-skill']) {
    const workDir = path.join(tmp, skillInstallRel.replace(/\//g, '_'));
    const fakeOrchDir = path.join(workDir, skillInstallRel, 'orchestrator');
    mkdirSync(path.join(workDir, skillInstallRel, 'references'), { recursive: true });
    mkdirSync(fakeOrchDir, { recursive: true });

    const frozenList = alwaysFrozenFiles('.architect/config.json', { workDir, orchestratorDir: fakeOrchDir });
    assert.ok(frozenList.includes(`${skillInstallRel}/SKILL.md`), skillInstallRel);
    assert.ok(frozenList.includes(`${skillInstallRel}/EXECUTOR.md`), skillInstallRel);
    assert.ok(frozenList.includes(`${skillInstallRel}/MAINTAINING.md`), skillInstallRel);

    for (const protectedPath of [
      'EXECUTOR.md',
      '.architect/EXECUTOR.md',
      '.agents/orchestrator.json',
      '.architect/config.json',
      `${skillInstallRel}/SKILL.md`,
      `${skillInstallRel}/EXECUTOR.md`,
      `${skillInstallRel}/MAINTAINING.md`,
      `${skillInstallRel}/README.ru.md`,
      `${skillInstallRel}/README.en.md`,
      `${skillInstallRel}/references/auto-review.md`,
      `${skillInstallRel}/references/orchestrator.md`,
      `${skillInstallRel}/references/nested/guide.md`,
    ]) {
      assert.equal(
        isAlwaysFrozenFile(protectedPath, { configPath: '.architect/config.json', workDir, orchestratorDir: fakeOrchDir }),
        true,
        `expected ${protectedPath} to be always frozen for ${skillInstallRel}`,
      );
    }

    for (const allowedByExecutor of [
      `${skillInstallRel}/orchestrator/run.mjs`,
      `${skillInstallRel}/orchestrator/prompts.mjs`,
      'src/index.ts',
      'docs/README.md',
    ]) {
      assert.equal(
        isAlwaysFrozenFile(allowedByExecutor, { configPath: '.architect/config.json', workDir, orchestratorDir: fakeOrchDir }),
        false,
        `expected ${allowedByExecutor} NOT to be always frozen for ${skillInstallRel}`,
      );
    }

    // Verify checkExecutorRun catches tampering with .claude/skills/architect/SKILL.md and references/auto-review.md even if listed in task.change!
    const g = (...args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: GIT_ENV }).trim();
    g('init', '-q', '-b', 'master');
    writeFileSync(path.join(workDir, skillInstallRel, 'SKILL.md'), '# v1\n');
    writeFileSync(path.join(workDir, skillInstallRel, 'references', 'auto-review.md'), '# r1\n');
    g('add', `${skillInstallRel}/SKILL.md`, `${skillInstallRel}/references/auto-review.md`);
    g('commit', '-q', '-m', 'init');
    const base = g('rev-parse', 'HEAD');

    writeFileSync(path.join(workDir, skillInstallRel, 'references', 'auto-review.md'), '# tampered\n');
    g('add', `${skillInstallRel}/references/auto-review.md`);
    g('commit', '-q', '-m', 'T-030: tamper reference');

    const res = checkExecutorRun({
      realGit,
      cwd: workDir,
      base,
      task: { id: 'T-030', risk: 'высокий', change: [`${skillInstallRel}/references/auto-review.md`] },
      frozen: [],
      scanPaths: [],
      bypassPatterns: [],
      configPath: '.architect/config.json',
      orchestratorDir: fakeOrchDir,
    });
    assert.ok(
      res.violations.some((v) => /трогает Frozen|touches Frozen/.test(v) && v.includes(`${skillInstallRel}/references/auto-review.md`)),
      `expected Frozen violation for ${skillInstallRel}/references/auto-review.md, got: ${res.violations.join('; ')}`,
    );
  }
});
