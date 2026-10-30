# PLAN

## Goal / Requirements
Скилл `architect` (`v3.28 / 1.8`) полностью отвязан от родительского проекта, проверен на сторонних проектах, покрыт живым замером `evals` (`eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS`) и подготовлен к публикации.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **CI GitHub Actions (`.github/workflows/ci.yml`):** живой облачный прогон GitHub Actions (`macos-latest`, Node 22 и 24) — `NOT VERIFIED` до первого `git push` в удалённый репозиторий.
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** создание удалённого репозитория и `git push` — только по отдельной прямой команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-039`) хранится в `docs/decisions.md`. Следующий номер: `ADR-040`.

## Frozen
- `EXECUTOR.md`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
Следующий номер задачи: `T-062`.
