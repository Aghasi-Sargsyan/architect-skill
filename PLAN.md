# План

## Цель / Требования
Цикл 33 — Аудит-цикл 3 «Подтверждение и git-shim» (`C-13`…`C-17` из `docs/audits/2026-11-11-{brief,findings}.md`). Реализует первую половину развилки Р-3 (`ADR-061` п. 3). Пользователь утвердил архитектуру 2026-11-12, перенос файлов из `workDir` — в Цикле 34.

Подтверждённые требования (находки сверены с кодом `c3350b3`, бесплатное воспроизведение):
- `C-13`: ответ, положенный в `.agent-runs/answer.json` до вопроса, не принимается; `id` вопроса содержит случайную часть, известную только процессу оркестратора; комментарий у `--answer` (`cli-dispatch.mjs`) соответствует факту.
- `C-14`: сокращения запрещённых длинных опций git (`--no-verif`, `--open-files-in-p`) блокируются так же, как полные формы.
- `C-15`: в репозитории проекта shim блокирует `commit --amend`, `add -A` / `--all` / `-u` / `.`; каталог из `-C` (и `cwd`) проверяется для всех подкоманд. Дополнение Архитектора: shim сейчас пропускает `git config core.hooksPath /dev/null` и алиасы — блокируются белым списком подкоманд.
- `C-16`: префикс `KEY=VALUE`, запускатели (`xcrun`, `busybox` …) и интерпретаторы (`ruby` …) — авто-отказ; для незнакомой программы вопрос остаётся, но с пометкой «оркестратор не распознаёт команду».
- `C-17`: вопрос действителен только при живом владельце `.agent-runs/.lock`; битый `question.json` даёт в `--watch` код 3 с причиной.

Допущения и границы:
- Защиты цикла — ограждение от ошибок модели (Р-1), не граница безопасности: фоновый процесс агента, переживший ход, может прочитать вопрос. Границу даёт только ОС-песочница раннера.
- Перенос `shims/` и файлов вопроса/ответа из `workDir` и хэши shim-файлов (вторая половина Р-3, `C-22`) — Цикл 34.
- `commit -a` / `--all` остаются разрешены: индексируют только отслеживаемые файлы, существующий тест `F-03` коммитит через shim с `-am`.
- Правила скилла (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) не меняются; README и `CHANGELOG.md` — при закрытии цикла (`README.ru.md` — 25 567 байт из 25 600).

Ограничения кода:
- Каждый модуль оркестратора ≤ 400 строк (`audit.test.mjs` и тесты `permissions.mjs` ≤ 400); `run.mjs` в этом цикле не меняется (370/370, тест C-06).
- `feed.mjs` — 395 строк: в `T-101` только замены строк, без новых функций.

