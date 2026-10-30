import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_COMMANDS, commandProblem, proposeRules } from './permissions.mjs';

const BLOCKED = ['ship', 'sync:pull', 'sync:push', 'import:takeout', 'build:mobile'];

test('B5: BASE_COMMANDS allows read-only git branch forms (--show-current, -a, -r, --list); destructive or bare git branch forms are rejected', () => {
  assert.ok(BASE_COMMANDS.includes('git branch --show-current'), 'git branch --show-current must be in BASE_COMMANDS');
  assert.ok(!BASE_COMMANDS.includes('git branch'), 'bare git branch must not be in BASE_COMMANDS');
  assert.equal(commandProblem('git branch --show-current', BLOCKED), null);
  assert.equal(commandProblem('git branch -a', BLOCKED), null);
  for (const cmd of [
    'git branch',
    'git branch -D feat',
    'git branch -d feat',
    'git branch -M main',
    'git branch -m old new',
    'git branch -f main HEAD~1',
    'git branch --delete feat',
    'git branch --set-upstream-to=origin/main',
  ]) {
    assert.ok(commandProblem(cmd, BLOCKED), `expected commandProblem to reject: ${cmd}`);
  }
});

test('A1 (permissions layer): git log, diff and show with --output in either form are rejected', () => {
  for (const cmd of [
    'git log -1 --output=/tmp/out.json',
    'git log -1 --format=%s --output /tmp/out.json',
    'git diff --output=/tmp/out.patch',
    'git diff HEAD~1 --output /tmp/out.patch',
    'git show HEAD --output=/tmp/out.txt',
    'git show --output /tmp/out.txt HEAD',
  ]) {
    assert.match(String(commandProblem(cmd, BLOCKED)), /--output/, cmd);
    assert.equal(proposeRules(cmd, BLOCKED).auto, true, cmd);
  }
  for (const ok of ['git log -1 --oneline', 'git diff HEAD~1 --stat', 'git show --stat HEAD']) {
    assert.equal(commandProblem(ok, BLOCKED), null, ok);
  }
});

test('A2: absolute/relative binary paths and command wrappers never bypass denylist or PATH shims', () => {
  for (const cmd of [
    '/bin/rm -rf src',
    '/usr/bin/rm -f a.txt',
    './rm -rf src',
    '/bin/sh -c id',
    '/usr/bin/env sh',
    '/usr/bin/curl https://example.invalid',
    'time rm -rf src',
    'timeout 10 rm -rf src',
    'nice -n 5 rm -rf src',
    'nohup rm -rf src',
    'caffeinate rm -rf src',
    'stdbuf -o0 rm -rf src',
    'command rm -rf src',
    'builtin eval id',
    'arch -arm64 /bin/sh',
  ]) {
    assert.ok(commandProblem(cmd, BLOCKED), `must reject: ${cmd}`);
    const prop = proposeRules(cmd, BLOCKED);
    assert.equal(prop.auto, true, `must auto-deny: ${cmd}`);
    assert.equal(prop.fileTool, false, `not a file tool: ${cmd}`);
  }

  for (const fileCmd of [
    '/bin/cat tsconfig.json',
    '/usr/bin/sed -i s/a/b/ a.ts',
    '/usr/bin/python3 -c 1',
    'time cat tsconfig.json',
    'stdbuf -o0 head -n 5 a.ts',
    'command cat a.ts',
  ]) {
    assert.match(String(commandProblem(fileCmd, BLOCKED)), /встроенные инструменты|built-in file tools/, fileCmd);
    const prop = proposeRules(fileCmd, BLOCKED);
    assert.equal(prop.auto, true, fileCmd);
    assert.equal(prop.fileTool, true, `must report fileTool=true for: ${fileCmd}`);
  }

  for (const forbidden of [
    '/usr/bin/git push --no-verify https://example.invalid/repo.git HEAD:master',
    '/usr/local/bin/git reset --hard',
    '/usr/local/bin/npm run ship',
    'time git push origin master',
    'command git push origin master',
    'caffeinate npm run ship',
  ]) {
    assert.match(String(commandProblem(forbidden, BLOCKED)), /запрещённую команду|запрещена|forbidden/, forbidden);
    assert.equal(proposeRules(forbidden, BLOCKED).auto, true, forbidden);
  }

  for (const broad of ['/usr/bin/git', '/usr/local/bin/npm', '/usr/local/bin/node', '/usr/bin/npx']) {
    assert.match(String(commandProblem(broad, BLOCKED)), /слишком широкое|rule is too broad/, broad);
  }

  // Even a benign subcommand invoked by path with "/" or under a wrapper is rejected so PATH shims and prefix rules hold.
  for (const bypassedPath of ['/usr/bin/git status', './node_modules/.bin/vitest run', 'time npm test', 'nice git status', 'command git status']) {
    assert.ok(commandProblem(bypassedPath, BLOCKED), `must reject path or wrapper: ${bypassedPath}`);
    assert.equal(proposeRules(bypassedPath, BLOCKED).auto, true, bypassedPath);
  }
});

