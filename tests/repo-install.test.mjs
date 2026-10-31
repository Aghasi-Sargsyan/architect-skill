import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const skillDir = path.join(repoRoot, '.agents', 'skills', 'architect');

test('repository installation: root EXECUTOR.md is a byte-for-byte copy of skill EXECUTOR.md, READMEs are synced, and AGENTS.md documents orchestrator flags and cross-Node tests', () => {
  const rootExecutor = readFileSync(path.join(repoRoot, 'EXECUTOR.md'), 'utf8');
  const skillExecutor = readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8');
  assert.equal(rootExecutor, skillExecutor, 'root EXECUTOR.md must match .agents/skills/architect/EXECUTOR.md byte-for-byte');

  const skillText = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const readmeRu = readFileSync(path.join(skillDir, 'README.ru.md'), 'utf8');
  const readmeEn = readFileSync(path.join(skillDir, 'README.en.md'), 'utf8');
  const skillVer = skillText.match(/^#\s+Architect Prompt (v\d+\.\d+)/m)?.[1];
  const execVer = skillExecutor.match(/^<!--\s*executor-policy-version:\s*(\d+\.\d+)\s*-->/)?.[1];
  assert.ok(skillVer, 'SKILL.md must declare version');
  assert.ok(execVer, 'EXECUTOR.md must declare policy version');
  assert.equal(readmeRu.split('\n')[0]?.trim(), `<!-- skill-readme-sync: ${skillVer} / ${execVer} -->`);
  assert.equal(readmeEn.split('\n')[0]?.trim(), `<!-- skill-readme-sync: ${skillVer} / ${execVer} -->`);

  const agentsText = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(agentsText, /--check/);
  assert.match(agentsText, /--self-check/);
  assert.match(agentsText, /--audit-plan/);
  assert.ok(
    agentsText.includes('node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs'),
    'AGENTS.md must document the direct cross-Node test command',
  );
});

test('repository installation: ci.yml specifies fetch-depth 0 in actions/checkout step', () => {
  const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
  const ciText = readFileSync(ciPath, 'utf8');
  const stepBlocks = ciText.split(/\n\s*-\s+/);
  const checkoutStep = stepBlocks.find((step) => /uses:\s*actions\/checkout@/.test(step));
  assert.ok(checkoutStep, 'ci.yml must contain an actions/checkout step');
  assert.match(
    checkoutStep,
    /with:[\s\S]*?\bfetch-depth:\s*0\b/,
    'actions/checkout step in ci.yml must configure fetch-depth: 0 under with:',
  );
});

test('repository installation: root LICENSE matches skill LICENSE byte-for-byte and root README.md links to guides and LICENSE', () => {
  const rootLicense = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
  const skillLicense = readFileSync(path.join(skillDir, 'LICENSE'), 'utf8');
  assert.equal(rootLicense, skillLicense, 'root LICENSE must match .agents/skills/architect/LICENSE byte-for-byte');

  const rootReadme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(rootReadme.trim().length > 0, 'root README.md must not be empty');
  assert.ok(rootReadme.split('\n').length <= 80, 'root README.md must be <= 80 lines');
  assert.match(
    rootReadme,
    /\.agents\/skills\/architect\/README\.en\.md/,
    'root README.md must link to skill README.en.md',
  );
  assert.match(
    rootReadme,
    /\.agents\/skills\/architect\/README\.ru\.md/,
    'root README.md must link to skill README.ru.md',
  );
  assert.match(rootReadme, /LICENSE/, 'root README.md must reference LICENSE');
});

test('repository installation: sanitized historical stage-4 plan contains no local absolute home path', () => {
  const stage4Path = path.join(repoRoot, 'docs', 'plans', '2026-10-31-stage-4-pre-publication.md');
  const stage4Plan = readFileSync(stage4Path, 'utf8');
  const forbiddenHomePath = ['', 'Users', 'aghasi'].join('/');
  assert.equal(
    stage4Plan.includes(forbiddenHomePath),
    false,
    'docs/plans/2026-10-31-stage-4-pre-publication.md must not contain local absolute home path',
  );
  assert.match(
    stage4Plan,
    /<local-home-path>/,
    'docs/plans/2026-10-31-stage-4-pre-publication.md must use <local-home-path> placeholder',
  );
});

