# План

## Цель / Требования
Цикл 34 — Аудит-цикл 4 «Изоляция и честная документация» (`C-18`…`C-23` из `docs/audits/2026-11-11-{brief,findings}.md`; развилки Р-1, Р-3 (вторая половина), Р-4). Цель: управляющие файлы цикла (shim-файлы, вопрос и ответ о разрешении) уходят из рабочего дерева в каталог `~/.config/architect/runs/<slug>-<hash8>/` (`0700`), их подмена во время хода видна; настоящий `git` никогда не берётся из каталогов проекта; `--write-permissions` не портит общий файл настроек `agy`; оба агента трактуют содержимое файлов, вывод команд и отчёты как данные, а не инструкции; документация называет проверки ограждением, а границей безопасности — только ОС-песочницу раннера.

Подтверждённые требования (решения пользователя):
- Архитектура Цикла 34 зафиксирована 2026-11-12 вариантом «Да, без живых agy»: живые проверки `agy --settings` и `agy --sandbox` (Р-4 вторая ступень, Р-5) не проводятся — `NOT VERIFIED`, `agy` остаётся без песочницы, и модель угроз прямо это говорит.
- Правки правил (`EXECUTOR.md` `1.9`, абзац в `SKILL.md` `v3.51`, «Модель угроз» в README) согласованы в той же фиксации архитектуры.

Сделано Архитектором в коммите плана:
- `control-dir.mjs` и его тест (`Frozen`): путь, права `0700`, отказ на симлинке и чужом владельце, `freshShimDir`.
- Заглушка `foreignProjectRule` с контрактом в `agy-settings.mjs` и реэкспорт из `permissions.mjs`; константа `UNTRUSTED_CONTENT_RULE` в `prompts.mjs`.
- Эталонные тесты `T-105`…`T-109`; ожидаемые значения прежнего контракта и фикстуры существующих тестов (`ADR-066` п. 6). Все эталонные тесты проверены на прототипе в копии скилла: зелёные на прототипе, красные на коде до задач.
- `EXECUTOR.md` `1.9` (+ корневая копия), `SKILL.md` `v3.51`, `README.{en,ru}.md`, корневой `README.md`, `CHANGELOG.md` (`v3.51` с поведением Цикла 33), `package.json` `3.51.0`, `AGENTS.md` (§2, §5).

Остаётся Архитектору при закрытии цикла: описать поведение Цикла 34 (управляющий каталог, `agy` без удаления правил, маркеры отчёта) в `CHANGELOG.md`, `README.{en,ru}.md` (строка `--write-permissions` в §6, `README.ru.md` — 25 387 байт из 25 600) и `references/orchestrator.md` (строка про `--write-permissions` и `*.pruned.json` в §1); полный набор тестов на Node 22 и Node 24.

Существующие тесты с переданным `home` (`ask-question`, `ask`, `feed`, `run`, `guards-shim-speed`, `skill-path`) и `control-dir.test.mjs` зелёные до задач и не входят ни в одно поле `Менять`: Исполнитель их не меняет; в `Frozen` — только красные до реализации эталонные тесты (`red-check`).

Окружение Исполнителя (раннер `claude`, ОС-песочница): до `T-105` тесты через `installGuards` падают с `EPERM` на каталоге из `PATH` в домашней папке — и до правок тоже. Базовый прогон снимать в самом проекте до первой правки (не через `git worktree` и не во внешнем каталоге), в отчёте сравнивать «до/после» по именам тестов; оркестратор повторяет `Проверка` вне песочницы.

Работающий цикл держит модули, загруженные при старте: перенос shim и вопроса действует со следующего запуска цикла. После цикла настройки `claude` нужно переписать `--write-permissions` (новое правило чтения каталога shim) — только с согласия пользователя.

