# План

## Цель / Требования
Цикл 30 (Аудит Цикл 1: План и гейты, `C-01`…`C-06` из `docs/audits/2026-11-11-{brief,findings}.md`): закрыть дефекты P0/P1 парсинга и валидации `PLAN.md`, проверки `Risk` и `Frozen`, блокировки `high`-risk задач с исполняемым кодом без эталонных `Frozen`-тестов и неверных кодов выхода `--repair` / `--write-permissions`, удерживая все модули оркестратора в пределах потолка `<= 400` строк без однострочников и приведя `SKILL.md` (`v3.47`) в точное соответствие с механикой.

Подтверждённые требования:
- Развилки **Р-1…Р-10** приняты по рекомендации брифа с восемью уточнениями пользователя и инвариантом восстановления для Цикла 2 (`ADR-061`).
- Модель Архитектора для автоматического цикла переключена на `gemini-4-carbon-high`, Исполнителя — `gemini-3.8-flash-high`.
- Оба файла аудита (`docs/audits/2026-11-11-brief.md` и `docs/audits/2026-11-11-findings.md`) включаются в первый коммит `arch: plan ...`.

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-062`). Ключевые решения этого цикла:
- **ADR-061:** Фиксация сквозных решений **Р-1…Р-10** по трём аудитам с уточнениями пользователя и расширением зон высокого риска `AGENTS.md` §5 (`ask`, `plan`, `plan-validate`, `run`, `check`, `cli`, `cli-dispatch`, `events`, `layout`).
- **ADR-062:** Нормализация CRLF и запрет склеивания задач в `plan.mjs`, вынос детерминированной валидации плана (`Risk`, `Frozen`, `referenceTests` / `structural verification`) в `plan-validate.mjs`, подключение гейтов в `check.mjs`, `evidence.mjs`, `cli.mjs` и `mechanics.mjs`, вынос ранней маршрутизации CLI из `run.mjs` в `cli-dispatch.mjs` с исправлением кодов выхода `--repair` и `--write-permissions`, и обновление `SKILL.md` до `v3.47` (`C-03`…`C-05`).

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/plan-validate.test.mjs`
- `.agents/skills/architect/orchestrator/plan-gates.test.mjs`
- `.agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-089: Strict `PLAN.md` parser in `plan.mjs` and structural/risk/frozen/referenceTests validator in `plan-validate.mjs` (`C-01`..`C-04`)
  - Риск: high.
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/plan-validate.test.mjs`, `.agents/skills/architect/orchestrator/plan.mjs` (строки 1–170), `.agents/skills/architect/orchestrator/plan-validate.mjs`, `.agents/skills/architect/orchestrator/plan.test.mjs`, `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/plan.mjs`, `.agents/skills/architect/orchestrator/plan-validate.mjs`.
  - Задача и инварианты:
    1. В `parsePlan(text)` (`plan.mjs`):
       - в начале нормализовать переводы строк `const normText = String(text ?? '').replace(/\r\n?/g, '\n');` и обходить строки с `1`-based индексом `lineNo = idx + 1`;
       - при разборе заголовков `## ...` снимать опциональный номер раздела `heading.replace(/^\d+[.)]\s*/, '')`, распознавая `frozen` (`/^(frozen\b|заморожен)/i`) и `tasks` (`/^(tasks\b|задачи\b)/i`), и сбрасывать `current = null; field = ''; seenTaskInSection = false;`;
       - в секции `frozen`: пропускать пустые строки и `NONE_RE`; для `^- \`([^\`]+)\`` добавлять путь в `frozen`; любую другую непустую строку (без бэктиков, с `*`, с отступом/вложенный пункт) записывать в массив `frozenErrors` как `{ line: lineNo, text: line.trim(), reason: 'Frozen entry must be a top-level "- `<path>`" item wrapped in backticks' }`;
       - вне секции `frozen`: при совпадении `TASK_RE` (`/^- \[( |x)\] (T-\d+): (.+)$/`) создавать задачу (с полем `rawTestCases: []`), выставлять `seenTaskInSection = true` (если `id` уже встречался в `tasks`, добавлять запись в `parseErrors` с `lineNo`); если строка НЕ совпала с `TASK_RE`:
         - на любом верхнеуровневом пункте списка (`/^[-*+]\s+/`) или заголовке (`/^#+\s+/`) безусловно сбрасывать `current = null; field = '';`, чтобы поля ниже никогда не приклеивались к предыдущей задаче;
         - если строка является чекбоксом (`/^\s*[-*+]\s*\[[^\]]*\]/`) ИЛИ верхнеуровневым пунктом `/^[-*+]\s+/` внутри секции задач (`section === 'tasks' || seenTaskInSection`, кроме заглушки `NONE_RE` типа `- —`), добавлять `{ line: lineNo, text: line.trim(), reason: 'Task line does not match "- [ ] T-NNN: Title"' }` в `parseErrors`;
       - при разборе поля `testCases` (как на основной строке поля `2..4` пробела, так и в подпунктах `4+` пробелов) сохранять непустые сырые строки значения в `current.rawTestCases` (до фильтрации по `Frozen`);
       - возвращать `{ tasks, frozen, parseErrors, frozenErrors }`, сохраняя полную обратную совместимость существующих полей `tasks` и `frozen`.
    2. В `plan-validate.mjs` реализовать все экспортируемые функции стаба:
       - `normalizeRisk(raw)`: `trim()`, снять одну завершающую точку `.`, привести к нижнему регистру; вернуть `'low'` для `'low'|'низкий'`, `'medium'` для `'medium'|'средний'`, `'high'` для `'high'|'высокий'`, иначе `null`; `isValidRisk(raw)` и `isHighRisk(raw)` строить поверх `normalizeRisk`;
       - `hasStructuralVerificationMarker(task)`: проверять `(task?.rawTestCases ?? []).join('\n')` по `/\bstructural verification\b|структурн(?:ая|ой|ую)\s+проверк/i`;
       - `isExecutableCodeFile(filePath)`: возвращать `false` для неисполняемых файлов (`.md`, `.mdx`, `.txt`, `.rst`, `.json`, `.jsonc`, `.json5`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.lock`, `.sql`, `.css`, `.scss`, `.less`, `.sass`, `.html`, `.htm`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.csv`, `.tsv` и имён `.gitignore`/`.dockerignore`/`Dockerfile*`/`Makefile`/`LICENSE*`/`NOTICE`/`CODEOWNERS`/`README*`/`CHANGELOG*`/`EXECUTOR.md`/`SKILL.md`), и `true` для всех остальных путей (исполняемый код, тесты и скрипты любых стеков);
       - `validateFrozenEntries(plan, { workDir, layout } = {})`: вернуть `string[]` проблем на английском без кириллицы и без абсолютных путей `workDir` — сначала все `plan.frozenErrors` (`line ${e.line}: ${e.reason} ("${e.text}")`), затем для каждого `entry` из `plan.frozen`: отклонять `..`/абсолютные пути; если нет `*`: при завершающем `/` сообщать о необходимости glob-маски `"${entry}*"` / `"${entry}**"`; при наличии `workDir`: если путь существует и `statSync` показывает директорию — сообщать, что каталог `"${entry}"` указан без glob-маски (`"${norm}/*"` или `"${norm}/**"`); если файл не существует на диске и путь не равен `'EXECUTOR.md'` и не равен `layout?.executorPath ?? 'EXECUTOR.md'` — сообщать, что файл не найден;
       - `validatePlan(plan, { workDir, layout, config } = {})`: собирать `parseIssues` (с `line ${e.line}`), `frozenIssues`, `riskIssues` (для всех открытых `!t.done` задач с `!isValidRisk(t.risk)`) и `highRiskTestIssues` (для всех открытых `!t.done` задач с `isHighRisk(t.risk)`, где `(t.change ?? []).some(isExecutableCodeFile)`, `(t.referenceTests ?? []).length === 0` и `!hasStructuralVerificationMarker(t)`), возвращая `{ ok, parseIssues, riskIssues, frozenIssues, highRiskTestIssues }`.
  - Граничные случаи: пустой текст плана или план закрытого цикла (`—` в `## Задачи` и `- \`EXECUTOR.md\`` в `## Frozen` без `EXECUTOR.md` на диске обязан давать `ok: true`); сообщения `plan-validate.mjs` должны быть строго на английском языке без кириллицы и без вставки абсолютного `workDir`; не добавлять идентификаторы `T-NNN` в комментарии производственных `.mjs` файлов и не оставлять пустых `catch {}`; удерживать оба модуля `<= 400` строк.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/plan-validate.test.mjs`.
  - Готово, когда: `plan-validate.test.mjs`, `plan.test.mjs` и `plan-reference-tests.test.mjs` полностью зелёные, оба изменённых модуля `<= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/plan-validate.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/plan.test.mjs .agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`

- [ ] T-090: Wire strict plan, `Risk`, `Frozen`, and high-risk `referenceTests` gates into `check.mjs`, `evidence.mjs`, `cli.mjs`, and `mechanics.mjs` (`C-01`..`C-04`)
  - Риск: high.
  - Зависит от: T-089.
  - Читать: `.agents/skills/architect/orchestrator/plan-gates.test.mjs`, `.agents/skills/architect/orchestrator/plan-validate.mjs`, `.agents/skills/architect/orchestrator/check.mjs` (строки 135–165, 300–330), `.agents/skills/architect/orchestrator/evidence.mjs` (строки 250–285), `.agents/skills/architect/orchestrator/cli.mjs` (строки 145–175, 325–360), `.agents/skills/architect/orchestrator/mechanics.mjs` (строки 120–155).
  - Менять: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/evidence.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`.
  - Задача и инварианты:
    1. В `localChecks` (`check.mjs`): вызывать `const pv = validatePlan(plan, { workDir, layout, config });`:
       - если `pv.parseIssues.length > 0`, добавлять `add(false, 'PLAN.md', pv.parseIssues.join('; '))` вместо `ok: true` на `PLAN.md` (сохраняя прежнее сообщение при `plan.tasks.length === 0 && pv.parseIssues.length === 0`);
       - если `pv.riskIssues.length > 0`, добавлять `add(false, 'Risk field', pv.riskIssues.join('; '))`;
       - если `pv.frozenIssues.length > 0`, добавлять `add(false, 'Frozen', pv.frozenIssues.join('; '))`;
       - если `pv.highRiskTestIssues.length > 0`, добавлять `add(false, 'Reference tests', pv.highRiskTestIssues.join('; '))`;
       - не выводить абсолютный путь `workDir` и кириллицу в `detail`. Поскольку `readiness()` вызывает `localChecks()`, все четыре гейта автоматически блокируют `--check`, `--dry-run`, `--background` и старт цикла.
    2. В `runRedCheck` (`evidence.mjs`): использовать `isHighRisk`, `isExecutableCodeFile` и `hasStructuralVerificationMarker` из `./plan-validate.mjs`; для каждой открытой `high`-risk задачи с `(task.referenceTests ?? []).length === 0`, если `(task.change ?? []).some(isExecutableCodeFile)` и `!hasStructuralVerificationMarker(task)`, записывать запись КАК в `notVerified` (`high-risk task ${task.id} has no frozen referenceTests in PLAN.md (NOT VERIFIED)` — сохраняя совместимость с `field-selfcheck-retro.test.mjs`), ТАК И в `violations` (`high-risk task ${task.id} with executable code in Change has no frozen referenceTests in PLAN.md`), независимо от `bypassScanPaths`.
    3. В `runFastSelfCheck` (`cli.mjs`): при наличии `planPath` прогонять `validatePlan(parsedPlan, { workDir, layout, config: cfg })` вместе с `checkParallelTasks(parsedPlan)` и добавлять `parseIssues`, `riskIssues`, `frozenIssues` и `highRiskTestIssues` в `violations`.
    4. В `checkExecutorRun` (`mechanics.mjs`): использовать `isValidRisk` и `isHighRisk` из `./plan-validate.mjs`; если `!isValidRisk(task.risk)`, добавлять нарушение в `violations` (`invalid or empty task Risk "${task.risk ?? ''}"`); вычислять `const highRisk = isHighRisk(task.risk)` для проверки `protectedConfigFiles`.
  - Граничные случаи: удержать `check.mjs`, `evidence.mjs`, `cli.mjs` и `mechanics.mjs` строго `<= 400` строк каждый (без склейки несвязанных операторов в однострочники); не нарушить `check.test.mjs`, `check-en.test.mjs`, `check-task.test.mjs`, `install-check.test.mjs`, `field-selfcheck-retro.test.mjs` и `mechanics.test.mjs`; не писать `T-NNN` в комментариях `.mjs` и не добавлять пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/plan-gates.test.mjs`.
  - Готово, когда: `plan-gates.test.mjs` и все смежные тесты `check*`, `evidence`, `cli`, `selfcheck`, `mechanics*`, `install-check` и `team-gate` проходят, все 4 модуля `<= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/plan-gates.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/check-task.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs .agents/skills/architect/orchestrator/team-gate.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/evidence.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs .agents/skills/architect/orchestrator/mechanics.test.mjs .agents/skills/architect/orchestrator/mechanics-frozen.test.mjs`

- [ ] T-091: Extract CLI subcommand dispatch into `cli-dispatch.mjs` and fix `--repair` and `--write-permissions` exit codes (`C-06`)
  - Риск: high.
  - Зависит от: T-090.
  - Читать: `.agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`, `.agents/skills/architect/orchestrator/run.mjs` (строки 1–85), `.agents/skills/architect/orchestrator/guards-recovery.mjs` (строки 179–191), `.agents/skills/architect/orchestrator/permissions-cli.mjs` (строки 10–67).
  - Менять: `.agents/skills/architect/orchestrator/cli-dispatch.mjs`, `.agents/skills/architect/orchestrator/run.mjs`.
  - Задача и инварианты:
    1. В `cli-dispatch.mjs` реализовать `export async function dispatchCliSubcommand({ opts, configPath, realGit, cwd = process.cwd() })` с читаемыми многострочными `if`-блоками без плотных однострочников:
       - `opts.repair`: вызвать `const code = handleRepairCli({ workDir: cwd, realGit });`, и если `code !== 0` (либо `typeof code === 'object' && code !== null && !code.ok`), выставить `process.exitCode = typeof code === 'number' ? code : 1`, вернуть `{ handled: true }`;
       - перенести в том же порядке обработку `opts.compact`, `opts.models || opts.setModel`, `opts.checkTask`, `opts.selfCheck`, проверку `process.platform === 'win32'`, `opts.init`, `opts.installHooks` и `opts.update` (с `if (!res?.ok) process.exitCode = 1`), возвращая `{ handled: true }`;
       - загрузить `const config = safeLoadConfig(configPath)`, `const layout = config.paths`, `const workDir = path.resolve(config.workDir ?? cwd)`;
       - `opts.writePermissions`: вызвать `const res = handleWritePermissionsCli({ config, workDir });`, и если `!res?.ok`, выставить `process.exitCode = 1`, вернуть `{ handled: true }`;
       - перенести `await runView(opts, workDir)`, `opts.answer !== null`, `opts.check` и `opts.auditPlan`, возвращая `{ handled: true }`;
       - если ни один ранний режим не сработал, вернуть `{ handled: false, config, layout, workDir }`.
    2. В `run.mjs`: заменить ранний блок маршрутизации CLI и неиспользуемые импорты вызовом `const sub = await dispatchCliSubcommand({ opts, configPath, realGit, cwd: process.cwd() }); if (sub.handled) return; const { config, layout, workDir } = sub;`, сократив `run.mjs` до `<= 370` строк.
  - Граничные случаи: сохранить дословный вывод `--init`, `--install-hooks`, `--answer` и порядок проверки `win32` (детерминированные режимы `--repair`, `--compact`, `--models`, `--set-model`, `--check-task`, `--self-check` работают до гейта `win32`, как закреплено в `CHANGELOG.md` `v3.46`); не оставлять `T-NNN` в комментариях `.mjs` и пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`.
  - Готово, когда: `cli-exit-codes.test.mjs`, `run.test.mjs`, `packaging-clean.test.mjs` и полный набор `npm test` проходят с кодом `0`, `run.mjs <= 370` строк и `cli-dispatch.mjs <= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
    - `npm test`
