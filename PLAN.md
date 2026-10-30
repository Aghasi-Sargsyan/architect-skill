# PLAN

## Goal / Requirements
Этап 3 (Цикл 13): Приёмка «глазами чужого человека» и механический контроль вне цикла.
- Команда `--check-task T-NNN [--base <ref>]` (`T-057`) для механической проверки коммитов Исполнителя вне цикла оркестратора (границы `Change`, `Frozen`, обходы проверок через `checkExecutorRun` из `mechanics.mjs`), работающая как с `.agents/orchestrator.json`, так и без него (в ручном / субагентном режиме).
- Проверка `checkExecutorModelConfig` в `--check` и `localChecks` (`T-057`), которая предупреждает, если модель Исполнителя нигде не задана (`executor.model` в конфиге, `Executor model: ...` в `AGENTS.md` / `CLAUDE.md` или `model:` в `.claude/agents/executor.md`) или если `.claude/agents/executor.md` содержит `model: inherit` или не содержит `model:`.
- Механическая проверка языка и формата сообщений коммитов (`T-058`, код, риск высокий):
  - (а) поле конфига `commitLanguage` (по умолчанию не задано — проверки нет; `"en"` — в теме коммита запрещены буквы не латинского алфавита);
  - (б) хук `commit-msg` на Node без зависимостей (`--install-hooks` и в составе `--init`; `--check` проверяет через `checkCommitMsgHook`, что он стоит; хук отклоняет коммит не на том языке и коммиты `arch:` / `T-NNN` не по формату — в том числе коммит, который только отмечает задачу `[x]` в `PLAN.md`, но не начинается с `arch: accept T-NNN` или `arch: приёмка T-NNN`; существующий хук не перезаписывать: если он есть или задан `core.hooksPath` — сообщить в `--check` и не ставить);
  - (в) `--self-check` показывает такие коммиты в диапазоне как предупреждение (`warnings`), а не блок (`ok: true`, историю не переписываем);
  - (г) блокировка `git commit --no-verify` (`-n`) в git-шим оркестратора (`guards.mjs`) и `commandProblem` (`permissions.mjs`).
- Приёмка «глазами чужого человека» во временных репо (`/tmp`: TS + Vitest и Python + pytest): установка скилла в `.claude/skills/architect/` и `.agents/skills/architect/` строго по README, ручной режим (план → задача Исполнителю → приёмка) и `--check` / `--dry-run` / `--self-check` (без `--write-permissions` на чужих репо), обновление копии скилла в `~/Desktop/Workspace`.

