# PLAN

## Goal / Requirements
Цикл 26 (`v3.38 / 1.8`, Компактная раскладка `.architect/` по умолчанию для новых проектов и миграция существующих `classic`-проектов одной командой `--compact` / `/architect compact`, задача `T-083`):
1. В `SKILL.md` (`v3.38`, `Step 0` и `Step 4`) и `README.*.md` закрепить раскладку `compact` (`.architect/PLAN.md`, `.architect/EXECUTOR.md`, `.architect/decisions.md`, `.architect/executor-profiles.md`, `.architect/plans/`, `.architect/config.json`) по умолчанию для всех новых проектов и добавить быстрый сценарий `/architect compact` (`/architect:compact`) для миграции существующих `classic`-проектов.
2. В оркестраторе (`layout.mjs`, `cli.mjs`, `run.mjs`, `selfcheck.mjs`, задача `T-083`): (а) переключить `loadConfigOrDefaults` в `cli.mjs` на `compact` по умолчанию в новых проектах без корневых `PLAN.md` и `EXECUTOR.md` (сохраняя `classic`, если в корне уже есть `PLAN.md` или `EXECUTOR.md`); (б) реализовать `migrateToCompact` и `handleCompactCli` в `layout.mjs` и CLI-флаг `--compact` в `cli.mjs` / `run.mjs`; (в) поддержать `.architect/PLAN.md` в `runSelfCheckGit` и `checkPostReviewSelfCheck` (`selfcheck.mjs`).

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-056`) хранится в `docs/decisions.md`.
- **ADR-057 (`2026-11-10`, Принято): Компактная раскладка `.architect/` (`compact`) по умолчанию для новых проектов и миграция `--compact` / `/architect compact` для существующих `classic`-проектов (`v3.38 / 1.8`, `T-083`).** В новых проектах без корневых `PLAN.md` и `EXECUTOR.md` Архитектор (`SKILL.md` `Step 0`, `Step 4`) и `loadConfigOrDefaults` (`cli.mjs`) по умолчанию используют раскладку `compact` (`.architect/`); для перевода существующих `classic`-проектов добавлены `migrateToCompact` / `handleCompactCli` в `layout.mjs`, флаг `--compact` в `cli.mjs` / `run.mjs` и быстрый сценарий `/architect compact` в `SKILL.md` `Step 0`, а `runSelfCheckGit` и `checkPostReviewSelfCheck` (`selfcheck.mjs`) проверяют `.architect/PLAN.md` наравне с корневым `PLAN.md`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/layout.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [x] T-083: Поддержать раскладку compact (.architect/) по умолчанию в loadConfigOrDefaults, миграцию migrateToCompact (--compact) и чтение .architect/PLAN.md в selfcheck.mjs
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (`flash`)
  - Читать: `.agents/skills/architect/orchestrator/layout.test.mjs` (строки 185–352), `.agents/skills/architect/orchestrator/layout.mjs` (строки 1–173), `.agents/skills/architect/orchestrator/cli.mjs` (строки 30–95, 130–155, 380–396), `.agents/skills/architect/orchestrator/run.mjs` (строки 20–55), `.agents/skills/architect/orchestrator/selfcheck.mjs` (строки 190–255, 380–397)
  - Менять: `.agents/skills/architect/orchestrator/layout.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`
  - Задача и инварианты: (1) В `layout.mjs` экспортировать `migrateToCompact({ workDir = process.cwd() } = {})` и `handleCompactCli({ workDir = process.cwd(), print = console.log } = {})`: проверить `process.env.AGENT_LOOP !== '1'` (иначе `throw new Error('cannot run --compact from inside the agent loop (AGENT_LOOP=1)')`) и отсутствие живого PID в `.agent-runs/.lock` через `lockHolder(path.join(workDir, '.agent-runs'))` из `./guards.mjs` (иначе `throw new Error('cannot migrate layout while orchestrator loop is running (PID ' + pid + ' in .agent-runs/.lock)')`); проверить парные пути (`['EXECUTOR.md', '.architect/EXECUTOR.md']`, `['PLAN.md', '.architect/PLAN.md']`, `['docs/decisions.md', '.architect/decisions.md']`, `['docs/executor-profiles.md', '.architect/executor-profiles.md']`, `['.agents/orchestrator.json', '.architect/config.json']`, `['.agents/orchestrator.local.json', '.architect/config.local.json']`) и файлы в `docs/plans/*.md` против `.architect/plans/<name>` — если существуют оба файла и их содержимое различается, бросить ошибку `conflicting classic and compact files: <from> vs <to>`; перенести существующие classic-файлы в `.architect/` (удаляя исходные; для `.architect/PLAN.md` заменить `- \`EXECUTOR.md\`` на `- \`.architect/EXECUTOR.md\``, `read EXECUTOR.md` на `read .architect/EXECUTOR.md`, `docs/decisions.md` на `.architect/decisions.md`, `docs/executor-profiles.md` на `.architect/executor-profiles.md`, `docs/plans/` на `.architect/plans/`; для `.architect/config.json` распарсить JSON и записать `{ layout: 'compact', ...raw }`; удалить `docs/plans` и `docs`, если они стали пустыми); в существующих `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` заменить ссылки на корневые `EXECUTOR.md`, `PLAN.md`, `.agents/orchestrator.json`, `.agents/orchestrator.local.json` на `.architect/...`, не меняя пути с `/` перед `EXECUTOR.md`/`PLAN.md` (такие как `.agents/skills/architect/EXECUTOR.md`); вернуть `{ ok: true, alreadyCompact: moved.length === 0 && updated.length === 0, moved, updated, notes }`. (2) В `cli.mjs`: в `parseArgs` добавить `compact: false`, разбирать `--compact` и включить `opts.compact` в `modeFlags`; в `loadConfigOrDefaults` при `missing config` использовать `COMPACT_CONFIG_PATH` по умолчанию, если не передан явный `configPath` и в `workDir` нет корневых `PLAN.md` и `EXECUTOR.md` (либо уже есть `.architect/PLAN.md` или `.architect/EXECUTOR.md`); реэкспортировать `handleCompactCli` из `./layout.mjs`. (3) В `run.mjs` импортировать `handleCompactCli` и вызывать `if (opts.compact) return handleCompactCli({ workDir: process.cwd() });` перед `opts.models`. (4) В `selfcheck.mjs`: в `runSelfCheckGit` читать `effectivePlanText` с приоритетом `config?.paths?.planPath`, `.architect/PLAN.md`, `PLAN.md` (и `HEAD:<path>`), а в цикле `arch: plan` коммитов вызывать `collectFrozen` для обоих путей `['PLAN.md', '.architect/PLAN.md']`; в `checkPostReviewSelfCheck` проверять `git diff -U0 baseSha HEAD -- PLAN.md .architect/PLAN.md`.
  - Граничные случаи: В комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`); все изменяемые файлы (`layout.mjs`, `cli.mjs`, `run.mjs`, `selfcheck.mjs`) обязаны оставаться строго `<= 400` строк и без пустых `catch {}` (разрешены только `/* cleanup: abort ... */`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/layout.test.mjs`
  - Готово, когда: `layout.test.mjs`, `cli.test.mjs`, `selfcheck.test.mjs`, `maintaining.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/layout.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/maintaining.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`