Перенесено из предыдущих циклов (`NOT VERIFIED`):
- Нестабильный тест `run.test.mjs` «--background: … the child released the lock» и `evals-permissions.test.mjs` T-035 (П1, П2) «git status … finishes in <4s» — в рамках `C-30` (Цикл 5).
- Живые замеры промпта (`evals.mjs`) на `v3.50`/`v3.51` (по согласию пользователя, `docs/audits/2026-11-11-brief.md` §8).
- Авто-отказы `C-16` и пометка «the orchestrator does not recognize this command» проверены только тестами.

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-066`). Решение цикла — `ADR-066`.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/control-dir.mjs`
- `.agents/skills/architect/orchestrator/find-executable.test.mjs`
- `.agents/skills/architect/orchestrator/ask-control-dir.test.mjs`
- `.agents/skills/architect/orchestrator/guards-control-dir.test.mjs`
- `.agents/skills/architect/orchestrator/adapters/claude-permissions.test.mjs`
- `.agents/skills/architect/orchestrator/agy-shared-settings.test.mjs`
- `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`
- `.agents/skills/architect/orchestrator/audit-hardening.test.mjs`
- `.agents/skills/architect/orchestrator/prompts-untrusted.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-105: Поиск бинарников: `EPERM`/`EACCES` как «нет в каталоге», настоящий `git` только вне проекта
  - Риск: высокий.
  - Зависит от: —.
  - Читать: `.agents/skills/architect/orchestrator/find-executable.test.mjs`, `.agents/skills/architect/orchestrator/events.mjs` (символы `isGuardShimFile`, `findExecutable`), `.agents/skills/architect/orchestrator/guards.mjs` (строки 1–55), `.agents/skills/architect/orchestrator/run.mjs` (строки 1–45), `.agents/skills/architect/orchestrator/cli-exit-codes.test.mjs` (тест `C-06`).
  - Менять: `.agents/skills/architect/orchestrator/events.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/run.mjs`.
  - Задача и инварианты:
    - Сигнатура: `findExecutable(bin, envPath = process.env.PATH, { excludeUnder = [] } = {})`. Ошибка `statSync` с кодом `EPERM` или `EACCES` значит «в этом каталоге нет»: поиск идёт к следующему каталогу `PATH`; для абсолютного `bin` — `null`. Любой другой код ошибки бросается как раньше (fail-closed). `ENOENT` / `ENOTDIR` — как сейчас (`throwIfNoEntry: false`).
    - Каталог `PATH` пропускается, если его реальный путь (`realpathSync`; несуществующий — `path.resolve`) равен реальному пути элемента `excludeUnder` или лежит внутри него. Сравнение — по сегментам пути (`dir` или `dir + path.sep`). Без опции поведение прежнее.
    - `which(bin, envPath, opts)` и `whichOptional(bin, envPath, opts)` передают `opts` в `findExecutable`; текст ошибки `binary not found in PATH: <bin>` прежний.
    - `run.mjs`: строка 38 становится ровно `const realGit = which('git', process.env.PATH, { excludeUnder: [process.cwd()] });` — без новых строк (лимит `C-06`: `split('\n').length <= 370`, сейчас 370).
    - `events.mjs` не импортирует `permissions.mjs` (свой помощник реального пути); `catch` только с явной проверкой кода ошибки, без пустых блоков.
  - Граничные случаи: относительный элемент `PATH` (разрешается от `process.cwd()`); элемент `PATH` — симлинк в проект; `excludeUnder` задан через симлинк; каталог без права поиска (`chmod 000`); запуск от root (каталог читается — тест проходит и так). Окружение песочницы: базовый прогон в самом проекте до первой правки (не через `git worktree`); красные до правок тесты через `installGuards` (`EPERM`) — ожидаемы, после правки они должны стать зелёными и в песочнице.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/find-executable.test.mjs`.
  - Готово, когда: все тесты `find-executable.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; `run.mjs` — не больше 369 строк (`wc -l`); нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/find-executable.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs .agents/skills/architect/orchestrator/guards-shim-speed.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs .agents/skills/architect/orchestrator/guards-git-path.test.mjs .agents/skills/architect/orchestrator/guards-read.test.mjs .agents/skills/architect/orchestrator/guards-recovery.test.mjs .agents/skills/architect/orchestrator/guards-runners.test.mjs .agents/skills/architect/orchestrator/git-shim-policy.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs`

