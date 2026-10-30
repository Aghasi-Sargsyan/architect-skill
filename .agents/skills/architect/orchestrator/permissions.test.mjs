import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.mjs';
import {
  AGY_SETTINGS_SHOWN, BASE_COMMANDS, agySettingsPath, allowedCommandsFor, allowlistBlock, commandProblem, maskPaths, proposeRules,
  permissionsCheck, readAgyRules, ruleProblem, rulesFor, unsafeRules, writeAgyAllowlist,
} from './permissions.mjs';

const BLOCKED = ['ship', 'deploy', 'release', 'db:seed', 'migrate:prod'];
let root; // fake machine: root/home is the home directory, root/home/projects/app the project
let home;
let workDir;
let settings;
const config = (extra = {}) => ({ ...DEFAULTS, blockedNpmScripts: BLOCKED, ...extra });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-perm-')));
  home = path.join(root, 'home');
  workDir = path.join(home, 'projects', 'app');
  mkdirSync(path.join(workDir, '.git'), { recursive: true });
  mkdirSync(path.join(home, '.gemini'), { recursive: true });
  settings = agySettingsPath(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = (deny = []) => ({ blockedNpmScripts: BLOCKED, workDir, home, deny });

test('the settings file is per machine, shown without the home directory', () => {
  assert.equal(settings, path.join(home, '.gemini', 'antigravity-cli', 'settings.json'));
  assert.equal(AGY_SETTINGS_SHOWN, '~/.gemini/antigravity-cli/settings.json');
  assert.equal(maskPaths(`write_file(${workDir}) and ${home}/x`, { workDir, home }), 'write_file(<workDir>) and ~/x');
});

test('commandProblem: broad rules, pushes, history rewrites and blocked scripts are unsafe; subcommands are fine', () => {
  for (const c of ['git', 'npm', 'npm run', 'npx', 'node', ' bash ', 'git -C', 'npm --prefix']) assert.ok(commandProblem(c, BLOCKED), c);
  for (const c of ['git push', 'git push --dry-run', 'git reset --hard', 'git clean', 'npm run ship', 'npm run-script deploy', 'npm ship']) {
    assert.match(String(commandProblem(c, BLOCKED)), /запрещённую команду|forbidden command/, c);
  }
  for (const c of [...BASE_COMMANDS, 'npm run lint', 'npm run build']) assert.equal(commandProblem(c, BLOCKED), null, c);
  assert.equal(commandProblem('npm run db', BLOCKED), null, 'word-level prefix: «npm run db» does not cover «npm run db:seed»');
  assert.match(String(commandProblem('npm test', ['test'])), /запрещённую|forbidden/, 'a blocked script also removes its base rule');
});

test('ruleProblem: file targets must stay inside the project; .git needs the deny; * is never allowed', () => {
  const gitDeny = [`write_file(${path.join(workDir, '.git')})`, `write_file(${path.join(workDir, '.claude')})`];
  const unsafe = {
    'command(*)': /разрешает всё|allows everything/,
    'mcp(*)': /разрешает всё|allows everything/,
    'write_file(*)': /разрешает всё|allows everything/,
    'write_file(/)': /домашний каталог или выше|home directory or above/,
    'read_file(/)': /домашний каталог или выше|home directory or above/,
    [`write_file(${home})`]: /домашний каталог или выше|home directory or above/,
    [`read_file(${root})`]: /домашний каталог или выше|home directory or above/,
    'write_file(projects/app)': /не абсолютный|not absolute/,
    [`write_file(${path.join(home, 'projects')})`]: /родительский каталог проекта|parent directory of the project/,
    [`write_file(${path.join(home, '.gemini', 'antigravity-cli')})`]: /~\/\.gemini/,
    [`write_file(${path.join(workDir, '.git', 'hooks')})`]: /запись в \.git|writing to project \.git/,
    [`write_file(${path.join(home, 'other')})`]: /вне текущего проекта|outside the current project/,
  };
  for (const [rule, reason] of Object.entries(unsafe)) assert.match(String(ruleProblem(rule, ctx(gitDeny))), reason, rule);
  assert.match(String(ruleProblem(`write_file(${workDir})`, ctx())), /deny write_file\(<workDir>\/\.git\)/);
  for (const rule of [`write_file(${workDir})`, `write_file(${path.join(workDir, 'src')})`, `read_file(${workDir})`, 'mcp(chrome_devtools/evaluate_script)', 'command(git status)']) {
    assert.equal(ruleProblem(rule, ctx(gitDeny)), null, rule);
  }
});

test('rules for the loop: base set minus blocked scripts plus allowedCommands, write_file of the project and a deny for its .git', () => {
  const list = allowedCommandsFor(config({ blockedNpmScripts: ['deploy'], allowedCommands: ['npm  run lint', 'git status'] }));
  assert.ok(!list.includes('npm run deploy'));
  assert.ok(list.includes('npm run lint'));
  assert.equal(list.filter((c) => c === 'git status').length, 1);
  const rules = rulesFor(config(), workDir);
  assert.equal(rules.allow.at(-1), `write_file(${workDir})`);
  assert.deepEqual(rules.deny, [`write_file(${path.join(workDir, '.git')})`, `write_file(${path.join(workDir, '.claude')})`]);
  assert.deepEqual(unsafeRules(rules.allow, ctx(rules.deny)), [], 'our own rules pass our own check');
  assert.deepEqual(JSON.parse(allowlistBlock({ allow: ['command(git status)'], deny: [] })), { permissions: { allow: ['command(git status)'], deny: [] } });
});

test('--write-permissions merges allow and deny into a missing file, then into an existing one keeping other fields', () => {
  const rules = rulesFor(config(), workDir);
  const first = writeAgyAllowlist({ settingsPath: settings, ...rules });
  assert.equal(first.addedAllow.length, rules.allow.length);
  assert.deepEqual(first.addedDeny, rules.deny);
  assert.equal(first.backup, false);
  assert.equal(statSync(settings).mode & 0o777, 0o600);

  writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { allow: ['command(adb)', 'command(git status)'], deny: ['command(rm)'] } }));
  const before = readFileSync(settings, 'utf8');
  const second = writeAgyAllowlist({ settingsPath: settings, allow: ['command(git status)', 'command(git diff)'], deny: ['write_file(/x/.git)'] });
  assert.deepEqual(second, { addedAllow: ['command(git diff)'], addedDeny: ['write_file(/x/.git)'], backup: true });
  assert.equal(readFileSync(`${settings}.bak`, 'utf8'), before);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
    theme: 'dark',
    permissions: { allow: ['command(adb)', 'command(git status)', 'command(git diff)'], deny: ['command(rm)', 'write_file(/x/.git)'] },
  });

  rmSync(`${settings}.bak`);
  assert.deepEqual(writeAgyAllowlist({ settingsPath: settings, allow: ['command(git diff)'], deny: [] }), { addedAllow: [], addedDeny: [], backup: false });
  assert.equal(existsSync(`${settings}.bak`), false, 'nothing to add → nothing written');
});