Перенесено из предыдущих циклов (`NOT VERIFIED`):
- Новая схема приёмки в живом цикле (ревью `opus-xhigh` только на чтение и коммит приёмки оркестратором) проверена только на поддельном раннере (`run-acceptance.test.mjs`) и интерактивным `commitAcceptance` (`716ad19`); первый живой прогон — `T-101`.
- Нестабильный тест `run.test.mjs` «--background: … the child released the lock»: проверяет блокировку сразу после появления `summary.md`, хотя цикл снимает блокировку после записи `summary.md` (на Node 24 `VERIFY_STEP_A1=1` — 325/326 дважды); исправление — в рамках `C-30` (Цикл 5). Там же `evals-permissions.test.mjs` T-035 (П1, П2) «git status … finishes in <4s»: упал один раз под нагрузкой (Node 22, `VERIFY_STEP_A1=1`, 325/326), в одиночку 3/3.
- Живые замеры промпта (`evals.mjs`) на `v3.49` (по согласию пользователя, `docs/audits/2026-11-11-brief.md` §8).
- Живой запуск раннера `claude` с `--effort` (платный) не выполнялся; аргументы проверены на поддельном бинарнике.

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-065`). Для этого цикла:
- `ADR-065` — протокол вопроса со случайным `id` и проверкой живого цикла, единая git-политика агентов (таблица + вычислитель), shim на этой политике, авто-отказ для `KEY=VALUE`, запускателей и интерпретаторов.
- Контракты: таблица `git-policy-rules.mjs` (данные, `Frozen`); заготовки с JSDoc — `git-policy.mjs`, `readPendingQuestion` и `submitAnswer` в `ask.mjs`, `isRecognizedCommand` в `permissions.mjs`. Сигнатуры, формы результата и подстроки сообщений из JSDoc — часть контракта.
- Дизайн политики и shim проверен Архитектором на прототипе в копии репозитория (не в коммите): `git-policy.test.mjs` и `git-shim-policy.test.mjs` зелёные, все существующие тесты shim и разрешений зелёные, кроме лимита 400 строк `permissions.mjs` (снимается выносом таблиц в `T-102`). Прототип выявил `F-03` (`commit -am` через shim) — `commit -a` оставлен разрешённым.
- Новые модули (`git-policy`, `git-policy-rules`, `git-shim`, `command-tables`) заранее внесены в `AGENTS.md` §5 коммитом плана, поэтому `AGENTS.md` нет в `Менять`.
- В коммите плана Архитектор поменял фикстуры двух существующих тестов без изменения ожидаемых значений: `feed.test.mjs` (живой `.lock` до вопроса), `skill-path.test.mjs` (ответ после записи вопроса вместо заранее положенного `answer.json` — это и есть уязвимость `C-13`). Оба зелёные и до, и после `T-101`, поэтому не в `Frozen` (red-check), а от правок Исполнителя их защищает проверка `Менять`.
- Ожидаемые падения после коммита плана (до закрытия задач): эталонные тесты `T-101`…`T-104` и `packaging-clean.test.mjs` «T-054: skill test suite passes in an isolated temporary directory» (гоняет весь набор, зелёный после `T-104`); остальные 328 тестов зелёные.
- Обходы проверок в этом проекте — `AGENTS.md` §4.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/git-policy-rules.mjs`
- `.agents/skills/architect/orchestrator/ask-question.test.mjs`
- `.agents/skills/architect/orchestrator/git-policy.test.mjs`
- `.agents/skills/architect/orchestrator/git-shim-policy.test.mjs`
- `.agents/skills/architect/orchestrator/permissions-launchers.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-101: Протокол вопроса: случайный `id`, вопрос только живого цикла
  - Риск: высокий.
  - Зависит от: —.
  - Читать: `.agents/skills/architect/orchestrator/ask.mjs` (контракты `readPendingQuestion`, `submitAnswer` — JSDoc в конце файла), `.agents/skills/architect/orchestrator/ask-question.test.mjs`, `.agents/skills/architect/orchestrator/ask.test.mjs`, `.agents/skills/architect/orchestrator/feed.mjs` (строки 165–240 и 286–335: `statusText`, `printStatus`, `watch`), `.agents/skills/architect/orchestrator/feed.test.mjs` (строки 55–125), `.agents/skills/architect/orchestrator/cli-dispatch.mjs` (строки 140–152), `.agents/skills/architect/orchestrator/guards.mjs` (символ `lockHolder`).
  - Менять: `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`.
  - Задача и инварианты:
    - `askPermission`: метка = `id` вопроса вызывающего (или прежний сгенерированный `id`); в `question.json` пишется копия вопроса с `id = <метка>-<randomBytes(12) в hex>` (`node:crypto`, 24 символа). Объект вызывающего не мутируется. Копии в каталоге прогона по-прежнему называются по метке (`<метка>.question.json`, `<метка>.answer.json`).
    - До записи вопроса — удалить `answer.json`; вопрос пишется синхронно до первого `await` (как сейчас); принимается только ответ с `id` из `question.json`, чужой удаляется (как сейчас). Режим терминала (`tty`) не меняется. Суффикс действует и в режиме без `workDir` (только `runDir`).
    - `readPendingQuestion` и `submitAnswer` — строго по JSDoc; `lockHolder` импортировать из `guards.mjs`.
    - `feed.mjs`, `watch`: `readPendingQuestion(workDir)`; при `error` → `{ code: 3, text: 'permission question cannot be read: <error>' }`; при вопросе — код 2 с прежним текстом; иначе прежняя логика (вопрос мёртвого цикла кода 2 не даёт). `printStatus` и `statusText` показывают ожидание ответа только для вопроса из `readPendingQuestion`.
    - `cli-dispatch.mjs`: `--answer` вызывает `submitAnswer` вместо `writeAnswer`; комментарий — по факту: `--answer` недоступен агенту (проверка `AGENT_LOOP` в вызывающем коде), а заранее записанный `answer.json` не совпадёт со случайным `id`.
    - `run.mjs` не менять.
  - Граничные случаи: `answer.json` есть до вопроса (в том числе с меткой без суффикса); два вопроса подряд с одной меткой; `.lock` с мёртвым PID; `question.json` — массив, битый JSON, без `options`, вариант без строкового `answer`; `feed.mjs` ≤ 399 строк.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/ask-question.test.mjs`.
  - Готово, когда: все тесты `ask-question.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; модули ≤ 400 строк; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/ask-question.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/ask.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs .agents/skills/architect/orchestrator/feed-en.test.mjs .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards-shim-speed.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/skill-path.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/audit-hardening.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs .agents/skills/architect/orchestrator/audit.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [x] T-102: Git-политика агентов `git-policy.mjs` и её подключение в `commandProblem`
  - Риск: высокий.
  - Зависит от: —.
  - Читать: `.agents/skills/architect/orchestrator/git-policy.mjs` (контракт — JSDoc), `.agents/skills/architect/orchestrator/git-policy-rules.mjs`, `.agents/skills/architect/orchestrator/git-policy.test.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs` (строки 1–150: таблицы, `unwrapTokens`, `commandProblem`).
  - Менять: `.agents/skills/architect/orchestrator/git-policy.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/command-tables.mjs` (новый).
  - Задача и инварианты:
    - Реализовать `gitArgsProblem` и `runGitPolicyCli` строго по JSDoc. Запуск как программы — сравнение `realpathSync(process.argv[1])` с `fileURLToPath(import.meta.url)`; импорт модуля ничего не запускает и не пишет.
    - `git-policy.mjs` импортирует только `node:*` и `git-policy-rules.mjs`: его запускает shim на каждый вызов git агента.
    - В `commandProblem` — вызов `gitArgsProblem(unwrappedTokens.slice(1))` без `ctx`, только для `git`, последней проверкой перед `return null`: порядок и сообщения прежних проверок не меняются.
    - Лимит 400 строк: перенести таблицы (`BASE_COMMANDS`, `TOO_BROAD`, `WRAPPERS`, `FILE_BINARIES`, `DENIED_BINARIES`, `PY_SAFE_MODULES`, `SUBCOMMAND_TOOLS`, `STANDALONE_TOOLS`, `LEADING_FLAG_RUNNERS`) из `permissions.mjs` в новый `command-tables.mjs` без импортов. `permissions.mjs` реэкспортирует прежние публичные имена (`BASE_COMMANDS`, `WRAPPERS`, `FILE_BINARIES`, `SUBCOMMAND_TOOLS`, `STANDALONE_TOOLS`) без изменения значений. Заглушку `isRecognizedCommand` не трогать (`T-104`).
  - Граничные случаи: сокращения длинных опций и пересечения префиксов (порядок поиска — JSDoc); кластеры коротких опций и их значения (`-mn`, `-qm x`); значения `--message` / `--trailer`; `--` и `--end-of-options`; накопительный и пустой `-C`; несуществующий каталог; симлинк на проект; вложенный репозиторий; песочница и пустой `sandboxRoot`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/git-policy.test.mjs`.
  - Готово, когда: все тесты `git-policy.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; `git-policy.mjs` ≤ 250 строк, `permissions.mjs` ≤ 400; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/git-policy.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-paths.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/permissions-symlink.test.mjs .agents/skills/architect/orchestrator/permissions-unwrap.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/commit-hooks.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/write-permissions-prune.test.mjs .agents/skills/architect/orchestrator/config.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/audit-hardening.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/evals-fixtures.test.mjs .agents/skills/architect/orchestrator/mechanics-verify.test.mjs .agents/skills/architect/orchestrator/audit.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards-runners.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [x] T-103: Git-shim на git-политике: модуль `git-shim.mjs`
  - Риск: высокий.
  - Зависит от: T-102.
  - Читать: `.agents/skills/architect/orchestrator/git-shim-policy.test.mjs`, `.agents/skills/architect/orchestrator/guards.mjs` (строки 1–185 и 296–347), `.agents/skills/architect/orchestrator/runners.mjs` (символ `pathCheckSnippet`), `.agents/skills/architect/orchestrator/events.mjs` (символ `isGuardShimFile`), `.agents/skills/architect/orchestrator/git-policy.mjs` (JSDoc `runGitPolicyCli`).
  - Менять: `.agents/skills/architect/orchestrator/git-shim.mjs` (новый), `.agents/skills/architect/orchestrator/guards.mjs`.
  - Задача и инварианты:
    - Перенести `writeGitShim` вместе с `unwrapGit` и `shQuote` из `guards.mjs` в новый `git-shim.mjs`. `git-shim.mjs` не импортирует `guards.mjs` (без цикла импортов); `guards.mjs` реэкспортирует `writeGitShim` и `unwrapGit` под прежними именами, `installGuards` вызывает `writeGitShim` как сейчас.
    - Сигнатура: `writeGitShim({ shimDir, realGit, sandboxRoot, workDir = '', realNode = process.execPath, policyPath = <каталог git-shim.mjs>/git-policy.mjs })`, возвращает путь shim; прежние проверки аргументов сохраняются.
    - Текст shim: заголовок `# agent-loop guard: git shim` во второй строке и строка `REAL_GIT='…'` без изменений (их читают `isGuardShimFile` и `unwrapGit`). Добавить `POLICY_NODE=<shQuote(realNode)>` и `POLICY=<shQuote(policyPath)>`.
    - Внутри ветки `AGENT_LOOP=1` все прежние проверки остаются и идут первыми (их сообщения сохраняются). Непосредственно перед блоком `push` — ровно одна строка:
      ```sh
      NODE_OPTIONS= NODE_PATH= "$POLICY_NODE" "$POLICY" "$WORK_REAL" "$SANDBOX_ROOT" "$@" </dev/null || exit 97
      ```
    - Без `AGENT_LOOP=1` shim по-прежнему сразу выполняет `exec` настоящего git.
  - Граничные случаи: пустой `workDir` (`WORK_REAL=''` — политика без проверки каталогов); пути с пробелами и `'` (`shQuote`); политика упала или отсутствует → 97; размер shim ≤ `SHIM_MAX_BYTES`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/git-shim-policy.test.mjs`.
  - Готово, когда: все тесты `git-shim-policy.test.mjs` и `git-policy.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; `guards.mjs` и `git-shim.mjs` ≤ 400 строк; нет пустых `catch` (кроме cleanup с причиной) и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/git-shim-policy.test.mjs .agents/skills/architect/orchestrator/git-policy.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs .agents/skills/architect/orchestrator/guards-git-path.test.mjs .agents/skills/architect/orchestrator/guards-read.test.mjs .agents/skills/architect/orchestrator/guards-recovery.test.mjs .agents/skills/architect/orchestrator/guards-runners.test.mjs .agents/skills/architect/orchestrator/guards-shim-speed.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/audit-hardening.test.mjs .agents/skills/architect/orchestrator/commit-hooks.test.mjs .agents/skills/architect/orchestrator/evals-permissions.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/audit.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs`

- [x] T-104: Авто-отказ для `KEY=VALUE`, запускателей и интерпретаторов; пометка незнакомой команды
  - Риск: высокий.
  - Зависит от: T-101, T-102.
  - Читать: `.agents/skills/architect/orchestrator/permissions-launchers.test.mjs`, `.agents/skills/architect/orchestrator/permissions.mjs` (`commandProblem`, `unwrapTokens`, заглушка `isRecognizedCommand`), `.agents/skills/architect/orchestrator/command-tables.mjs`, `.agents/skills/architect/orchestrator/ask.mjs` (символ `questionText`).
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/command-tables.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`.
  - Задача и инварианты:
    - Сразу после проверок пустой команды и операторов shell: первое слово или первое слово после `unwrapTokens` вида `/^[A-Za-z_][A-Za-z0-9_]*=/` → отказ с сообщением, содержащим `environment variable` и это слово.
    - В `command-tables.mjs` добавить `LAUNCHERS` и `INTERPRETERS` и включить их в `DENIED_BINARIES`:
      - `LAUNCHERS`: `xcrun`, `busybox`, `toybox`, `doas`, `pkexec`, `runuser`, `setsid`, `flock`, `script`, `watch`, `chroot`, `unshare`, `nsenter`, `sandbox-exec`, `launchctl`, `parallel`, `expect`, `ionice`, `taskset`, `chrt`, `systemd-run`, `firejail`, `bwrap`, `proot`, `fakeroot`, `xvfb-run`, `dbus-run-session`, `sg`, `newgrp`;
      - `INTERPRETERS`: `ruby`, `irb`, `php`, `lua`, `luajit`, `tclsh`, `wish`, `Rscript`, `pwsh`, `powershell`, `fish`, `dash`, `ksh`, `mksh`, `csh`, `tcsh`, `jshell`, `groovy`, `nodejs`, `pypy`, `pypy3`, `python2`, `ipython`, `julia`, `guile`, `racket`, `sbcl`, `ghci`, `runghc`;
      - `deno`, `docker`, `pip`, `gh` не добавлять: они уходят вопросом человеку.
    - `isPython` — `/^python\d*(\.\d+)*$/` вместо точных `python` / `python3`; правило тест-раннеров (`-m pytest` и др.) сохраняется.
    - `isRecognizedCommand` — строго по JSDoc; пустая команда → `false` без исключения.
    - `questionText`: если `!isRecognizedCommand(question.command)`, сразу после строки `**Command:**` — пустая строка и `**Note:** the orchestrator does not recognize this command — check what it does before allowing it`; для распознанных команд текст побайтно прежний.
    - Прежние сообщения отказов не меняются; `permissions.mjs` ≤ 400 строк.
  - Граничные случаи: обёртки перед `KEY=VALUE` (`nice`, `timeout 5`); `python3.12 -m pytest` разрешён, `python3.12 -c` — отказ; пустая команда в `isRecognizedCommand`; цикл импортов `ask.mjs` → `permissions.mjs` недопустим в обратную сторону. Окружение: в песочнице раннера тесты через `installGuards` (`guards-runners`, `run`, `run-acceptance`, `adapters/index`, часть `audit-hardening` и `audit`) падают с `EPERM` на каталоге из `PATH` в домашней папке — и до правок тоже (так было в `T-101`…`T-103`). Снять базовый прогон в самом проекте до первой правки (не через `git worktree`), в отчёте сравнить «до/после» по именам тестов и закоммитить, если новых падений нет; оркестратор повторяет `Проверка` вне песочницы.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/permissions-launchers.test.mjs`.
  - Готово, когда: все тесты `permissions-launchers.test.mjs` зелёные; регрессионные тесты из `Проверка` зелёные; модули ≤ 400 строк; нет пустых `catch` и обходов проверок.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/permissions-launchers.test.mjs .agents/skills/architect/orchestrator/git-policy.test.mjs .agents/skills/architect/orchestrator/ask-question.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-paths.test.mjs .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/permissions-symlink.test.mjs .agents/skills/architect/orchestrator/permissions-unwrap.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/ask.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/check-en.test.mjs .agents/skills/architect/orchestrator/commit-hooks.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/write-permissions-prune.test.mjs .agents/skills/architect/orchestrator/config.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/audit-hardening.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/evals-fixtures.test.mjs .agents/skills/architect/orchestrator/mechanics-verify.test.mjs .agents/skills/architect/orchestrator/audit.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/guards-runners.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/run-acceptance.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

<!-- executor-policy-version: 1.8 -->