- [x] T-106: Вопрос и ответ о разрешении — в управляющем каталоге вне проекта
  - Риск: высокий.
  - Зависит от: T-105.
  - Читать: `.agents/skills/architect/orchestrator/ask-control-dir.test.mjs`, `.agents/skills/architect/orchestrator/control-dir.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/feed.mjs` (символы `statusText`, `printStatus`, `watch`, `runView`), `.agents/skills/architect/orchestrator/cli-dispatch.mjs` (строки 140–152), `.agents/skills/architect/orchestrator/ask-question.test.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`.
  - Задача и инварианты:
    - `ask.mjs`: `questionPath(workDir, home = os.homedir())` = `path.join(controlDirFor({ workDir, home }), 'question.json')`, `answerPath` — то же с `answer.json`. `clearQuestion(workDir, home = os.homedir())`, `writeAnswer({ workDir, answer, home = os.homedir() })`, `readPendingQuestion(workDir, home = os.homedir())`, `submitAnswer({ workDir, answer, home = os.homedir() })` (передаёт `home` в `readPendingQuestion` и `writeAnswer`), `answerPendingPermission(targetDir, answer, home = os.homedir())` — по `questionPath(targetDir, home)` / `answerPath(targetDir, home)`.
    - `askPermission`: новая опция `home` (по умолчанию `os.homedir()`). Если задан `opts.workDir` — до записи вопроса `ensureControlDir({ workDir, home })`, файлы — `questionPath(workDir, home)` / `answerPath(workDir, home)`, уборка — `clearQuestion(workDir, home)`. Режим только с `runDir` и копии `<label>.question.json` / `<label>.answer.json` в каталоге прогона — без изменений.
    - Блокировка остаётся `<workDir>/.agent-runs/.lock` (`lockHolder(path.join(workDir, RUNS_DIR))`). Старый `<workDir>/.agent-runs/question.json` больше не читается и не пишется.
    - Сообщения об ошибках сохраняют фразы `the loop is not asking anything`, `not running`, `cannot be read`, `not one of the options`; упоминание `${RUNS_DIR}/question.json` в них заменить на `question.json`. Комментарий в шапке `ask.mjs` — про новое место файлов.
    - `feed.mjs`: `statusText(workDir, now = Date.now(), home = os.homedir())`, `printStatus({ workDir, planPath, out, home = os.homedir() })`, `watch({ workDir, minutes, since, pollMs, graceMs, home = os.homedir() })` передают `home` в `readPendingQuestion`; вызов `statusText` внутри `watch` — с тем же `home`. Правки в существующих строках: `feed.mjs` сейчас 396 строк и должен остаться не больше 400.
    - `cli-dispatch.mjs` и `run.mjs` не менять: они работают с `home` по умолчанию (`os.homedir()`).
  - Граничные случаи: управляющего каталога ещё нет при чтении (`readPendingQuestion` — «вопроса нет», без исключения); симлинк на месте управляющего каталога — `askPermission` бросает ошибку `ensureControlDir`; вопрос в управляющем каталоге при мёртвом `.lock` — `stale`; два вопроса подряд с одной меткой. Окружение: базовый прогон в самом проекте до первой правки (не через `git worktree`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/ask-control-dir.test.mjs`.
  - Готово, когда: все тесты `ask-control-dir.test.mjs` зелёные; регрессионные тесты из `Проверка` (в том числе `ask-question.test.mjs` и `feed.test.mjs` с переданным `home`) зелёные; `ask.mjs` и `feed.mjs` ≤ 400 строк; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/ask-control-dir.test.mjs .agents/skills/architect/orchestrator/control-dir.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/ask-question.test.mjs .agents/skills/architect/orchestrator/ask.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs .agents/skills/architect/orchestrator/feed-en.test.mjs .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/skill-path.test.mjs .agents/skills/architect/orchestrator/guards-shim-speed.test.mjs .agents/skills/architect/orchestrator/permissions-launchers.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [x] T-107: Shim-файлы в управляющем каталоге, их хэши, оверлеи в слепке; чтение каталога shim для `claude`
  - Риск: высокий.
  - Зависит от: T-106.
  - Читать: `.agents/skills/architect/orchestrator/guards-control-dir.test.mjs`, `.agents/skills/architect/orchestrator/adapters/claude-permissions.test.mjs`, `.agents/skills/architect/orchestrator/control-dir.mjs`, `.agents/skills/architect/orchestrator/guards.mjs` (символы `GUARDED_UNTRACKED_FILES`, `installGuards`, `verifyGuards`), `.agents/skills/architect/orchestrator/run.mjs` (строки 100–126), `.agents/skills/architect/orchestrator/adapters/claude.mjs` (строки 1–200 и 385–397), `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (проверка `<= 400` строк для `adapters/claude.mjs`).
  - Менять: `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/adapters/claude-permissions.mjs` (новый).
  - Задача и инварианты:
    - `guards.mjs`: в `GUARDED_UNTRACKED_FILES` после прежних пяти добавить `.agents/orchestrator.local.json` и `.architect/config.local.json`. Реэкспорт `export { freshShimDir } from './control-dir.mjs';`.
    - `installGuards({ …, backupDir = path.dirname(shimDir) })`: резервные копии `.before` / `.after` охраняемых файлов пишутся в `backupDir`. После записи всех shim — слепок SHA-256 каждого элемента непосредственно в `shimDir` (не обычный файл — фиксированная метка вместо хэша). `verify()` возвращает проблемы `verifyGuards` и затем по каждому shim ровно одну из строк: `guard shim <name> was modified during the turn`, `guard shim <name> was removed during the turn`, `guard shim <name> was created during the turn`. Ошибка чтения при сверке бросается (fail-closed).
    - `run.mjs`: `installGuards({ workDir, shimDir: freshShimDir({ workDir }), backupDir: runDir, blockedNpmScripts: config.blockedNpmScripts, realGit })`; `freshShimDir` — через существующую строку импорта из `./guards.mjs`. Без новых строк (лимит `C-06`).
    - Перенести без изменений из `adapters/claude.mjs` в новый `adapters/claude-permissions.mjs`: `CLAUDE_SETTINGS_SHOWN`, `claudeSettingsPath`, `toClaudeBashRule`, `claudeRulesFor`, `writeClaudeAllowlist`, `checkClaudePathTarget`, `claudeRuleProblem`, `claudePermissionsCheck`, `claudeAllowlistBlock` и нужные им помощники. `adapters/claude.mjs` реэкспортирует их под прежними именами; `claude-permissions.mjs` не импортирует `claude.mjs`. Оба файла ≤ 400 строк.
    - `claudeRulesFor`: каталог shim `S = realOrResolved(controlShimDir({ workDir: w, home }))`; `additionalDirectories` — `[<внешний каталог скилла, если есть>, S]` в этом порядке; в `allow` после правила чтения скилла — `Read(//S/**)`; `deny` прежний (запись под `~/.config/architect/**` уже запрещена).
    - `checkClaudePathTarget` для `Read`: цель внутри `S` этого проекта разрешена; любой другой путь под `~/.config/architect` — по-прежнему `reading outside project and skill directory is forbidden`. `claudePermissionsCheck`: элемент `additionalDirectories`, равный `S`, допустим; без `S` — `missing required rules … additionalDirectories: <S>`; другой каталог под `~/.config/architect` — небезопасный.
  - Граничные случаи: каталога shim ещё нет при `--write-permissions` (`realOrResolved` разрешает предков); `home` через симлинк; скилл внутри проекта (в `additionalDirectories` только `S`); агент создал каталог внутри `shimDir`; `verify()` после `restore()`. Окружение: базовый прогон в самом проекте до первой правки (не через `git worktree`). `write-permissions-prune.test.mjs` и `audit-hardening.test.mjs` красны до `T-108` — их в этой задаче не запускать.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/guards-control-dir.test.mjs`, `.agents/skills/architect/orchestrator/adapters/claude-permissions.test.mjs`.
  - Готово, когда: все тесты двух эталонных файлов зелёные; регрессионные тесты из `Проверка` зелёные; `run.mjs` ≤ 369 строк (`wc -l`), `guards.mjs`, `adapters/claude.mjs`, `adapters/claude-permissions.mjs` ≤ 400 строк; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/guards-control-dir.test.mjs .agents/skills/architect/orchestrator/adapters/claude-permissions.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs .agents/skills/architect/orchestrator/guards-git-path.test.mjs .agents/skills/architect/orchestrator/guards-read.test.mjs .agents/skills/architect/orchestrator/guards-recovery.test.mjs .agents/skills/architect/orchestrator/guards-runners.test.mjs .agents/skills/architect/orchestrator/git-shim-policy.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/adapters/claude.test.mjs .agents/skills/architect/orchestrator/adapters/claude-transcript.test.mjs .agents/skills/architect/orchestrator/adapters/claude-models.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/claude-setup.test.mjs .agents/skills/architect/orchestrator/permissions-paths.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/feed-en.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs .agents/skills/architect/orchestrator/evals-permissions.test.mjs`

- [x] T-108: Общий файл настроек `agy`: слияние без удаления правил, правила других проектов — пометка
  - Риск: высокий.
  - Зависит от: T-107.
  - Читать: `.agents/skills/architect/orchestrator/agy-shared-settings.test.mjs`, `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`, `.agents/skills/architect/orchestrator/audit-hardening.test.mjs` (строки 184–255), `.agents/skills/architect/orchestrator/agy-settings.mjs` (контракт `foreignProjectRule`), `.agents/skills/architect/orchestrator/permissions.mjs` (строки 1–80 и 226–393), `.agents/skills/architect/orchestrator/permissions-cli.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/agy-settings.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/permissions-cli.mjs`.
  - Задача и инварианты:
    - Перенести без изменений из `permissions.mjs` в `agy-settings.mjs`: `readAgyRules`, `unsafeRules`, `writeAgyAllowlist`, `checkProjectWriteRule`, `checkPermissions`, `permissionsCheck`. `permissions.mjs` реэкспортирует их под прежними именами (`export { … } from './agy-settings.mjs'`), так что все импорты продолжают работать. Модули импортируют друг друга: в `agy-settings.mjs` импортированные из `permissions.mjs` имена используются только внутри тел функций, не на верхнем уровне. Оба файла ≤ 400 строк.
    - `foreignProjectRule(rule, { workDir, home })` — по JSDoc-контракту в `agy-settings.mjs`.
    - `unsafeRules` пропускает правила, для которых `foreignProjectRule` не `null` (поэтому их не считают нарушением и `checkPermissions`, и `permissionsCheck`). Успешный `permissionsCheck` при `N > 0` таких правил дописывает к `detail` `; other projects' file rules: N (shared settings file)`.
    - `writeAgyAllowlist` с `pruneCtx` никогда не удаляет правило: `removedAllow` всегда `[]`, форма ответа с `pruneCtx` прежняя (`{ addedAllow, addedDeny, removedAllow, backup }`); недостающие правила добавляются, `.bak` пишется, повторный вызов ничего не меняет. Без `pruneCtx` — как сейчас.
    - `permissions-cli.mjs`: в `*.pruned.json` архивируется каждое удалённое правило (не только файловые) — это путь `claude`; у `agy` удалённых правил нет, архив не создаётся. Строка `✗ <detail>` при оставшемся небезопасном правиле сохраняется.
    - `ruleProblem` и `proposeRules` не менять.
  - Граничные случаи: `.git` другого проекта — файл (рабочее дерево `git worktree`); правило на подкаталог другого проекта; правило на каталог без `.git`; правило на родителя текущего проекта; симлинк на другой проект; пустой `permissions.allow`. Окружение: базовый прогон в самом проекте до первой правки (не через `git worktree`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/agy-shared-settings.test.mjs`, `.agents/skills/architect/orchestrator/write-permissions-prune.test.mjs`, `.agents/skills/architect/orchestrator/audit-hardening.test.mjs`.
  - Готово, когда: все тесты трёх эталонных файлов зелёные (включая проверку `<= 400` строк в `write-permissions-prune.test.mjs`); регрессионные тесты из `Проверка` зелёные; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/agy-shared-settings.test.mjs .agents/skills/architect/orchestrator/write-permissions-prune.test.mjs .agents/skills/architect/orchestrator/audit-hardening.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-paths.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/permissions-symlink.test.mjs .agents/skills/architect/orchestrator/permissions-unwrap.test.mjs .agents/skills/architect/orchestrator/permissions-launchers.test.mjs .agents/skills/architect/orchestrator/git-policy.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/config.test.mjs .agents/skills/architect/orchestrator/team-config.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/mechanics-verify.test.mjs`

- [ ] T-109: Правило «данные, а не инструкции» в промптах и отчёт Исполнителя между маркерами
  - Риск: высокий.
  - Зависит от: T-108.
  - Читать: `.agents/skills/architect/orchestrator/prompts-untrusted.test.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/prompts.mjs`.
  - Задача и инварианты:
    - Текст `UNTRUSTED_CONTENT_RULE` — контракт Архитектора: не менять. Он входит ровно один раз в `executorPrompt` (сразу после `${TOOLS_RULE}`) и ровно один раз в `architectPrompt`.
    - `architectPrompt(task, report, mechText, executorModel, { …, nonce = randomBytes(8).toString('hex') })`: блок `Executor report:` заменяется на строку правила, затем строку, которая называет id (`nonce`) и говорит, что отчёт закончит только маркер конца с этим id (полные маркеры в ней не повторять), затем `<<<EXECUTOR_REPORT ${nonce}>>>`, текст отчёта, `<<<END_EXECUTOR_REPORT ${nonce}>>>`. Формат ответа (`ANSWER_FORMAT.architect`) — после маркера конца. Остальной текст промпта не менять.
  - Граничные случаи: отчёт-объект (сериализуется как сейчас, внутри маркеров); отчёт с поддельным маркером конца с другим id; пустой отчёт. Окружение: базовый прогон в самом проекте до первой правки (не через `git worktree`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/prompts-untrusted.test.mjs`.
  - Готово, когда: все тесты `prompts-untrusted.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/prompts-untrusted.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/prompts-en.test.mjs .agents/skills/architect/orchestrator/prompts-verify.test.mjs .agents/skills/architect/orchestrator/skill-path.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/mechanics-bypass.test.mjs .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/evals-fixtures.test.mjs`

<!-- executor-policy-version: 1.9 -->
