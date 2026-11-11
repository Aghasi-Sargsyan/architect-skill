import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli.mjs';
import { findEmptyCatches } from './selfcheck.mjs';
import {
  extractEffort,
  resolveArchitectModelInfo,
  listAvailableModels,
  setRoleModel,
  handleModelsCli,
} from './models.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
let prevAgentLoop;
beforeEach(() => {
  prevAgentLoop = process.env.AGENT_LOOP;
  delete process.env.AGENT_LOOP;
});
afterEach(() => {
  if (prevAgentLoop === undefined) delete process.env.AGENT_LOOP;
  else process.env.AGENT_LOOP = prevAgentLoop;
});

test('T-082: parseArgs parses --models, --set-model <role> <model>, and --local with validation and mode mutual exclusion', () => {
  const m = parseArgs(['--models']);
  assert.equal(m.models, true);
  assert.equal(m.setModel, null);
  assert.equal(m.local, false);

  const smExec = parseArgs(['--set-model', 'executor', 'gemini-3.8-flash-high']);
  assert.deepEqual(smExec.setModel, { role: 'executor', model: 'gemini-3.8-flash-high' });
  assert.equal(smExec.local, false);

  const smArchLocal = parseArgs(['--set-model', 'architect', 'gemini-4-argon-high', '--local']);
  assert.deepEqual(smArchLocal.setModel, { role: 'architect', model: 'gemini-4-argon-high' });
  assert.equal(smArchLocal.local, true);

  assert.throws(() => parseArgs(['--set-model']), /--set-model requires <executor\|architect> <model>/i);
  assert.throws(() => parseArgs(['--set-model', 'executor']), /--set-model requires <executor\|architect> <model>/i);
  assert.throws(() => parseArgs(['--set-model', 'executor', '--local']), /--set-model requires <executor\|architect> <model>/i);
  assert.throws(() => parseArgs(['--set-model', 'reviewer', 'gemini-3.8-flash-high']), /--set-model role must be executor or architect/i);
  assert.throws(() => parseArgs(['--local']), /--local is allowed only with --set-model/i);
  assert.throws(() => parseArgs(['--models', '--local']), /--local is allowed only with --set-model/i);
  assert.throws(() => parseArgs(['--models', '--check']), /only one/i);
  assert.throws(() => parseArgs(['--set-model', 'executor', 'gemini-3.8-flash-high', '--update']), /only one/i);
});

