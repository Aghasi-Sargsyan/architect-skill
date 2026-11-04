# PLAN

## Goal / Requirements
Цикл 21 (`v3.30 / 1.8`, Ненавязчивое уведомление о доступном обновлении скилла, задача `T-075`):
1. В `.agents/skills/architect/orchestrator/update.mjs` добавить `checkSkillUpdateAvailable({ workDir, orchestratorDir, repoUrl, realGit, nowMs, ttlMs, env, force })` и константу `UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000`.
2. Сравнивать локальный SHA из `.version` в папке установленного скилла с `git ls-remote <repoUrl> HEAD` (таймаут `1500` мс, `GIT_TERMINAL_PROMPT=0`), кэшируя результат на 24 часа в `.agent-runs/.update-check.json`. При вызове `updateSkill` очищать/обновлять кэш.
3. При недоступности сети или репозитория завершать проверку мягко (fail-open: `{ updateAvailable: false, notice: null }`), не ломая `--check` и офлайн-работу. В тестовой среде (`NODE_TEST_CONTEXT` или `ARCHITECT_NO_UPDATE_CHECK=1`) не делать сетевых запросов, если не передан явный `repoUrl` или `force: true` (при этом валидный локальный кэш `.agent-runs/.update-check.json` читается без сети).
4. Показывать информационное уведомление `! skill update available: <ver> (<localSha> -> <remoteSha>) — run "/architect update" or "node .agents/skills/architect/orchestrator/run.mjs --update"` в `runCheckCommand` (`check.mjs`), `runFullSelfCheck` / `formatSelfCheckReport` / `formatStartupNotices` (`cli.mjs`).

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-048`) хранится в `docs/decisions.md`.
- **ADR-049 (`2026-11-04`, Принято): Неблокирующая проверка обновлений с 24-часовым кэшем в `.agent-runs/.update-check.json`.** Оркестратор проверяет наличие новых коммитов в апстрим-репозитории скилла через `git ls-remote <repoUrl> HEAD` (таймаут 1.5 с, не чаще 1 раза в 24 часа, кэш в `.agent-runs/.update-check.json`) и выводит информационную строку `! skill update available: ... — run "/architect update" or "node .agents/skills/architect/orchestrator/run.mjs --update"` в `--check`, `--dry-run`, `--self-check` и при старте цикла, никогда не блокируя работу при отсутствии сети.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/update.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [ ] T-075: Ненавязчивое уведомление о наличии обновления скилла (риск: high)
  - Риск: высокий
  - Менять: `.agents/skills/architect/orchestrator/update.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/check.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/update.test.mjs`, `EXECUTOR.md`
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Тест-кейсы: `.agents/skills/architect/orchestrator/update.test.mjs`
  - Приёмка: (a) `update.mjs` экспортирует `UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000` и `checkSkillUpdateAvailable({ workDir, orchestratorDir, repoUrl, realGit, nowMs, ttlMs, env, force })` (реэкспортируется из `cli.mjs`), которая читает локальный SHA из `.version` в папке скилла, проверяет 24-часовой кэш `.agent-runs/.update-check.json`, при устаревании кэша вызывает `spawnSync(git, ['ls-remote', targetRepo, 'HEAD'], { timeout: 1500 })` и возвращает `{ updateAvailable: true, localSha, remoteSha, notice }`, если `remoteSha` отличается от `localSha` (а при отсутствии `.version`, если `remoteSha` является предком `HEAD` в `workDir` по `git merge-base --is-ancestor`, считает репозиторий актуальным); `updateSkill` очищает кэш `.agent-runs/.update-check.json`; не используется `Date.now(` (используется `Number(new Date())` или переданный `nowMs`), нет пустых `catch {}` и `catch` только с комментарием без `cleanup/abort/stop/close`; (b) при ошибке сети или недоступном `repoUrl` `checkSkillUpdateAvailable` возвращает `{ updateAvailable: false, notice: null }` без выброса исключений; в `runCheckCommand` (`check.mjs`), `runFullSelfCheck`, `formatSelfCheckReport` и `formatStartupNotices` (`cli.mjs`) при наличии обновления выводится строка с префиксом `! skill update available:`; все файлы оркестратора остаются `<= 400` строк; эталонные тесты `T-075 (a)` и `T-075 (b)` в `.agents/skills/architect/orchestrator/update.test.mjs` проходят.
  - Проверка: `node --test .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/check-env.test.mjs tests/packaging-clean.test.mjs`
  - Зависимости: нет
