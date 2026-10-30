# PLAN

## Goal / Requirements
Этап 2 (Цикл 12, `v3.28`): Готовность для других (П6–П10).
- П10d (`T-055`): расширение `BASE_COMMANDS` командами только для чтения (`git ls-files`, `git grep` без `-O` / `--open-files-in-pager`, `git blame`, `git ls-tree`, `git merge-base`, `git rev-list`, `git describe`, `git shortlog`, `git stash list`, `git tag -l`, `git branch -a` / `-r` / `--list`, `git check-ignore`, `pwd`, `which`, `node --version`, `npm ls`) с синхронизацией `commandProblem` и git-shim в `guards.mjs`.
- П10e (`T-056`): валидный патч `stop.diff` (`gitRaw` без `.trim()`) и продолжение работы оркестратора после эскалации на грязном дереве, когда грязные файлы входят в `Change` текущей задачи и совпадают со слепком эскалации (`stop.status.txt` и `stop.diff`), с передачей отчёта об эскалации в `executorPrompt`.
- П6–П10a–c (шаг Архитектора по `MAINTAINING.md`): нейтральное ядро `SKILL.md` (`v3.28`, размер не больше `27780` байт), честные два уровня установки и обновление в `README.ru.md` / `README.en.md`, раздел «Когда скилл не использовать», контроль роста правил (`references/retro.md`, `MAINTAINING.md`), правила эскалаций (а)–(г) в `references/auto-review.md` и пояснение к `### 🔐 Command Permission` в `references/orchestrator.md`.

### Очередь следующих циклов
- **Этап 3 (Приёмка «глазами чужого человека» и механический контроль вне цикла):**
  - временные репо (TS + Vitest, Python + pytest), установка скилла в `.claude/skills/architect/` и `.agents/skills/architect/` по README, ручной режим и `--check` / `--dry-run` / `--self-check`, обновление копии скилла в `~/Desktop/Workspace`;
  - команда для механической проверки коммитов Исполнителя вне цикла оркестратора (границы `Change`, `Frozen`, обходы проверок через `mechanics.mjs`), так как при запуске субагентом или вручную `--self-check` пропускает коммиты `T-NNN`, а `mechanics.mjs` вызывается только внутри `npm run agents`;
  - проверка в `--check`, которая предупреждает, если модель Исполнителя нигде не задана или `.claude/agents/executor.md` содержит `model: inherit` или не содержит `model`;
  - механическая проверка языка и формата сообщений коммитов (код, риск высокий): (а) поле конфига `commitLanguage` (по умолчанию не задано — проверки нет; `"en"` — в теме коммита запрещены буквы не латинского алфавита); (б) хук `commit-msg` на Node без зависимостей (`--install-hooks` или в составе `--init`; `--check` проверяет, что он стоит; хук отклоняет коммит не на том языке и коммиты `arch:` / `T-NNN` не по формату — в том числе коммит, который только отмечает задачу `[x]` в `PLAN.md`, но не начинается с `arch: accept T-NNN` или `arch: приёмка T-NNN`; существующий хук не перезаписывать: если он есть или задан `core.hooksPath` — сообщить в `--check` и не ставить); (в) `--self-check` показывает такие коммиты в диапазоне как предупреждение, а не блок (историю не переписываем); (г) блокировка `git commit --no-verify` в git-шим оркестратора.
