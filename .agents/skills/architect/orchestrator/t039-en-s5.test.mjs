import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatTranscriptRow, printStatus } from './feed.mjs';
import { classifyStopReason, formatWebhookBody } from './events.mjs';
import { installGuards, writeGitShim } from './guards.mjs';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

test('T-039 (D5, S5): feed.mjs formats transcript rows and status in English while keeping bilingual verdict regex', () => {
  const row = {
    type: 'PLANNER_RESPONSE',
    created_at: '2026-10-29T12:00:00Z',
    thinking: 'Checking contract',
    content: 'All good',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
  };
  const lines = formatTranscriptRow(row);
  assert.doesNotMatch(lines.join('\n'), CYRILLIC_RE);
  assert.match(lines.join('\n'), /\[thoughts\] Checking contract/);
  assert.match(lines.join('\n'), /\[answer\] All good/);

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-t039-feed-')));
  try {
    mkdirSync(path.join(tmp, '.agent-runs'), { recursive: true });
    writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Tasks\n- [x] T-001: Done\n- [ ] T-002: Next\n');
    const chunks = [];
    const out = { write: (s) => chunks.push(String(s)) };
    const st = printStatus({ workDir: tmp, planPath: 'PLAN.md', out });
    assert.equal(st.running, false);
    assert.doesNotMatch(chunks.join(''), CYRILLIC_RE);
    assert.match(chunks.join(''), /Status:\s+STOPPED/);
    assert.match(chunks.join(''), /Progress:\s+1\/2 accepted/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-039 (D5, S5): events.mjs classifies both English and Russian stop reasons and formats English notifications', () => {
  assert.equal(classifyStopReason('T-001 escalated by Executor: contract gap'), 'stop_escalation');
  assert.equal(classifyStopReason('T-001: Architect requests user decision — check API'), 'stop_needs_user');
  assert.equal(classifyStopReason('T-001: permission confirmation timeout'), 'stop_permission_timeout');
  assert.equal(classifyStopReason('T-001: mechanics violation (attempt 2/2)'), 'stop_mechanics');
  assert.equal(classifyStopReason('Done: all planned tasks accepted'), 'all_accepted');

  // Backward compatibility with Russian stop reasons
  assert.equal(classifyStopReason('T-001 эскалирована Исполнителем'), 'stop_escalation');
  assert.equal(classifyStopReason('Готово: все задачи плана приняты'), 'all_accepted');

  const bodyEn = formatWebhookBody({
    event: 'task_accepted',
    taskId: 'T-001',
    message: 'Architect: accepted (commit 1234567)',
  });
  assert.equal(bodyEn.commit, '1234567');
});

test('T-039 (D5, S5): guards.mjs and run.mjs contain no Cyrillic in source diagnostics', () => {
  assert.throws(
    () => writeGitShim({ shimDir: '/tmp', realGit: 'git', sandboxRoot: '/tmp' }),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /realGit.*absolute/i);
      return true;
    },
  );
  assert.throws(
    () => installGuards({ workDir: '/tmp', shimDir: '/tmp', realGit: 'relative/git' }),
    (err) => {
      assert.doesNotMatch(err.message, CYRILLIC_RE);
      assert.match(err.message, /realGit.*absolute/i);
      return true;
    },
  );

  const runSrc = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runSrc, CYRILLIC_RE, 'run.mjs must contain no Cyrillic');
  const guardsSrc = readFileSync(new URL('./guards.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(guardsSrc, CYRILLIC_RE, 'guards.mjs must contain no Cyrillic');
});
