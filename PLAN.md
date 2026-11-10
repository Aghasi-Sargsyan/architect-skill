# План: Цикл 28 — Контекст запросов Command Permission и авто-блокировка отката через терминал (v3.42 / 1.8)

## Цель / Требования
- **Пользователь и проблема:** При появлении запроса `### 🔐 Command Permission` оператор видит только голую строку команды (`git checkout scripts/harvest-native-client.ts`), но не видит ни причины, по которой Исполнитель её вызвал (`toolSummary` / `description` из транскрипта), ни названия текущей задачи, ни понятного объяснения от Архитектора. Кроме того, команды `git checkout`, `git restore` и `git switch` вообще не должны доходить до запроса пользователю: Исполнитель должен откатывать свои правки через `edit_file` и не трогать чужие файлы вне `Change` (`git commit --only` их не заденет).
- **Критерий успеха MVP:**
  1. `forbiddenCommands` (`permissions.mjs`) включает `'git checkout'`, `'git restore'` и `'git switch'`; `commandProblem` и `proposeRules` автоматически отклоняют их (`auto: true`), `writeGitShim` (`guards.mjs`) блокирует эти три подкоманды с `exit 97` при `AGENT_LOOP=1`, а `autoRefusalPrompt` (`prompts.mjs`) подсказывает использовать встроенные файловые тулы (`edit_file` / `write_file`) для своих файлов из `Change` и оставлять чужие файлы вне `Change` нетронутыми (`git commit --only`).
  2. `deniedFromTranscript` (`adapters/agy.mjs`) и `extractClaudeDeniedStep` (`adapters/claude.mjs`) извлекают намерение вызова команды (`toolSummary` или первую строку `thinking`/`content` в Antigravity; `tool_input.description` в Claude Code) в опциональное поле `reason` (добавляется только при непустой строке для обратной совместимости); `run.mjs` передаёт `taskTitle` и `reason` в `askPermission`, а `questionText` (`ask.mjs`) рендерит `(<taskTitle>)` в строке `**Who:**` и секцию `**Why:** <reason>` сразу под `**Command:**`.
  3. В `references/orchestrator.md` §2 (`v3.42`) закреплены 3 обязательных буллета простыми словами перед `---` при коде выхода `2` из `--watch`.

## Решения
- **ADR-059:** Контекст намерения агента в `Command Permission` и авто-блокировка `git checkout` / `git restore` / `git switch` (`v3.42 / 1.8`, `T-086`..`T-087`, `permissions.mjs`, `guards.mjs`, `prompts.mjs`, `adapters/{agy,claude}.mjs`, `ask.mjs`, `run.mjs`, `references/orchestrator.md`):
  - **Выбранный вариант:** (1) добавить `'git checkout'`, `'git restore'` и `'git switch'` в `forbiddenCommands` (`permissions.mjs`), блокировать подкоманды `checkout|restore|switch` в `writeGitShim` (`guards.mjs`) с `exit 97` при `AGENT_LOOP=1` и выдавать в `autoRefusalPrompt` (`prompts.mjs`) адресную подсказку об откате правок через `edit_file` и игнорировании файлов вне `Change` при `git commit --only`; (2) в `deniedFromTranscript` (`adapters/agy.mjs`) искать предшествующий шаг с `run_command` и извлекать `toolSummary` (или первую строку `thinking`/`content`, до 160 символов), в `extractClaudeDeniedStep` (`adapters/claude.mjs`) извлекать `tool_input.description`, включая поле `reason` в возвращаемый объект только при непустом значении; передавать `taskTitle` и `reason` из `run.mjs` в `askPermission` и выводить их в `questionText` (`ask.mjs`); (3) в `references/orchestrator.md` §2 (`v3.42`) обязать Архитектора перед `---` выводить 3 буллета (`What the command does`, `Why the agent requested it`, `Recommendation`).
  - **Отвергнутые альтернативы:** оставлять `git checkout` на усмотрение пользователя в `Command Permission` (отвергнуто: опция `1` открывает `command(git checkout)` с риском переключения веток и затирания незакоммиченных файлов вне `Change`); всегда добавлять `reason: null` в `deniedStep` и `**Why:**` в `questionText` (отвергнуто: ломает обратную совместимость с существующими тестами `adapters/agy.test.mjs`, `adapters/claude.test.mjs` и `ask.test.mjs`).

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/SKILL.md`
- `.agents/skills/architect/references/orchestrator.md`
- `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
- `.agents/skills/architect/orchestrator/adapters/claude.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-086: Авто-блокировка `git checkout`, `git restore` и `git switch` и подсказка об откате через `edit_file`
  - Риск: high.
  - Зависит от: —.
  - Модель: Gemini Flash (`flash`).
  - Читать: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (тест `T-086`), `.agents/skills/architect/orchestrator/permissions.mjs` (строки 85–135), `.agents/skills/architect/orchestrator/guards.mjs` (строки 90–145), `.agents/skills/architect/orchestrator/prompts.mjs` (строки 20–55).
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`.
  - Задача и инварианты:
    1. В `forbiddenCommands(blockedScripts = [])` (`permissions.mjs`) добавить `'git checkout'`, `'git restore'`, `'git switch'` в возвращаемый массив запрещённых команд (сохранив `BASE_COMMANDS.length === 30` и лимит `permissions.mjs <= 400` строк).
    2. В `writeGitShim` (`guards.mjs`) внутри блока `if [ "$AGENT_LOOP" = "1" ]; then` блокировать подкоманды `checkout`, `restore` и `switch` (`if [ "$sub" = "checkout" ] || [ "$sub" = "restore" ] || [ "$sub" = "switch" ]; then echo "agent-loop guard: git $sub is blocked for agents" >&2; exit 97; fi`), уложившись в лимит `guards.mjs <= 400` строк.
    3. В `autoRefusalPrompt` (`prompts.mjs`) при отказе для `git checkout`, `git restore` или `git switch` (`/git\s+(?:checkout|restore|switch)\b/i.test(command) || /git\s+(?:checkout|restore|switch)\b/i.test(reason ?? '')`) формировать `hint`, явно указывающий использовать встроенные файловые тулы (`edit_file` / `write_file`) для отката своих правок в файлах из `Change` и оставлять чужие файлы вне `Change` (`unrelated files outside Change`) нетронутыми (`git commit --only <paths>` их игнорирует).
  - Граничные случаи: вызовы с флагами после подкоманды (`git checkout -- src/app.ts`, `git checkout -b feat/test`, `git restore --staged src/app.ts`) и прямые вызовы git-шима при `AGENT_LOOP=1`; в комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`) и не оставлять пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`.
  - Готово, когда: тест `T-086` в `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`, `permissions.test.mjs`, `guards-git.test.mjs` и `packaging-clean.test.mjs` проходят, все изменяемые модули `<= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/guards-git.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`