- **Замена проверки времени в `guards-shim-speed.test.mjs`:** перевод существующего теста скорости с `performance.now` на структурную проверку (счётчик вызовов/чтений или размер файла).
- **Контроль неизменности `HEAD` хоста во время `runLiveEvals` (`evals.mjs`):** `preStatus` / `postHostStatus` сейчас проверяют только чистоту дерева (`git status --porcelain`), но не сдвиг `HEAD` — фиксировать `Commit:` на старте прогона и сверять с `HEAD` при записи `results.md`.
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-29T19-28-29-841Z @ cde76a4: 9/10 PASS` (`FAIL claude:haiku high_risk_frozen_test`), `eval 2026-10-30T12-11-59-225Z @ 6e8471c: 1/1 PASS`, `eval 2026-10-30T12-13-40-767Z @ 6e8471c: 1/1 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` после S5 пройдено 2 из 3 прогонов, `NOT VERIFIED (sample < 5)`; при следующем живом замере — довести выборку до ≥ 5 прогонов или завести задачу при повторном FAIL).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Этап 4 (Подготовка к публикации):** CI GitHub Actions (`.github/workflows/ci.yml`: `ubuntu-latest` + `macos-latest`, Node 22 + Node 24; Linux до первого зелёного прогона — `NOT VERIFIED`) и финальная чистка личных данных (`/Users/...`, почта, имена проектов, Supabase, ключи).
- **Публикация скилла (`E4`):** выгрузка `.agents/skills/architect/` в отдельный публичный репозиторий под лицензией `MIT` с чистой историей и CI-матрицей GitHub Actions на Node 22 и Node 24 — финальным шагом после Этапа 4, только по отдельной команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-037`) хранится в `docs/decisions.md`.
- **Аудит другой моделью перед `arch: fix-frozen` — отклонено:** перебор для текущего масштаба; вернуться, если `fix-frozen` станет частым.
- **ADR-038 (Чтение в `BASE_COMMANDS`, валидный `stop.diff` и продолжение после эскалации):** (1) `BASE_COMMANDS` дополняется командами чтения (`git ls-files`, `git grep`, `git blame`, `git ls-tree`, `git merge-base`, `git rev-list`, `git describe`, `git shortlog`, `git stash list`, `git tag -l`, `git branch -a`, `git branch -r`, `git branch --list`, `git check-ignore`, `pwd`, `which`, `node --version`, `npm ls`); `commandProblem` и git-shim в `guards.mjs` разрешают только безопасные аргументы чтения для `git branch`, `git tag`, `git grep` (без `-O` / `--open-files-in-pager`) и `node --version` / `-v`. (2) `gitRaw` в `git.mjs` сохраняет пробельные контекстные строки unified diff при записи `stop.diff`; `resolveEscalationResume` в `check.mjs` разрешает старт после эскалации, только если грязные файлы входят в `Change` текущей задачи и совпадают со слепком `stop.status.txt` и `stop.diff` последнего прогона с `stop_escalation`, а `executorPrompt` включает отчёт об эскалации (`EXECUTOR.md:25`).

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs` — эталонный тест `T-055`
- `.agents/skills/architect/orchestrator/escalation-resume.test.mjs` — эталонный тест `T-056`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-055: Read-only commands in BASE_COMMANDS, commandProblem, and git shim (П10d)
  - Контекст: в реальных прогонах агенты регулярно запрашивают безопасные команды чтения (`git grep`, `git ls-files`, `git branch -a` / `-r` / `--list`, `git tag -l`, `git stash list`, `node --version`, `pwd`, `which`, `npm ls`). Необходимо включить их в `BASE_COMMANDS` и синхронизировать проверки аргументов в `commandProblem` (`permissions.mjs`) и git-shim (`guards.mjs`), удерживая оба модуля `<= 400` строк.
  - Риск: высокий
  - Модель: Gemini 4 Argon / High (subagent)
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs`, `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/permissions-readonly.test.mjs`
    - Вход `BASE_COMMANDS` -> включает все 30 нейтральных к стеку команд чтения и локальной верификации (`git status`, `git diff`, `git log`, `git show`, `git rev-parse`, `git branch --show-current`, `git ls-files`, `git grep`, `git blame`, `git ls-tree`, `git merge-base`, `git rev-list`, `git describe`, `git shortlog`, `git stash list`, `git tag -l`, `git branch -a`, `git branch -r`, `git branch --list`, `git check-ignore`, `git add`, `git commit`, `node --test`, `node --version`, `npm ls`, `wc -l`, `grep`, `ls`, `pwd`, `which`).
    - Вход `commandProblem(cmd, blocked)` -> возвращает `null` для всех `BASE_COMMANDS`, `git branch -a` / `-r` / `--list` / `--list <pattern>`, `git tag -l` / `--list`, `git stash list`, `git grep -n ...`, `node --version` / `node -v` (без доп. аргументов), `pwd`, `which`, `npm ls`; отклоняет `git grep -O` / `-O*` / `--open-files-in-pager` / `--open-files-in-pager=*`, мутирующие и пустые вызовы `git branch` (`git branch`, `git branch new-branch`, `git branch -d/-D/-m/-M`, `git branch -a new-branch`, `git branch --list -D feat`), `git tag` без `-l`/`--list` или с `-d/-a/-s/-f/-m/-F/-u`, и `node` кроме `node --test` и одиночного `node --version` / `node -v` (при этом `proposeRules('git stash list', blocked)` сохраняет префикс `git stash` по `permissions.test.mjs`).
    - Вход `writeGitShim` в `guards.mjs` при `AGENT_LOOP=1` -> разрешает `git branch --show-current`, `git branch -a`, `git branch -r`, `git branch --list [<pattern>]` и блокирует (exit `97`) прочие формы `git branch` (включая `git branch --list -D ...`), а также блокирует `git grep -O` / `-O*` / `--open-files-in-pager` / `--open-files-in-pager=*`.
    - `permissions.mjs` и `guards.mjs` остаются `<= 400` строк (`split('\n').length <= 400`).
  - Проверка: `node --test .agents/skills/architect/orchestrator/permissions-readonly.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/permissions-unwrap.test.mjs .agents/skills/architect/orchestrator/permissions-runners.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs`
  - Критерий приёмки: проверка зелёная.

