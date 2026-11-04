# PLAN

## Goal / Requirements
Цикл 22 (`v3.31 / 1.8`, Механический гейт увеличения версии при правке правил скилла и релиз `v3.31 / 1.8`, задача `T-076`):
1. В `runSelfCheckGit` (`.agents/skills/architect/orchestrator/selfcheck.mjs`) добавить детерминированную проверку: если между `baseSha` и `HEAD` изменился `SKILL.md` или `references/*.md` (и при этом не обновлялся `.version`, т.е. это не клиентский `--update`), то версия `# Architect Prompt vX.Y` в `HEAD:SKILL.md` обязана быть строго больше, чем в `baseSha:SKILL.md`; аналогично при изменении `EXECUTOR.md` версия `<!-- executor-policy-version: A.B -->` в `HEAD:EXECUTOR.md` обязана быть строго больше, чем в `baseSha:EXECUTOR.md`.
2. Синхронизировать версию `v3.31 / 1.8` (`package.json` `3.31.0`, `SKILL.md`, `README.en.md`, `README.ru.md`, `README.md`, `CHANGELOG.md`) и зафиксировать правило в `AGENTS.md` §4.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-049`) хранится в `docs/decisions.md`.
- **ADR-050 (`2026-11-05`, Принято): Механический гейт увеличения версии при изменении правил скилла в `runSelfCheckGit` (`selfcheck.mjs`).** Если в диапазоне `baseSha..HEAD` затронуты `SKILL.md` или `references/*.md` (без изменения `.version`), `runSelfCheckGit` проверяет, что версия `# Architect Prompt vX.Y` в `HEAD` строго больше версии в `baseSha`; аналогично при изменении `EXECUTOR.md` проверяется строгий рост `<!-- executor-policy-version: A.B -->`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/selfcheck.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [ ] T-076: Механический гейт увеличения версии при изменении SKILL.md, references/*.md и EXECUTOR.md в selfcheck.mjs
  - Риск: высокий
  - Менять: `.agents/skills/architect/orchestrator/selfcheck.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/selfcheck.test.mjs`, `EXECUTOR.md`
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Тест-кейсы: `.agents/skills/architect/orchestrator/selfcheck.test.mjs`
  - Приёмка: В `runSelfCheckGit` (`selfcheck.mjs`) проверяется набор изменённых файлов в коммитах `allCommits` (`baseSha..HEAD`). Если в этом диапазоне НЕ менялся файл `.version` (`!changed.some((f) => f === '.version' || f.endsWith('/.version'))`), то: (1) если изменён `SKILL.md` или `references/*.md`, версия `# Architect Prompt vX.Y` в `HEAD:SKILL.md` должна быть строго больше версии в `baseSha:SKILL.md` (иначе добавляется нарушение `skill rule files changed since <base7> without bumping version in <skillFile> (still v<ver>)`); (2) если изменён `EXECUTOR.md`, версия `<!-- executor-policy-version: A.B -->` в `HEAD:EXECUTOR.md` должна быть строго больше версии в `baseSha:EXECUTOR.md` (иначе добавляется нарушение `EXECUTOR.md changed since <base7> without bumping version in <execFile> (still <ver>)`); `selfcheck.mjs` остаётся строго `<= 400` строк и без пустых `catch {}`; эталонный тест `T-076` в `selfcheck.test.mjs` проходит.
  - Проверка: `node --test .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/maintaining.test.mjs .agents/skills/architect/orchestrator/skill-packaging.test.mjs tests/repo-install.test.mjs`
  - Зависимости: нет
