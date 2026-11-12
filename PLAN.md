# План

## Цель / Требования
Цикл 36 «Передача `--background` → `--watch`» (`ADR-071`, `T-118`…`T-119`, риск high). Вопрос о разрешении и остановка цикла доходят до чата только через `--watch` (код 2 / 3). Связка `--background` → `--watch` хрупкая: `--background` возвращает управление до того, как дочерний процесс возьмёт блокировку (2,5–6,7 с в 11 запусках из 11 при окне `--watch` 2 с), и `--watch` сразу после него ложно сообщает об остановке со сводкой прошлого прогона. Если `--watch` не запущен, цикл молча ждёт ответа до 60 мин (вопрос `T-112` в Цикле 35).

Критерий успеха:
- `--background` возвращает код 0 только после подтверждённого старта, печатает следующую команду `--watch --since 0` и честный список каналов; падение дочернего процесса до блокировки — код 1 с хвостом его вывода (`T-118`).
- `sendNotification` пишет в лог, что сделал: macOS-уведомление, webhook (`T-118`).
- `--dry-run` отклоняет в `Менять` пути, всегда замороженные для Исполнителя (`T-119`).
- Правило в `references/orchestrator.md` §1–§2 и версия v3.53 — коммитом Архитектора после приёмки `T-118`.

Шаг Архитектора после приёмки `T-118` (не задача Исполнителя: `references/` и `.md` в корне скилла всегда заморожены для него): коммит `arch: rules v3.53 …`. §1 — сразу после `--background` в том же ходе запустить фоновый `--watch --since 0` из его вывода. §2 — первый `--watch` после запуска не берёт N из `--status`. Синхронизация по `MAINTAINING.md` §1: `SKILL.md` — только номер версии той же длины; `README.ru.md` ≤ 25 600 байт; `README.en.md`, корневой `README.md`, `CHANGELOG.md`, `package.json` 3.53.0.

Порядок циклов: Аудит-цикл 6 «Self-check и fail-closed» (`C-31`…`C-34` из `docs/audits/2026-11-11-{brief,findings}.md`) — Цикл 37, `C-34` первой задачей. Туда же шум `fatal: path '.architect/PLAN.md'` в выводе `--background` / `--dry-run` (`C-45`, `selfcheck.mjs:181` — тот же `catch`, что в `C-33`).

Ограничения цикла:
- `run.mjs` 369 из 370 строк: новая логика только в `background.mjs` (`ADR-069`), `run.mjs` должен уменьшиться; `feed.mjs` (394) не трогаем.
- Red-check эталонных тестов проверен Архитектором вручную по виду сбоя: `AssertionError` или `Not implemented` заглушки `background.mjs` (честный red-check — `C-34`, Цикл 37).
- Набор тестов на момент плана: 433 теста — 422 зелёных и 11 эталонных красных (`background.test.mjs` — 8 из 8, `plan-validate-frozen-change.test.mjs` — 3 из 4; четвёртый, «обычные пути разрешены», зелёный по замыслу).

