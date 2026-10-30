# PLAN (Архив Цикла 12 — Этап 2: Готовность для других, `v3.28 / 1.8`)

## Goal / Requirements
Этап 2 (Цикл 12, `v3.28`): Готовность для других (П6–П10).
- П10d (`T-055`): расширение `BASE_COMMANDS` командами только для чтения (`git ls-files`, `git grep` без `-O` / `--open-files-in-pager`, `git blame`, `git ls-tree`, `git merge-base`, `git rev-list`, `git describe`, `git shortlog`, `git stash list`, `git tag -l`, `git branch -a` / `-r` / `--list`, `git check-ignore`, `pwd`, `which`, `node --version`, `npm ls`) с синхронизацией `commandProblem` и git-shim в `guards.mjs`.
- П10e (`T-056`): валидный патч `stop.diff` (`gitRaw` без `.trim()`) и продолжение работы оркестратора после эскалации на грязном дереве, когда грязные файлы входят в `Change` текущей задачи и совпадают со слепком эскалации (`stop.status.txt` и `stop.diff`), с передачей отчёта об эскалации в `executorPrompt`.
- П6–П10a–c (шаг Архитектора по `MAINTAINING.md`): нейтральное ядро `SKILL.md` (`v3.28`, размер `27459` байт `<= 27780`), честные два уровня установки и обновление в `README.ru.md` / `README.en.md`, раздел «Когда скилл не использовать», контроль роста правил (`references/retro.md`, `MAINTAINING.md`), правила эскалаций (а)–(г) в `references/auto-review.md` и пояснение к `### 🔐 Command Permission` в `references/orchestrator.md`.

## Decisions (ADR)
Перенесены в `docs/decisions.md` (`ADR-038` и отклонённое предложение об аудите другой моделью перед `arch: fix-frozen`).

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs` — эталонный тест `T-055`
- `.agents/skills/architect/orchestrator/escalation-resume.test.mjs` — эталонный тест `T-056`

## Задачи

- [x] T-055: Read-only commands in BASE_COMMANDS, commandProblem, and git shim (П10d)
  - Риск: высокий
  - Модель: Gemini 4 Argon / High (subagent)
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs`
  - Проверка: `node --test .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-unwrap.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs`

- [x] T-056: Valid stop.diff via gitRaw and escalation resume on matching dirty working tree (П10e)
  - Риск: высокий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Менять: `.agents/skills/architect/orchestrator/git.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/escalation-resume.test.mjs`
  - Проверка: `node --test .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/cli-node-version.test.mjs`

## Ретроспектива Цикла 12 (Этап 2: Готовность для других, `v3.28 / 1.8`)

- **Прогон тестов оркестратора по версиям Node:**
  - Node `v24.22.2`: `184/184 PASS` (`VERIFY_STEP_A1=1 npm test`)
  - Node `v22.23.4`: `184/184 PASS` (`VERIFY_STEP_A1=1 npx -y -p node@22 -c 'node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs tests/*.test.mjs'`)
- **Self-check:** `✓ Self-check PASSED (0f73809..dd434c4)`, `0 violations`, `3 NOT VERIFIED` (исторические строки `eval` в `PLAN.md` из `Workspace`, каталог `.agent-runs/evals` не переносился).
- **Rules: added 5 / removed 4** (`SKILL.md`: `27459` байт при лимите `27780` байт, `-321` байт к началу цикла).
  - Добавлено (5): выбор модели Исполнителя один раз на проект и порядок запуска (оркестратор → субагент с явной моделью без `inherit` → отдельный чат); приоритет языка коммитов проекта над языком `PLAN.md` и чата; запрет `git commit --no-verify` в Категории 1 (`SKILL.md`, `EXECUTOR.md`); правила разрешения эскалаций `(a)`–`(d)` в `references/auto-review.md`; правило простого однострочного пояснения к `### 🔐 Command Permission` и таблица передачи задач по средам в `references/orchestrator.md`.
  - Вынесено из `SKILL.md` / консолидировано (4): механика CLI оркестратора (`--self-check`, `--audit-plan`, `arch: fix-frozen`, `WAIVER`) перенесена в `references/orchestrator.md`; дисциплина `evals` из `references/retro.md` перенесена в `MAINTAINING.md`; ужаты дублирующиеся перечни шагов в `SKILL.md` §3–§6.
  - Правила, не сработавшие за последние 3 цикла: `WAIVER (<file>): <reason>` (0 срабатываний за Циклы 10–12 — оставлено как защитный механизм для удаления устаревших тестов в `selfcheck.mjs`).

| Измерение | Статус | Детали |
|---|---|---|
| Boundaries | OK | Коммиты `T-055` (`e10c7fe`), `T-056` (`11062cb`, `d324bab`) меняли строго файлы из `Менять`; `Frozen` не затронут Исполнителем; правка существующего теста выполнена отдельным коммитом `arch: fix-frozen T-055` (`37b2f1d`). |
| Git | OK | Разделение `arch:` и `T-NNN`, явные пути при коммите (`git commit --only`), все новые коммиты `arch:` — на английском по `AGENTS.md §1`. |
| Bypasses | OK | Независимый grep по `0f73809..HEAD -- .agents/skills/architect/orchestrator` — 0 совпадений. |
| Escalations | 1 обоснованная | На `T-055` субагент (`Gemini 4 Argon / High (subagent)`) корректно эскалировал конфликт `permissions.test.mjs:139` (`command(…) rules: 12` vs `30`) и `permissions.test.mjs:173` (`git stash` префикс) без отката правок; устранено в `arch: fix-frozen T-055` (`37b2f1d`). |
| Acceptance | 1 rework | `T-055` принята с 1-й попытки после продолжения эскалации; `T-056` (`Gemini Flash (subagent, уровень неизвестен)`) потребовала 1 раунд `rework` (`d324bab`) из-за двух пустых блоков `catch {}` в `check.mjs`. |
| Context | OK | Стандартного минимального промпта (`Read EXECUTOR.md and PLAN.md. Execute task T-NNN.`) без пересказа задачи и без истории чата было достаточно для `T-056`. |
| Профили Исполнителей | Обновлено | `Gemini 4 Argon / High (subagent)`: добавлена `T-055`; создан раздел `Gemini Flash (subagent, уровень неизвестен)` по результатам `T-056` (`11062cb` → `d324bab`). |
