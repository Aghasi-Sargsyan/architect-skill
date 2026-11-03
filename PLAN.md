# PLAN

## Goal / Requirements
Скилл `architect` (`v3.28 / 1.8`) и репозиторий полностью подготовлены к публикации и приглашению тестировщиков: все 16 циклов закрыты (`200/200 PASS`, `Self-check PASSED`), в корне добавлены `README.md` (с разделом `Feedback`) и `LICENSE`, добавлена форма обратной связи `.github/ISSUE_TEMPLATE/field-report.yml`, в `.github/workflows/ci.yml` включён `fetch-depth: 0` (первый облачный прогон GitHub Actions https://github.com/Aghasi-Sargsyan/architect-skill/actions/runs/41631020713 на `bb3bf8c` — `success`, Node 22 и 24), во всех не-тестовых `.mjs` модулях оркестратора устранены пустые `catch {}`, а `--init` и `templates/claude-agent-executor.md` требуют явного выбора модели человеком.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** `git push` — только по отдельной прямой команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-041`) хранится в `docs/decisions.md`. Следующий номер: `ADR-042`.

## Frozen
- `EXECUTOR.md`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
Следующий номер задачи: `T-065`.
