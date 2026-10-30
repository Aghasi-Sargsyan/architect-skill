import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, EXAMPLE_PATH, initProject, loadConfig, validateConfig, withDefaults } from './config.mjs';

const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let dir;
const cfg = (obj) => {
  const file = path.join(dir, 'orchestrator.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-config-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('the example config is the defaults and is valid', () => {
  assert.deepEqual(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')), DEFAULTS);
  assert.deepEqual(validateConfig(DEFAULTS), []);
  for (const key of ['agyBin', 'executor', 'architect', 'permissions', 'blockedNpmScripts', 'allowedCommands', 'bypassScanPaths', 'bypassPatterns', 'maxFixRounds', 'timeoutMinutes', 'notify']) {
    assert.ok(key in DEFAULTS, key);
  }
});

test('a partial config is merged over the defaults, one level deep for the roles', () => {
  const c = loadConfig(cfg({ executor: {}, architect: { model: 'claude-opus-5-5-high' }, blockedNpmScripts: ['ship'] }));
  assert.equal(c.executor.model, DEFAULTS.executor.model);
  assert.equal(c.architect.model, 'claude-opus-5-5-high');
  assert.deepEqual(c.blockedNpmScripts, ['ship']);
  assert.equal(c.maxFixRounds, 2);
  assert.equal(c.bypassRegexps.length, DEFAULTS.bypassPatterns.length);
  assert.deepEqual(loadConfig(cfg({ bypassPatterns: [] })).bypassRegexps, [], '[] turns the bypass check off');
});

test('missing, broken and invalid configs fail with a clear message', () => {
  assert.throws(() => loadConfig(path.join(dir, 'nope.json')), /(?:нет конфига|missing config) .*--init/);
  assert.throws(() => loadConfig(cfg('{ not json')), /не JSON|not JSON/);
  assert.throws(() => loadConfig(cfg('[1]')), /JSON-объектом|JSON object/);
  assert.throws(() => loadConfig(cfg({ bypassPattern: [] })), /(?:неизвестное поле «bypassPattern»|unknown field "bypassPattern")/, 'a typo must not silently fall back to defaults');
  assert.throws(() => loadConfig(cfg({ bypassPatterns: ['('] })), /не регулярное выражение|not a regular expression/);
  assert.throws(() => loadConfig(cfg({ permissions: 'all', maxFixRounds: -1, executor: 'x' })), (err) => {
    const m = String(err.message);
    return /permissions/.test(m) && /maxFixRounds/.test(m) && /executor\.model/.test(m);
  });
  const workDirProb = validateConfig(withDefaults({ workDir: '' }));
  assert.equal(workDirProb.length, 1);
  assert.match(workDirProb[0], /^workDir (?:— непустая строка|must be a non-empty string)$/);
  assert.throws(() => loadConfig(cfg({ blockedNpmScripts: ['ship'], allowedCommands: ['npm run lint', 'npm run ship', 'git', 'git push origin'] })), (err) => {
    const m = String(err.message);
    return !/npm run lint/.test(m) && /[«"]npm run ship[»"]/.test(m) && /[«"]git[»"] — (?:слишком широкое|rule is too broad)/.test(m) && /[«"]git push origin[»"]/.test(m);
  });
});

test('--init creates the config and the ignore rule once, never overwrites, handles a missing trailing newline', () => {
  execFileSync(realGit, ['init', '-q', '-b', 'master'], { cwd: dir });
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');
  const notes = initProject({ workDir: dir, configPath: '.agents/orchestrator.json', realGit });
  assert.match(notes.join('\n'), /(?:создан|created) \.agents\/orchestrator\.json/);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n\n# Agent orchestrator runs (prompts, reports, lock)\n.agent-runs/\n');
  const configFile = path.join(dir, '.agents', 'orchestrator.json');
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), DEFAULTS);

  writeFileSync(configFile, '{"agyBin": "custom"}');
  const again = initProject({ workDir: dir, configPath: '.agents/orchestrator.json', realGit });
  assert.match(again.join('\n'), /конфиг уже есть|config already exists/);
  assert.match(again.join('\n'), /уже игнорируется|already ignored/);
  assert.equal(readFileSync(configFile, 'utf8'), '{"agyBin": "custom"}');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8').match(/\.agent-runs\//g)?.length, 1);
});

test('--init outside a git repository fails before writing anything', () => {
  assert.throws(() => initProject({ workDir: dir, configPath: 'orchestrator.json', realGit }));
  assert.throws(() => readFileSync(path.join(dir, 'orchestrator.json')));
});
