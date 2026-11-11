# План

## Цель / Требования
Цикл 31 (поддержка Claude Code, вставлен перед циклами аудита по решению пользователя): скилл и оркестратор работают в Claude Code так же, как в Antigravity, при одной установке на все среды. `--update` не ломает симлинк `.claude/skills/architect`, раннер `claude` понимает уровни effort (`<alias>-<effort>`), `--init` из Claude Code выбирает раннер `claude` и делает скилл видимым через `/architect`, а `--check` предупреждает о двух типичных ошибках настройки, не меняя код выхода.

Подтверждённые требования:
- План аудита `docs/audits/2026-11-11-{brief,findings}.md` и решения `ADR-061` остаются без изменений: цикл 31 не исправляет ни одной находки `C-01`…`C-46`, даже частично. Находки про Claude Code (`C-28`, `C-35`, `C-36`, `C-37`, `C-40`, `C-44`, `C-45`) остаются в своих циклах аудита.
- Нумерация циклов: аудит-цикл N исполняется как проектный цикл 30 + N (аудит-цикл 2 → цикл 32, …, аудит-цикл 7 → цикл 37). Бриф и `ADR-061` используют нумерацию аудита 1–7 и остаются верными. Цикл 31 использует `T-092`…`T-094` и `ADR-063`; аудит-цикл 2 начинается с `T-095` и `ADR-064`.
- Файлы основных модулей аудит-циклов 2–3 не меняются: `run.mjs`, `mechanics.mjs`, `selfcheck.mjs`, `hooks.mjs`, `prompts.mjs`, `ask.mjs`, `guards.mjs`, `permissions.mjs`, `feed.mjs`.
- В общих с аудитом файлах (`update.mjs`, `check.mjs`, `config.mjs`, `cli-dispatch.mjs`, `models.mjs`, `adapters/claude.mjs`) меняются только точки вызова (до 5 строк); логика живёт в новых модулях `skill-targets.mjs`, `claude-setup.mjs`, `adapters/claude-models.mjs`.
- Запасы для аудита сохраняются: `adapters/claude.mjs` не длиннее 397 строк; в `SKILL.md` меняется только номер версии; `README.en.md` и `README.ru.md` не растут в байтах; `EXECUTOR.md` не меняется (политика 1.8, подъём до 1.9 — аудит-цикл 4).
- Обратная совместимость: конфиги с `runner: "agy"` или `model: "sonnet"` ведут себя как раньше (без `--effort`); `--init` вне Claude Code или при установленном `agy` пишет тот же конфиг, что и до цикла; ожидаемые значения существующих тестов не меняются.

Ограничения прогона (бриф §2, §5 — дыры `C-07`…`C-13` ещё открыты):
- Цикл идёт только под наблюдением Архитектора (`--watch`).
- После каждой задачи Архитектор вручную сверяет весь диапазон задачи: коммит `T-NNN:` на месте, коммит `arch: accept` меняет только `PLAN.md`, `--check-task T-NNN --base <SHA перед задачей>` с явной базой.

