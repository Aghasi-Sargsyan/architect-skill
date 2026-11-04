# PLAN

## Goal / Requirements
Цикл 19: Устранение ошибок и узких мест оркестратора по итогам 6 полевых циклов (`T-001`..`T-026`) в проекте `sl-factory-kit`:
1. Мгновенный `auto-refused` с подсказкой `suggestedCommand` для `npx grep`, `npx ls` и `npm list` в `permissions.mjs` (устранение 68-минутного и 26-минутного простоев фонового цикла на `T-026` и `T-020`), расширение `TOOLS_RULE` запретом `find`, `tail`, `npx tsx`, `npm run agents` и напоминание о языке коммита проекта в `executorPrompt` (`prompts.mjs`).
2. Исключение ложных срабатываний паттерна `\.(skip|only)\(` на доменных методах `this.skip()`, `adapter.skip()`, `presenter.skip()` в `findBypasses` (`mechanics.mjs`), поддержка glob-масок (`dir/*`, `dir/**`) в `## Frozen` (`matchesFrozenPath` в `plan.mjs`, `mechanics.mjs`, `check.mjs`), разбор полей задачи без пробела после дефиса (`-Проверка:`) и резервное извлечение `referenceTests` из `Проверка` / `Verify`, когда поле `Тест-кейсы` опущено.
3. Детерминированная проверка в `selfcheck.mjs` наличия секции `## Ретроспектива` / `## Retrospective` и строки `Rules: added N / removed M` в архивах `docs/plans/*.md` и `.architect/plans/*.md` при коммите `arch: close cycle`, и явная фиксация `NOT VERIFIED` в `runRedCheck` (`evidence.mjs`), если открытая high-risk задача по коду из `bypassScanPaths` не имеет ни одного замороженного эталонного теста в `referenceTests`.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогону на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-046`) хранится в `docs/decisions.md`.
- **ADR-047:** Полевые исправления оркестратора по итогам 6 циклов в `sl-factory-kit` (без раздувания `SKILL.md` / `EXECUTOR.md`): (1) `commandProblem` и `proposeRules` (`permissions.mjs`) отклоняют `npx grep` и `npx ls` с `auto: true` и `suggestedCommand: "grep ..."` / `"ls ..."`, а `proposeRules` автоматически перенаправляет `npm list ...` на разрешённый `npm ls ...` без остановки цикла и без изменения 30 базовых элементов `BASE_COMMANDS`; `TOOLS_RULE` и `executorPrompt` (`prompts.mjs`) явно запрещают `find`, `tail`, `npx tsx`, `npm run agents` и напоминают переводить тему коммита `T-NNN:` на язык коммитов проекта (`commitLanguage`); (2) `findBypasses` (`mechanics.mjs`) для паттерна `\.(skip|only)\(` проверяет принадлежность вызова к тест-раннерам (`describe`, `it`, `test`, `suite`, `context`, `bench`, `t` и их модификаторам), не срабатывая на доменных методах `this.skip()` / `adapter.skip()`; `matchesFrozenPath` (`plan.mjs`) поддерживает glob-маски `dir/*` и `dir/**` в `## Frozen` во всех проверках (`plan.mjs`, `mechanics.mjs`, `check.mjs`, `selfcheck.mjs`), а `parsePlan` допускает отсутствие пробела после дефиса (`-Проверка:`) и извлекает `referenceTests` также из `Verify`-команд при пропущенном поле `Тест-кейсы`; (3) `runSelfCheckGit` (`selfcheck.mjs`) проверяет наличие заголовка `## Ретроспектива` / `## Retrospective` и строки `Rules: added N / removed M` в архивах закрытия цикла, а `runRedCheck` (`evidence.mjs`) помечает `NOT VERIFIED` открытые high-risk задачи по коду без `referenceTests`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
- `.agents/skills/architect/orchestrator/field-bypass-frozen.test.mjs`
- `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-070: Auto-refuse npx grep/ls and npm list with suggestedCommand and harden TOOLS_RULE and executorPrompt
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/permissions.test.mjs`, `.agents/skills/architect/orchestrator/prompts-verify.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`
  - Задача и инварианты: (1) В `permissions.mjs` внутри `commandProblem` для `unwrappedBin === 'npx'` перед проверкой `STANDALONE_TOOLS` отклонять `unwrappedSecond === 'grep' || unwrappedSecond === 'ls'` с сообщением `` `npx ${unwrappedSecond} is not allowed: run ${unwrappedSecond} directly` ``; в `proposeRules` при `problem` для `unwrappedBin === 'npx' && (unwrappedSecond === 'grep' || unwrappedSecond === 'ls')` выставлять `suggestedCommand = unwrapped.slice(1).join(' ')`, а после блока `if (problem)` добавить авто-перенаправление для `w[0] === 'npm' && w[1] === 'list'`, возвращая `{ auto: true, reason: 'use "npm ls" instead of "npm list"', fileTool: false, suggestedCommand: ['npm', 'ls', ...w.slice(2)].join(' ') }` (массив `BASE_COMMANDS` из 30 элементов не менять). (2) В `prompts.mjs` расширить `TOOLS_RULE` упоминанием `tail`, `find`, `npx tsx`, `npm run agents` и `"npm ls"` (сохранив `node -e`, `python -c`, `single targeted test file` и `before commit`), а в `executorPrompt` добавить строку с напоминанием писать сообщение коммита на языке коммитов проекта (`Write the git commit message in the project's commit language (e.g. in English when commitLanguage is "en")`).
  - Граничные случаи: Сохранить оба модуля `permissions.mjs` и `prompts.mjs` строго `<= 400` строк (при необходимости компактно записать однострочные ветки в `permissions.mjs`) и без пустых `catch {}` (`AGENTS.md §4`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
  - Готово, когда: Замороженный тест `field-permissions-prompts.test.mjs` и существующие тесты `permissions*.test.mjs` и `prompts*.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/prompts-en.test.mjs .agents/skills/architect/orchestrator/prompts-verify.test.mjs`

- [x] T-071: Scope .skip/.only bypass check to test-runner calls, support Frozen globs, and harden parsePlan
  - Риск: высокий
  - Зависит от: T-070
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/field-bypass-frozen.test.mjs`, `.agents/skills/architect/orchestrator/plan.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/mechanics-bypass.test.mjs`, `.agents/skills/architect/orchestrator/plan-reference-tests.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/plan.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/check.mjs`
  - Задача и инварианты: (1) В `plan.mjs` экспортировать `matchesFrozenPath(filePath, frozenList)`: нормализовать пути (`\` → `/`, убрать ведущий `./`), возвращать `true` при точном совпадении или при совпадении с glob-записью (`*` / `**`, где `**` матчит `.*`, а одиночный `*` — `.*` для `dir/*` на весь подкаталог или `[^/]*` внутри сегмента: `new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, '.*') + '$')`); в `parsePlan` заменить `/^ {2}- ([^:]+):\s*(.*)$/` на `/^ {2}-\s*([^:]+):\s*(.*)$/`, при формировании `task.referenceTests` проверять `matchesFrozenPath(p, frozen)` и дополнительно добавлять токены из `task.verifyCommands` (`cmd.split(/\s+/)`), которые матчатся `matchesFrozenPath(tok, frozen)` и выглядят как тестовый файл (`/(?:^|\/)tests\/|\.(?:test|spec)\.[^/\s]+$/`); в `checkParallelTasks` проверять `matchesFrozenPath(ch, plan.frozen ?? [])`. (2) В `mechanics.mjs` внутри `findBypasses` для паттерна с `re.source === '\\.(skip|only)\\('` проверять строку через `TEST_SKIP_ONLY_RE = /\b(?:describe|it|test|suite|context|bench|t)(?:\s*\.\s*(?:concurrent|sequential|todo|shuffle|scoped|serial|each|for))*(?:\s*\([^)]*\))?\s*\.\s*(?:skip|only)\s*\(/`, а в `checkExecutorRun` и `inspectFailedExecutorTurn` проверять принадлежность файла к `Frozen` через `matchesFrozenPath(f, [...effectiveFrozen])`. (3) В `check.mjs` внутри `resolveEscalationResume` использовать `matchesFrozenPath(norm, planFrozen)` вместо `frozenSet.has(norm)`.
  - Граничные случаи: Каждый из модулей `plan.mjs`, `mechanics.mjs` и `check.mjs` должен оставаться строго `<= 400` строк и без пустых `catch {}` (`AGENTS.md §4`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-bypass-frozen.test.mjs`
  - Готово, когда: Замороженный тест `field-bypass-frozen.test.mjs` и существующие тесты `mechanics*.test.mjs`, `plan-reference-tests.test.mjs`, `check*.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-bypass-frozen.test.mjs .agents/skills/architect/orchestrator/mechanics-bypass.test.mjs .agents/skills/architect/orchestrator/mechanics-frozen.test.mjs .agents/skills/architect/orchestrator/plan-reference-tests.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/escalation-resume.test.mjs`

- [x] T-072: Enforce retrospective section on cycle closure in selfcheck.mjs and report missing referenceTests in runRedCheck
  - Риск: высокий
  - Зависит от: T-071
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/evidence.mjs`, `.agents/skills/architect/orchestrator/selfcheck.test.mjs`, `.agents/skills/architect/orchestrator/evidence.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/evidence.mjs`
  - Задача и инварианты: (1) В `selfcheck.mjs` (`runSelfCheckGit`) добавить проверку архивов закрытия цикла: для каждого коммита из `nonExecCommits` с темой `/^arch:\s*(?:close cycle|закрытие цикла)\b/i` проверить все файлы из `c.files` вида `(?:^|\/)(?:docs|\.architect)\/plans\/[^/]+\.md$`, которые существуют в `headFileSet`; если содержимое файла на `HEAD` (`git show HEAD:${f}`) не содержит заголовок `/^##\s+.*(?:Ретроспектива|Retrospective)\b/im` или строку `/\bRules:\s*added\s+\d+\s*\/\s*removed\s+\d+/i`, добавить в `violations` сообщение `cycle closure archive ${f} is missing ## Retrospective / Ретроспектива section or "Rules: added N / removed M" line`. (2) В `evidence.mjs` (`runRedCheck`) для каждой открытой high-risk задачи из `highRiskTasks`, у которой `(task.referenceTests ?? []).length === 0` и в `task.change` есть кодовый файл (не `.md`/`.json`/`.yml`/`.yaml`) внутри `config?.bypassScanPaths ?? ['src', 'tests']`, добавлять в `notVerified` запись `high-risk task ${task.id} has no frozen referenceTests in PLAN.md (NOT VERIFIED)`.
  - Граничные случаи: Оба модуля `selfcheck.mjs` и `evidence.mjs` должны оставаться строго `<= 400` строк и без пустых `catch {}` (`AGENTS.md §4`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs`
  - Готово, когда: Замороженный тест `field-selfcheck-retro.test.mjs` и существующие тесты `selfcheck.test.mjs` и `evidence.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/evidence.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
