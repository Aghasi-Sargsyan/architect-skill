// T-104 reference tests (C-16): environment prefixes, launchers and interpreters are refused automatically;
// a question about an unknown command says that the orchestrator does not recognize it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionText } from './ask.mjs';
import { commandProblem, isRecognizedCommand, proposeRules } from './permissions.mjs';

const NOTE = '**Note:** the orchestrator does not recognize this command — check what it does before allowing it';
const question = (command) => ({ id: 'T-001-exec-q-0123456789abcdef01234567', who: 'Executor', taskId: 'T-001', command, options: [{ answer: '2', rule: command }] });

test('C-16: KEY=VALUE before a command is refused automatically (also after a wrapper)', () => {
  for (const c of ['AGENT_LOOP=0 git push https://example.invalid/x', 'FOO=1 npm test', 'GIT_DIR=/x git status', 'nice FOO=1 npm test', 'timeout 5 A_B=1 pnpm test']) {
    const p = commandProblem(c);
    assert.match(p ?? '', /environment variable/, c);
    assert.equal(proposeRules(c).auto, true, c);
  }
});

test('C-16: launchers that run another program are refused automatically', () => {
  for (const c of ['xcrun git push --no-verify https://example.invalid/x', 'busybox sh -c ls', 'toybox sh -c ls', 'doas git push', 'pkexec ls',
    'flock /tmp/l git push', 'script -q /dev/null git push', 'watch git status', 'setsid git push', 'chroot / sh', 'unshare -r sh',
    'sandbox-exec -p x git push', 'launchctl submit -l x -- sh', 'parallel ::: ls', 'expect -c x', 'systemd-run sh', 'firejail sh', 'bwrap sh', 'fakeroot sh']) {
    assert.notEqual(commandProblem(c), null, c);
    assert.equal(proposeRules(c).auto, true, c);
  }
});

test('C-16: interpreters are refused automatically; versioned python follows the python rules', () => {
  for (const c of ['ruby -e 1', 'irb', 'php -r 1', 'lua -e x', 'luajit -e x', 'tclsh x.tcl', 'Rscript -e 1', 'pwsh -c x', 'powershell -c x', 'fish -c x', 'dash -c x',
    'ksh -c x', 'mksh -c x', 'csh -c x', 'tcsh -c x', 'jshell', 'groovy -e x', 'nodejs -e 1', 'pypy3 -c 1', 'python2 -c 1', 'python3.12 -c 1', 'ipython -c 1', 'julia -e 1']) {
    assert.notEqual(commandProblem(c), null, c);
    assert.equal(proposeRules(c).auto, true, c);
  }
  assert.equal(commandProblem('python3.12 -m pytest -q'), null, 'a versioned python test runner stays allowed');
});

test('C-16: unknown but plausible commands still go to the person', () => {
  for (const c of ['npm install left-pad', 'pip install requests', 'docker run alpine', 'gh pr merge 1', 'deno test', 'cargo test', 'npm publish']) {
    assert.equal(commandProblem(c), null, c);
    assert.notEqual(proposeRules(c).auto, true, c);
  }
});

test('isRecognizedCommand: known tools after unwrapping wrappers; unknown binaries are not', () => {
  for (const c of ['npm run lint -- --fix', 'pnpm test', 'git status', 'npx vitest run', 'pytest -q', 'python3 -m pytest', 'node --test', 'wc -l a.txt', 'nice npm test', 'cargo test', 'grep -rn x src']) {
    assert.equal(isRecognizedCommand(c), true, c);
  }
  for (const c of ['pip install requests', 'docker run alpine', 'gh pr merge 1', 'deno test', 'terraform apply', '']) {
    assert.equal(isRecognizedCommand(c), false, c);
  }
});

test('questionText: a note right after the command line only for an unrecognized command', () => {
  const unknown = questionText(question('docker run alpine')).split('\n');
  const cmdIdx = unknown.indexOf('**Command:** `docker run alpine`');
  assert.ok(cmdIdx > 0);
  assert.equal(unknown[cmdIdx + 1], '');
  assert.equal(unknown[cmdIdx + 2], NOTE);
  assert.equal(unknown.filter((l) => l === NOTE).length, 1);
  for (const c of ['npm run lint', 'pnpm test', 'git status']) {
    assert.ok(!questionText(question(c)).includes('does not recognize'), c);
  }
});
