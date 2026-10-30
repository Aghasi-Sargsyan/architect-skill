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
