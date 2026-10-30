import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './guards.mjs';
import {
  EVAL_FIXTURE_ANCHORS,
  resolveSelfCheckBase,
  parseWaivers,
  findEmptyCatches,
  findTestTimers,
  runSelfCheckGit,
  checkPostReviewSelfCheck,
} from './selfcheck.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');

// Build forbidden patterns via concatenation so self-check does not flag this test file itself
const EMPTY_CATCH_1 = 'try { work(); } ' + 'catch ' + '{}';
const EMPTY_CATCH_COMMENT = 'try {\n  work();\n} ' + 'catch (err) {\n  // ' + 'ignore error\n}';
const EMPTY_PROMISE_CATCH = 'doAsync().' + 'catch(() => {' + '});';
const CLEANUP_CATCH_OK = 'try {\n  proc.kill();\n} ' + 'catch {\n  // cleanup: ' + 'stop child process\n}';
const TIMER_PERF = 'const t0 = ' + 'performance.' + 'now(';
const TIMER_DATE = 'const t1 = ' + 'Date.' + 'now(';
const TIMER_HRTIME = 'const t2 = ' + 'process.' + 'hrtime(';
const TIMER_CONSOLE = 'console.' + 'time("bench")';
const BYPASS_ONLY = 'test.' + 'only("focused", () => {});';

function initTempRepo(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  return { root, g };
}

