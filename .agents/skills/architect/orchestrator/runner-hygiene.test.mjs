// T-129 reference test (Frozen): Claude Code flag support, duplicate prompt phrases, and the --dry-run prompt file (C-44, C-45, ADR-079).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from './adapters/claude.mjs';
import * as prompts from './prompts.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const FLAGS = ['--output-format', '--json-schema', '--setting-sources', '--settings', '--permission-mode', '--permission-prompts', '--session-id', '--resume'];
const helpFor = (flags) => ['Usage: claude [options] [prompt]', '', 'Options:', ...flags.map((f) => `  ${f} <value>   description of ${f}`), ''].join('\n');

function withFakeClaude(helpText, helpExit, fn) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runner-hygiene-')));
  try {
    const helpFile = path.join(tmp, 'help.txt');
    writeFileSync(helpFile, helpText);
    const bin = path.join(tmp, 'claude');
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.308 (Claude Code)"; exit 0;;\n  --help) cat "${helpFile}"; exit ${helpExit};;\nesac\nexit 2\n`);
    chmodSync(bin, 0o755);
    return fn(bin, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('C-44: REQUIRED_CLAUDE_FLAGS lists the flags runClaudeAgent passes', () => {
  assert.ok(Array.isArray(claude.REQUIRED_CLAUDE_FLAGS), 'adapters/claude.mjs must export REQUIRED_CLAUDE_FLAGS');
  assert.deepEqual([...claude.REQUIRED_CLAUDE_FLAGS].sort(), [...FLAGS].sort());
  const src = readFileSync(path.join(orchDir, 'adapters', 'claude.mjs'), 'utf8');
  for (const f of FLAGS) assert.ok(src.includes(`'${f}'`), `runClaudeAgent must pass ${f}`);
});

test('C-44: checkClaudeEnv accepts a CLI whose --help lists every required flag', () => {
  withFakeClaude(helpFor(FLAGS), 0, (bin) => {
    assert.deepEqual(claude.checkClaudeEnv(bin), { ok: true, issues: [] });
  });
});

test('C-44: checkClaudeEnv names exactly the missing flags, matching whole flags only', () => {
  withFakeClaude(helpFor(FLAGS.filter((f) => f !== '--permission-prompts')), 0, (bin) => {
    const res = claude.checkClaudeEnv(bin);
    assert.equal(res.ok, false);
    assert.equal(res.issues.length, 1);
    assert.match(res.issues[0], /--permission-prompts/);
    assert.doesNotMatch(res.issues[0], /--permission-mode/);
    assert.match(res.issues[0], /update Claude Code/i);
  });
  const withoutSettings = helpFor(FLAGS.filter((f) => f !== '--settings')) + '  --settings-file <path>   not the same flag\n';
  withFakeClaude(withoutSettings, 0, (bin) => {
    const res = claude.checkClaudeEnv(bin);
    assert.equal(res.ok, false);
    assert.ok(res.issues[0].includes('--settings'), res.issues[0]);
    assert.equal(res.issues[0].includes('--setting-sources'), false, '--setting-sources is present and must not be reported');
  });
});

test('C-44: checkClaudeEnv fails closed when --help cannot run', () => {
  withFakeClaude(helpFor(FLAGS), 1, (bin) => {
    const res = claude.checkClaudeEnv(bin);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => /--help/.test(i)), res.issues.join('\n'));
  });
});

test('C-45: refusal and resume prompts carry each phrase once', () => {
  const refusal = prompts.autoRefusalPrompt('executor', { command: 'git -C x status', reason: 'leading flag', suggestedCommand: 'git status' });
  assert.equal(refusal.split('The restriction applies only').length - 1, 1, refusal);
  const resume = prompts.resumePrompt('executor', { command: 'npm run lint', rule: 'npm run lint' });
  assert.equal(resume.split('command(npm run lint)').length - 1, 1, resume);
  assert.equal(resume.includes('was allowed (rule'), false, resume);
});

test('C-45: writeDryRunPrompt stores the full Executor prompt under .agent-runs and returns its path and size', () => {
  assert.equal(typeof prompts.writeDryRunPrompt, 'function', 'prompts.mjs must export writeDryRunPrompt');
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dry-run-prompt-')));
  try {
    const text = 'Role: Executor\nЗадача T-007\n';
    const res = prompts.writeDryRunPrompt({ workDir: tmp, taskId: 'T-007', text });
    assert.deepEqual(res, { relPath: '.agent-runs/dry-run-prompt-T-007.md', chars: text.length });
    assert.equal(readFileSync(path.join(tmp, '.agent-runs', 'dry-run-prompt-T-007.md'), 'utf8'), text);
    for (const bad of ['../T-007', 'T-7', 'T-007/../../x', '']) {
      assert.throws(() => prompts.writeDryRunPrompt({ workDir: tmp, taskId: bad, text }), /task id/i);
    }
    assert.equal(existsSync(path.join(tmp, 'x')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('C-45: --dry-run prints the prompt file path instead of the whole prompt', () => {
  const run = readFileSync(path.join(orchDir, 'run.mjs'), 'utf8');
  assert.match(run, /writeDryRunPrompt\(/, 'run.mjs must write the dry-run prompt through writeDryRunPrompt');
  assert.doesNotMatch(run, /console\.log\(`[^`]*\$\{executorPrompt\(/, 'run.mjs must not print the whole Executor prompt');
});
