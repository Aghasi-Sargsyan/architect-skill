# PLAN

## Goal / Requirements
Этап 4 (Цикл 14): Живой замер `evals` (`v3.28 / 1.8`) и подготовка к публикации.
- **Живой замер поведенческих `evals` (`v3.28 / 1.8`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (5 сценариев × 2 модели: `claude:haiku` `5/5 PASS` и `agy:gemini-4-argon-high` `5/5 PASS`, все с 1-й попытки, `maxErrorRetries: 1`).
- Контроль неизменности `HEAD` хоста во время `runLiveEvals` (`evals.mjs`) и замена `performance.now` в `guards-shim-speed.test.mjs` на структурную проверку (`T-060`).
- CI GitHub Actions (`.github/workflows/ci.yml`: только `macos-latest`, матрица Node `22` и `24`) и чистка оставшихся следов родительского проекта в тестах (`T-061`).

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-29T19-28-29-841Z @ cde76a4: 9/10 PASS` (`FAIL claude:haiku high_risk_frozen_test`), `eval 2026-10-30T12-11-59-225Z @ 6e8471c: 1/1 PASS`, `eval 2026-10-30T12-13-40-767Z @ 6e8471c: 1/1 PASS`, `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` после S5 пройдено 3 из 4 прогонов, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** выгрузка `.agents/skills/architect/` в отдельный публичный репозиторий под лицензией `MIT` с чистой историей и CI-матрицей GitHub Actions на Node 22 и Node 24 — финальным шагом после Этапа 4, только по отдельной команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-039`) хранится в `docs/decisions.md`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs` — эталонный тест `T-060`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [ ] T-060: Host HEAD invariance in runLiveEvals (evals.mjs) and structural interval assertions in guards-shim-speed.test.mjs
  - Контекст: (1) `runLiveEvals` в `evals.mjs` сейчас проверяет только чистоту дерева (`git status --porcelain`), но не сдвиг `HEAD` хоста во время хода (например, если внутри хода был сделан коммит на хосте). Нужно фиксировать `preHostHead = runGit(realGit, hostDir, ['rev-parse', 'HEAD'])` до старта (бросать ошибку, если `!preHostHead`), после каждого хода проверять `postHostHead === preHostHead` (иначе бросать ошибку `runLiveEvals: Host repository HEAD changed during turn (${preHostHead} -> ${postHostHead})`), а при записи `results.md` использовать `Commit: ${preHostHead}`, сохраняя `evals.mjs <= 400` строк (`split('\n').length <= 400`). (2) В `guards-shim-speed.test.mjs` тест `T-041: askPermission, watch, and follow resolve intervals...` использует `performance.now()`, что запрещено `AGENTS.md §4` (`findTestTimers` в `selfcheck.mjs`). Нужно экспортировать `resolveInterval` из `feed.mjs` и `ask.mjs` и заменить все вызовы `performance.now()` в `guards-shim-speed.test.mjs` на структурные проверки `resolveInterval` и детерминированных кодов возврата `watch` (`code: 3` vs `code: 0`), `follow` и `askPermission` (`'2'` vs `null`), сохраняя `>= 2` тестов и `>= 19` вызовов `assert.*` и `0` таймеров реального времени (`performance.now(`, `Date.now(`, `process.hrtime`, `console.time(`).
  - Риск: высокий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/evals.mjs`, `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/guards-shim-speed.test.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`
  - Менять: `.agents/skills/architect/orchestrator/evals.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/guards-shim-speed.test.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`, `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`
    - `runLiveEvals` бросает ошибку с `rev-parse HEAD` или `HEAD`, если в `hostDir` нет коммитов (`!preHostHead`).
    - `runLiveEvals` бросает ошибку с `HEAD changed`, если во время `runTurn` коммит `HEAD` в `hostDir` изменился (даже при чистом `git status --porcelain`), и не записывает строку `Commit:` в `results.md`.
    - `evals.mjs`, `feed.mjs`, `ask.mjs` остаются `<= 400` строк (`split('\n').length <= 400`).
    - `guards-shim-speed.test.mjs` не содержит `performance.now(`, `Date.now(`, `process.hrtime`, `console.time(`, сохраняет `>= 2` тестов и `>= 19` вызовов `assert.*` и проходит зелёным.
  - Проверка: `node --test .agents/skills/architect/orchestrator/plan-reference-tests.test.mjs .agents/skills/architect/orchestrator/guards-shim-speed.test.mjs .agents/skills/architect/orchestrator/evals-permissions.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs .agents/skills/architect/orchestrator/ask.test.mjs`
  - Критерий приёмки: проверка зелёная.

- [ ] T-061: GitHub Actions macOS CI workflow (.github/workflows/ci.yml) and test fixture hygiene
  - Контекст: (1) Создать `.github/workflows/ci.yml`: запуск на `push` и `pull_request`, только `macos-latest` (без `ubuntu`), матрица `node-version: [22, 24]`, шаги `actions/checkout@v4`, `actions/setup-node@v4`, прогон `VERIFY_STEP_A1=1 npm test` и `node .agents/skills/architect/orchestrator/run.mjs --self-check`. (2) Очистить оставшиеся строки родительского проекта в тестах оркестратора без уменьшения числа `test(...)` и `assert.*`: в `events.test.mjs` заменить `'PRIVATE_USER_TAKEOUT_DATA_42'`, `'scripts/test-takeout-pipeline.ts'` и `'MyActivity.json'` на нейтральные строки (`'PRIVATE_SECRET_PAYLOAD_42'`, `'scripts/run-migration.ts'`, `'secrets.json'`); в `packaging-clean.test.mjs` заменить `'Workspace task ID'` на `'host task ID'`; в `permissions-paths.test.mjs` заменить имя тестовой папки `'Workspace'` / `'Workspace-old'` на `'my-app'` / `'my-app-old'`. (3) В `packaging-clean.test.mjs` добавить `assert.*` проверки, что в файлах `.agents/skills/architect/` нет подстрок `PRIVATE_USER_TAKEOUT_DATA` / `MyActivity.json` / `/Users/aghasi`, а если в корне хост-репозитория есть `.github/workflows/ci.yml`, он содержит `macos-latest`, `22`, `24` и не содержит `ubuntu`.
  - Риск: низкий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: T-060
  - Читать: `.agents/skills/architect/orchestrator/events.test.mjs`, `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/permissions-paths.test.mjs`, `package.json`
  - Менять: `.github/workflows/ci.yml`, `.agents/skills/architect/orchestrator/events.test.mjs`, `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/permissions-paths.test.mjs`
  - Не трогать: `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/events.test.mjs`, `.agents/skills/architect/orchestrator/permissions-paths.test.mjs`
  - Проверка: `node --test .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs .agents/skills/architect/orchestrator/permissions-paths.test.mjs`
  - Критерий приёмки: проверка зелёная, число `test(...)` и `assert.*` в каждом изменённом тест-файле не уменьшилось.