- [x] T-056: Valid stop.diff via gitRaw and escalation resume on matching dirty working tree (П10e)
  - Контекст: (1) `git()` в `git.mjs` вызывает `.trim()`, обрезая пробел в пустой контекстной строке в конце `git diff HEAD`, из-за чего `stop.diff` не проходит `git apply --check`. (2) Согласно `EXECUTOR.md:25`, при эскалации Исполнитель не откатывает свои правки; оркестратор должен разрешать повторный старт после эскалации, если грязные файлы входят в `Change` текущей задачи и совпадают со слепком `stop.status.txt` и `stop.diff` последнего прогона, остановившегося на эскалации этой задачи, и передавать отчёт об эскалации в `executorPrompt`. Все изменяемые модули должны оставаться `<= 400` строк (`split('\n').length <= 400`).
  - Риск: высокий
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Зависит от: T-055
  - Читать: `.agents/skills/architect/orchestrator/git.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/escalation-resume.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/git.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Не трогать: `.agents/skills/architect/orchestrator/escalation-resume.test.mjs`, `PLAN.md`, `EXECUTOR.md`
  - Тест-кейсы: `.agents/skills/architect/orchestrator/escalation-resume.test.mjs`
    - `gitRaw(realGit, cwd, args)` в `git.mjs` возвращает вывод `git` без `.trim()`, а `run.mjs` записывает `stop.diff` через `gitRaw(realGit, workDir, ['diff', 'HEAD'])` (с ровно одним завершающим `\n` для непустого diff), так что `git apply --check --reverse stop.diff` проходит с кодом `0` даже при пустой строке контекста в конце файла.
    - `resolveEscalationResume({ realGit, workDir, task })` в `check.mjs` проверяет последний прогон в `.agent-runs/`: если он остановился с категорией `stop_escalation` (или `status === 'escalation'`) на `task.id`, содержит `stop.status.txt`, `stop.diff` и `<taskId>-*.report.md`, все грязные файлы текущего дерева входят в `task.change` (и не входят в `Frozen`), а текущие `git status --porcelain --untracked-files=all` и `gitRaw(realGit, workDir, ['diff', 'HEAD'])` совпадают со слепком `stop.status.txt` и `stop.diff` — возвращает `{ ok: true, taskId: task.id, runDir, reportText }`; иначе `{ ok: false, reason }`.
    - `localChecks` в `check.mjs` при грязном дереве проверяет `resolveEscalationResume` для следующей открытой задачи плана (`nextTask(plan, only)`): при `ok: true` проверка `'clean working tree'` проходит (`ok: true`), иначе падает (`ok: false`).
    - `executorPrompt` в `prompts.mjs` принимает `escalationReport` (через `layout.escalationReport` или `rework.escalationReport`) и включает инструкции продолжения после эскалации по `EXECUTOR.md` и текст отчёта об эскалации; `run.mjs` передаёт `escalationReport` в `executorPrompt` при старте `round === 0` после эскалации.
    - `git.mjs`, `check.mjs`, `prompts.mjs` и `run.mjs` остаются `<= 400` строк (`split('\n').length <= 400`).
  - Проверка: `node --test .agents/skills/architect/orchestrator/escalation-resume.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/cli-node-version.test.mjs`
  - Критерий приёмки: проверка зелёная.
