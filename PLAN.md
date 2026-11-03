# PLAN

## Goal / Requirements
Скилл `architect` (`v3.29 / 1.8`) и репозиторий полностью обновлены по итогам Цикла 17 (`203/203 PASS` на Node 22 и 24, `Self-check PASSED`): `Quickstart` в корневом `README.md` и в `README.en.md` / `README.ru.md` сокращён до двух шагов с выносом ручной настройки в `Manual Installation` / «Ручная установка», а в `SKILL.md` и `references/orchestrator.md` зафиксирован протокол первого запуска в новом проекте.
- **Живой прогон нового сценария `first_run_no_executor_model`:** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`).

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогону на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-042`) хранится в `docs/decisions.md`. Следующий номер: `ADR-043`.

## Frozen
- `EXECUTOR.md`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
Следующий номер задачи: `T-066`.
