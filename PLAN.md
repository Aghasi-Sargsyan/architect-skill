# PLAN

## Goal / Requirements
Цикл 24 (`v3.34 / 1.8`, Полевая закалка скилла и оркестратора по итогам аудита `sl-factory-kit` за Циклы 7–15 / `T-027`..`T-051`, задачи `T-078`..`T-081`):
1. В правилах скилла (`SKILL.md` `v3.34`, `references/retro.md`, `references/auto-review.md`):
   - в `Step 0` (`Fast path: /architect update`) проверять `.agent-runs/.lock` перед обновлением и останавливаться при живом процессе оркестратора;
   - запретить прямые `arch:` коммиты рантайм-кода в high-risk путях без эталонного теста или явной записи `NOT VERIFIED`;
   - требовать автономности `Frozen`-тестов (без зависимости от gitignored/неотслеживаемых папок вроде `reference/`, `.idea/`) и размещения входных файлов задач внутри `<workDir>`, а не во внешних scratch-путях;
   - в `references/auto-review.md` требовать отдельный коммит `arch: accept T-NNN` / `arch: приёмка T-NNN` для каждой принятой задачи до `arch: close cycle`;
   - в `references/retro.md` требовать сверку каждого SHA коммита из ретро-таблицы с `git log --oneline <base>..HEAD` и проверку `.agent-runs/*/summary.md` (`events.jsonl`) на предмет остановок/ретраев цикла до очистки `.agent-runs/`.