Перенесено из предыдущего цикла (`NOT VERIFIED`):
- Живые замеры промпта (`evals.mjs`) на `v3.47` (проводятся по согласию пользователя согласно `docs/audits/2026-11-11-brief.md` §8).

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-062`). Ключевое решение этого цикла:
- **ADR-063:** Поддержка Claude Code без вмешательства в план аудита (`v3.48 / 1.8`, `T-092`…`T-094`): (1) каноническая установка — `.agents/skills/architect`, для Claude Code — относительный симлинк `.claude/skills/architect -> ../../.agents/skills/architect` (Claude Code официально читает скиллы только из `.claude/skills/` и поддерживает симлинки); (2) `--update` определяет папки скилла по реальному пути через `resolveSkillUpdateTargets` (`skill-targets.mjs`): симлинк никогда не заменяется копией, папка вне проекта не обновляется и выводится как `skipped`; (3) раннер `claude` принимает id `<alias>-<effort>` и `claude-*-<effort>` и передаёт `--model <alias> --effort <effort>`; эффорт отделяется только от id моделей Claude, поэтому id других семейств (`gemini-3.8-flash-high`) не меняются; `--set-model` пишет в `.claude/agents/executor.md` пару `model` + `effort` (поле `effort` поддерживается субагентами Claude Code); (4) `--init` выбирает `runner: "claude"` только при `CLAUDECODE=1`, найденном `claude` и отсутствии `agy`, а окружение передаётся только из точки входа CLI, чтобы тесты не зависели от среды запуска; (5) `--init` в Claude Code создаёт симлинк, если скилл стоит в `.agents/skills/architect`, и никогда не перезаписывает существующий путь; (6) `--check` печатает неблокирующие предупреждения `! Claude Code skill` (скилл не виден Claude Code) и `! CLAUDE.md` (Claude Code пропускает `AGENTS.md`, если есть `CLAUDE.md`, а импорта `@AGENTS.md` нет); `CLAUDE.md` автоматически не создаётся, потому что без него Claude Code сам читает `AGENTS.md`; (7) находки аудита не исправляются, файлы аудит-циклов 2–3 не меняются, запасы размеров `claude.mjs`, `SKILL.md`, README и версия `EXECUTOR.md` сохраняются для аудита.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/skill-targets.test.mjs`
- `.agents/skills/architect/orchestrator/adapters/claude-models.test.mjs`
- `.agents/skills/architect/orchestrator/claude-setup.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-092: Resolve `--update` targets by real path so a symlinked `.claude/skills/architect` is never replaced by a copy
  - Риск: high.
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/skill-targets.test.mjs`, `.agents/skills/architect/orchestrator/skill-targets.mjs`, `.agents/skills/architect/orchestrator/update.mjs` (строки 1–12, 60–95, 145–210), `.agents/skills/architect/orchestrator/layout.mjs` (строки 84–104), `.agents/skills/architect/orchestrator/update.test.mjs` (строки 1–60).
  - Менять: `.agents/skills/architect/orchestrator/skill-targets.mjs`, `.agents/skills/architect/orchestrator/update.mjs`.
  - Задача и инварианты:
    1. В `skill-targets.mjs` реализовать `resolveSkillUpdateTargets({ workDir, orchestratorDir })` строго по JSDoc стаба: кандидаты в порядке `.agents/skills/architect`, `.claude/skills/architect`, `resolveInstalledSkillDir(workDir, orchestratorDir)` (импорт из `./layout.mjs`); несуществующие (`existsSync === false`) пропускать; `realWorkDir = realpathSync(workDir)`, `real = realpathSync(candidate)`, `rel = path.relative(realWorkDir, real)`; путь внутри проекта, только если `rel !== ''`, `!rel.startsWith('..')` и `!path.isAbsolute(rel)` — тогда цель `path.join(workDir, rel)`, иначе кандидат (в исходном написании) идёт в `skipped`; дубли отсекать по `real` через один общий `Set` для обоих списков; порядок — порядок кандидатов.
    2. В `updateSkill` (`update.mjs`) заменить блок сборки `targetDirs` / `seen` / `candidates` (от `const targetDirs = [];` до цикла `for (const c of candidates)` включительно) на `const { targets: targetDirs, skipped: skippedDirs } = resolveSkillUpdateTargets({ workDir, orchestratorDir: effectiveOrchDir });`. Проверку `targetDirs.length === 0` и текст её ошибки оставить без изменений. В возвращаемый объект добавить `skippedDirs`. Неиспользуемый после правки импорт `resolveInstalledSkillDir` удалить, если он больше нигде в файле не нужен.
    3. В `handleUpdateCli` после цикла строк `  updated: …` печатать для каждого `res.skippedDirs ?? []` строку `  skipped (outside project): ${path.relative(workDir, d) || d}`.
    4. Остальной код `update.mjs` (проверка блокировки и грязного дерева, клонирование, копирование, синхронизация `EXECUTOR.md`, хук, кэш, `checkSkillUpdateAvailable`) не трогать: это зона находки аудита `C-39` (аудит-цикл 7).
  - Граничные случаи: висячий симлинк не цель и не `skipped`; обратный симлинк (`.agents` → `.claude`) даёт целью реальную папку `.claude/...`; две независимые реальные копии остаются двумя целями; ошибки `realpathSync`, кроме отсутствующего пути, не глотать (fail-closed); без пустых `catch {}`; без идентификаторов `T-NNN` в комментариях; без однострочников.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/skill-targets.test.mjs`.
  - Готово, когда: `skill-targets.test.mjs` и `update.test.mjs` зелёные; `update.mjs` не длиннее 393 строк; изменены только два файла из «Менять».
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/skill-targets.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/layout.test.mjs`

