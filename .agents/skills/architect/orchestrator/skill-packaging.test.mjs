import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

export const MAX_README_BYTES = 25 * 1024;
export const REFERENCE_NAMES = ['auto-review', 'orchestrator', 'retro', 'stacks', 'team'];

// Allowed bilingual tokens when English docs mention backward-compatible Russian PLAN.md / verdict / header tokens
const ALLOWED_CYRILLIC_TOKENS = [
  '# Промт Архитектора v',
  'Промт Архитектора',
  'Задачи',
  'Заморожено',
  'Риск',
  'Зависит от',
  'Модель',
  'Читать',
  'Менять',
  'Задача и инварианты',
  'Граничные случаи',
  'Тест-кейсы',
  'Готово, когда',
  'Проверка',
  'Доработка',
  'план',
  'настройка оркестратора',
  'приёмка',
  'закрытие цикла',
  'Принято',
  'принято',
  'отклонено',
  'Доработать',
  'высокий',
  'средний',
  'низкий',
];

function stripAllowedCyrillic(text) {
  let out = text;
  for (const tok of ALLOWED_CYRILLIC_TOKENS) {
    out = out.split(tok).join('');
  }
  return out;
}

function extractNumberedHeadings(md) {
  const withoutFences = md.replace(/```[\s\S]*?```/g, '');
  const matches = [];
  for (const line of withoutFences.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(\d+(?:\.\d+)?\.?)\s+/);
    if (m) matches.push(`${m[1]} ${m[2].replace(/\.$/, '')}`);
  }
  return matches;
}