## Ретроспектива цикла 26 (`v3.38 / 1.8`, Компактная раскладка `.architect/` по умолчанию и миграция `--compact` / `/architect compact`)

| Измерение | Результат |
|---|---|
| Границы (`Boundaries`) | OK — коммит `913f101` (`T-083`) изменил строго только `layout.mjs`, `cli.mjs`, `run.mjs` и `selfcheck.mjs` из списка `Менять`; `Frozen` (`EXECUTOR.md`, `layout.test.mjs`) не затронут |
| Git | OK — `arch:` (`39d3cc7`, `54890fd`) и `T-083` (`913f101`) не смешаны, без amend, 0 сторонних коммитов, все SHA сверены с `git log --oneline c401b1c..HEAD` |
| Обходы (`Bypasses`) | OK — `0` срабатываний ретро-скана в `c401b1c..HEAD`; `layout.mjs` (`291` строка), `cli.mjs` (`396` строк), `run.mjs` (`396` строк), `selfcheck.mjs` (`398` строк) строго `<= 400` строк и без пустых `catch {}` |
| Эскалации (`Escalations`) | OK — `0` эскалаций |
| Приёмка (`Acceptance`) | OK — `T-083` принята с первой попытки (`0` раундов `rework`), субагент `Gemini Flash` выполнил задачу за `14 мин 37 с` |
| Контекст (`Context`) | OK — `PLAN.md` и эталонного замороженного теста `layout.test.mjs` хватило без истории чата |

- **Прогон тестов оркестратора и репозитория:** Node `v24.22.2` — `241/241 PASS` (`VERIFY_STEP_A1=1 npm test`), `--self-check`: `✓ Self-check PASSED`.
- **Rules: added 1 / removed 0** (`SKILL.md`: `32395` → `33561` байт `<= 34816` байт; синхронизация `<!-- skill-readme-sync: v3.38 / 1.8 -->` подтверждена).
  - Добавлено (1): раскладка `compact` (`.architect/`) по умолчанию для новых проектов и быстрый сценарий `/architect compact` (`/architect:compact`) в `SKILL.md` (`Step 0`, `Step 4`, `v3.38`, `ADR-057`).
  - Правила, не сработавшие за последние 3 цикла: `WAIVER <sha7>: <rule> — <reason>` (0 срабатываний за Циклы 24–26 — сохранено как защитный механизм в `selfcheck.mjs`).
