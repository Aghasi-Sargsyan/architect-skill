# PLAN

## Goal / Requirements
Цикл 27 (`v3.38 / 1.8`, Устранение повторных запросов `Command Permission`, зависаний `askPermission` в PTY и ложных сбоев `runRedCheck` по итогам полевого аудита Цикла 26, задачи `T-084`..`T-085`):
1. В `permissions.mjs`, `prompts.mjs` и `run.mjs` (`T-084`):
   - в `proposeRules` (`permissions.mjs`) проверять список уже существующих правил `allow` (из `optsOrWorkDir?.allow`, поддерживая форматы `command(<rule>)`, `Bash(<rule>:*)` и `<rule>`): если префиксное правило `p` или полное правило `full` уже присутствует в `allow`, возвращать `{ auto: true, reason: 'rule "command(' + existing + ')" is already in allowlist, but runner rejected this command form (avoid unquoted globs like *.css or pass a directory path)', fileTool: false }` без остановки цикла на повторный вопрос пользователю;
   - добавить `'shasum'`, `'sha256sum'`, `'md5'` в `FILE_BINARIES` (`permissions.mjs`) при сохранении 30 элементов `BASE_COMMANDS`;
   - в `autoRefusalPrompt` (`prompts.mjs`) при `/already in allowlist/i.test(why)` подсказывать передавать путь к папке или конкретному файлу вместо неэкранированной glob-маски (например `*.css` / `*.js`) или использовать встроенные файловые инструменты;
   - в `run.mjs` передавать `allow: readAgyRules(adapter.permissions.settingsPath(os.homedir(), workDir)).allow` в `proposeRules` и заменить `tty: Boolean(process.stdin.isTTY)` на `tty: Boolean(rl)` в вызове `askPermission`.
2. В `evidence.mjs` (`T-085`):
   - в `runRedCheck` при отсутствии аргумента `plan` искать план по цепочке `[config?.paths?.planPath, '.architect/PLAN.md', 'PLAN.md'].filter(Boolean)` (на диске и в `HEAD:<rel>`);
   - если для любой открытой задачи в плане `resolveEscalationResume({ realGit, workDir: cwd, task, layout: config?.paths }).ok` возвращает `true` (продолжение после эскалации на грязном рабочем дереве), пропускать `red-check` со статусом `{ ok: true, skipped: true, reason: 'resuming ' + task.id + ' after escalation on dirty working tree: red-check skipped', violations: [], notVerified: [], checked: [] }`.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-057`) хранится в `docs/decisions.md`.
- **ADR-058 (`2026-11-10`, Принято): Устранение повторных запросов разрешений и ложных блокировок по итогам аудита Цикла 26 (`v3.38 / 1.8`, `T-084`..`T-085`).** (1) `proposeRules` (`permissions.mjs`) проверяет текущие правила `allow` из `settings.json` (передаваемые из `run.mjs`) и при наличии префиксного или полного правила в `allow` сразу возвращает `{ auto: true }` вместо повторного запроса пользователю, а `autoRefusalPrompt` (`prompts.mjs`) подсказывает передавать путь к папке или файлу без неэкранированной glob-маски `*`; (2) `shasum`, `sha256sum` и `md5` включены в `FILE_BINARIES` (`permissions.mjs`), а `run.mjs` передаёт `tty: Boolean(rl)` в `askPermission`, чтобы запуски без `--pause` внутри PTY (`run_command`) всегда записывали `.agent-runs/question.json`; (3) `runRedCheck` (`evidence.mjs`) поддерживает `.architect/PLAN.md` (`config.paths.planPath`) при отсутствии параметра `plan` и пропускает `red-check` при продолжении задачи после эскалации на грязном рабочем дереве (`resolveEscalationResume`).

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
- `.agents/skills/architect/orchestrator/evidence.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [ ] T-084: Auto-refuse already-allowlisted rules in proposeRules/run.mjs, block shasum/sha256sum/md5 in FILE_BINARIES, add glob hint in autoRefusalPrompt, and bind tty: Boolean(rl) in run.mjs
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (`flash`)
  - Читать: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (строки 75–175), `.agents/skills/architect/orchestrator/permissions.mjs` (строки 15–36, 178–232), `.agents/skills/architect/orchestrator/prompts.mjs` (строки 20–50), `.agents/skills/architect/orchestrator/run.mjs` (строки 15–20, 190–215)
  - Менять: `.agents/skills/architect/orchestrator/permissions.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`
  - Задача и инварианты: (1) В `permissions.mjs`: добавить `'shasum'`, `'sha256sum'`, `'md5'` в `FILE_BINARIES` (массив `BASE_COMMANDS` из 30 элементов не менять); в `proposeRules(command, blockedScripts = [], optsOrWorkDir = null)` после вычисления `p` проверить массив `optsOrWorkDir?.allow`: если он непустой, нормализовать каждое правило `r` через `normalizeCommand(String(r).replace(/^command\((.*)\)$|^Bash\((.*?)(?::\*)?\)$/, '$1$2'))` в `Set`, и если `(p && allowSet.has(p)) || allowSet.has(full)`, вернуть `{ auto: true, reason: \`rule "command(\${existing})" is already in allowlist, but runner rejected this command form (avoid unquoted globs like *.css or pass a directory path)\`, fileTool: false }` (уплотнить соседние строки в `proposeRules`, чтобы `permissions.mjs` оставался строго `<= 400` строк). (2) В `prompts.mjs` (`autoRefusalPrompt`): если `/already in allowlist/i.test(why)`, задать `hint = ' Pass a directory path or explicit file path instead of an unquoted glob (e.g. use a directory path instead of *.css / *.js), or use built-in file tools.'` и стандартный `cont`. (3) В `run.mjs`: импортировать `readAgyRules` из `./permissions.mjs`, в вызове `proposeRules` передать `{ workDir, allow: readAgyRules(adapter.permissions.settingsPath(os.homedir(), workDir)).allow }`, а в вызове `askPermission` заменить `tty: Boolean(process.stdin.isTTY)` на `tty: Boolean(rl)`, сохранив `run.mjs <= 400` строк.
  - Граничные случаи: В комментариях производственных `.mjs` файлов не использовать идентификаторы `T-NNN` (`packaging-clean.test.mjs`); все изменяемые файлы (`permissions.mjs`, `prompts.mjs`, `run.mjs`) обязаны оставаться строго `<= 400` строк и без пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
  - Готово, когда: `field-permissions-prompts.test.mjs`, `permissions.test.mjs`, `prompts.test.mjs`, `run.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/permissions.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`

- [ ] T-085: Support .architect/PLAN.md in runRedCheck and skip red-check when resuming a task after escalation on a dirty working tree (evidence.mjs)
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
