import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandProblem, proposeRules, checkProjectWriteRule, checkPermissions } from './permissions.mjs';
import { runCheck, formatCheckReport } from './check.mjs';
import { loadConfig } from './config.mjs';
import { askPermission, answerPendingPermission } from './ask.mjs';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

test('T-038 (D5, S5): permissions.mjs returns English reasons and issues without Cyrillic', () => {
  const problems = [
    commandProblem(''),
    commandProblem('git status && git diff'),
    commandProblem('git push origin master'),
    commandProblem('git add .'),
    commandProblem('git -C . status'),
    commandProblem('npm run ship', ['ship']),
    commandProblem('npx unknown-pkg'),
  ];
  for (const p of problems) {
    assert.ok(p, 'expected non-null problem');
    assert.doesNotMatch(p, CYRILLIC_RE);
  }

  const propLeading = proposeRules('git -C /tmp/work status', [], '/tmp/work');
  assert.equal(propLeading.auto, true);
  assert.doesNotMatch(propLeading.reason, CYRILLIC_RE);
  assert.match(propLeading.reason, /leading flag.*before.*subcommand/i);

  const propSafe = proposeRules('npx tsc -b');
  assert.equal(propSafe.auto, false);
  for (const ch of propSafe.choices) {
    assert.doesNotMatch(ch.label, CYRILLIC_RE);
  }

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t038-perm-')));
  try {
    const resWrite = checkProjectWriteRule(tmp, path.join(tmp, 'missing-settings.json'));
    assert.equal(resWrite.ok, false);
    assert.doesNotMatch(resWrite.issue, CYRILLIC_RE);

    const resPerm = checkPermissions({ allowedCommands: ['git status'], blockedScripts: ['ship'] }, tmp, tmp);
    assert.equal(resPerm.ok, false);
    assert.doesNotMatch(resPerm.issues.join('\n'), CYRILLIC_RE);
    assert.doesNotMatch(resPerm.warnings.join('\n'), CYRILLIC_RE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-038 (D5, S5): check.mjs, config.mjs, and ask.mjs output English messages without Cyrillic', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t038-check-')));
  try {
    const chk = runCheck({ workDir: tmp, home: tmp });
    const report = formatCheckReport(chk);
    assert.doesNotMatch(report, CYRILLIC_RE);
    assert.match(report, /=== Environment check ===/);
    assert.match(report, /Summary: NOT READY/);

    assert.throws(
      () => loadConfig(tmp),
      (err) => {
        assert.doesNotMatch(err.message, CYRILLIC_RE);
        assert.match(err.message, /not found/i);
        return true;
      },
    );

    const badCfgDir = path.join(tmp, 'badcfg');
    mkdirSync(path.join(badCfgDir, '.agents'), { recursive: true });
    writeFileSync(path.join(badCfgDir, '.agents', 'orchestrator.json'), '{"executor":{},"architect":{}}');
    assert.throws(
      () => loadConfig(badCfgDir),
      (err) => {
        assert.doesNotMatch(err.message, CYRILLIC_RE);
        assert.match(err.message, /executor\.model/i);
        return true;
      },
    );

    const runDir = path.join(tmp, 'run');
    mkdirSync(runDir, { recursive: true });
    const proposal = proposeRules('npx vitest run tests/a.test.ts');
    const outChunks = [];
    const out = { write: (s) => outChunks.push(String(s)) };
    const askPromise = askPermission({
      runDir,
      taskId: 'T-001',
      role: 'executor',
      step: { kind: 'command', command: 'npx vitest run tests/a.test.ts' },
      proposal,
      pollMs: 20,
      timeoutMs: 2000,
      interactive: false,
      out,
    });
    await new Promise((r) => setTimeout(r, 60));
    const answered = answerPendingPermission(runDir, '3');
    assert.doesNotMatch(answered.label, CYRILLIC_RE);
    const decision = await askPromise;
    assert.equal(decision.allow, false);
    assert.doesNotMatch(decision.reason, CYRILLIC_RE);
    assert.doesNotMatch(outChunks.join(''), CYRILLIC_RE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
