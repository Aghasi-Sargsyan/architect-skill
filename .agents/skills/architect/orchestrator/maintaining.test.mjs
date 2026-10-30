import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(orchDir);

/**
 * Validates version markers, README section structure, EXECUTOR.md copy identity,
 * and (once MAINTAINING.md is present / v3.21+) decoupling invariants C1-C3, C5, E1.
 */
export function checkSkillMaintenance({
  skillText,
  executorText,
  projectExecutorText = null,
  readmeRuText,
  readmeEnText,
  maintainingText = null,
  requireStepA1 = false,
}) {
  const problems = [];

  const skillVer = skillText.match(/^# (?:Промт Архитектора|Architect Prompt) (v\d+\.\d+)/m)?.[1] ?? null;
  if (!skillVer) problems.push('SKILL.md: не найден заголовок версии (vX.Y)');

  const execVer = executorText.split('\n')[0]?.match(/^<!-- executor-policy-version: (\d+\.\d+) -->$/)?.[1] ?? null;
  if (!execVer) problems.push('EXECUTOR.md: в первой строке нет <!-- executor-policy-version: A.B -->');

  if (projectExecutorText !== null && projectExecutorText !== executorText) {
    problems.push('копия EXECUTOR.md в проекте не совпадает с эталоном в папке скилла');
  }

  const expectedSync = skillVer && execVer ? `<!-- skill-readme-sync: ${skillVer} / ${execVer} -->` : null;
  for (const [label, text] of [['README.ru.md', readmeRuText], ['README.en.md', readmeEnText]]) {
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    if (expectedSync && firstLine !== expectedSync) {
      problems.push(`${label}: метка первой строки «${firstLine}» не совпадает с «${expectedSync}»`);
    }
  }

  const sectionNumbers = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.match(/^## (\d+)\./)?.[1] ?? l);

  const ruSections = sectionNumbers(readmeRuText);
  const enSections = sectionNumbers(readmeEnText);
  if (ruSections.length === 0 || JSON.stringify(ruSections) !== JSON.stringify(enSections)) {
    problems.push(`структура разделов ## в README.ru.md (${ruSections.join(',')}) и README.en.md (${enSections.join(',')}) не совпадает`);
  }

  const isPostStepA1 = requireStepA1 || maintainingText !== null || (skillVer !== null && skillVer !== 'v3.20');
  if (isPostStepA1) {
    if (!maintainingText || !maintainingText.includes('skill-readme-sync')) {
      problems.push('MAINTAINING.md отсутствует или не содержит правил синхронизации skill-readme-sync');
    }
    if (skillText.includes('<!-- Только при изменении правил в SKILL.md или EXECUTOR.md')) {
      problems.push('SKILL.md: комментарий сопровождения не вынесен в MAINTAINING.md (E1)');
    }
    if (executorText.includes('<!-- Только при изменении правил в SKILL.md или EXECUTOR.md')) {
      problems.push('EXECUTOR.md: комментарий сопровождения не вынесен в MAINTAINING.md (E1)');
    }
    if (skillText.includes('onstop') || skillText.includes('onresult')) {
      problems.push('SKILL.md: остались специфичные для родительского проекта обработчики onstop/onresult (C2)');
    }
    if (executorText.includes('в зеркало контента')) {
      problems.push('EXECUTOR.md: осталась специфичная для родительского проекта фраза «в зеркало контента» (C2)');
    }
    if (skillText.includes('.agents/skills/architect/')) {
      problems.push('SKILL.md: остался захардкоженный путь установки .agents/skills/architect/ (C3)');
    }
    if (executorText.includes('.agents/skills/architect/')) {
      problems.push('EXECUTOR.md: остался захардкоженный путь установки .agents/skills/architect/ (C3)');
    }
  }

  return problems;
}

test('E1: checkSkillMaintenance catches version drift, README section mismatch, EXECUTOR.md divergence, and C2/C3/E1 leaks', () => {
  const valid = {
    skillText: '# Промт Архитектора v3.21\nТекст без хардкода пути.\n',
    executorText: '<!-- executor-policy-version: 1.6 -->\n# Правила для Исполнителя\n',
    projectExecutorText: '<!-- executor-policy-version: 1.6 -->\n# Правила для Исполнителя\n',
    readmeRuText: '<!-- skill-readme-sync: v3.21 / 1.6 -->\n## 1. Раздел\n## 2. Раздел\n',
    readmeEnText: '<!-- skill-readme-sync: v3.21 / 1.6 -->\n## 1. Section\n## 2. Section\n',
    maintainingText: '# MAINTAINING\nskill-readme-sync rules\n',
    requireStepA1: true,
  };
  assert.deepEqual(checkSkillMaintenance(valid), []);

  assert.match(
    checkSkillMaintenance({ ...valid, readmeEnText: '<!-- skill-readme-sync: v3.20 / 1.5 -->\n## 1. Section\n## 2. Section\n' }).join('\n'),
    /README\.en\.md: метка первой строки/,
  );
  assert.match(
    checkSkillMaintenance({ ...valid, readmeEnText: '<!-- skill-readme-sync: v3.21 / 1.6 -->\n## 1. Section\n' }).join('\n'),
    /структура разделов ##/,
  );
  assert.match(
    checkSkillMaintenance({ ...valid, projectExecutorText: 'different' }).join('\n'),
    /копия EXECUTOR\.md/,
  );
  assert.match(
    checkSkillMaintenance({
      ...valid,
      skillText: '# Промт Архитектора v3.21\n<!-- Только при изменении правил в SKILL.md или EXECUTOR.md -->\nonstop .agents/skills/architect/\n',
      executorText: '<!-- executor-policy-version: 1.6 -->\nв зеркало контента .agents/skills/architect/\n',
      maintainingText: null,
    }).join('\n'),
    /MAINTAINING\.md[\s\S]*E1[\s\S]*C2[\s\S]*C3/,
  );
});

test('E1: live skill files in repository have synchronized versions, README sections, and identical EXECUTOR.md copies', () => {
  const skillText = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const executorText = readFileSync(path.join(skillDir, 'EXECUTOR.md'), 'utf8');
  const readmeRuText = readFileSync(path.join(skillDir, 'README.ru.md'), 'utf8');
  const readmeEnText = readFileSync(path.join(skillDir, 'README.en.md'), 'utf8');
  const maintainingPath = path.join(skillDir, 'MAINTAINING.md');
  const maintainingText = existsSync(maintainingPath) ? readFileSync(maintainingPath, 'utf8') : null;

  const tmpRepo = mkdtempSync(path.join(os.tmpdir(), 'maintaining-proj-'));
  try {
    const rootExecutorPath = path.join(tmpRepo, 'EXECUTOR.md');
    writeFileSync(rootExecutorPath, executorText);
    const projectExecutorText = readFileSync(rootExecutorPath, 'utf8');

    const problems = checkSkillMaintenance({
      skillText,
      executorText,
      projectExecutorText,
      readmeRuText,
      readmeEnText,
      maintainingText,
      requireStepA1: process.env.VERIFY_STEP_A1 === '1',
    });
    assert.deepEqual(problems, [], problems.join('\n'));
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});
