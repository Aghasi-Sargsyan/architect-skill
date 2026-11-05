# PLAN

## Goal / Requirements
Цикл 25 (`v3.35 / 1.8`, Двухшаговый выбор роли и модели `/architect model` и CLI-команды `--models` / `--set-model`, задача `T-082`):
1. В `SKILL.md` (`v3.35`, Step 0) добавить `Fast path` для `/architect model` (`/architect:model`): без чтения `PLAN.md`, `docs/decisions.md`, `docs/executor-profiles.md` и `--status` запускать `node <skill-folder>/orchestrator/run.mjs --models`, показывать текущие модели обеих ролей и первым шагом спрашивать целевую роль (`1 — Executor`, `2 — Architect`, `3 — Both`, пропуская шаг 1, если роль уже указана в команде), вторым шагом выводить пронумерованный список всех доступных моделей окружения с уровнями `effort`, а после выбора записывать модель через `node <skill-folder>/orchestrator/run.mjs --set-model <executor|architect> <model-id> [--local]`.
2. Реализовать модуль `.agents/skills/architect/orchestrator/models.mjs` и флаги `--models`, `--set-model <executor|architect> <model>`, `--local` в `cli.mjs` и `run.mjs` (`T-082`) по эталонному тесту `.agents/skills/architect/orchestrator/models.test.mjs`.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-053`) хранится в `docs/decisions.md`.
- **ADR-054 (`2026-11-05`, Принято): Двухшаговый сценарий `/architect model` в `SKILL.md` (`v3.35`) и модуль `orchestrator/models.mjs` (`--models`, `--set-model <executor|architect> <id> [--local]`).** При вызове `/architect model` Архитектор пропускает чтение `PLAN.md`, `decisions.md`, `executor-profiles.md` и `--status`, вызывает `run.mjs --models`, показывает текущие модели обеих ролей и проводит выбор в 2 шага: (1) роль (`Executor` / `Architect` / `Both`), (2) модель со всеми уровнями `effort` из доступных в окружении, после чего записывает выбор через `run.mjs --set-model <executor|architect> <id> [--local]`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/models.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [x] T-082: Реализовать модуль orchestrator/models.mjs и CLI-флаги --models и --set-model <executor|architect> <model> [--local] в cli.mjs и run.mjs
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (`flash`)
  - Читать: `.agents/skills/architect/orchestrator/models.test.mjs`, `.agents/skills/architect/orchestrator/cli.mjs` (строки 30–90, 370–389), `.agents/skills/architect/orchestrator/run.mjs` (строки 20–55), `.agents/skills/architect/orchestrator/hooks.mjs` (строки 17–103), `.agents/skills/architect/orchestrator/adapters/index.mjs` (строки 26–88)
  - Менять: `.agents/skills/architect/orchestrator/models.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Задача и инварианты: (1) Создать `.agents/skills/architect/orchestrator/models.mjs` с экспортом `extractEffort({ id, name })` (извлекает `'low' | 'medium' | 'high' | 'xhigh' | 'max'` из скобок в `name` или суффикса `-<level>` в `id`, иначе `null`), `resolveArchitectModelInfo({ workDir, config })` (по аналогии с `resolveExecutorModelInfo`: приоритет `.architect/config.local.json` / `.agents/orchestrator.local.json` → `.architect/config.json` / `.agents/orchestrator.json`, возвращает `{ ok, model, source, detail }`), `listAvailableModels({ workDir, config, env, listRunnerModels })` (определяет `runner` из конфига или `'agy'`, вызывает `listRunnerModels ? listRunnerModels({ runner, bin, env }) : adapter.listModels({ bin, env })` и возвращает `{ runner, models: raw.map((m) => ({ id: m.id, name: m.name, effort: extractEffort(m), runner })) }`), `setRoleModel({ workDir, role, model, local = false })` (проверяет `role === 'executor' || role === 'architect'`, проверяет валидность `model` — непустая строка, не `'inherit'` и не `/^<.*>$/`; при `local: true` записывает `{ [role]: { model } }` в `.architect/config.local.json` или `.agents/orchestrator.local.json`, не трогая общий конфиг и `AGENTS.md`; при `local: false` обновляет `obj[role].model` в существующем `.architect/config.json` или `.agents/orchestrator.json`, а для `role === 'executor'` также синхронизирует строку `Executor model:` / `Модель Исполнителя:` / `Исполнитель по умолчанию —` в существующих `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` и `^model: ...$` в `.claude/agents/executor.md`; возвращает `{ ok: true, role, model, updatedFiles }`) и `handleModelsCli({ workDir, opts, listRunnerModels, print = console.log })` (запрещает запуск при `process.env.AGENT_LOOP === '1'`, для `opts.setModel` вызывает `setRoleModel` и печатает `• ${res.role}.model set to ${res.model} (${res.updatedFiles.join(', ')})`, для `opts.models` печатает `executor: <model|not set>`, `architect: <model|not set>` и нумерованный список `1. <id>\t<name>` и возвращает `{ ok: true, runner, current: { executor, architect }, models }`). (2) В `cli.mjs` в `parseArgs` добавить `models: false, setModel: null, local: false`, разбирать `--models`, `--local` (разрешён только с `--set-model`) и `--set-model <role> <model>` (требует 2 аргумента без ведущего `--`, `role` — `executor` или `architect`), включить `opts.models` и `opts.setModel !== null` в `modeFlags` и реэкспортировать `handleModelsCli` из `./models.mjs`. (3) В `run.mjs` импортировать `handleModelsCli` и вызывать `if (opts.models || opts.setModel) return handleModelsCli({ workDir: process.cwd(), opts });` рядом с `opts.update`, сохранив `models.mjs`, `cli.mjs` и `run.mjs` строго `<= 400` строк и без пустых `catch {}`.
  - Граничные случаи: В комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`); все три файла (`models.mjs`, `cli.mjs`, `run.mjs`) обязаны оставаться `<= 400` строк и без пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/models.test.mjs`
  - Готово, когда: `models.test.mjs`, `cli.test.mjs`, `maintaining.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/models.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/maintaining.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