export function checkSkillS5({
  files,
  maxReadmeBytes = MAX_README_BYTES,
}) {
  const issues = [];
  const requiredFiles = [
    'SKILL.md',
    'EXECUTOR.md',
    'README.en.md',
    'README.ru.md',
    'LICENSE',
    'CHANGELOG.md',
    ...REFERENCE_NAMES.map((n) => `references/${n}.md`),
  ];

  // 1. No *.ru.md files other than README.ru.md are allowed in the skill folder (ADR-032)
  for (const rel of Object.keys(files)) {
    if (rel.endsWith('.ru.md') && rel !== 'README.ru.md') {
      issues.push(`${rel}: forbidden *.ru.md rule copy (only README.ru.md is allowed per ADR-032)`);
    }
  }

  for (const rel of requiredFiles) {
    if (typeof files[rel] !== 'string' || files[rel].trim().length === 0) {
      issues.push(`${rel}: missing or empty`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // 2. SKILL.md YAML frontmatter and version tags in SKILL.md, EXECUTOR.md, and root/EXECUTOR.md
  if (!/^---\r?\nname:\s*architect\b/.test(files['SKILL.md'])) {
    issues.push('SKILL.md: must start with YAML frontmatter (name: architect)');
  }

  const skillEnVer = files['SKILL.md'].match(/^#\s+Architect Prompt v(\d+\.\d+)/m)?.[1];
  if (!skillEnVer) issues.push('SKILL.md: missing "# Architect Prompt vX.Y" heading');

  const execEnVer = files['EXECUTOR.md'].match(/<!--\s*executor-policy-version:\s*(\d+\.\d+)\s*-->/)?.[1];
  if (!execEnVer) issues.push('EXECUTOR.md: missing executor-policy-version tag');

  if (typeof files['root/EXECUTOR.md'] === 'string' && files['root/EXECUTOR.md'] !== files['EXECUTOR.md']) {
    issues.push('root EXECUTOR.md and skill EXECUTOR.md differ');
  }

  // 3. Active English files must contain no unwhitelisted Cyrillic (D5)
  const englishFiles = [
    'SKILL.md',
    'EXECUTOR.md',
    'README.en.md',
    ...REFERENCE_NAMES.map((n) => `references/${n}.md`),
  ];
  for (const rel of englishFiles) {
    const cleaned = stripAllowedCyrillic(files[rel]);
    const cyrMatch = cleaned.match(/[А-Яа-яЁё]+/);
    if (cyrMatch) {
      issues.push(`${rel}: contains unexpected Cyrillic "${cyrMatch[0]}"`);
    }
  }

  // 4. README compression <= 25 KB and sync (E2)
  for (const readmeRel of ['README.en.md', 'README.ru.md']) {
    const bytes = Buffer.byteLength(files[readmeRel], 'utf8');
    if (bytes > maxReadmeBytes) {
      issues.push(`${readmeRel}: size ${bytes} bytes exceeds limit ${maxReadmeBytes} bytes (25 KB)`);
    }
    const syncMatch = files[readmeRel].match(/<!--\s*skill-readme-sync:\s*v(\d+\.\d+)\s*\/\s*(\d+\.\d+)\s*-->/);
    if (!syncMatch) {
      issues.push(`${readmeRel}: missing skill-readme-sync tag`);
    } else if (skillEnVer && execEnVer && (syncMatch[1] !== skillEnVer || syncMatch[2] !== execEnVer)) {
      issues.push(`${readmeRel}: sync tag v${syncMatch[1]} / ${syncMatch[2]} != v${skillEnVer} / ${execEnVer}`);
    }
    for (const token of ['Claude Code', 'Gemini CLI', 'Codex', 'Antigravity', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      if (!files[readmeRel].includes(token)) {
        issues.push(`${readmeRel}: missing installation/snippet reference "${token}"`);
      }
    }
  }
  const readmeEnHeadings = extractNumberedHeadings(files['README.en.md']).filter((h) => h.startsWith('## '));
  const readmeRuHeadings = extractNumberedHeadings(files['README.ru.md']).filter((h) => h.startsWith('## '));
  if (readmeEnHeadings.join('|') !== readmeRuHeadings.join('|')) {
    issues.push(`README section mismatch: README.en.md (${readmeEnHeadings.join(', ')}) vs README.ru.md (${readmeRuHeadings.join(', ')})`);
  }

  // 5. LICENSE (MIT) and CHANGELOG.md (E4)
  if (!/MIT License/i.test(files['LICENSE'])) {
    issues.push('LICENSE: must contain "MIT License"');
  }
  if (skillEnVer && !files['CHANGELOG.md'].includes(skillEnVer)) {
    issues.push(`CHANGELOG.md: must mention current SKILL version ${skillEnVer}`);
  }

  // 6. Chat output hygiene: forbid duplicating full task cards / PLAN.md and skill git diff in chat
  if (!/Do not duplicate task cards/i.test(files['SKILL.md']) || /show `git diff` before committing/i.test(files['SKILL.md'])) {
    issues.push('SKILL.md: missing chat output hygiene rule or still requires showing skill git diff in chat');
  }

  return { ok: issues.length === 0, issues };
}

function buildValidFixture() {
  const readmeCommon = 'Claude Code, Gemini CLI, Codex, Antigravity, AGENTS.md, CLAUDE.md, GEMINI.md';
  return {
    'SKILL.md': '---\nname: architect\ndescription: Chief Architect\n---\n\n# Architect Prompt v3.25\n\n## 0. Role\nDo not duplicate task cards in chat.\n\n## 1. Mode\n### 1.1 Sub\nText\n',
    'EXECUTOR.md': '<!-- executor-policy-version: 1.7 -->\n# Executor Rules\n\n## 1. Role\nText\n',
    'root/EXECUTOR.md': '<!-- executor-policy-version: 1.7 -->\n# Executor Rules\n\n## 1. Role\nText\n',
    'README.en.md': `<!-- skill-readme-sync: v3.25 / 1.7 -->\n# Architect\n\n## 1. Quickstart\n${readmeCommon}\n\n## 2. Reference\nText\n`,
    'README.ru.md': `<!-- skill-readme-sync: v3.25 / 1.7 -->\n# Архитектор\n\n## 1. Быстрый старт\n${readmeCommon}\n\n## 2. Справочник\nТекст\n`,
    'LICENSE': 'MIT License\n\nCopyright (c) 2026\n',
    'CHANGELOG.md': '# Changelog\n\n## v3.25 / 1.7\n- English core and packaging.\n',
    'references/auto-review.md': '# Auto Review\n\n## 1. Steps\nText\n',
    'references/orchestrator.md': '# Orchestrator\n\n## 1. Setup\nText\n',
    'references/retro.md': '# Retro\n\n## 1. Checks\nText\n',
    'references/stacks.md': '# Stacks\n\n## 1. Commands\nText\n',
    'references/team.md': '# Team\n\n## 1. Branches\nText\n',
  };
}

test('D5 / E2 / E4 / ADR-032: checkSkillS5 forbids extra *.ru.md files, validates English-only active files, root EXECUTOR.md parity, README <= 25 KB, and LICENSE/CHANGELOG', () => {
  const valid = buildValidFixture();
  assert.deepEqual(checkSkillS5({ files: valid }), { ok: true, issues: [] });

  const withForbiddenRuCopy = { ...valid, 'SKILL.ru.md': '# Промт Архитектора v3.25\n' };
  assert.equal(checkSkillS5({ files: withForbiddenRuCopy }).ok, false);
  assert.match(checkSkillS5({ files: withForbiddenRuCopy }).issues.join('; '), /SKILL\.ru\.md.*forbidden \*\.ru\.md/);

  const withCyrillicLeak = { ...valid, 'SKILL.md': `${valid['SKILL.md']}\nНепереведённая строка\n` };
  assert.equal(checkSkillS5({ files: withCyrillicLeak }).ok, false);
  assert.match(checkSkillS5({ files: withCyrillicLeak }).issues.join('; '), /SKILL\.md.*Cyrillic/);

  const withOversizedReadme = { ...valid, 'README.en.md': `${valid['README.en.md']}${'x'.repeat(26000)}` };
  assert.equal(checkSkillS5({ files: withOversizedReadme }).ok, false);
  assert.match(checkSkillS5({ files: withOversizedReadme }).issues.join('; '), /README\.en\.md.*exceeds limit/);
});

test('D5 / E2 / E4 / ADR-032: live repository S5 packaging passes and contains no *.ru.md files other than README.ru.md', () => {
  const relPaths = [
    'SKILL.md',
    'EXECUTOR.md',
    'README.en.md',
    'README.ru.md',
    'LICENSE',
    'CHANGELOG.md',
    ...REFERENCE_NAMES.map((n) => `references/${n}.md`),
  ];
  const files = {};
  for (const rel of relPaths) {
    const abs = path.join(SKILL_ROOT, rel);
    if (existsSync(abs)) files[rel] = readFileSync(abs, 'utf8');
  }
  // Scan skill root and references/ for any *.ru.md files
  for (const entry of readdirSync(SKILL_ROOT)) {
    if (entry.endsWith('.ru.md') && entry !== 'README.ru.md') {
      files[entry] = readFileSync(path.join(SKILL_ROOT, entry), 'utf8');
    }
  }
  const refsDir = path.join(SKILL_ROOT, 'references');
  if (existsSync(refsDir)) {
    for (const entry of readdirSync(refsDir)) {
      if (entry.endsWith('.ru.md')) {
        files[`references/${entry}`] = readFileSync(path.join(refsDir, entry), 'utf8');
      }
    }
  }
  files['root/EXECUTOR.md'] = files['EXECUTOR.md'];

  const res = checkSkillS5({ files });
  assert.deepEqual(res, { ok: true, issues: [] });
});