### Очередь следующих циклов
- **Замена проверки времени в `guards-shim-speed.test.mjs`:** перевод существующего теста скорости с `performance.now` на структурную проверку (счётчик вызовов/чтений или размер файла).
- **Контроль неизменности `HEAD` хоста во время `runLiveEvals` (`evals.mjs`):** `preStatus` / `postHostStatus` сейчас проверяют только чистоту дерева (`git status --porcelain`), но не сдвиг `HEAD` — фиксировать `Commit:` на старте прогона и сверять с `HEAD` при записи `results.md`.
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-29T19-28-29-841Z @ cde76a4: 9/10 PASS` (`FAIL claude:haiku high_risk_frozen_test`), `eval 2026-10-30T12-11-59-225Z @ 6e8471c: 1/1 PASS`, `eval 2026-10-30T12-13-40-767Z @ 6e8471c: 1/1 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` после S5 пройдено 2 из 3 прогонов, `NOT VERIFIED (sample < 5)`; перед Этапом 4 запускается живой прогон 5 сценариев × 2 модели: `agy` Argon и `claude` haiku).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Этап 4 (Подготовка к публикации):** CI GitHub Actions (`.github/workflows/ci.yml`: только `macos-latest`, Node 22 + Node 24) и финальная чистка личных данных (`/Users/...`, почта, имена проектов, Supabase, ключи).
- **Публикация скилла (`E4`):** выгрузка `.agents/skills/architect/` в отдельный публичный репозиторий под лицензией `MIT` с чистой историей и CI-матрицей GitHub Actions на Node 22 и Node 24 — финальным шагом после Этапа 4, только по отдельной команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-038`) хранится в `docs/decisions.md`.
- **ADR-039 (Механический контроль коммитов и модели Исполнителя вне цикла):** (1) Новый модуль `hooks.mjs` объединяет проверку конфигурации модели Исполнителя (`checkExecutorModelConfig`: `executor.model` в конфиге, `Executor model: ...` в `AGENTS.md`/`CLAUDE.md`, запрет `model: inherit` или отсутствия `model` в `.claude/agents/executor.md`), валидацию сообщений коммитов (`validateCommitMessage`: `commitLanguage: "en"` запрещает нелатинские буквы `/[^\P{L}\p{Script=Latin}]/u` в теме; проверка формата `T-NNN:` / `arch:` и обязательного префикса `arch: accept T-NNN` / `arch: приёмка T-NNN` для коммита, который только отмечает задачу `[x]` в `PLAN.md`), установку и проверку zero-dependency Node-хука `.git/hooks/commit-msg` (`installCommitMsgHook` / `checkCommitMsgHook` без перезаписи чужого хука или `core.hooksPath`) и сканирование диапазона для предупреждений (`warnings`) в `--self-check`. (2) Флаг `--check-task T-NNN [--base <ref>]` в `cli.mjs` и `run.mjs` запускает `checkExecutorRun` вне цикла оркестратора (в том числе без `.agents/orchestrator.json` через `loadConfigOrDefaults`). (3) `writeGitShim` в `guards.mjs` и `commandProblem` в `permissions.mjs` блокируют `--no-verify` и `git commit -n`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/check-task.test.mjs` — эталонный тест `T-057`
- `.agents/skills/architect/orchestrator/commit-hooks.test.mjs` — эталонный тест `T-058`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-057: Out-of-loop Executor commit verification (--check-task) and Executor model check in --check (ADR-039)
  - Контекст: при запуске Исполнителя субагентом или вручную в отдельном чате `--self-check` пропускает коммиты `T-NNN`, а `checkExecutorRun` вызывается только внутри `npm run agents`. Нужна отдельная команда `--check-task T-NNN [--base <ref>]` (работающая даже без созданного `.agents/orchestrator.json`), а также проверка `checkExecutorModelConfig` в `hooks.mjs` / `check.mjs`, которая предупреждает, если модель Исполнителя нигде не задана или `.claude/agents/executor.md` содержит `model: inherit` / не содержит `model:`. Все модули должны оставаться `<= 400` строк (`split('\n').length <= 400`).
  - Риск: высокий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/check-task.test.mjs`, `.agents/skills/architect/orchestrator/cli.test.mjs`, `.agents/skills/architect/orchestrator/check.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/hooks.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/check-task.test.mjs`, `.agents/skills/architect/orchestrator/commit-hooks.test.mjs`, `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/check-task.test.mjs`
    - `parseArgs` в `cli.mjs` поддерживает `--check-task <T-NNN>` (валидирует `/^T-\d+$/`, иначе бросает ошибку с `T-NNN`), разрешает `--base <ref>` вместе с `--self-check` или `--check-task` (сообщение об ошибке при одиночном `--base` сохраняет подстроку `--base is allowed only with --self-check or --check-task`), и включает `opts.checkTask !== null` в `modeFlags`.
    - `loadConfigOrDefaults(configPath, workDir)` в `cli.mjs` вызывает `safeLoadConfig(configPath)`, а если файл конфига по умолчанию не существует (`missing config`), возвращает дефолтный конфиг на базе `DEFAULTS` с `executor: { model: '' }` и `_missingConfigFile: true`.
    - `runCheckTask({ realGit, workDir, config, taskId, baseRef, orchestratorDir })` и `handleCheckTaskCli` в `cli.mjs` (вызывается из `run.mjs` при `opts.checkTask`): находят задачу `taskId` в `PLAN.md`, определяют `baseSha` (если `baseRef` не передан — SHA последнего коммита `^arch:\s` перед `HEAD`, либо родитель первого коммита задачи `<sha>^`, либо `HEAD`), вызывают `checkExecutorRun`, печатают `formatMechanicsReport` и выставляют `process.exitCode = 1` при `!res.ok`.
    - `checkExecutorModelConfig({ workDir, config })` в `hooks.mjs` (вызывается в `localChecks` в `check.mjs`): (1) если в `workDir` существует `.claude/agents/executor.md` и в нём отсутствует `model:` или указано `model: inherit` (без учёта регистра), возвращает `{ ok: false, name: 'Executor model (.claude/agents/executor.md)', detail: '.claude/agents/executor.md must set an explicit "model:" (found inherit or missing)' }`; (2) если модель Исполнителя не задана ни в `config.executor.model` (при `!config._missingConfigFile` и не `'inherit'`), ни на диске в `.agents/orchestrator.json` / `.architect/config.json`, ни в `AGENTS.md` / `CLAUDE.md` (`Executor model: ...` / `Модель Исполнителя: ...` / `Исполнитель по умолчанию — ...`), ни в `.claude/agents/executor.md`, возвращает `{ ok: false, name: 'Executor model', detail: 'Executor model is not configured — set executor.model in .agents/orchestrator.json, "Executor model: ..." in AGENTS.md, or model in .claude/agents/executor.md' }`.
    - Все изменённые файлы (`hooks.mjs`, `cli.mjs`, `check.mjs`, `run.mjs`) остаются `<= 400` строк (`split('\n').length <= 400`) без пустых блоков `catch {}`.
  - Проверка: `node --test .agents/skills/architect/orchestrator/check-task.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`
  - Критерий приёмки: проверка зелёная.

