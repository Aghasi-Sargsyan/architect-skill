// T-128 reference test (Frozen): --audit-plan is removed; an old "auditor" config key is ignored with a note (C-40, ADR-075).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli.mjs';
import * as config from './config.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(orchDir, '../../../..');
const moduleSources = () => readdirSync(orchDir)
  .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
  .map((n) => ({ name: n, text: readFileSync(path.join(orchDir, n), 'utf8') }));

test('C-40: audit.mjs is gone and no orchestrator module refers to the plan audit', () => {
  assert.equal(existsSync(path.join(orchDir, 'audit.mjs')), false, 'audit.mjs must be deleted');
  for (const { name, text } of moduleSources()) {
    for (const needle of ['./audit.mjs', 'runPlanAudit', 'checkAuditCoverage', 'rejectedBlockers', 'auditPlan', 'auditor claude']) {
      assert.equal(text.includes(needle), false, `${name} still contains "${needle}"`);
    }
  }
});

test('C-40: --audit-plan is rejected with a clear removal message', () => {
  assert.throws(() => parseArgs(['--audit-plan']), /--audit-plan was removed in v3\.55 \(ADR-075\)/);
  assert.equal(parseArgs(['--self-check']).selfCheck, true);
});

test('C-40: an old "auditor" key is accepted and reported as ignored instead of failing the config', () => {
  assert.equal(typeof config.deprecatedConfigNotes, 'function', 'config.mjs must export deprecatedConfigNotes');
  const legacy = config.withDefaults({ auditor: { runner: 'agy', model: '' } });
  assert.deepEqual(config.validateConfig(legacy).filter((p) => /auditor/.test(p)), []);
  assert.deepEqual(config.validateLocalConfig({ auditor: 'anything' }).filter((p) => /auditor/.test(p)), []);

  const notes = config.deprecatedConfigNotes(legacy);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^auditor: ignored — --audit-plan was removed in v3\.55 \(ADR-075\)/);
  assert.deepEqual(config.deprecatedConfigNotes(config.withDefaults({})), []);
});

test('C-40: --check prints the deprecation notes, and AGENTS.md no longer documents --audit-plan', () => {
  const check = readFileSync(path.join(orchDir, 'check.mjs'), 'utf8');
  assert.match(check, /deprecatedConfigNotes\(/, 'runCheckCommand must print deprecatedConfigNotes(config) as "! " lines');
  const agents = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.equal(agents.includes('--audit-plan'), false, 'AGENTS.md must not document --audit-plan');
  assert.doesNotMatch(agents, /[{,]audit,/, 'audit.mjs must leave the AGENTS.md §5 high-risk list');
});
