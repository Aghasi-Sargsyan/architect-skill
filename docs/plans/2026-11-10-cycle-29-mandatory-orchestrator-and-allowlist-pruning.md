# План: Цикл 29 — Обязательный оркестратор по умолчанию на macOS, запрет тихого отката в субагента и авто-очистка allowlist в `--write-permissions` (v3.44 / 1.8)

## Цель / Требования
- **Пользователь и проблема:** В интерактивных сессиях на macOS Архитектор самовольно переключался на вызов субагентов (`invoke_subagent`) вместо запуска детерминированного оркестратора (`run.mjs`) по двум связанным причинам: (1) мягкие формулировки в `SKILL.md` (`when configured and --dry-run is green`, `If the user wants the orchestrator`) позволяли молча уходить в субагента при любой ошибке `--dry-run`; (2) глобальный файл `~/.gemini/antigravity-cli/settings.json` при работе с несколькими проектами накапливал чужие `write_file(<другой-проект>)` и устаревшие запрещённые команды (`command(git restore)`, `command(git checkout ...)`), а флаг `--write-permissions` умел только дописывать правила и не очищал конфликтующие записи.
- **Критерий успеха MVP:**
  1. В `SKILL.md` (`v3.44`, `<= 34 КБ`), `references/orchestrator.md` и `references/auto-review.md` оркестратор (`run.mjs`) закреплён как обязательный путь запуска по умолчанию на macOS при наличии папки оркестратора; молчаливый откат в `invoke_subagent` при `✗` в `--dry-run` запрещён без явного отчёта о причине и согласия пользователя, а при приёмке резервного субагента обязателен детерминированный гейт `run.mjs --check-task T-NNN`.
  2. `writeAgyAllowlist` (`permissions.mjs`) и `writeClaudeAllowlist` (`adapters/claude.mjs`) при передаче `pruneCtx` после слияния `deny` удаляют из `permissions.allow` правила, не проходящие `ruleProblem` / `claudeRuleProblem` (чужие проектные `write_file`/`read_file` и запрещённые команды), сохраняя безопасные пользовательские правила (`command(adb)`, `mcp(...)`), `.bak`-бэкап и обратную совместимость возвращаемого объекта без `pruneCtx`.
  3. Новый связный модуль `permissions-cli.mjs` (`handleWritePermissionsCli`) подключён в `run.mjs` (`opts.writePermissions`), маскирует пути проекта и домашнего каталога в выводе добавленных и удалённых правил, удерживает все изменяемые модули в бюджете `<= 400` строк и зарегистрирован в `AGENTS.md` §5.