Перенесено из предыдущих циклов (`NOT VERIFIED`):
- `T-110`: остановка цикла по таймауту `Verify` в `run.mjs` не покрыта тестом (покрыт только `kind: "timeout"` в `mechanics.mjs`).
- `T-112`: `--stop` вживую на настоящем цикле не запускался (проверен эталонным тестом с дочерним процессом); `killTrackedChildren` завершает только прямой процесс агента, его внуки — нет.
- macOS-уведомление о вопросе разрешения: `osascript` завершается с кодом 0, но Script Editor не зарегистрирован в Центре уведомлений пользователя — баннер, вероятно, не показывается (на экране не проверялось).
- Живые замеры промпта (`evals.mjs`) на `v3.51`/`v3.52` (по согласию пользователя, `docs/audits/2026-11-11-brief.md` §8).
- Авто-отказы `C-16` и пометка «the orchestrator does not recognize this command» проверены только тестами.
- `agy --settings` и `agy --sandbox` вживую не проверялись по решению пользователя; `agy` работает без ОС-песочницы.
- Отложено в Аудит-цикл 7: adversarial eval-сценарий (`C-20` → `C-42`), уведомление об обновлении (`C-22` → `C-39`).

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-071`); для цикла главное — `ADR-071`.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/background.test.mjs`
- `.agents/skills/architect/orchestrator/plan-validate-frozen-change.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
- [ ] T-118: `--background` returns only after the loop has confirmed its start and prints the next `--watch`
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/background.mjs` (the contract stub), `.agents/skills/architect/orchestrator/background.test.mjs`, `.agents/skills/architect/orchestrator/run.mjs` (imports, lines 1–30; the `--background` block, lines 88–103), `.agents/skills/architect/orchestrator/run-lock.mjs` (`readLockOwner`; `stopLoop` — the counted-steps pattern, lines 158–180), `.agents/skills/architect/orchestrator/events.mjs` (`resolveWebhookUrl`, `sendNotification`, lines 144–305), `.agents/skills/architect/orchestrator/run.test.mjs` (the `--background` test, lines 56–82).
  - Change: `.agents/skills/architect/orchestrator/background.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/events.mjs`.
  - Task & invariants: (1) implement `startBackground` exactly as the JSDoc contract in `background.mjs` says (replace the stub body, keep the contract comment, no task IDs in comments). (2) `run.mjs`: the `if (opts.background)` block becomes a call `startBackground({ workDir, runsDir, args: <process.argv.slice(2) without --background>, scriptPath: fileURLToPath(import.meta.url), config })`, prints `res.text`, sets `process.exitCode = 1` when `!res.ok`, returns; remove imports that become unused; no new logic in `run.mjs` (`ADR-069`), the file must shrink. (3) `events.mjs`: new export `deliveryChannels({ config, env = process.env, home = os.homedir(), webhookFile, platform = process.platform })` → one line that always contains `questions reach the chat only through --watch`; `config.notify` false → also `notifications: off` and nothing about channels; otherwise `macOS notification: on (delivery is not confirmed by macOS)` on darwin, and `webhook: configured` or `webhook: not configured` via `resolveWebhookUrl`; never the URL. (4) `sendNotification` logs through `log` (when given): `notification: macOS sent` after a successful osascript call, `webhook: not configured` when no URL resolves, `webhook: sent` after the fetch resolves; the existing `notification not sent: …` / `webhook not sent: …` lines and the return value stay; never log the URL. (5) Real defaults in `startBackground`: `spawn`, `readLockOwner`, a `setTimeout` sleep, steps 600, stepMs 100; the parent never takes the lock and does not kill the child.
  - Edge cases: a lock of another pid keeps polling; a child that already stopped after creating a run folder not older than the launch counts as started; older run folders, `check-*` and `background-*` entries never confirm; spawn `error` → failed start naming the error; empty or missing output file → `(no output)`; the home directory is printed as `~`.
  - Test cases: `.agents/skills/architect/orchestrator/background.test.mjs`
  - Done when: the frozen test is green; the `--background` test in `run.test.mjs` stays green (the first output line keeps its format); `run.mjs` has fewer than 369 lines; baseline run of the Verify commands in the project itself before the first edit (not in a worktree or a copy outside the project). The full suite is not part of this task's Verify: the T-119 reference tests stay red until T-119 (plan fix after the escalation `T-118-fix1`).
  - Verify: `node --test .agents/skills/architect/orchestrator/background.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`

- [ ] T-119: `--dry-run` rejects files always frozen for the Executor in `Change`
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/plan-validate-frozen-change.test.mjs`, `.agents/skills/architect/orchestrator/plan-validate.mjs` (`validatePlan`, lines 145–193), `.agents/skills/architect/orchestrator/layout.mjs` (`isAlwaysFrozenFile`, `alwaysFrozenFiles`, lines 105–175), `.agents/skills/architect/orchestrator/check.mjs` (`localChecks`, lines 140–160 — how `changeIssues` become a ✗ line).
  - Change: `.agents/skills/architect/orchestrator/plan-validate.mjs`.
  - Task & invariants: in `validatePlan`, for every open task and every `Change` path (normalized as today), when `isAlwaysFrozenFile(norm, { workDir: opts.workDir ?? process.cwd() })` is true, push `task <id>: <norm> is always frozen for the Executor — change it in an Architect commit (arch: …), not in Change` to `changeIssues`, one entry per path. The existing `PLAN.md` rule stays. `check.mjs` already turns `changeIssues` into a `✗ Change («Менять») field` line for `--dry-run`, `--check`, the loop and `--background`; `cli.mjs` (`--self-check`) does not read `changeIssues` — keep it that way (archived plans are history).
  - Edge cases: closed `[x]` tasks are not checked; the `./` prefix and backslashes normalize as today; nested `.md` below the skill root (e.g. `orchestrator/notes.md`), root `README.md`, `package.json` and `AGENTS.md` stay allowed; no import cycle (`layout.mjs` does not import `plan-validate.mjs`). Inside the `claude` sandbox `npm test` also fails `T-115: with probe: true the live turn runs`, `T-045` and `T-060` (`runLiveEvals`) with `EPERM` on `~/.gemini/…`: environment, not a regression — report it, do not fix it; the orchestrator runs `Verify` outside the sandbox.
  - Test cases: `.agents/skills/architect/orchestrator/plan-validate-frozen-change.test.mjs`
  - Done when: the frozen test is green; `plan-validate.test.mjs`, `plan-gates.test.mjs` and `check.test.mjs` stay green; baseline run of the Verify commands in the project itself before the first edit.
  - Verify: `node --test .agents/skills/architect/orchestrator/plan-validate-frozen-change.test.mjs .agents/skills/architect/orchestrator/plan-validate.test.mjs .agents/skills/architect/orchestrator/plan-gates.test.mjs .agents/skills/architect/orchestrator/check.test.mjs`, `npm test`

<!-- executor-policy-version: 1.9 -->