- [ ] T-087: Извлечение причины вызова (`reason`) из транскрипта и вывод `taskTitle` + `**Why:**` в `Command Permission`
  - Риск: high.
  - Зависит от: T-086.
  - Модель: Gemini Flash (`flash`).
  - Читать: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (тест `T-087`), `.agents/skills/architect/orchestrator/adapters/agy.mjs` (строки 20–65), `.agents/skills/architect/orchestrator/adapters/claude.mjs` (строки 195–210), `.agents/skills/architect/orchestrator/ask.mjs` (строки 30–55, 110–130), `.agents/skills/architect/orchestrator/run.mjs` (строки 185–220).
  - Менять: `.agents/skills/architect/orchestrator/adapters/agy.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/run.mjs`.
  - Задача и инварианты:
    1. В `deniedFromTranscript(conversationId, home)` (`adapters/agy.mjs`): когда найдена строка `ERROR` с `m = text.match(DENIED_COMMAND_RE)`, просканировать предшествующие строки `j = i - 1` до `0` в поисках шага с `Array.isArray(prev.tool_calls)` и вызовом `run_command` (сопоставляя разкавыченный `CommandLine` с `m[1]` или последний `run_command`); извлечь разкавыченный `tc.args?.toolSummary` (сняв внешние JSON-кавычки `"..."` если они есть), а при его отсутствии — первую непустую строку `prev.thinking` или `prev.content` (обрезав до 160 символов). Если непустая строка `reason` найдена, вернуть `{ kind: 'command', command: m[1], reason }`, иначе `{ kind: 'command', command: m[1] }` без ключа `reason`. Удерживать размер `adapters/agy.mjs <= 400` строк (уплотнив пустые строки или многострочные комментарии в файле).
    2. В `extractClaudeDeniedStep(denials = [])` (`adapters/claude.mjs`): для `d?.tool_name === 'Bash'` извлекать `const reason = typeof d?.tool_input?.description === 'string' ? d.tool_input.description.trim() : '';` и возвращать `{ kind: 'command', command: d.tool_input.command, ...(reason ? { reason } : {}) }` (`<= 400` строк).
    3. В `questionText(question)` (`ask.mjs`): если задан непустой `question.taskTitle`, выводить `**Who:** ${question.who}, task ${question.taskId} (${question.taskTitle})` (иначе без скобок, как раньше); если задан непустой `question.reason`, сразу после строки `**Command:** \`${question.command}\`` добавлять пустую строку и `**Why:** ${question.reason}`. В `askPermission` (`ask.mjs`) при сборке дефолтного `question` пробрасывать `taskTitle` и `reason` при их наличии.
    4. В `run.mjs` при вызове `askPermission` передавать в `question` поля `...(task?.title ? { taskTitle: task.title } : {})` и `...(step.reason ? { reason: step.reason } : {})` (`<= 400` строк).
  - Граничные случаи: JSON-экранированные строки `toolSummary: "\"Run Playwright smoke test\""` в `transcript.jsonl` Antigravity; многострочный `thinking`; отсутствие `toolSummary`/`thinking`/`description` (ключ `reason` не должен присутствовать в объекте `deniedStep`, а `**Why:**` не должен выводиться в `questionText`); в комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`) и не оставлять пустых `catch {}` (любой `catch` для парсинга неполной строки должен содержать комментарий `cleanup` / `abort` / `stop` / `close`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`.
  - Готово, когда: все тесты в `field-permissions-prompts.test.mjs`, `ask.test.mjs`, `run.test.mjs`, `adapters/agy.test.mjs`, `adapters/claude.test.mjs` и `packaging-clean.test.mjs` проходят, все изменяемые модули `<= 400` строк.
  - Проверка:
    - `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
    - `node --test .agents/skills/architect/orchestrator/ask.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/adapters/agy.test.mjs .agents/skills/architect/orchestrator/adapters/claude.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