## Решения
- **ADR-060:** Обязательный оркестратор по умолчанию на macOS, запрет молчаливого отката в субагента, обязательный `--check-task` для резервного режима и авто-очистка allowlist при `--write-permissions` (`v3.44 / 1.8`, `T-088`, `SKILL.md`, `references/{orchestrator,auto-review}.md`, `permissions.mjs`, `permissions-cli.mjs`, `adapters/claude.mjs`, `run.mjs`, `AGENTS.md`):
  - **Выбранный вариант:** (1) сделать `orchestrator/run.mjs` обязательным по умолчанию на macOS в `SKILL.md` (`v3.44`) и `references/orchestrator.md`, запретив молчаливый вызов `invoke_subagent` при `✗` в `--dry-run` без сообщения причины и явного согласия пользователя, и обязать запускать `--check-task T-NNN` при любой приёмке вне цикла в `references/auto-review.md`; (2) добавить опциональный `pruneCtx` в `writeAgyAllowlist` (`permissions.mjs`) и `writeClaudeAllowlist` (`adapters/claude.mjs`), выполняя слияние `deny` до фильтрации `allow` через `ruleProblem` / `claudeRuleProblem` и возвращая `removedAllow` только при переданном `pruneCtx`; (3) вынести обработчик `--write-permissions` из `run.mjs` в `permissions-cli.mjs` (`handleWritePermissionsCli`) для соблюдения бюджета `<= 400` строк и чистой модульной тестируемости.
  - **Отвергнутые альтернативы:** всегда возвращать `removedAllow` из `writeAgyAllowlist` и `writeClaudeAllowlist` даже без `pruneCtx` (отвергнуто: ломает обратную совместимость `assert.deepEqual` в существующих тестах `permissions.test.mjs`); полная перезапись `permissions.allow` только базовым набором `rulesFor` (отвергнуто: уничтожает безопасные пользовательские правила вроде `command(adb)` и `mcp(...)`).

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/SKILL.md`
- `.agents/skills/architect/references/orchestrator.md`
- `.agents/skills/architect/references/auto-review.md`
- `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-088: Авто-очистка конфликтующих и запрещённых правил allowlist при `--write-permissions` и выделение `permissions-cli.mjs`
  - Риск: high.
  - Зависит от: —.
  - Модель: Gemini 3.8 Flash / High (`gemini-3.8-flash-high`).
  - Читать: `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs` (строки 233–262, 311–398), `.agents/skills/architect/orchestrator/adapters/claude.mjs` (строки 50–145), `.agents/skills/architect/orchestrator/run.mjs` (строки 15–26, 50–69), `AGENTS.md` (раздел 5).
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/permissions-cli.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `AGENTS.md`.
  - Задача и инварианты:
    1. В `writeAgyAllowlist({ settingsPath, allow, deny = [], pruneCtx = null })` (`permissions.mjs`): при `pruneCtx === null` сохранить точную обратную совместимость поведения и возвращаемого объекта `{ addedAllow, addedDeny, backup }`; при переданном `pruneCtx` сначала влить `deny` (`addedDeny`), затем отфильтровать существующий `json.permissions.allow ?? []` через `ruleProblem(r, { ...pruneCtx, deny: json.permissions.deny ?? [] })`, сохранив удалённые правила в `removedAllow`, после чего влить `allow` (`addedAllow`); если `!addedAllow.length && !addedDeny.length && !removedAllow.length` — не записывать файл и вернуть `{ addedAllow, addedDeny, removedAllow: [], backup: false }`, иначе сохранить `.bak` (если файл существовал), атомарно записать JSON и вернуть `{ addedAllow, addedDeny, removedAllow, backup: existed }`. Удержать `permissions.mjs <= 400` строк.
    2. В `writeClaudeAllowlist({ settingsPath = null, workDir = null, home = os.homedir(), allow = [], deny = [], additionalDirectories = [], pruneCtx = null })` (`adapters/claude.mjs`): при `pruneCtx === null` сохранить возвращаемый объект `{ addedAllow, addedDeny, backup }`; при переданном `pruneCtx` после слияния `effectiveDeny` в `json.permissions.deny` удалить из `json.permissions.allow ?? []` правила, для которых `claudeRuleProblem(r, { config: pruneCtx.config ?? { blockedScripts: pruneCtx.blockedScripts ?? pruneCtx.blockedNpmScripts ?? [] }, workDir: pruneCtx.workDir ?? inferredWork, home: pruneCtx.home ?? home, deny: json.permissions.deny ?? [], skillDir: pruneCtx.skillDir, skillFilePath: pruneCtx.skillFilePath }) !== null`, собрав их в `removedAllow`, затем влить `allow` и вернуть `{ addedAllow, addedDeny, removedAllow, backup: existed && newText !== prevText }`. Удержать `adapters/claude.mjs <= 400` строк.
    3. Создать `.agents/skills/architect/orchestrator/permissions-cli.mjs` с экспортом `handleWritePermissionsCli({ config, workDir, home = os.homedir(), log = console.log })`: вызывать `adapter.permissions.writeAllowlist` с `pruneCtx`, логировать маскированные через `maskPaths(rule, ctx)` добавленные и удалённые правила (`removed <N> unsafe/other-project rules`, отметку `, previous version saved to settings.json.bak` при `backup`, либо `all rules already present, file unchanged` при отсутствии изменений), вызывать `adapter.permissions.check({ config, settingsPath, workDir, home })`, логировать `✗ ...` при `!perm.ok` и `next: run with --check`, возвращая `{ addedAllow, addedDeny, removedAllow, backup, ok: perm.ok }`. Подключить `handleWritePermissionsCli` в `run.mjs` (`if (opts.writePermissions) { handleWritePermissionsCli({ config, workDir }); return; }`, удержав `run.mjs <= 400` строк) и добавить `permissions-cli` в список зон высокого риска `AGENTS.md` §5.
  - Граничные случаи: порядок слияния `deny` до вызова `ruleProblem` (чтобы `write_file(<workDir>)` текущего проекта не был ошибочно удалён из-за ещё не влитого `deny write_file(<workDir>/.git)`), сохранение безопасных пользовательских правил (`command(adb)`, `mcp(...)`) и прочих ключей JSON (`theme`, `account`), маскирование `home` (`~`) и `workDir` (`<workDir>`) в выводе CLI без утечки абсолютных путей, отсутствие идентификаторов `T-NNN` в комментариях производственных `.mjs` файлов и запрет пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`.
  - Готово, когда: `write-permissions-prune.test.mjs`, `permissions.test.mjs`, `adapters/claude.test.mjs`, `packaging-clean.test.mjs` и `npm test` полностью зелёные, а `permissions.mjs`, `permissions-cli.mjs`, `adapters/claude.mjs` и `run.mjs` каждый `<= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/adapters/claude.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
    - `npm test`

