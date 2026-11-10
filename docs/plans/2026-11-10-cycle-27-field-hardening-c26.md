# План — Цикл 27: Защита от повторного запроса уже разрешённых правил (`proposeRules`), автоотказ `shasum`/`sha256sum`/`md5`, привязка `tty: Boolean(rl)` и учёт продолжения после эскалации в `runRedCheck`

## Цель / Требования
Устранить сбои, выявленные при аудите 26-го цикла на реальном проекте (`sl-factory-kit`, задачи `T-070`, `T-074`, `T-075`):
1. В `permissions.mjs` (`proposeRules`) и `run.mjs`: если предлагаемое правило (`p` или `full`) уже присутствует в списке `allow` настроек раннера (`settings.json`), автоматически отказывать (`{ auto: true, reason: '...', fileTool: false }`) с подсказкой в `prompts.mjs` (`autoRefusalPrompt`) передавать путь к папке или файлу без неэкранированных shell-глобов (`*.css`, `*.js`), вместо повторного запроса пользователю `1. Always — rule command(git grep)`.
2. В `permissions.mjs`: добавить `'shasum'`, `'sha256sum'`, `'md5'` в `FILE_BINARIES` (без изменения 30 базовых команд `BASE_COMMANDS`), чтобы терминальные хеш-утилиты мгновенно получали автоотказ (`use built-in file tools`).
3. В `run.mjs`: передавать в `askPermission` параметр `tty: Boolean(rl)` вместо `tty: Boolean(process.stdin.isTTY)`, чтобы оркестратор, запущенный без `--pause` внутри псевдотерминала (PTY), записывал `.agent-runs/question.json` и уведомлял наблюдателя `--watch`, а не блокировался навсегда на чтении `stdin`.
4. В `evidence.mjs` (`runRedCheck`): поддерживать чтение `.architect/PLAN.md` (помимо `PLAN.md` и `config.paths.planPath`) и пропускать `red-check` (`skipped: true`), если открытая задача продолжает работу после эскалации поверх незакоммиченных правок Исполнителя в рабочем дереве (`resolveEscalationResume(...).ok === true`).

## Контракты
- `proposeRules(command, blockedScripts = [], optsOrWorkDir = null)` в `.agents/skills/architect/orchestrator/permissions.mjs`:
  - `optsOrWorkDir` поддерживает необязательное поле `allow: string[]` (массив строк правил из `settings.json`, например `["command(git grep)", "Bash(git grep:*)"]`).
  - После вычисления короткого префикса `p` и нормализованной команды `full`, если передан непустой `allow`, функция нормализует правила из `allow` (снимая обёртки `command(...)` и `Bash(...:*)` / `Bash(...)`) и проверяет, входит ли `p` или `full` в множество уже разрешённых правил.
  - Если `p` или `full` уже есть в `allow`, `proposeRules` возвращает `{ auto: true, reason: 'rule "command(' + (p || full) + ')" is already in allowlist, but runner rejected this command form (avoid unquoted globs like *.css or pass a directory path)', fileTool: false }`.
- `FILE_BINARIES` в `.agents/skills/architect/orchestrator/permissions.mjs`:
  - Включает `'shasum'`, `'sha256sum'`, `'md5'` (инвариант `BASE_COMMANDS.length === 30` остаётся неизменным).
- `autoRefusalPrompt(role, { command, reason, suggestedCommand })` в `.agents/skills/architect/orchestrator/prompts.mjs`:
  - Если `reason` содержит `already in allowlist`, добавляет подсказку передавать путь к директории или конкретному файлу без неэкранированных shell-глобов (`*.css`, `*.js`) либо использовать встроенные файловые тулы.
- `run.mjs`:
  - Передаёт текущие правила `allow` из `readAgyRules(adapter.permissions.settingsPath(os.homedir(), workDir)).allow` в `proposeRules(step.command, config.blockedNpmScripts, { workDir, allow })`.
  - В `askPermission(...)` передаёт `tty: Boolean(rl)` вместо `tty: Boolean(process.stdin.isTTY)`.
- `runRedCheck({ realGit, cwd, baseSha, plan, config })` в `.agents/skills/architect/orchestrator/evidence.mjs`:
  - При `plan === undefined` ищет план по кандидатам `[config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)` на диске и в `HEAD:<candidate>`.
  - Если для любой открытой задачи (`!t.done`) выполняется `resolveEscalationResume({ realGit, workDir: cwd, task: t, layout: config?.paths }).ok === true`, возвращает `{ ok: true, skipped: true, reason: 'resuming ' + t.id + ' after escalation on dirty working tree: red-check skipped', violations: [], notVerified: [], checked: [] }`.