2. В оркестраторе (`T-078`..`T-081`):
   - **`T-078` (`update.mjs`):** блокировать `updateSkill` (без `--force`), если в `.agent-runs/.lock` записан живой PID (`lockHolder`), игнорируя мёртвые PID; уточнить подсказку `checkSkillUpdateAvailable` (`(when no loop is running)`).
   - **`T-079` (`adapters/agy.mjs`):** экспортировать `finishFromTranscript(conversationId, home)` и восстанавливать завершённый ответ субагента в `runAgent`, когда `agy` завершился с кодом `0` и `raw.status !== 'SUCCESS'` (`ERROR` на финальном summary-шаге после `finish`), если в `transcript.jsonl` уже есть завершённый вызов `finish` и нет отказов разрешений (`deniedFromTranscript`).
   - **`T-080` (`prompts.mjs`):** в `TOOLS_RULE` явно запретить вызов `read_file` на бинарных/нетекстовых ассетах (`.ico`, изображения, аудио, шрифты, архивы) и указать `ls` (или `git ls-files`) для просмотра содержимого папок вместо `find`; в `autoRefusalPrompt` подсказывать `ls` при отказе на `find` и напоминать про коммит через `git commit --only <paths>`.
   - **`T-081` (`selfcheck.mjs`, `hooks.mjs`):** поддержать мультицикловые диапазоны в `runSelfCheckGit` (собирать `Frozen`-тесты из всех коммитов `arch: plan|план` в диапазоне и не помечать последующие `arch: plan|план` коммиты как нарушение `fix-frozen`); проверять `ADR-NNN` именно в заголовке коммита, удалившего тестовый файл; добавить предупреждения (`warnings`) при закрытии цикла без коммита `arch: accept T-NNN` / `arch: приёмка T-NNN` и при `arch:` коммите кода в `bypassScanPaths` без изменения тестов.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячеек eval `first_run_no_executor_model` (`NOT VERIFIED (sample < 5)`):** `eval 2026-11-03T14-14-27-157Z @ 3a046ba: 2/2 PASS` (`agy:gemini-4-argon-high` и `claude:haiku`, по 1 прогон на ячейку, `NOT VERIFIED (sample < 5)`).
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Отложено в очередь (командный режим v2):** схема «у каждого разработчика свой Архитектор» (несколько параллельных Архитекторов в одном репозитории) — вне объёма v1.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-052`) хранится в `docs/decisions.md`.
- **ADR-053 (`2026-11-05`, Принято): Полевая закалка скилла и оркестратора по итогам аудита `sl-factory-kit` за Циклы 7–15 (`v3.34 / 1.8`, `T-078`..`T-081`).** (1) `updateSkill` (`update.mjs`) и `SKILL.md` (`Step 0`) проверяют `.agent-runs/.lock` через `lockHolder` и блокируют обновление при активном цикле оркестратора без `--force`; (2) `adapters/agy.mjs` восстанавливает результат завершённого тул-вызова `finish` из `transcript.jsonl`, если `agy` вернул `exit 0` и `raw.status === 'ERROR'` на пост-шаге суммаризации без отказов разрешений; (3) `prompts.mjs` запрещает `read_file` на бинарных ассетах и подсказывает `ls` + `git commit --only` при автоотказе на `find`; (4) `selfcheck.mjs` корректно обрабатывает мультицикловые `arch: plan` коммиты, проверяет `ADR-NNN` на конкретном коммите удаления теста и выдаёт предупреждения при пропуске `arch: accept T-NNN` или при нетестированных `arch:` коммитах кода в `bypassScanPaths`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/update.test.mjs`
- `.agents/skills/architect/orchestrator/adapters/agy.test.mjs`
- `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
- `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [x] T-078: Защита --update от запуска во время активного цикла оркестратора (.agent-runs/.lock) и уточнение подсказки обновления
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/update.mjs` (строки 1–105, 320–358), `.agents/skills/architect/orchestrator/guards.mjs` (строки 255–285), `.agents/skills/architect/orchestrator/update.test.mjs` (строки 330–425)
  - Менять: `.agents/skills/architect/orchestrator/update.mjs`
  - Задача и инварианты: (1) импортировать `lockHolder` из `./guards.mjs` в `update.mjs`; (2) в `updateSkill` перед проверкой `git status` и клонированием, если `!force`, проверить `const activePid = lockHolder(path.join(workDir, '.agent-runs'))`; если `activePid !== null`, выбросить `new Error(\`cannot update skill while orchestrator loop is running (PID \${activePid} in .agent-runs/.lock); wait for the loop to finish or re-run with --update --force\`)`; (3) в `checkSkillUpdateAvailable` (`update.mjs`) дополнить текст `notice`, чтобы он заканчивался на `(when no loop is running)`: `architect skill update available (${installedShort} -> ${remoteShort}) — run "/architect update" or "node .agents/skills/architect/orchestrator/run.mjs --update" (when no loop is running)`; (4) файл `update.mjs` обязан оставаться `<= 400` строк и без пустых `catch {}`.
  - Граничные случаи: если `.agent-runs/.lock` содержит мёртвый PID (`lockHolder` возвращает `null`), `--update` не блокируется; при `force: true` (`--update --force`) проверка `.lock` пропускается.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/update.test.mjs`
  - Готово, когда: `update.test.mjs` (включая `T-078`) полностью проходит, `update.mjs <= 400` строк.
  - Проверка: `node --test .agents/skills/architect/orchestrator/update.test.mjs`

- [x] T-079: Восстановление завершённого ответа finish из transcript.jsonl в adapters/agy.mjs при пост-ошибке суммаризации
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/adapters/agy.mjs` (строки 15–55, 190–245), `.agents/skills/architect/orchestrator/adapters/agy.test.mjs` (строки 1–136)
  - Менять: `.agents/skills/architect/orchestrator/adapters/agy.mjs`
  - Задача и инварианты: (1) экспортировать функцию `finishFromTranscript(conversationId, home = os.homedir())` в `adapters/agy.mjs`, которая читает `transcriptPath(conversationId, home)` и ищет с конца к началу запись со статусом `row.status === 'DONE'` и элементом `tc` в `row.tool_calls`, у которого `tc.name === 'finish'` и `tc.args` (объект или JSON-строка) содержит непустое строковое поле `status` (или `verdict`); возвращает распарсенный объект `args` или `null`, если файл отсутствует или подходящий вызов не найден; (2) в `runAgent` (`adapters/agy.mjs`), после проверки `deniedFromTranscript`, когда `raw && raw.status !== 'SUCCESS'`, если `r.status === 0`, вызвать `const finishArgs = finishFromTranscript(conv, home)`; если `finishArgs` найден, попытаться распарсить `parseAgentResponse(raw.response)` (а если `raw.response` пуст или не парсится в JSON — использовать `finishArgs` как `json`), вывести в `log` строку `agy: recovered completed finish response after status ${raw.status}` и вернуть `{ ok: true, json, raw, recoveredAfterFinish: true, conversationId: conv, transcript, attempts: attempt, seconds: elapsed() }`; (3) если `finishArgs === null` (или были `denied_actions` / `deniedFromTranscript`), сохранять прежнее fail-closed поведение с ретраями; (4) `adapters/agy.mjs` обязан оставаться `<= 400` строк и без пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/adapters/agy.test.mjs`
  - Готово, когда: `agy.test.mjs` (включая `T-079`) и `agy-parse.test.mjs` полностью проходят, `adapters/agy.mjs <= 400` строк.
  - Проверка: `node --test .agents/skills/architect/orchestrator/adapters/agy.test.mjs .agents/skills/architect/orchestrator/adapters/agy-parse.test.mjs`

- [x] T-080: Запрет read_file на бинарных ассетах в TOOLS_RULE и подсказки ls / git commit --only в autoRefusalPrompt (prompts.mjs)
  - Риск: средний
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/prompts.mjs` (строки 1–65), `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs` (строки 50–105), `.agents/skills/architect/orchestrator/prompts.test.mjs` (строки 1–120)
  - Менять: `.agents/skills/architect/orchestrator/prompts.mjs`
  - Задача и инварианты: (1) в `TOOLS_RULE` (`prompts.mjs`) добавить правило не вызывать `read_file` на бинарных/нетекстовых файлах (например `.ico`, изображениях, аудио, шрифтах, архивах) и использовать `ls` (или `git ls-files`) в терминале для просмотра списков файлов вместо `find`; (2) в `autoRefusalPrompt` (`prompts.mjs`) добавить подсказку использовать `ls` при отказе на `find` и напоминание коммитить файлы задачи через `git commit --only <paths>`; (3) сохранить все существующие инварианты `prompts.test.mjs`, `prompts-en.test.mjs`, `prompts-verify.test.mjs` и удержать `prompts.mjs <= 400` строк.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs`
  - Готово, когда: `field-permissions-prompts.test.mjs`, `prompts.test.mjs`, `prompts-en.test.mjs` и `prompts-verify.test.mjs` проходят, `prompts.mjs <= 400` строк.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/prompts-en.test.mjs .agents/skills/architect/orchestrator/prompts-verify.test.mjs`

- [ ] T-081: Поддержка мультицикловых arch: plan, проверка ADR-NNN на коммите удаления теста и предупреждения ретро-аудита в selfcheck.mjs / hooks.mjs
  - Риск: высокий
  - Зависит от: —
  - Читать: `.agents/skills/architect/orchestrator/selfcheck.mjs` (строки 205–394), `.agents/skills/architect/orchestrator/hooks.mjs` (строки 340–385), `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs` (строки 120–236)
  - Менять: `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/hooks.mjs`
  - Задача и инварианты: (1) в `runSelfCheckGit` (`selfcheck.mjs`) при сборе `frozenTestSet` парсить `PLAN.md` из каждого коммита в `allCommits`, чей `subject` матчит `/^arch:\s*(?:plan|план)\b/i` (а также `effectivePlanText`), и в цикле проверки `commitsAfterPlan` пропускать коммиты с `/^arch:\s*(?:plan|план)\b/i`, чтобы мультицикловый диапазон `--base` не вызывал ложных нарушений `without arch: fix-frozen` на последующих планах циклов; (2) при проверке удалённых тестовых файлов (`baseTestFiles`) проверять, что хотя бы один коммит в `allCommits`, который затронул данный `testFile` (`c.files.map(norm).includes(norm(testFile))`), содержит `/\bADR-\d+\b/.test(c.subject)` (а не любой сторонний коммит в диапазоне); (3) добавить предупреждения в `warnings` (`runSelfCheckGit`), когда: (a) в диапазоне есть коммит задачи `T-NNN:` и последующий коммит `arch: close cycle` / `arch: закрытие цикла`, но между ними (или в диапазоне) нет коммита `arch: accept T-NNN` / `arch: приёмка T-NNN` (текст предупреждения должен содержать идентификатор `T-NNN` и слово `accept` или `приёмка`), и (b) коммит `arch:` (не являющийся `plan|план`, `accept|приёмка`, `close cycle|закрытие цикла`, `fix-frozen`, `init`, `update`) меняет кодовые файлы внутри `config.bypassScanPaths` (не являющиеся тестовыми по `isTestFile` и не являющиеся `.md`/`.json`), не меняя при этом ни одного тестового файла в том же коммите (текст предупреждения должен содержать путь файла или заголовок коммита и слово `test` или `NOT VERIFIED`); (4) оба файла `selfcheck.mjs` и `hooks.mjs` обязаны оставаться строго `<= 400` строк и без пустых `catch {}`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs`
  - Готово, когда: `field-selfcheck-retro.test.mjs`, `selfcheck.test.mjs` и `commit-hooks.test.mjs` полностью проходят, `selfcheck.mjs <= 400` строк и `hooks.mjs <= 400` строк.
  - Проверка: `node --test .agents/skills/architect/orchestrator/field-selfcheck-retro.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/commit-hooks.test.mjs`