test('--write-permissions refuses without changes when the file is not a JSON object or allow / deny are not lists', () => {
  mkdirSync(path.dirname(settings), { recursive: true });
  for (const text of ['{ broken', '[1]', '{"permissions": 1}', '{"permissions": {"allow": "x"}}', '{"permissions": {"deny": {}}}']) {
    writeFileSync(settings, text);
    assert.throws(() => writeAgyAllowlist({ settingsPath: settings, allow: ['command(git status)'] }), /файл не изменён|file unchanged/, text);
    assert.equal(readFileSync(settings, 'utf8'), text);
    assert.equal(existsSync(`${settings}.bak`), false);
  }
});

test('--check reads only the allow / deny rules; fails on a missing file, unsafe or missing rules; masks paths', () => {
  const check = () => permissionsCheck({ config: config(), settingsPath: settings, workDir, home });
  assert.equal(check().ok, false);
  assert.match(check().detail, /(?:нет — запустите с|is missing — run with) --write-permissions/);
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ account: 'someone@example.invalid', permissions: { allow: ['command(git)', 'command(npm run ship)', `write_file(${workDir})`, 'read_file(*)'] } }));
  assert.deepEqual(readAgyRules(settings).allow.length, 4);
  const bad = check();
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /command\(git\) — (?:слишком широкое|rule is too broad)/);
  assert.match(bad.detail, /command\(npm run ship\) — (?:покрывает запрещённую|covers forbidden)/);
  assert.match(bad.detail, /write_file\(<workDir>\) — (?:покрывает \.git|covers project \.git)/);
  assert.match(bad.detail, /read_file\(\*\) — /);
  assert.ok(!bad.detail.includes('someone@') && !bad.detail.includes(root), 'no other fields and no absolute paths in the output');

  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['command(git status)', `write_file(${workDir})`], deny: [`write_file(${path.join(workDir, '.git')})`, `write_file(${path.join(workDir, '.claude')})`] } }));
  const partial = check();
  assert.equal(partial.ok, false, 'missing required rules fail: the loop would stop inside the first agent run');
  assert.match(partial.detail, /(?:не хватает правил|missing rules): command\(git diff\), .*--write-permissions/);
  assert.ok(!partial.detail.includes(root));

  writeAgyAllowlist({ settingsPath: settings, ...rulesFor(config(), workDir) });
  const ok = check();
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /(?:правил command\(…\): 30, запись в проект без \.git, опасных нет|command\(…\) rules: 30, project write without \.git, no unsafe rules)/);
  assert.ok(rulesFor(config(), workDir).allow.includes('command(ls)'), 'ls is in the base set');
  writeFileSync(settings, '{ broken');
  assert.equal(check().ok, false);
});

