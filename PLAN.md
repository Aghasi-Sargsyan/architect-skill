# PLAN

## Goal / Requirements
Цикл 23 (`v3.33 / 1.8`, Быстрый путь `/architect update` без чтения проектных файлов и защита от перезаписи незакоммиченных правок скилла в `--update`, задача `T-077`):
1. В `SKILL.md` (`v3.33`, Step 0) вынести `/architect update` первым пунктом как `Fast path`: не читать `PLAN.md`, `docs/decisions.md`, `docs/executor-profiles.md` и `--status`, не перечитывать `SKILL.md` после обновления; проверять `git status --porcelain` до апдейта (при полностью чистом дереве — сразу коммитить `arch: update architect skill to <sha>`, при грязных файлах проекта вне скилла — обновлять без автокоммита и спрашивать, при грязных отслеживаемых файлах внутри `<skill-folder>` или `EXECUTOR.md` — останавливаться до апдейта).
2. В `update.mjs`, `cli.mjs` и `run.mjs` (`T-077`) добавить проверку `git status --porcelain --untracked-files=no` по `<targetDirs>` и `EXECUTOR.md` (`.architect/EXECUTOR.md`) перед клонированием/перезаписью: если есть незакоммиченные правки в отслеживаемых файлах скилла и не передан флаг `--force` (`--update --force`), выбрасывать ошибку `uncommitted changes in skill files (<files>); commit or revert them first, or re-run with --update --force`, не затрагивая локальные правки.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-051`) хранится в `docs/decisions.md`.
- **ADR-052 (`2026-11-05`, Принято): Fast-path `/architect update` в `SKILL.md` (`v3.33`) и защита от потери незакоммиченных правок в файлах скилла при `--update` (`update.mjs`, `cli.mjs`, `run.mjs`).** При вызове `/architect update` Архитектор пропускает чтение `PLAN.md`, `decisions.md`, `executor-profiles.md` и `--status`; `updateSkill` перед перезаписью проверяет `git status --porcelain --untracked-files=no -- <targetDirs> <EXECUTOR.md>` и без флага `--force` отказывается затирать незакоммиченные правки в отслеживаемых файлах скилла, разрешая обновление при грязных файлах проекта вне скилла.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/update.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [x] T-077: Защита от перезаписи незакоммиченных отслеживаемых правок в папке скилла и EXECUTOR.md при --update и флаг --force
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/update.mjs` (строки 40–159), `.agents/skills/architect/orchestrator/cli.mjs` (строки 30–86), `.agents/skills/architect/orchestrator/run.mjs` (строки 40–55), `.agents/skills/architect/orchestrator/update.test.mjs` (строки 240–330)
  - Менять: `.agents/skills/architect/orchestrator/update.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Задача и инварианты: (1) в `parseArgs` (`cli.mjs`) добавить булево поле `force: false`, обрабатывать флаг `--force` и проверять `if (opts.force && !opts.update) throw new Error('--force is allowed only with --update')`; (2) в `run.mjs` передавать `force: opts.force` в `handleUpdateCli({ workDir: process.cwd(), realGit, force: opts.force })`; (3) в `updateSkill` и `handleUpdateCli` (`update.mjs`) принимать `force = false`; если `!force`, `g` найден и `existsSync(path.join(workDir, '.git'))`, перед `mkdtempSync`/клонированием собрать существующие пути из `targetDirs`, `path.join(workDir, 'EXECUTOR.md')` и `path.join(workDir, '.architect', 'EXECUTOR.md')` и вызвать `spawnSync(g, ['status', '--porcelain', '--untracked-files=no', '--', ...checkPaths], { cwd: workDir, encoding: 'utf8' })`; если `res.status === 0 && res.stdout && res.stdout.trim()`, извлечь список затронутых файлов и выбросить `new Error('uncommitted changes in skill files (' + dirtyFiles.join(', ') + '); commit or revert them first, or re-run with --update --force')`; каждый изменяемый файл (`update.mjs`, `cli.mjs`, `run.mjs`) обязан оставаться `<= 400` строк и без пустых `catch {}`.
  - Граничные случаи: неотслеживаемые (`??`) файлы скилла в свежеинициализированном репозитории без коммитов (`T-073 (b)`) и изменённые файлы проекта вне папки скилла и `EXECUTOR.md` не должны блокировать `--update`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/update.test.mjs`
  - Готово, когда: `update.test.mjs` (включая `T-077`) полностью проходит, `update.mjs`, `cli.mjs` и `run.mjs` `<= 400` строк.
  - Проверка: `node --test .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/maintaining.test.mjs tests/repo-install.test.mjs`