- [x] T-093: Claude model ids with effort tiers for the `claude` runner and `.claude/agents/executor.md`
  - Риск: high.
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/adapters/claude-models.test.mjs`, `.agents/skills/architect/orchestrator/adapters/claude-models.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs` (строки 1–12, 230–240, 300–335), `.agents/skills/architect/orchestrator/adapters/index.mjs` (строки 1–15, 60–80), `.agents/skills/architect/orchestrator/models.mjs` (строки 1–30, 155–240), `.agents/skills/architect/templates/claude-agent-executor.md`, `.agents/skills/architect/orchestrator/check-task.test.mjs` (строки 236–256).
  - Менять: `.agents/skills/architect/orchestrator/adapters/claude-models.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/models.mjs`, `.agents/skills/architect/templates/claude-agent-executor.md`.
  - Задача и инварианты:
    1. В `adapters/claude-models.mjs` реализовать `listClaudeModels`, `splitClaudeModel`, `claudeModelArgs` и `syncClaudeAgentFile` строго по JSDoc стаба; константы `CLAUDE_MODEL_ALIASES` и `CLAUDE_EFFORT_LEVELS` не менять. Имена уровней в `name`: `Low`, `Medium`, `High`, `XHigh`, `Max`.
    2. В `adapters/claude.mjs`: удалить локальное определение `listClaudeModels` и вместо него реэкспортировать его из `./claude-models.mjs` (импорты `claude.test.mjs` и `adapters/index.mjs` из `./claude.mjs` должны продолжать работать); в массиве `args` функции `runClaudeAgent` заменить `'--model', model` на `...claudeModelArgs(model)`. Больше ничего в `claude.mjs` не менять: файл настроек, песочница, права, транскрипт и проверка окружения защищены брифом §6 и находками `C-13`, `C-44`, `C-45`. Итоговая длина `claude.mjs` — не больше 397 строк.
    3. В `setRoleModel` (`models.mjs`) заменить только блок записи `.claude/agents/executor.md` (от `const claudeAgent = …` до конца его `if`) на вызов `syncClaudeAgentFile(text, validModel)`: при результате `!== null` записать его и добавить `'.claude/agents/executor.md'` в `updatedFiles`. Регулярные выражения замены модели в `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` выше не трогать — это находка `C-28` (аудит-цикл 5).
    4. В `templates/claude-agent-executor.md` сразу после строки `# model: …` добавить закомментированную строку `# effort: <optional: low | medium | high | xhigh | max — Claude Code subagent effort tier>`; строка `model:` остаётся закомментированной.
  - Граничные случаи: id других семейств (`gemini-3.8-flash-high`) возвращаются целиком и в `executor.md` пишутся без `effort` (существующий тест `models.test.mjs` ожидает `model: gemini-3.8-flash-high`); `opus-turbo` и `claude-sonnet-4-5` не расщепляются; пустой или нестроковый id — `TypeError` с `non-empty string`; `syncClaudeAgentFile` меняет только строки внутри первого блока `---` … `---`; без пустых `catch {}`; без идентификаторов `T-NNN` в комментариях; без однострочников.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/adapters/claude-models.test.mjs`.
  - Готово, когда: `claude-models.test.mjs`, `claude.test.mjs`, `adapters/index.test.mjs`, `models.test.mjs` и `check-task.test.mjs` зелёные; `adapters/claude.mjs` не длиннее 397 строк; изменены только четыре файла из «Менять».
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/adapters/claude-models.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/adapters/claude.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/models.test.mjs .agents/skills/architect/orchestrator/check-task.test.mjs`

