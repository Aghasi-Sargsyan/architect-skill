import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const orchDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(orchDir);

export const MAX_SKILL_CORE_BYTES = 34 * 1024;
export const REQUIRED_REFERENCE_FILES = ['auto-review.md', 'orchestrator.md', 'retro.md', 'stacks.md'];

/**
 * Validates S4 skill decomposition (D4, D6, D7, D8, Ф5):
 * - Every present file in references/*.md is free of hardcoded .agents/skills/architect/ paths (C3)
 *   and parent-project leaks (C2: onstop, onresult, в зеркало контента, Personal AI Workspace).
 * - references/auto-review.md contains the 4 review sources, NOT VERIFIED rule, and escalation rule without touching «Менять».
 * - When requireStepA1 is true (VERIFY_STEP_A1=1):
 *   - SKILL.md byte size <= 34 KB (34816 bytes);
 *   - All 4 reference files exist in references/;
 *   - Section 4 of SKILL.md delegates the review procedure to references/auto-review.md instead of duplicating it;
 *   - SKILL.md links to references/orchestrator.md, references/retro.md, and references/stacks.md;
 *   - SKILL.md includes instruction priority (D6), context isolation generalization (D7), and native environment tools priority (D8) without WaitMsBeforeAsync in the core.
 */
export function checkSkillS4({
  skillText,
  referenceFiles = {},
  requireStepA1 = false,
}) {
  const problems = [];

  for (const [name, content] of Object.entries(referenceFiles)) {
    if (typeof content !== 'string' || !content.trim()) {
      problems.push(`references/${name}: пустой файл`);
      continue;
    }
    if (content.includes('.agents/skills/architect/')) {
      problems.push(`references/${name}: захардкожен путь .agents/skills/architect/ (C3 / Ф5)`);
    }
    if (
      content.includes('onstop') ||
      content.includes('onresult') ||
      content.includes('в зеркало контента') ||
      content.includes('Personal AI Workspace')
    ) {
      problems.push(`references/${name}: утечка фактов родительского проекта (C2 / Ф5)`);
    }
  }

  const autoReview = referenceFiles['auto-review.md'];
  if (!autoReview) {
    problems.push('references/auto-review.md отсутствует');
  } else {
    if (!autoReview.includes('NOT VERIFIED')) {
      problems.push('references/auto-review.md: нет правила NOT VERIFIED');
    }
    if (!/четырёх источников|четыре источника|four sources/i.test(autoReview)) {
      problems.push('references/auto-review.md: нет сверки четырёх источников при приёмке');
    }
    if (!/не правь и не коммить файлы из «Менять»|do not edit or commit files from.*Change/i.test(autoReview)) {
      problems.push('references/auto-review.md: нет инварианта неприкосновенности грязных файлов из «Менять» при эскалации');
    }
  }

  if (requireStepA1) {
    const byteLen = Buffer.byteLength(skillText, 'utf8');
    if (byteLen > MAX_SKILL_CORE_BYTES) {
      problems.push(`SKILL.md: размер ${byteLen} байт превышает лимит ${MAX_SKILL_CORE_BYTES} байт (34 КБ, Ф5)`);
    }
    for (const reqFile of REQUIRED_REFERENCE_FILES) {
      if (!referenceFiles[reqFile]) {
        problems.push(`references/${reqFile}: отсутствует обязательный справочник Шага А1`);
      }
    }
    for (const reqRef of ['references/auto-review.md', 'references/orchestrator.md', 'references/retro.md', 'references/stacks.md']) {
      if (!skillText.includes(reqRef)) {
        problems.push(`SKILL.md: нет ссылки на ${reqRef} (D4 / Ф5)`);
      }
    }
    if (skillText.includes('При приёмке сопоставь четыре источника:') || skillText.includes('Match the four sources during review:')) {
      problems.push('SKILL.md: раздел 4 дублирует процедуру приёмки вместо ссылки на references/auto-review.md (Ф5)');
    }
    if (skillText.includes('WaitMsBeforeAsync')) {
      problems.push('SKILL.md: деталь адаптера WaitMsBeforeAsync осталась в ядре вместо references/orchestrator.md (D8)');
    }
    if (!/приоритет инструкций|Пользователь → Проект|instruction priority|User → Project/i.test(skillText)) {
      problems.push('SKILL.md: не зафиксирован приоритет инструкций (D6)');
    }
    if (!/изоляци[яи] контекста|субагент|context isolation|subagent/i.test(skillText)) {
      problems.push('SKILL.md: не обобщена изоляция контекста Исполнителя (D7)');
    }
  }

  return problems;
}

test('D4 / Ф5: checkSkillS4 validates byte size limit, reference files hygiene (C2/C3), and single source of truth in references/auto-review.md', () => {
  const validCore = `# Промт Архитектора v3.23
Приоритет инструкций: Пользователь → Проект → Ядро → Адаптер.
Изоляция контекста Исполнителя: отдельный чат, субагент или CLI.
Справочники: references/auto-review.md, references/orchestrator.md, references/retro.md, references/stacks.md.
`;
  const validRefs = {
    'auto-review.md': '# Приёмка\nСопоставление четырёх источников. NOT VERIFIED. Не правь и не коммить файлы из «Менять» с незакоммиченными правками Исполнителя.\n',
    'orchestrator.md': '# Оркестратор\n--watch --since N\n',
    'retro.md': '# Ретро\nТаблица ретро\n',
    'stacks.md': '# Стеки\nTypeScript / Python / Go / Rust\n',
  };
  assert.deepEqual(checkSkillS4({ skillText: validCore, referenceFiles: validRefs, requireStepA1: true }), []);

  // Oversized SKILL.md (> 34 KB) fails in byte check even if it is a single line!
  const oneHugeLine = `# Промт Архитектора v3.23 ${'а'.repeat(20_000)}`;
  assert.match(
    checkSkillS4({ skillText: oneHugeLine, referenceFiles: validRefs, requireStepA1: true }).join('\n'),
    /превышает лимит 34816 байт/,
  );

  // Hardcoded .agents/skills/architect/ or duplicated review checklist in SKILL.md fails
  assert.match(
    checkSkillS4({
      skillText: `${validCore}\nПри приёмке сопоставь четыре источника:\nWaitMsBeforeAsync\n`,
      referenceFiles: { ...validRefs, 'orchestrator.md': 'Путь .agents/skills/architect/run.mjs onstop' },
      requireStepA1: true,
    }).join('\n'),
    /C3[\s\S]*C2[\s\S]*дублирует процедуру приёмки[\s\S]*WaitMsBeforeAsync/,
  );
});

test('D4 / Ф5: live repository references/*.md pass hygiene checks now, and full S4 core decomposition passes when VERIFY_STEP_A1=1', () => {
  const skillText = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const refsDir = path.join(skillDir, 'references');
  const referenceFiles = {};
  if (existsSync(refsDir)) {
    for (const entry of readdirSync(refsDir)) {
      if (entry.endsWith('.md')) {
        referenceFiles[entry] = readFileSync(path.join(refsDir, entry), 'utf8');
      }
    }
  }
  const problems = checkSkillS4({
    skillText,
    referenceFiles,
    requireStepA1: process.env.VERIFY_STEP_A1 === '1',
  });
  assert.deepEqual(problems, [], problems.join('\n'));
});
