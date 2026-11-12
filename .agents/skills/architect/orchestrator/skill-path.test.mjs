import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as layoutMod from './layout.mjs';
import { architectPrompt } from './prompts.mjs';
import { askPermission, writeAnswer } from './ask.mjs';
import { runSelfCheckGit } from './selfcheck.mjs';
import { which } from './guards.mjs';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const realGit = which('git');
const HARDCODED_SKILL_PATH = '.agents/' + 'skills/architect';

test('T-051: layout.mjs, prompts.mjs, ask.mjs, and selfcheck.mjs contain no hardcoded .agents/skills/architect path and resolve paths from orchestratorDir', () => {
  for (const modFile of ['layout.mjs', 'prompts.mjs', 'ask.mjs', 'selfcheck.mjs']) {
    const src = readFileSync(path.join(orchDir, modFile), 'utf8');
    assert.equal(
      src.includes(HARDCODED_SKILL_PATH),
      false,
      `${modFile} must not hardcode ${HARDCODED_SKILL_PATH}`,
    );
  }

  assert.equal(typeof layoutMod.isSkillAtWorkDirRoot, 'function', 'layout.mjs must export isSkillAtWorkDirRoot');
  assert.equal(typeof layoutMod.resolveInstalledSkillDir, 'function', 'layout.mjs must export resolveInstalledSkillDir');

  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skill-path-t051-')));
  try {
    // 1. Skill installed in .claude/skills/architect/
    const claudeSkillDir = path.join(tmp, '.claude', 'skills', 'architect');
    const claudeOrchDir = path.join(claudeSkillDir, 'orchestrator');
    mkdirSync(path.join(claudeSkillDir, 'references'), { recursive: true });
    mkdirSync(claudeOrchDir, { recursive: true });
    writeFileSync(path.join(claudeSkillDir, 'SKILL.md'), '# Architect Prompt v3.27\n');
    writeFileSync(path.join(claudeSkillDir, 'EXECUTOR.md'), '<!-- executor-policy-version: 1.8 -->\n');

    assert.equal(layoutMod.isSkillAtWorkDirRoot(tmp, claudeOrchDir), false);
    assert.equal(layoutMod.resolveInstalledSkillDir(tmp, claudeOrchDir), claudeSkillDir);

    const frozen = layoutMod.alwaysFrozenFiles('.architect/config.json', { workDir: tmp, orchestratorDir: claudeOrchDir });
    assert.ok(frozen.includes('.claude/skills/architect/SKILL.md'));
    assert.ok(frozen.includes('.claude/skills/architect/EXECUTOR.md'));
    assert.ok(frozen.includes('.claude/skills/architect/MAINTAINING.md'));
    assert.equal(frozen.some((f) => f.startsWith(HARDCODED_SKILL_PATH)), false, 'must not include hardcoded .agents/skills/architect when installed in .claude');

    assert.equal(
      layoutMod.isAlwaysFrozenFile('.claude/skills/architect/references/retro.md', { workDir: tmp, orchestratorDir: claudeOrchDir }),
      true,
    );

    // 2. Skill at repository root (workDir === skillDir): isAlwaysFrozenFile and alwaysFrozenFiles behave consistently (neither freezes root *.md)
    const rootOrchDir = path.join(tmp, 'orchestrator');
    mkdirSync(rootOrchDir, { recursive: true });
    assert.equal(layoutMod.isSkillAtWorkDirRoot(tmp, rootOrchDir), true);
    assert.equal(
      layoutMod.isAlwaysFrozenFile('README.md', { workDir: tmp, orchestratorDir: rootOrchDir }),
      false,
      'skill at repo root must not freeze arbitrary root README.md in isAlwaysFrozenFile',
    );
    assert.equal(
      layoutMod.isAlwaysFrozenFile('references/retro.md', { workDir: tmp, orchestratorDir: rootOrchDir }),
      false,
      'skill at repo root must not freeze root references/ in isAlwaysFrozenFile',
    );

    // 3. architectPrompt derives default skillPath from orchestratorDir when skillPath is omitted
    const promptText = architectPrompt(
      { id: 'T-001', title: 'Test' },
      'Report',
      'Passed: YES',
      'gemini-3.8-flash-high',
      { planPath: 'PLAN.md', workDir: tmp, orchestratorDir: claudeOrchDir },
    );
    assert.match(promptText, /\.claude\/skills\/architect\/SKILL\.md/);
    assert.match(promptText, /\.claude\/skills\/architect\/references\/auto-review\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-051: askPermission hint and selfcheck.mjs config.example.json monotonicity work with skill installed in .claude/skills/architect/', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'skill-claude-t051-')));
  const g = (...args) => execFileSync(realGit, args, { cwd: tmp, encoding: 'utf8' }).trim();
  try {
    g('init', '-q', '-b', 'master');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.invalid');

    const claudeOrchDir = path.join(tmp, '.claude', 'skills', 'architect', 'orchestrator');
    const runDir = path.join(tmp, '.agent-runs', 'run-1');
    mkdirSync(claudeOrchDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });

    // Answer right after the question is written: its id gets a random suffix (C-13), so an answer written in advance never matches
    const logs = [];
    const qId = 'q-claude-1';
    setTimeout(() => writeAnswer({ workDir: tmp, answer: '2' }), 30);
    const ans = await askPermission(
      {
        id: qId,
        command: 'pytest',
        options: [
          { answer: '1', label: 'Always', rule: 'pytest' },
          { answer: '2', label: 'Once', rule: 'pytest' },
          { answer: '3', label: 'No', rule: null },
        ],
      },
      {
        workDir: tmp,
        runDir,
        orchestratorDir: claudeOrchDir,
        timeoutMs: 2000,
        pollMs: 10,
        log: (msg) => logs.push(msg),
      },
    );
    assert.equal(ans.allow, true);
    assert.ok(
      logs.some((m) => m.includes('node .claude/skills/architect/orchestrator/run.mjs --answer')),
      `expected .claude hint in logs, got: ${logs.join('\n')}`,
    );

    // Self-check monotonicity & fix-frozen protection on .claude/skills/architect/orchestrator/config.example.json
    const cfgExampleRel = '.claude/skills/architect/orchestrator/config.example.json';
    writeFileSync(
      path.join(tmp, cfgExampleRel),
      JSON.stringify({ bypassScanPaths: ['src', 'tests'], bypassPatterns: ['a', 'b'], protectedConfigFiles: ['package.json'], blockedNpmScripts: [] }, null, 2),
    );
    writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n');
    g('add', cfgExampleRel, 'PLAN.md');
    g('commit', '-q', '-m', 'arch: close cycle 1');

    writeFileSync(path.join(tmp, 'PLAN.md'), '# PLAN\n\n## Frozen\n- `EXECUTOR.md`\n\n## Tasks\n- [ ] T-001: x\n  - Change: `src/a.js`\n');
    g('add', 'PLAN.md');
    g('commit', '-q', '-m', 'arch: plan cycle 2');

    // Drop element 'b' from bypassPatterns in .claude/.../config.example.json without fix-frozen
    writeFileSync(
      path.join(tmp, cfgExampleRel),
      JSON.stringify({ bypassScanPaths: ['src', 'tests'], bypassPatterns: ['a'], protectedConfigFiles: ['package.json'], blockedNpmScripts: [] }, null, 2),
    );
    g('add', cfgExampleRel);
    g('commit', '-q', '-m', 'arch: weaken claude config example');

    const res = runSelfCheckGit({ realGit, cwd: tmp, config: { bypassScanPaths: ['src'] }, orchestratorDir: claudeOrchDir });
    assert.equal(res.ok, false);
    assert.ok(
      res.violations.some((v) => v.includes(cfgExampleRel) && v.includes('bypassPatterns')),
      `expected monotonicity violation on ${cfgExampleRel}, got: ${res.violations.join('; ')}`,
    );
    assert.ok(
      res.violations.some((v) => v.includes('fix-frozen') && v.includes(cfgExampleRel)),
      `expected fix-frozen violation on ${cfgExampleRel}, got: ${res.violations.join('; ')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
