import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';
import { localChecks } from './check.mjs';
import * as cliMod from './cli.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));

test('T-050: nodeVersionProblem returns exact diagnostic for < 22 and null for 22+, and localChecks requires Node 22+', () => {
  assert.equal(typeof cliMod.nodeVersionProblem, 'function', 'cli.mjs must export nodeVersionProblem(version)');

  assert.equal(
    cliMod.nodeVersionProblem('20.19.0'),
    'Node v20.19.0: the orchestrator requires Node 22+; skill rules and manual Executor handoff work without it',
  );
  assert.equal(
    cliMod.nodeVersionProblem('v20.19.0'),
    'Node v20.19.0: the orchestrator requires Node 22+; skill rules and manual Executor handoff work without it',
  );
  assert.equal(cliMod.nodeVersionProblem('22.0.0'), null);
  assert.equal(cliMod.nodeVersionProblem('v24.0.0'), null);

  const checks20 = localChecks({
    config: DEFAULTS,
    workDir: orchDir,
    realGit: 'git',
    platform: 'darwin',
    nodeVersion: '20.19.0',
  });
  const node20 = checks20.find((c) => c.name === 'Node.js');
  assert.ok(node20, 'localChecks must include Node.js entry');
  assert.equal(node20.ok, false, 'Node 20.19.0 must fail localChecks');
  assert.match(node20.detail, /requires 22\+/, 'Node.js detail must state requires 22+');

  const checks22 = localChecks({
    config: DEFAULTS,
    workDir: orchDir,
    realGit: 'git',
    platform: 'darwin',
    nodeVersion: '22.0.0',
  });
  const node22 = checks22.find((c) => c.name === 'Node.js');
  assert.ok(node22);
  assert.equal(node22.ok, true, 'Node 22.0.0 must pass localChecks');
});

test('T-050: run.mjs checks nodeVersionProblem right after parseArgs before config loading, keeps runFastSelfCheck before --background, and modules stay <= 400 lines', () => {
  const runText = readFileSync(path.join(orchDir, 'run.mjs'), 'utf8');
  const mainStart = runText.indexOf('async function main()');
  assert.ok(mainStart !== -1, 'run.mjs must define async function main()');
  const mainBody = runText.slice(mainStart);

  const parseIdx = mainBody.indexOf('parseArgs(');
  const nodeProbIdx = mainBody.indexOf('nodeVersionProblem(');
  const resolveCfgIdx = mainBody.indexOf('resolveConfigPath(');
  const safeLoadIdx = mainBody.indexOf('safeLoadConfig(');
  const fastScIdx = mainBody.indexOf('runFastSelfCheck(');
  const bgIdx = mainBody.indexOf('if (opts.background)');

  assert.ok(parseIdx !== -1, 'main() must call parseArgs');
  assert.ok(nodeProbIdx !== -1, 'main() must call nodeVersionProblem');
  assert.ok(nodeProbIdx > parseIdx, 'nodeVersionProblem must be called after parseArgs');
  assert.ok(resolveCfgIdx > nodeProbIdx, 'nodeVersionProblem must run before resolveConfigPath (gating --init and all modes)');
  assert.ok(safeLoadIdx > nodeProbIdx, 'nodeVersionProblem must run before safeLoadConfig');
  assert.ok(fastScIdx > nodeProbIdx && fastScIdx < bgIdx, 'runFastSelfCheck must run after nodeVersionProblem and before if (opts.background)');

  for (const modName of ['check.mjs', 'cli.mjs', 'run.mjs']) {
    const lineCount = readFileSync(path.join(orchDir, modName), 'utf8').split('\n').length;
    assert.ok(lineCount <= 400, `${modName} must stay <= 400 lines (got ${lineCount})`);
  }
});