test('commandProblem K2: shell operators, denied binaries, node / npx code runners, git config and remote', () => {
  const unsafe = {
    'ls -la a && ls -la b': /операторы оболочки|shell operators/,
    'npm test; rm -rf x': /операторы оболочки|shell operators/,
    'git log | head': /операторы оболочки|shell operators/,
    'echo $(id)': /операторы оболочки|shell operators/,
    'cat tsconfig.json': /встроенные инструменты|built-in file tools/,
    'sed -i s/a/b/ f': /встроенные инструменты|built-in file tools/,
    'python3 -c 1': /встроенные инструменты|built-in file tools/,
    'rm -rf node_modules': /с любыми аргументами|with any arguments/,
    'curl https://example.invalid': /с любыми аргументами|with any arguments/,
    'sh -c "git push"': /операторы оболочки|с любыми аргументами|shell operators|with any arguments/,
    'node -e 1': /node --test/,
    'node scripts/ship.ts': /node --test/,
    'npx tsx scripts/ship.ts': /npx tsx/,
    'npx ts-node x': /npx ts-node/,
    'git config core.hooksPath x': /git config/,
    'git remote add x y': /git remote/,
  };
  for (const [c, reason] of Object.entries(unsafe)) assert.match(String(commandProblem(c, BLOCKED)), reason, c);
  for (const c of ['node --test tests/', 'npx vitest run tests/a.test.ts', 'git stash list', 'pnpm test']) assert.equal(commandProblem(c, BLOCKED), null, c);
});

test('proposeRules: unsafe → automatic no; otherwise [1] command + subcommand (npm run keeps three words) and [2] the command', () => {
  assert.deepEqual(proposeRules('cat tsconfig.test.json', BLOCKED).auto, true);
  assert.equal(proposeRules('cat tsconfig.test.json', BLOCKED).fileTool, true);
  assert.equal(proposeRules('npm run migrate:prod', BLOCKED).auto, true);
  assert.deepEqual(proposeRules('npm run lint -- --fix', BLOCKED), { auto: false, options: [{ answer: '1', rule: 'npm run lint' }, { answer: '2', rule: 'npm run lint -- --fix' }] });
  assert.deepEqual(proposeRules('git stash list', BLOCKED).options.map((o) => o.rule), ['git stash', 'git stash list']);
  assert.deepEqual(proposeRules('pnpm test', BLOCKED).options, [{ answer: '2', rule: 'pnpm test' }], 'no [1] when the prefix is the command itself');
  assert.deepEqual(proposeRules('npm  run   lint', BLOCKED).options, [{ answer: '2', rule: 'npm run lint' }]);
});
