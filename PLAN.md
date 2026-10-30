# PLAN

## Goal / Requirements
Этап 4 (Цикл 14): Живой замер `evals` (`v3.28 / 1.8`) и подготовка к публикации.
- Живой прогон поведенческих `evals` на текущем ядре `v3.28`: 5 сценариев × 2 модели (`agy` Argon и `claude` haiku); повтор — только для ячеек с `ERROR` и не больше одного раза (`maxErrorRetries: 1`); если какая-то ячейка `FAIL` — остановиться и показать разбор без изменения правил.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь Этапа 4)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-29T19-28-29-841Z @ cde76a4: 9/10 PASS` (`FAIL claude:haiku high_risk_frozen_test`), `eval 2026-10-30T12-11-59-225Z @ 6e8471c: 1/1 PASS`, `eval 2026-10-30T12-13-40-767Z @ 6e8471c: 1/1 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` после S5 пройдено 2 из 3 прогонов, `NOT VERIFIED (sample < 5)`).
- **Замена проверки времени в `guards-shim-speed.test.mjs`:** перевод существующего теста скорости с `performance.now` на структурную проверку (счётчик вызовов/чтений или размер файла).
- **Контроль неизменности `HEAD` хоста во время `runLiveEvals` (`evals.mjs`):** фиксировать `Commit:` на старте прогона и сверять с `HEAD` после каждого хода и при записи `results.md`.
- **CI GitHub Actions (`.github/workflows/ci.yml`):** только `macos-latest`, матрица Node `22` и `24`.
- **Чистка личных данных:** проверка и очистка отслеживаемых файлов от путей `/Users/...`, почты, имён сторонних проектов, упоминаний Supabase и ключей.
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** выгрузка `.agents/skills/architect/` в отдельный публичный репозиторий под лицензией `MIT` с чистой историей и CI-матрицей GitHub Actions на Node 22 и Node 24 — финальным шагом после Этапа 4, только по отдельной команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-039`) хранится в `docs/decisions.md`.

## Frozen
- `EXECUTOR.md`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