test('T-046: resolveSelfCheckBase follows priority --base > last close cycle != HEAD > @{u} (only when no close cycle exists)', () => {
  const { root, g } = initTempRepo('s10-t046-base-');
  const bare = realpathSync(mkdtempSync(path.join(os.tmpdir(), 's10-t046-bare-')));
  try {
    execFileSync(realGit, ['init', '--bare', '-q', bare]);
    writeFileSync(path.join(root, 'a.txt'), '1\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'arch: close cycle 8');
    const close8Sha = g('rev-parse', 'HEAD');

    writeFileSync(path.join(root, 'a.txt'), '2\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'arch: plan Cycle 9');
    const plan9Sha = g('rev-parse', 'HEAD');

    // Push mid-cycle (like e965d31 in Cycle 9) so @{u} is newer than close8Sha
    g('remote', 'add', 'origin', bare);
    g('push', '-q', '-u', 'origin', 'master');

    writeFileSync(path.join(root, 'a.txt'), '3\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'arch: close cycle 9');
    const close9Sha = g('rev-parse', 'HEAD');

    // When HEAD === close9Sha, last close cycle != HEAD is close8Sha (NOT @{u} = plan9Sha!)
    const atClose9 = resolveSelfCheckBase({ realGit, cwd: root });
    assert.equal(atClose9.sha, close8Sha);
    assert.equal(atClose9.source, 'close-cycle');

    // When a new commit lands in Cycle 10, last close cycle != HEAD is close9Sha
    writeFileSync(path.join(root, 'a.txt'), '4\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'arch: plan Cycle 10');
    const inCycle10 = resolveSelfCheckBase({ realGit, cwd: root });
    assert.equal(inCycle10.sha, close9Sha);
    assert.equal(inCycle10.source, 'close-cycle');

    // Explicit --base @{u} overrides to plan9Sha
    const explicitUpstream = resolveSelfCheckBase({ realGit, cwd: root, baseRef: '@{u}' });
    assert.equal(explicitUpstream.sha, plan9Sha);
    assert.equal(explicitUpstream.source, 'explicit');

    // In a repo without any close cycle commits, fallback uses @{u}
    const { root: noCloseRoot, g: g2 } = initTempRepo('s10-t046-noclose-');
    try {
      writeFileSync(path.join(noCloseRoot, 'x.txt'), 'init\n');
      g2('add', 'x.txt');
      g2('commit', '-q', '-m', 'initial commit');
      const initSha = g2('rev-parse', 'HEAD');
      const bare2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), 's10-t046-bare2-')));
      try {
        execFileSync(realGit, ['init', '--bare', '-q', bare2]);
        g2('remote', 'add', 'origin', bare2);
        g2('push', '-q', '-u', 'origin', 'master');
        writeFileSync(path.join(noCloseRoot, 'x.txt'), 'next\n');
        g2('add', 'x.txt');
        g2('commit', '-q', '-m', 'arch: plan Cycle 1');
        const fallbackUp = resolveSelfCheckBase({ realGit, cwd: noCloseRoot });
        assert.equal(fallbackUp.sha, initSha);
        assert.equal(fallbackUp.source, 'upstream');
      } finally {
        rmSync(bare2, { recursive: true, force: true });
      }
    } finally {
      rmSync(noCloseRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('T-046: findEmptyCatches and findTestTimers detect multiline empty catch (ignoring only stop/abort/close cleanup) and test timing calls', () => {
  const diff = [
    '+++ b/src/service.js',
    '@@ -1,0 +1,12 @@',
    `+${EMPTY_CATCH_1}`,
    ...EMPTY_CATCH_COMMENT.split('\n').map((l) => `+${l}`),
    `+${EMPTY_PROMISE_CATCH}`,
    ...CLEANUP_CATCH_OK.split('\n').map((l) => `+${l}`),
    '+++ b/tests/speed.test.mjs',
    '@@ -1,0 +1,4 @@',
    `+${TIMER_PERF}0);`,
    `+${TIMER_DATE});`,
    `+${TIMER_HRTIME});`,
    `+${TIMER_CONSOLE};`,
  ].join('\n');

  const catches = findEmptyCatches(diff);
  assert.equal(catches.length, 3, 'must catch empty {}, comment-only ignore, and empty promise catch, but allow stop/abort/close cleanup');
  assert.ok(catches.every((c) => c.file === 'src/service.js'));

  const timers = findTestTimers(diff);
  assert.equal(timers.length, 4, 'must detect all four test timer calls in test files');
  assert.ok(timers.every((t) => t.file === 'tests/speed.test.mjs'));
});

test('T-046: runSelfCheckGit enforces remediability on HEAD, monotonicity (tests, config arrays, eval-fixtures anchors), fix-frozen, WAIVER, and post-review rules', () => {
  const { root, g } = initTempRepo('s10-t046-full-');
  try {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    mkdirSync(path.join(root, '.agents', 'skills', 'architect', 'orchestrator'), { recursive: true });

    const baseOrchConfig = {
      bypassScanPaths: ['tests'],
      bypassPatterns: ['\\.(skip|only)\\('],
      protectedConfigFiles: ['tsconfig.json', 'package.json'],
      blockedNpmScripts: ['ship', 'sync:push'],
    };
    writeFileSync(path.join(root, '.agents', 'orchestrator.json'), JSON.stringify(baseOrchConfig, null, 2));
    writeFileSync(
      path.join(root, '.agents', 'skills', 'architect', 'orchestrator', 'eval-fixtures.mjs'),
      EVAL_FIXTURE_ANCHORS.join('\n') + '\n',
    );
    writeFileSync(
      path.join(root, 'tests', 'ref.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => { assert.equal(1, 1); assert.ok(true); });\ntest("b", () => { assert.equal(2, 2); });\n',
    );
    writeFileSync(
      path.join(root, 'PLAN.md'),
      '# PLAN\n\n## Decisions (ADR)\n- ADR-001: Base\n\n## Frozen\n- `EXECUTOR.md`\n- `tests/ref.test.mjs`\n\n## Задачи\n- [ ] T-001: Demo\n  - Риск: высокий.\n  - Менять: `src/a.js`.\n',
    );
    g('add', '.');
    g('commit', '-q', '-m', 'arch: close cycle 9');

    const config = {
      bypassScanPaths: ['tests'],
      bypassPatterns: ['\\.(skip|only)\\('],
      bypassRegexps: [/\.(skip|only)\(/],
      protectedConfigFiles: ['tsconfig.json', 'package.json'],
      blockedNpmScripts: ['ship', 'sync:push'],
    };

    // 1. Plan commit
    writeFileSync(path.join(root, 'PLAN.md'), readFileSync(path.join(root, 'PLAN.md'), 'utf8') + '  - Проверка: `npm test`.\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: plan Cycle 10');

    // 2. Add a temporary violation in tests/temp.test.mjs and then fix it in the next commit -> remediability means NO violation on HEAD!
    writeFileSync(path.join(root, 'tests', 'temp.test.mjs'), `${BYPASS_ONLY}\n${TIMER_PERF});\n${EMPTY_CATCH_1}\n`);
    g('add', 'tests/temp.test.mjs');
    g('commit', '-q', '-m', 'arch: add temp test with issues');

    writeFileSync(path.join(root, 'tests', 'temp.test.mjs'), 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("clean", () => { assert.ok(true); });\n');
    g('add', 'tests/temp.test.mjs');
    g('commit', '-q', '-m', 'arch: clean up temp test');

    const cleanRes = runSelfCheckGit({ realGit, cwd: root, config });
    assert.equal(cleanRes.ok, true, `remediated content issues should not fail on HEAD: ${cleanRes.violations.join('; ')}`);

    // 3. Modify Frozen test after plan WITHOUT arch: fix-frozen prefix AND decrease assert count + replace config array item
    writeFileSync(
      path.join(root, 'tests', 'ref.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => { assert.equal(1, 1); });\ntest("b", () => { assert.equal(2, 2); });\n',
    );
    // Same array length (2), but 'sync:push' replaced with 'other' -> fails superset check!
    writeFileSync(
      path.join(root, '.agents', 'orchestrator.json'),
      JSON.stringify({ ...baseOrchConfig, blockedNpmScripts: ['ship', 'other'] }, null, 2),
    );
    g('add', 'tests/ref.test.mjs', '.agents/orchestrator.json');
    g('commit', '-q', '-m', 'arch: silent weaken after plan');
    const badSha7 = g('rev-parse', 'HEAD').slice(0, 7);

    const badRes = runSelfCheckGit({ realGit, cwd: root, config });
    assert.equal(badRes.ok, false);
    assert.match(badRes.violations.join('\n'), /monotonicity|assert/i);
    assert.match(badRes.violations.join('\n'), /blockedNpmScripts|sync:push/i);
    assert.match(badRes.violations.join('\n'), /fix-frozen/i);

    // 4. Restore monotonicity on HEAD, and add WAIVER for the historical non-fix-frozen commit badSha7
    writeFileSync(
      path.join(root, 'tests', 'ref.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => { assert.equal(1, 1); assert.ok(true); });\ntest("b", () => { assert.equal(2, 2); assert.ok(true); });\n',
    );
    writeFileSync(path.join(root, '.agents', 'orchestrator.json'), JSON.stringify(baseOrchConfig, null, 2));
    const planWithWaiver = readFileSync(path.join(root, 'PLAN.md'), 'utf8').replace(
      '- ADR-001: Base',
      `- ADR-001: Base\n- WAIVER ${badSha7}: fix-frozen — user approved historical commit`,
    );
    writeFileSync(path.join(root, 'PLAN.md'), planWithWaiver);
    g('add', 'tests/ref.test.mjs', '.agents/orchestrator.json', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: fix-frozen audit: restore monotonicity and record waiver');

    const waivedRes = runSelfCheckGit({ realGit, cwd: root, config });
    assert.equal(waivedRes.ok, true, `after restoring HEAD state and waiving ${badSha7}, self-check must pass: ${waivedRes.violations.join('; ')}`);
    assert.equal(waivedRes.waivers.length, 1);
    assert.equal(waivedRes.waivers[0].sha7, badSha7);

    // 5. Post-review check in loop forbids adding a new WAIVER line
    const beforeReviewSha = g('rev-parse', 'HEAD');
    writeFileSync(
      path.join(root, 'PLAN.md'),
      planWithWaiver.replace(
        `- WAIVER ${badSha7}: fix-frozen — user approved historical commit`,
        `- WAIVER ${badSha7}: fix-frozen — user approved historical commit\n- WAIVER 1234567: fix-frozen — unauthorized loop waiver`,
      ),
    );
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: accept T-001');

    const postRev = checkPostReviewSelfCheck({ realGit, cwd: root, baseSha: beforeReviewSha, config });
    assert.equal(postRev.ok, false);
    assert.match(postRev.violations.join('\n'), /WAIVER/i);

    const selfcheckLines = readFileSync(path.join(orchDir, 'selfcheck.mjs'), 'utf8').split('\n').length;
    assert.ok(selfcheckLines <= 400, `selfcheck.mjs must stay <= 400 lines (got ${selfcheckLines})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-046: live repository eval-fixtures.mjs preserves all EVAL_FIXTURE_ANCHORS and parseWaivers parses Decisions section', () => {
  const fixturesText = readFileSync(path.join(orchDir, 'eval-fixtures.mjs'), 'utf8');
  for (const anchor of EVAL_FIXTURE_ANCHORS) {
    assert.ok(fixturesText.includes(anchor), `eval-fixtures.mjs missing anchor: ${anchor}`);
  }
  const waivers = parseWaivers('# PLAN\n\n## Decisions (ADR)\n- WAIVER abc1234: fix-frozen — test reason\n\n## Задачи\n');
  assert.equal(waivers.length, 1);
  assert.deepEqual(waivers[0], {
    sha7: 'abc1234',
    rule: 'fix-frozen',
    reason: 'test reason',
    raw: '- WAIVER abc1234: fix-frozen — test reason',
  });
});