## Ретроспектива

| Измерение | Результат |
|---|---|
| Границы (`Менять` / `Frozen`) | OK — `db44c6f` (`T-088`) меняет только `.agents/skills/architect/orchestrator/{permissions,permissions-cli,run}.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs` и `AGENTS.md`. Все изменённые модули уложились в лимит `≤ 400` строк (`permissions.mjs` — 398, `permissions-cli.mjs` — 37, `adapters/claude.mjs` — 396, `run.mjs` — 387). Файлы из `Frozen` Исполнителем не затрагивались. |
| Git | OK — коммиты правил до цикла (`3d7d622`), плана (`9ba53b7`), задачи (`db44c6f`) и приёмки (`1a4134c`) строго разделены, без amend и без посторонних коммитов вне `arch:` / `T-NNN`. |
| Обходы проверок | OK — независимый grep по добавленным строкам `873eb53..1a4134c` в `.agents/skills/architect/orchestrator` не выявил ни одного обхода (`0` совпадений). |
| Эскалации | OK — 0 эскалаций и 0 скрытых отклонений от плана (разовый бутстрап `T-088` через субагента `flash` согласован пользователем до запуска, так как именно `T-088` устраняет блокировку старых записей allowlist). |
| Приёмка | OK — `T-088` принята с первой попытки (0 раундов `Доработать`) с подтверждением через детерминированный гейт `--check-task T-088`, `VERIFY_STEP_A1=1` (`14/14 PASS`), Node `v22.23.4` (`241/241 PASS`) и Node `v24.22.2` (`249/249 PASS`: `241/241` оркестратор + `8/8` `tests/*.test.mjs`). Профили Исполнителей (`docs/executor-profiles.md`) обновлены для пары `Gemini Flash (subagent, уровень неизвестен)` (`T-088`). |
| Контекст | OK — контекста `PLAN.md` и эталонного теста `write-permissions-prune.test.mjs` хватило без истории чата. |

Rules: added 2 / removed 1 (не задействованы за 2–3 цикла: командный режим `references/team.md` и совещательный аудит плана `references/plan-audit.md` — оставлены, так как закрывают отдельные рабочие режимы).