- [x] T-094: Claude Code setup in `--init` (runner choice and skill link) and non-blocking `--check` warnings
  - Риск: high.
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/claude-setup.test.mjs`, `.agents/skills/architect/orchestrator/claude-setup.mjs`, `.agents/skills/architect/orchestrator/config.mjs` (строки 300–335), `.agents/skills/architect/orchestrator/cli-dispatch.mjs` (строки 1–30, 85–105), `.agents/skills/architect/orchestrator/check.mjs` (строки 1–35, 336–364), `.agents/skills/architect/orchestrator/layout.mjs` (строки 84–104).
  - Менять: `.agents/skills/architect/orchestrator/claude-setup.mjs`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`, `.agents/skills/architect/orchestrator/check.mjs`.
  - Задача и инварианты:
    1. В `claude-setup.mjs` реализовать `detectInitRunner`, `ensureClaudeSkillLink` и `checkClaudeSetup` строго по JSDoc стаба, используя только `node:fs`, `node:os` и `node:path` (никаких импортов из `check.mjs` или `cli-dispatch.mjs` — без циклов импорта). «Путь существует по `lstatSync`»: `ENOENT` — не существует, любая другая ошибка пробрасывается.
    2. В `initProject` (`config.mjs`) добавить параметр `runner = null`; если он задан, записывать `base.runner = runner` до записи файла (обе ветки — `compact` и `classic`). Без параметра вывод `--init` побайтно такой же, как до цикла.
    3. В ветке `opts.init` (`cli-dispatch.mjs`): вычислить `runner` через `detectInitRunner({ env: process.env, hasBin: (b) => Boolean(findBinary(b)) })` (`findBinary` из `./check.mjs`) и передать его в `initProject`; после `const ready = loadProjectConfig(configPath);` вызвать `ensureClaudeSkillLink({ workDir: cwd, skillDir: resolveInstalledSkillDir(cwd), env: process.env, runner: ready.runner })` (`resolveInstalledSkillDir` из `./layout.mjs`) и печатать `• ${link.reason}` только при `link.created`.
    4. В `runCheckCommand` (`check.mjs`) сразу после строки печати `hookRes.skipped` печатать `! ${w.name}: ${w.detail}` для каждого `checkClaudeSetup({ workDir, runner: config.runner })`. Предупреждения не попадают в `results` и не меняют `allOk` и код выхода. `localChecks`, `runnerChecks`, `readiness` и пробу разрешений не трогать (`C-29`, `C-43`).
  - Граничные случаи: `process.env` передаётся только из `cli-dispatch.mjs`, умолчания функций ничего не определяют; существующий путь `.claude/skills/architect` (папка, файл, валидный или висячий симлинк) никогда не перезаписывается; скилл, установленный прямо в `.claude/skills/architect`, ссылку не получает; `CLAUDE.md` никогда не создаётся и не правится; без пустых `catch {}`; без идентификаторов `T-NNN` в комментариях; без однострочников.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/claude-setup.test.mjs`.
  - Готово, когда: `claude-setup.test.mjs`, `config.test.mjs`, `check.test.mjs`, `check-task.test.mjs`, `install-check.test.mjs`, `team-gate.test.mjs` и `cli-exit-codes.test.mjs` зелёные; `check.mjs`, `config.mjs` и `cli-dispatch.mjs` не длиннее 400 строк; изменены только четыре файла из «Менять».
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/claude-setup.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/config.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-task.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs .agents/skills/architect/orchestrator/team-gate.test.mjs .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`
