# PLAN

## Goal / Requirements
Цикл 20: Встроенное обновление скилла одной командой `--update` в оркестраторе (`node .agents/skills/architect/orchestrator/run.mjs --update` / `npm run agents -- --update`) без необходимости вручную копировать длинный `mktemp && git clone` однострочник:
1. Реализовать модуль `.agents/skills/architect/orchestrator/update.mjs` и флаг `--update` в `cli.mjs` / `run.mjs`: клонирование свежего коммита из репозитория скилла во временную директорию, атомарное обновление установленной папки скилла (`.agents/skills/architect` и/или `.claude/skills/architect`), запись ревизии в `.version`, синхронизация проектного `EXECUTOR.md` и обновление `.git/hooks/commit-msg` без изменения пользовательских конфигов (`config.json` / `config.local.json`).
2. Задокументировать команду `--update` в `README.md`, `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md` и `AGENTS.md`.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-047`) хранится в `docs/decisions.md`.
- **ADR-048:** Встроенное самообновление скилла через флаг `--update` оркестратора (`update.mjs`, `cli.mjs`, `run.mjs`): `node .agents/skills/architect/orchestrator/run.mjs --update` клонирует `https://github.com/Aghasi-Sargsyan/architect-skill.git` (или `ARCHITECT_SKILL_REPO_URL`) с `--depth 1` во временную папку, обновляет установленные в проекте папки скилла (`.agents/skills/architect`, `.claude/skills/architect`), записывает версию и короткий SHA коммита в `.version`, синхронизирует корневой `EXECUTOR.md` (и `.architect/EXECUTOR.md`, если он есть) и обновляет `.git/hooks/commit-msg`, не затрагивая конфиги проекта (`config.json`, `config.local.json`, `PLAN.md`).

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/update.test.mjs`
- `tests/repo-install.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-073: Add --update CLI flag and updateSkill module to refresh installed skill, EXECUTOR.md, and git hooks
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/update.test.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/layout.mjs`, `.agents/skills/architect/orchestrator/hooks.mjs`
  - Менять: `.agents/skills/architect/orchestrator/update.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Задача и инварианты: (1) Создать `.agents/skills/architect/orchestrator/update.mjs` с экспортом `DEFAULT_SKILL_REPO_URL = 'https://github.com/Aghasi-Sargsyan/architect-skill.git'`, `readSkillVersion(skillDir)`, `updateSkill({ workDir, orchestratorDir, repoUrl, realGit })` и `handleUpdateCli({ workDir, orchestratorDir, repoUrl, realGit, print })`: запрещать запуск при `process.env.AGENT_LOOP === '1'`, находить установленные папки скилла в `workDir` (`.agents/skills/architect`, `.claude/skills/architect` и `resolveInstalledSkillDir(workDir, orchestratorDir)`), клонировать `repoUrl` (`git clone --depth 1`) во временную директорию `os.tmpdir()` с обязательной очисткой в `finally`, проверять наличие `SKILL.md` и `EXECUTOR.md` в склонированном скилле, заменять целевую папку скилла, записывать `${afterVersion} (${commitSha})\n` в `path.join(dir, '.version')`, синхронизировать `EXECUTOR.md` и `.architect/EXECUTOR.md` в `workDir` (если они существуют), обновлять `.git/hooks/commit-msg` через `installCommitMsgHook` и печатать итог через `print`. (2) В `cli.mjs` добавить флаг `--update` в `parseArgs` (`opts.update = false`, включить в `modeFlags` для взаимного исключения с другими режимами) и реэкспортировать `handleUpdateCli` из `./update.mjs`. (3) В `run.mjs` импортировать `handleUpdateCli` и вызывать `if (opts.update) return handleUpdateCli({ workDir: process.cwd(), realGit });` рядом с `opts.installHooks`.
  - Граничные случаи: Сохранить `cli.mjs`, `run.mjs` и `update.mjs` строго `<= 400` строк и без пустых `catch {}` (`AGENTS.md §4`) и упоминаний `T-NNN` в комментариях производственных модулей.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/update.test.mjs`
  - Готово, когда: Замороженный тест `update.test.mjs` и существующие тесты `cli.test.mjs` и `run.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [x] T-074: Document --update command in root README.md, skill README.en.md, skill README.ru.md, and AGENTS.md
  - Риск: высокий
  - Зависит от: T-073
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `tests/repo-install.test.mjs`, `README.md`, `AGENTS.md`, `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md`
  - Менять: `README.md`, `AGENTS.md`, `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md`
  - Задача и инварианты: (1) В корневом `README.md` (строго `<= 80` строк, сохранив двухшаговый `## Quickstart` и существующие проверки `tests/repo-install.test.mjs`) упомянуть `node .agents/skills/architect/orchestrator/run.mjs --update` в `## Manual Installation` (шаг 4). (2) В `.agents/skills/architect/README.en.md` и `.agents/skills/architect/README.ru.md` в разделе `### D.` указать команду `node .agents/skills/architect/orchestrator/run.mjs --update` (или `npm run agents -- --update`) как основной способ обновления одной командой, сохранив упоминание однострочника с `mktemp -d` для установок без Node.js (`tests/repo-install.test.mjs` проверяет наличие `mktemp -d` в `### D.`, лимит каждого README `<= 25 KB`, заголовки `## 1.`..`## 9.` синхронны, в `README.en.md` нет кириллицы). (3) В `AGENTS.md` (§3, таблица команд) добавить `-- --update` в список флагов `npm run agents`.
  - Граничные случаи: Корневой `README.md` `<= 80` строк; `README.en.md` и `README.ru.md` `<= 25 KB` и без нарушения `skill-packaging.test.mjs` / `maintaining.test.mjs` / `tests/repo-install.test.mjs`.
  - Тест-кейсы: `tests/repo-install.test.mjs`
  - Готово, когда: Замороженный тест `tests/repo-install.test.mjs`, `update.test.mjs`, `skill-packaging.test.mjs`, `maintaining.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test tests/repo-install.test.mjs .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/skill-packaging.test.mjs .agents/skills/architect/orchestrator/maintaining.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`