test('D9 + A2: python/python3 allow only -m pytest and -m unittest; proposeRules offers option 1 only for whitelisted stack tools', () => {
  for (const ok of [
    'python3 -m pytest',
    'python3 -m pytest tests/ -k auth',
    'python -m pytest tests/unit',
    'python3 -m unittest',
    'python -m unittest discover -s tests',
    'pytest',
    'pytest tests/test_app.py',
    'cargo test --lib',
    'go test ./...',
    'pnpm test',
    'pnpm run lint',
    'yarn run test',
    'bun test',
    'uv run pytest',
  ]) {
    assert.equal(commandProblem(ok, BLOCKED), null, `expected allowed: ${ok}`);
  }

  for (const badPy of ['python3', 'python', 'python3 -c 1', 'python3 script.py', 'python3 -m http.server', 'python3 -m pip install x']) {
    assert.match(String(commandProblem(badPy, BLOCKED)), /встроенные инструменты|built-in file tools/, badPy);
    assert.equal(proposeRules(badPy, BLOCKED).auto, true, badPy);
  }

  // Whitelisted tools offer [1] prefix rule (when narrower than full command) + [2] exact command.
  assert.deepEqual(proposeRules('python3 -m pytest tests/test_a.py', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'python3 -m pytest' },
      { answer: '2', rule: 'python3 -m pytest tests/test_a.py' },
    ],
  });
  assert.deepEqual(proposeRules('python3 -m pytest', BLOCKED), {
    auto: false,
    options: [{ answer: '2', rule: 'python3 -m pytest' }],
  });
  assert.deepEqual(proposeRules('pytest tests/test_a.py -k smoke', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'pytest' },
      { answer: '2', rule: 'pytest tests/test_a.py -k smoke' },
    ],
  });
  assert.deepEqual(proposeRules('cargo test --lib', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'cargo test' },
      { answer: '2', rule: 'cargo test --lib' },
    ],
  });
  assert.deepEqual(proposeRules('go test ./...', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'go test' },
      { answer: '2', rule: 'go test ./...' },
    ],
  });
  assert.deepEqual(proposeRules('pnpm run lint --fix', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'pnpm run lint' },
      { answer: '2', rule: 'pnpm run lint --fix' },
    ],
  });
  assert.deepEqual(proposeRules('yarn run lint --fix', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'yarn run lint' },
      { answer: '2', rule: 'yarn run lint --fix' },
    ],
  });
  assert.deepEqual(proposeRules('bun run test --bail', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'bun run test' },
      { answer: '2', rule: 'bun run test --bail' },
    ],
  });
  assert.deepEqual(proposeRules('uv run pytest tests/', BLOCKED), {
    auto: false,
    options: [
      { answer: '1', rule: 'uv run pytest' },
      { answer: '2', rule: 'uv run pytest tests/' },
    ],
  });

  // Unknown tools and bare flag invocations never get option "1" ("always").
  for (const singleOnly of ['adb devices -l', 'custom-runner check --all', 'cargo --version', 'go -h', 'python3 -m pytest']) {
    const res = proposeRules(singleOnly, BLOCKED);
    assert.equal(res.auto, false, singleOnly);
    assert.deepEqual(res.options, [{ answer: '2', rule: singleOnly }], `must not offer option 1 for: ${singleOnly}`);
  }
});