## Решения
- ADR-058: Автоотказ при повторном срабатывании уже разрешённого правила в `proposeRules`, блокировка `shasum`/`sha256sum`/`md5` в `FILE_BINARIES`, привязка `tty: Boolean(rl)` в `run.mjs` и пропуск `runRedCheck` при продолжении после эскалации.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
- `.agents/skills/architect/orchestrator/evidence.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [x] T-084: Auto-refuse already-allowlisted rules in proposeRules/run.mjs, block shasum/sha256sum/md5 in FILE_BINARIES, add glob hint in autoRefusalPrompt, and bind tty: Boolean(rl) in run.mjs
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (`flash`)
  - Читать: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (строки 75–175), `.agents/skills/architect/orchestrator/permissions.mjs` (строки 15–36, 178–232), `.agents/skills/architect/orchestrator/prompts.mjs` (строки 20–50), `.agents/skills/architect/orchestrator/run.mjs` (строки 15–20, 190–215)
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Задача и инварианты: (1) В `permissions.mjs`: добавить `'shasum'`, `'sha256sum'`, `'md5'` в `FILE_BINARIES` (массив `BASE_COMMANDS` из 30 элементов не менять); в `proposeRules(command, blockedScripts = [], optsOrWorkDir = null)` после вычисления `p` проверить массив `optsOrWorkDir?.allow`: если он непустой, нормализовать каждое правило `r` через `normalizeCommand(String(r).replace(/^command\((.*)\)$|^Bash\((.*?)(?::\*)?\)$/, '$1$2'))` в `Set`, и если `(p && allowSet.has(p)) || allowSet.has(full)`, вернуть `{ auto: true, reason: \`rule "command(\${existing})" is already in allowlist, but runner rejected this command form (avoid unquoted globs like *.css or pass a directory path)\`, fileTool: false }` (уплотнить соседние строки в `proposeRules`, чтобы `permissions.mjs` оставался строго `<= 400` строк). (2) В `prompts.mjs` (`autoRefusalPrompt`): если `/already in allowlist/i.test(why)`, задать `hint = ' Pass a directory path or explicit file path instead of an unquoted glob (e.g. use a directory path instead of *.css / *.js), or use built-in file tools.'` и стандартный `cont`. (3) В `run.mjs`: импортировать `readAgyRules` из `./permissions.mjs`, в вызове `proposeRules` передать `{ workDir, allow: readAgyRules(adapter.permissions.settingsPath(os.homedir(), workDir)).allow }`, а в вызове `askPermission` заменить `tty: Boolean(process.stdin.isTTY)` на `tty: Boolean(rl)`, сохранив `run.mjs <= 400` строк.
  - Граничные случаи: В комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`); все изменяемые файлы (`permissions.mjs`, `prompts.mjs`, `run.mjs`) обязаны оставаться строго `<= 400` строк и без пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
  - Готово, когда: `field-permissions-prompts.test.mjs`, `permissions.test.mjs`, `prompts.test.mjs` и `run.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [x] T-085: Support .architect/PLAN.md in runRedCheck and skip red-check when resuming a task after escalation on a dirty working tree (evidence.mjs)
  - Риск: высокий
  - Зависит от: T-084
  - Модель: Gemini Flash (`flash`)
  - Читать: `.agents/skills/architect/orchestrator/evidence.test.mjs` (строки 200–310), `.agents/skills/architect/orchestrator/evidence.mjs` (строки 1–15, 193–245), `.agents/skills/architect/orchestrator/check.mjs` (строки 55–116)
  - Менять: `.agents/skills/architect/orchestrator/evidence.mjs`
  - Задача и инварианты: (1) В `evidence.mjs` импортировать `resolveEscalationResume` из `./check.mjs`. (2) В `runRedCheck` при `!parsedPlan` искать план по очереди в `[config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)` — сначала через `existsSync(path.join(cwd, rel))` + `readFileSync`, затем через `git(realGit, cwd, ['show', \`HEAD:\${rel}\`])` (с непустым обработчиком `catch`), и только при отсутствии всех вариантов использовать `{ tasks: [], frozen: [] }`. (3) Перед циклом по `highRiskTasks` проверить открытые задачи `(parsedPlan.tasks ?? []).filter((t) => !t.done)`: если для какой-либо открытой задачи `resolveEscalationResume({ realGit, workDir: cwd, task: t, layout: config?.paths }).ok` равно `true`, вернуть `{ ok: true, skipped: true, reason: \`resuming \${t.id} after escalation on dirty working tree: red-check skipped\`, violations: [], notVerified: [], checked: [] }`.
  - Граничные случаи: В комментариях `evidence.mjs` не использовать идентификаторы `T-NNN` и не оставлять пустых `catch {}` (`packaging-clean.test.mjs`); `evidence.mjs` обязан оставаться строго `<= 400` строк.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/evidence.test.mjs`
  - Готово, когда: `evidence.test.mjs`, `selfcheck.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/evidence.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`

## Ретроспектива

| Измерение | Результат |
|---|---|
| Границы (`Менять` / `Frozen`) | OK — `d03bdc8` (`T-084`) меняет только `.agents/skills/architect/orchestrator/{permissions,prompts,run}.mjs`; `7f4fb42` (`T-085`) меняет только `.agents/skills/architect/orchestrator/evidence.mjs`. Все файлы уложились в лимит `≤ 400` строк (`permissions.mjs` — 398, `prompts.mjs` — 130, `run.mjs` — 396, `evidence.mjs` — 339). Файлы из `Frozen` (`EXECUTOR.md`, `field-permissions-prompts.test.mjs`, `evidence.test.mjs`) не затронуты. |
| Git | OK — коммиты плана (`9eebae5`), задач (`d03bdc8`, `7f4fb42`) и приёмки (`5b607f6`, `51cd2ea`) разделены, без amend и без посторонних коммитов вне `arch:` / `T-NNN`. |
| Обходы проверок | OK — независимый grep по добавленным строкам `fe046a4..51cd2ea` в `.agents/skills/architect/orchestrator` не выявил ни одного обхода (`0` совпадений). |
| Эскалации | OK — 0 эскалаций, 0 скрытых отклонений от плана. |
| Приёмка | OK — `T-084` и `T-085` приняты с первой попытки (0 раундов `Доработать`). Профили Исполнителей (`docs/executor-profiles.md`) обновлены для пары `Gemini Flash (subagent, уровень неизвестен)` (`T-084`, `T-085`). |
| Контекст | OK — контекста `PLAN.md` и замороженных эталонных тестов (`field-permissions-prompts.test.mjs`, `evidence.test.mjs`) хватило без истории чата. |

Rules: added 0 / removed 0