## Ретроспектива цикла 20 (`v3.30 / 1.8`, Команда самообновления `--update`)

- **Прогон тестов оркестратора и репозитория по версиям Node:**
  - Node `v24.22.2`: `226/226 PASS` (`VERIFY_STEP_A1=1 npm test`)
  - Node `v22.23.4`: `226/226 PASS` (`VERIFY_STEP_A1=1 npx -y -p node@22 -c 'node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs tests/*.test.mjs'`)
- **Self-check:** `✓ Self-check PASSED (0b4be9f..8065f42)`, `0 violations`, `0 NOT VERIFIED`.
- **Rules: added 0 / removed 0** (`SKILL.md`: `27776` байт при лимите `27780` байт; синхронизация `<!-- skill-readme-sync: v3.30 / 1.8 -->` подтверждена).
  - Добавлено (0): флаг `--update` и модуль `update.mjs` реализованы в оркестраторе и отражены в пользовательских руководствах (`README.md`, `README.en.md`, `README.ru.md`, `AGENTS.md`) без добавления правил в промпты `SKILL.md` и `EXECUTOR.md`.
  - Правила, не сработавшие за последние 3 цикла: `WAIVER <sha7>: <rule> — <reason>` (0 срабатываний за Циклы 18–20 — оставлено как защитный механизм в `selfcheck.mjs`).

| Измерение | Статус | Детали |
|---|---|---|
| Boundaries | OK | Коммиты `T-073` (`3c853b1`) и `T-074` (`ba5b417`) меняли строго файлы из `Менять`; замороженные тесты (`update.test.mjs`, `tests/repo-install.test.mjs`) не затронуты Исполнителем. |
| Git | OK | Чёткое разделение `arch:` и `T-NNN`, явные пути при коммите (`git commit --only`), все коммиты — на английском (`.git/hooks/commit-msg` активен), 0 сторонних коммитов вне `arch:`/`T-NNN`. |
| Bypasses | OK | Независимый grep по `0b4be9f..HEAD -- .agents/skills/architect/orchestrator` — 0 совпадений. Все не-тестовые модули оркестратора `<= 400` строк (`update.mjs` — 154, `cli.mjs` — 391, `run.mjs` — 397) и без пустых `catch {}`. |
| Escalations | 0 | Обе задачи выполнены без эскалаций. |
| Acceptance | 0 rework | Обе задачи (`T-073` и `T-074`) приняты с первой попытки без раундов `rework`. |
| Context | OK | Минимального изолированного промпта (`Read EXECUTOR.md and PLAN.md. Execute task T-NNN.`) без истории чата было достаточно для обоих субагентов. |
| Профили Исполнителей | Обновлено | `Gemini Flash (subagent, уровень неизвестен)`: сильные стороны дополнены `T-073`…`T-074` (модуль самообновления `update.mjs` и синхронизация документации с сохранением лимитов байт/строк). |