test('T-082: extractEffort, resolveArchitectModelInfo, and listAvailableModels resolve role state and models with efforts', async () => {
  assert.equal(extractEffort({ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }), 'high');
  assert.equal(extractEffort({ id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' }), 'medium');
  assert.equal(extractEffort({ id: 'gemini-4-argon-low', name: 'Gemini 4 Argon' }), 'low');
  assert.equal(extractEffort({ id: 'sonnet', name: 'Claude Sonnet' }), null);

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-models-info-')));
  try {
    const emptyInfo = resolveArchitectModelInfo({ workDir: tmp });
    assert.equal(emptyInfo.ok, false);
    assert.equal(emptyInfo.model, null);

    mkdirSync(path.join(tmp, '.agents'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.agents', 'orchestrator.json'),
      JSON.stringify({ executor: { model: 'gemini-3.8-flash-high' }, architect: { model: 'gemini-4-argon-high' } }, null, 2),
    );
    const sharedInfo = resolveArchitectModelInfo({ workDir: tmp });
    assert.equal(sharedInfo.ok, true);
    assert.equal(sharedInfo.model, 'gemini-4-argon-high');
    assert.equal(sharedInfo.source, '.agents/orchestrator.json');

    writeFileSync(
      path.join(tmp, '.agents', 'orchestrator.local.json'),
      JSON.stringify({ architect: { model: 'claude-opus-5-5-high' } }, null, 2),
    );
    const localInfo = resolveArchitectModelInfo({ workDir: tmp });
    assert.equal(localInfo.ok, true);
    assert.equal(localInfo.model, 'claude-opus-5-5-high');
    assert.equal(localInfo.source, '.agents/orchestrator.local.json');

    const listed = await listAvailableModels({
      workDir: tmp,
      listRunnerModels: () => [
        { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      ],
    });
    assert.equal(listed.runner, 'agy');
    assert.equal(listed.models.length, 3);
    assert.deepEqual(listed.models[2], {
      id: 'gemini-3.8-flash-high',
      name: 'Gemini 3.8 Flash (High)',
      effort: 'high',
      runner: 'agy',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-082: setRoleModel and handleModelsCli update shared or local configs and sync AGENTS.md / .claude/agents/executor.md', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arch-models-set-')));
  try {
    assert.throws(() => setRoleModel({ workDir: tmp, role: 'invalid', model: 'gemini-3.8-flash-high' }), /role must be "executor" or "architect"/i);
    assert.throws(() => setRoleModel({ workDir: tmp, role: 'executor', model: '' }), /non-empty model/i);
    assert.throws(() => setRoleModel({ workDir: tmp, role: 'executor', model: 'inherit' }), /not "inherit"/i);
    assert.throws(() => setRoleModel({ workDir: tmp, role: 'executor', model: '<model>' }), /non-empty model/i);

    await assert.rejects(
      async () => {
        const prev = process.env.AGENT_LOOP;
        process.env.AGENT_LOOP = '1';
        try {
          await handleModelsCli({ workDir: tmp, opts: { models: true } });
        } finally {
          if (prev === undefined) delete process.env.AGENT_LOOP;
          else process.env.AGENT_LOOP = prev;
        }
      },
      /AGENT_LOOP=1/,
    );

    mkdirSync(path.join(tmp, '.agents'), { recursive: true });
    mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.agents', 'orchestrator.json'),
      JSON.stringify({ executor: { model: 'gemini-3.8-flash-low' }, architect: { model: 'gemini-4-argon-low' } }, null, 2) + '\n',
    );
    writeFileSync(
      path.join(tmp, 'AGENTS.md'),
      '# Rules\n- **Executor model:** `gemini-3.8-flash-low`\n',
    );
    writeFileSync(
      path.join(tmp, '.claude', 'agents', 'executor.md'),
      '---\nname: executor\nmodel: gemini-3.8-flash-low\n---\nPrompt\n',
    );

    const execRes = setRoleModel({ workDir: tmp, role: 'executor', model: 'gemini-3.8-flash-high' });
    assert.equal(execRes.ok, true);
    assert.equal(execRes.role, 'executor');
    assert.equal(execRes.model, 'gemini-3.8-flash-high');
    assert.ok(execRes.updatedFiles.includes('.agents/orchestrator.json'));
    assert.ok(execRes.updatedFiles.includes('AGENTS.md'));
    assert.ok(execRes.updatedFiles.includes('.claude/agents/executor.md'));

    const cfgAfterExec = JSON.parse(readFileSync(path.join(tmp, '.agents', 'orchestrator.json'), 'utf8'));
    assert.equal(cfgAfterExec.executor.model, 'gemini-3.8-flash-high');
    assert.equal(cfgAfterExec.architect.model, 'gemini-4-argon-low');
    assert.match(readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8'), /gemini-3\.8-flash-high/);
    assert.match(readFileSync(path.join(tmp, '.claude', 'agents', 'executor.md'), 'utf8'), /^model: gemini-3\.8-flash-high$/m);

    const archRes = setRoleModel({ workDir: tmp, role: 'architect', model: 'claude-opus-5-5-high' });
    assert.equal(archRes.ok, true);
    const cfgAfterArch = JSON.parse(readFileSync(path.join(tmp, '.agents', 'orchestrator.json'), 'utf8'));
    assert.equal(cfgAfterArch.architect.model, 'claude-opus-5-5-high');
    assert.equal(cfgAfterArch.executor.model, 'gemini-3.8-flash-high');

    const localRes = setRoleModel({ workDir: tmp, role: 'executor', model: 'claude-sonnet-5-5-medium', local: true });
    assert.equal(localRes.ok, true);
    assert.deepEqual(localRes.updatedFiles, ['.agents/orchestrator.local.json']);
    assert.equal(existsSync(path.join(tmp, '.agents', 'orchestrator.local.json')), true);
    const localCfg = JSON.parse(readFileSync(path.join(tmp, '.agents', 'orchestrator.local.json'), 'utf8'));
    assert.equal(localCfg.executor.model, 'claude-sonnet-5-5-medium');
    // Shared config remains unchanged when --local is used
    const sharedStill = JSON.parse(readFileSync(path.join(tmp, '.agents', 'orchestrator.json'), 'utf8'));
    assert.equal(sharedStill.executor.model, 'gemini-3.8-flash-high');

    const lines = [];
    const cliOut = await handleModelsCli({
      workDir: tmp,
      opts: { models: true },
      listRunnerModels: () => [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
        { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
      ],
      print: (msg) => lines.push(msg),
    });
    assert.equal(cliOut.ok, true);
    assert.equal(cliOut.current.executor.model, 'claude-sonnet-5-5-medium');
    assert.equal(cliOut.current.architect.model, 'claude-opus-5-5-high');
    assert.match(lines.join('\n'), /executor:\s+claude-sonnet-5-5-medium/i);
    assert.match(lines.join('\n'), /architect:\s+claude-opus-5-5-high/i);
    assert.match(lines.join('\n'), /1\.\s+gemini-3\.8-flash-high\s+Gemini 3\.8 Flash \(High\)/);

    const runMjs = path.join(orchDir, 'run.mjs');
    const { AGENT_LOOP: _al, ...cleanEnv } = process.env;
    const spawned = spawnSync(
      process.execPath,
      [runMjs, '--set-model', 'architect', 'gemini-4-argon-high'],
      { cwd: tmp, env: cleanEnv, encoding: 'utf8' },
    );
    assert.equal(spawned.status, 0, `run.mjs --set-model failed: ${spawned.stdout}\n${spawned.stderr}`);
    assert.match(spawned.stdout, /architect\.model set to gemini-4-argon-high/);

    for (const file of ['models.mjs', 'cli.mjs', 'run.mjs']) {
      const text = readFileSync(path.join(orchDir, file), 'utf8');
      const count = text.split('\n').length;
      assert.ok(count <= 400, `${file} must stay <= 400 lines (got ${count})`);
      assert.deepEqual(findEmptyCatches(text), [], `${file} must have no empty catch blocks`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