- [x] T-058: Mechanical commit language & format enforcement: commitLanguage, commit-msg hook, --self-check warnings, and --no-verify guard (ADR-039)
  - Контекст: язык и формат коммитов должны проверяться механически: (а) опциональное поле конфига `commitLanguage` (`"en"` запрещает нелатинские буквы в теме коммита); (б) zero-dependency Node-хук `.git/hooks/commit-msg`, устанавливаемый через `--install-hooks` и `--init` и проверяемый в `--check` (не перезаписывает чужой хук и не ставится при `core.hooksPath`; отклоняет коммиты не на том языке, кривые `arch:` / `T-NNN` и коммиты, которые только отмечают задачу `[x]` в `PLAN.md` без префикса `arch: accept T-NNN` или `arch: приёмка T-NNN`); (в) предупреждения (`warnings`) в `--self-check` без падения (`ok: true`); (г) блокировка `git commit --no-verify` (`-n`) в `guards.mjs` и `permissions.mjs`. Все модули должны оставаться `<= 400` строк (`split('\n').length <= 400`).
  - Риск: высокий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: T-057
  - Читать: `.agents/skills/architect/orchestrator/hooks.mjs`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/commit-hooks.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/hooks.mjs`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/commit-hooks.test.mjs`, `.agents/skills/architect/orchestrator/check-task.test.mjs`, `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/commit-hooks.test.mjs`
    - В `config.mjs` `KNOWN_KEYS` включает `'commitLanguage'`, а `validateConfig` разрешает `undefined` / `null` / `''` / `'en'` и возвращает ошибку с `commitLanguage` для иных значений.
    - В `hooks.mjs` экспортируются `validateCommitMessage`, `installCommitMsgHook`, `checkCommitMsgHook`, `scanRangeCommitMessages`:
      - `validateCommitMessage({ subject, commitLanguage, stagedFiles, planDiff })` отклоняет: (1) тему с нелатинскими буквами (`/[^\P{L}\p{Script=Latin}]/u`), когда `commitLanguage === 'en'`; (2) тему, начинающуюся с `T-\d+` (регистронезависимо), но не соответствующую `/^T-\d+(?: \(fix \d+\))?: \S/`; (3) тему, начинающуюся с `arch` (`/^(?:arch:|arch\s|arch$)/i`), но не соответствующую `/^arch: \S/` (или кривой `arch: fix-frozen` / `arch: accept`); (4) коммит, в котором единственный изменённый файл — `PLAN.md` (или `.architect/PLAN.md`) и все изменённые строки в diff меняют `- [ ] T-NNN:` на `- [x] T-NNN:`, если тема не начинается с `arch: accept T-NNN` или `arch: приёмка T-NNN`.
      - `installCommitMsgHook({ workDir, realGit })` проверяет `git config --get core.hooksPath` и наличие чужого `.git/hooks/commit-msg` (без маркера `// agent-loop commit-msg hook`): если они есть, не перезаписывает и возвращает `{ installed: false, skipped: true, reason }`; иначе создаёт исполняемый (`0o755`) zero-dependency Node-скрипт `.git/hooks/commit-msg` и вызывается из `initProject` (`config.mjs`) и `--install-hooks` (`cli.mjs`, `run.mjs`).
      - `checkCommitMsgHook({ workDir, realGit })` возвращает `{ ok: true, name: 'commit-msg hook', detail }` только когда установлен хук с маркером, и `{ ok: false, name: 'commit-msg hook', detail }` с причиной (`not installed`, `core.hooksPath`, `existing ... commit-msg`), когда хук не установлен или стоит чужой; вызывается в `runCheckCommand` (`check.mjs`).
    - `runSelfCheckGit` (`selfcheck.mjs`), `runFastSelfCheck`, `runFullSelfCheck` и `formatSelfCheckReport` (`cli.mjs`) собирают предупреждения по коммитам диапазона `baseSha..HEAD` через `scanRangeCommitMessages` в массив `warnings` и выводят блок `Warnings (N):` без превращения их в `violations` (`res.ok === true`).
    - `writeGitShim` (`guards.mjs`) при `AGENT_LOOP=1` блокирует (exit `97`) флаг `--no-verify` и `git commit -n` (включая короткие групповые флаги с `n`, такие как `-an`, `-nm`), а `commandProblem` (`permissions.mjs`) отклоняет команды `git` с `--no-verify` и `git commit` с `-n`.
    - Все изменённые модули остаются `<= 400` строк (`split('\n').length <= 400`) без пустых блоков `catch {}`.
  - Проверка: `node --test .agents/skills/architect/orchestrator/commit-hooks.test.mjs .agents/skills/architect/orchestrator/check-task.test.mjs .agents/skills/architect/orchestrator/config.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/layout.test.mjs`
  - Критерий приёмки: проверка зелёная.

- [x] T-059: Non-blocking Linux warning in --check / localChecks
  - Контекст: оркестратор официально поддерживает только macOS; Linux и WSL2 не тестируются, Windows не поддерживается. В `localChecks` (`check.mjs`) проверка `OS` на `platform === 'linux'` должна возвращать `ok: true` (не блок), но с предупреждением в `detail`: `"linux (untested, use at your own risk — officially supported: macOS)"`. Код для Linux не удалять.
  - Риск: низкий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: T-058
  - Читать: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/check.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/check.test.mjs`
  - Не трогать: `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: в `check.test.mjs`: `localChecks({ config: config(), workDir: dir, realGit, platform: 'linux' })` возвращает `OS` с `ok: true` и `detail`, содержащим `untested` и `use at your own risk`.
  - Проверка: `node --test .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs`
  - Критерий приёмки: проверка зелёная, `check.mjs <= 400` строк.
