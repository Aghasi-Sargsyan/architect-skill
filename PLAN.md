# План

## Цель / Требования
Цикл 35 (Аудит-цикл 5 «Надёжность цикла и CLI», находки `C-24`…`C-30` из `docs/audits/2026-11-11-{brief,findings}.md`, риск medium–high; нумерация продолжает `T-110`, `ADR-068`/`ADR-069`). Цикл 34 заархивирован в `docs/plans/2026-11-12-cycle-34-audit-cycle-4-isolation-and-honest-docs.md`.

Подтверждено пользователем (вариант 1): весь план `T-110`…`T-117`, включая `--stop` (`T-112`).

Ограничения по размеру (из Цикла 34): `run.mjs` ≤ 370 строк при 369 сейчас — каждая задача, меняющая `run.mjs`, даёт прирост не больше +1 строки (остальное — в новых модулях и функциях `mechanics.mjs` / `check.mjs`); `feed.mjs` 396 из ~400 — нулевой прирост; `SKILL.md` 33 778 из 33 792 байт (тест «prompt diet»); `README.ru.md` 25 521 из 25 600 байт.

Перенесено из предыдущих циклов (`NOT VERIFIED`):
- Живые замеры промпта (`evals.mjs`) на `v3.51` (по согласию пользователя, `docs/audits/2026-11-11-brief.md` §8).
- Авто-отказы `C-16` и пометка «the orchestrator does not recognize this command» проверены только тестами.
- `agy --settings` и `agy --sandbox` вживую не проверялись по решению пользователя; `agy` работает без ОС-песочницы.
- Отложено в Цикл 7: adversarial eval-сценарий (`C-20` → `C-42`), уведомление об обновлении (`C-22` → `C-39`).

Цикл 35 (`NOT VERIFIED`):
- `T-110`: остановка цикла по таймауту `Verify` в `run.mjs` не покрыта тестом (покрыт только `kind: "timeout"` в `mechanics.mjs`).
- `T-112`: `--stop` вживую на настоящем цикле не запускался (проверен эталонным тестом с дочерним процессом); `killTrackedChildren` завершает только прямой процесс агента, его внуки — нет.

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-069`); для цикла главные — `ADR-068` (контракты `C-24`…`C-30`) и `ADR-069` (новые модули вместо роста перегруженных файлов). В плановом коммите Архитектор уже: добавил в `config.example.json` пять шаблонов обходов (индексы 10..14) и поднял `verifyTimeoutMs` до 600000; обновил ожидания `T-042` (длина `bypassPatterns` 15) и `T-043a` (`verifyTimeoutMs` 600000).

Решения по ходу цикла (эскалации):
- `T-110`: эталонные тесты запускали `node script.mjs`, а `commandProblem()` пропускает только `node --test <файл>` — тест переписан (`arch: fix-frozen T-110`).
- `T-112`: (1) `guards.test.mjs` ждал старый формат блокировки (голый PID) — сверяет `pid` из JSON (`arch: fix-frozen T-112`); (2) песочница `claude` (Seatbelt) не даёт запускать setuid `/bin/ps`: без времени старта JSON-блокировка с живым PID считается живой, но `verified: false`, и `--stop` её не сигналит (безопасная сторона); `run-lock.test.mjs` проверяет обе ветки (с `ps` и без). `readLockOwner` возвращает `{pid, alive, legacy, verified}` — принятое отступление Исполнителя от контракта.

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/config.example.json`
- `.agents/skills/architect/orchestrator/mechanics-verify-output.test.mjs`
- `.agents/skills/architect/orchestrator/mechanics-bypass-scope.test.mjs`
- `.agents/skills/architect/orchestrator/run-lock.test.mjs`
- `.agents/skills/architect/orchestrator/check-probe.test.mjs`
- `.agents/skills/architect/orchestrator/feed-protocol.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-110: `Verify`: large output is not a timeout; timeout stops the loop as an environment problem
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/mechanics.mjs` (`runTaskVerification`, `extractOutputTail`), `.agents/skills/architect/orchestrator/run.mjs` (lines 290–312, the `verifyRes` branch), `.agents/skills/architect/orchestrator/mechanics-verify-output.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/run.mjs`.
  - Task & invariants: (1) `spawnSync` in `runTaskVerification` gets `maxBuffer: 256 * 1024 * 1024`; a pass or failure with 3 MiB of output is reported as such (`passed` / `failed` with `exitCode`), never `timeout`. (2) A timeout is detected only by `res.error?.code === 'ETIMEDOUT'` (drop the `signal === 'SIGTERM' && status === null` guess); the result is `{ ok: false, kind: 'timeout', timedOut: true, environment: true, failedCommand, outputTail, results }`; `failed` and `passed` never carry `environment: true`. (3) The default `timeoutMs` in the function signature becomes `config?.verifyTimeoutMs ?? 600000` (the config default is already 600000). (4) In `run.mjs` a `timeout` result stops the loop: `stopReason = \`${task.id}: Verify timed out (environment): ${command}\`` and `break outer` — no rework round is spent; `failed` still goes to rework as today. The `verify_checked` event keeps its fields. `run.mjs` may grow by at most +1 line (limit 370): compress the touched branch instead of adding lines.
  - Edge cases: output tail stays ≤ 4000 characters; the exit code 3 with 3 MiB of stdout keeps the last lines in `outputTail`; a command killed by a signal other than the timeout is `failed`, not `timeout`.
  - Test cases: `.agents/skills/architect/orchestrator/mechanics-verify-output.test.mjs`
  - Done when: the frozen test is green; `run.mjs` ≤ 370 lines; existing Verify tests stay green.
  - Verify: `node --test .agents/skills/architect/orchestrator/mechanics-verify-output.test.mjs .agents/skills/architect/orchestrator/mechanics-verify.test.mjs .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`

- [x] T-111: Bypass scanner ignores comments, strings and foreign languages
  - Risk: high.
  - Depends on: T-110
  - Read: `.agents/skills/architect/orchestrator/mechanics.mjs` (`findBypasses`, `PROTO_BYPASS_RE`, `TEST_SKIP_ONLY_RE`), `.agents/skills/architect/orchestrator/config.example.json` (`bypassPatterns`, read-only), `.agents/skills/architect/orchestrator/mechanics-bypass-scope.test.mjs`, `.agents/skills/architect/orchestrator/mechanics-bypass.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/bypass-scope.mjs`.
  - Task & invariants: `findBypasses(diffText, patterns, testFilePatterns)` keeps its signature and the existing config-array indices; scoping is built in the new `bypass-scope.mjs` (keeps `mechanics.mjs` ≤ 400 lines) and keyed by the pattern `source` of the known patterns (patterns the code does not know apply to every file, as today). (1) `any` patterns (`[:<,|=>&[(]\s*any\b`, `\bas\s+any\b`) and the skip/only family apply only to `.ts .tsx .mts .cts .js .jsx .mjs .cjs` files and are matched against the added line with comments (`//…`, `/* … */` and ` * ` doc lines) and string/template literals blanked out. (2) Directive patterns (`@ts-ignore|expect-error|nocheck`, `eslint-disable`) match inside comments too and in the same file kinds. (3) `# noqa`, `# type: ignore`, `@pytest.mark.skip…` apply only to `.py`; `#[allow(` only to `.rs`. (4) `as unknown as` and the prototype/`globalThis`/`__proto__` pattern keep today's behavior (all files; the prototype pattern is still skipped for test files). (5) `['skip'](`, `skip: true`, `.todo(`, `xit(` (config indices 10..13) apply to JS/TS test files, `@pytest.mark…` (index 14) to `.py`. A line that only contains the word `skip`/`only`/`any` in prose never matches.
  - Edge cases: a `// @ts-ignore` comment is still a hit; a string containing `// any` blanks correctly (a `//` inside a string is not a comment start); an unterminated quote on a line does not throw (blank to the end of the line); diff headers `+++ b/…` keep switching the active file.
  - Test cases: `.agents/skills/architect/orchestrator/mechanics-bypass-scope.test.mjs`
  - Done when: the frozen test is green; `mechanics-bypass.test.mjs`, `selfcheck.test.mjs`, `field-bypass-frozen.test.mjs` stay green; `mechanics.mjs` ≤ 400 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/mechanics-bypass-scope.test.mjs .agents/skills/architect/orchestrator/mechanics-bypass.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/field-bypass-frozen.test.mjs`

- [x] T-113: `--set-model` replaces the whole model line and validates the id
  - Risk: medium.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/models.mjs` (`validateModelName`, lines ~40–60 and ~200–235), `.agents/skills/architect/orchestrator/models.test.mjs`, `AGENTS.md` (line 5 sample `Исполнитель по умолчанию — …`; read-only).
  - Change: `.agents/skills/architect/orchestrator/models.mjs`, `.agents/skills/architect/orchestrator/models.test.mjs`.
  - Task & invariants: (1) the id must match `/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/` after `normalizeModelValue`; anything else throws before any file is written. (2) The fallback replacement for `Исполнитель по умолчанию — <model>` replaces the whole model phrase up to the sentence-ending period that is followed by whitespace or end of line (the phrase may contain dots and spaces, e.g. `Gemini 3.8 Flash (High)`), and keeps the trailing period. (3) The `Executor model: …` replacement keeps its current behavior (backticks preserved). (4) Return `ok: true` only when at least one file was actually changed.
  - Edge cases: model phrase with dots and parentheses; a line already in backticks; a model id with `/` (`vendor/model-1.5`); an id with a space or a quote is rejected; no matching line → `ok: false` (no silent success).
  - Test cases: extend `.agents/skills/architect/orchestrator/models.test.mjs` with: (a) a temp `AGENTS.md` containing `Исполнитель по умолчанию — Gemini 3.8 Flash (High).` and `--set-model executor claude-sonnet-4-5` → exactly `Исполнитель по умолчанию — claude-sonnet-4-5.` with the rest of the file unchanged; (b) the same on a copy of this repository's real `AGENTS.md` line; (c) ids `bad id`, `x"y` and one with a backtick are rejected and the file is byte-identical afterwards; (d) `vendor/model-1.5` is accepted; (e) no matching line → `ok: false`.
  - Done when: all cases above are green; existing `models.test.mjs` cases stay green.
  - Verify: `node --test .agents/skills/architect/orchestrator/models.test.mjs`

- [x] T-112: Atomic loop lock, owner check beyond the PID, and `--stop`
  - Risk: high.
  - Depends on: T-110
  - Read: `.agents/skills/architect/orchestrator/run-lock.test.mjs` (the contract), `.agents/skills/architect/orchestrator/guards.mjs` (`lockHolder`, `acquireLock`, lines ~145–170), `.agents/skills/architect/orchestrator/guards-recovery.mjs` (`activeLoopPid`, lines ~60–80 and ~135–150), `.agents/skills/architect/orchestrator/adapters/agy.mjs` (spawn promise ~107–130), `.agents/skills/architect/orchestrator/adapters/claude.mjs` (~70–95), `.agents/skills/architect/orchestrator/run.mjs` (line ~127, signal handler), `.agents/skills/architect/orchestrator/cli.mjs` (`parseArgs`), `.agents/skills/architect/orchestrator/cli-dispatch.mjs`.
  - Change: `.agents/skills/architect/orchestrator/run-lock.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/guards-recovery.mjs`, `.agents/skills/architect/orchestrator/adapters/agy.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`, `.agents/skills/architect/orchestrator/cli.test.mjs`.
  - Task & invariants: new module `run-lock.mjs` exports (a) `acquireRunLock(runsDir)` → release function: creates the lock with `openSync(path, 'wx')` and writes JSON `{pid, startedAt, token}` (`startedAt` = trimmed output of `ps -o lstart= -p <pid>`, `token` random); on `EEXIST` it reads the owner and throws `loop is already running (PID n, <path>)` when the owner is alive, otherwise removes the stale file and retries once; the release function removes the lock only if its `token` still matches. (b) `readLockOwner(runsDir)` → `null` (no lock) or `{pid, alive, legacy}`; a legacy lock (a bare PID number) is alive iff the PID is alive; a JSON lock is alive iff the PID is alive **and** the `ps` start time equals `startedAt` (EPERM counts as alive for the PID check). (c) `trackChild(child)` registers a spawned agent process; `killTrackedChildren({graceMs})` sends `SIGTERM`, then `SIGKILL` after the grace period, resolves when all are gone. (d) `installStopHandlers({cleanup, exit = process.exit, graceMs})` registers `SIGINT`/`SIGTERM` handlers that run: `await killTrackedChildren` → `cleanup()` → `exit(130)`. (e) `stopLoop({runsDir, signalWaitSteps})` → `{stopped, pid?, reason?}`: no alive owner → `{stopped:false, reason:'no running loop'}` and no signal; alive owner → `SIGTERM` to the owner PID, then waits (bounded polling with `setTimeout`, counted steps — no wall-clock) until the lock disappears or the process is gone. `guards.mjs` `lockHolder`/`acquireLock` and `guards-recovery.mjs` `activeLoopPid` delegate to `run-lock.mjs` (keep their exported names and return types so existing callers and tests stay green). `agy.mjs` and `claude.mjs` call `trackChild(child)` right after spawn. `run.mjs` replaces its `process.on(sig, …)` loop with `installStopHandlers({ cleanup })` — net lines ≤ +1 (limit 370). `cli.mjs` parses `--stop` (boolean, default false); `cli-dispatch.mjs` runs `stopLoop` and prints `loop stopped (PID n)` or the reason (exit code 0 when stopped, 1 when no loop).
  - Edge cases: a lock file with empty or garbage content is stale; the guards `restore()` runs only after the agent process is gone; `stopLoop` never signals a PID of a stale lock (PID reuse); two simultaneous acquires — exactly one wins (frozen test); `--repair` still never clears a lock of a live owner but now clears one with a reused PID.
  - Test cases: `.agents/skills/architect/orchestrator/run-lock.test.mjs`; add to `.agents/skills/architect/orchestrator/cli.test.mjs`: `parseArgs(['--stop']).stop === true`, default `false`, and the dispatch with no running loop exits with code 1 and prints `no running loop`.
  - Done when: the frozen test is green; `guards*.test.mjs`, `cli*.test.mjs`, `run.test.mjs`, `layout.test.mjs` stay green; `run.mjs` ≤ 370 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/run-lock.test.mjs .agents/skills/architect/orchestrator/guards.test.mjs .agents/skills/architect/orchestrator/guards-recovery.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs`

- [x] T-115: `--check` makes no live model call without `--probe`
  - Risk: high.
  - Depends on: T-112
  - Read: `.agents/skills/architect/orchestrator/check-probe.test.mjs`, `.agents/skills/architect/orchestrator/check.mjs` (`runCheckCommand`, lines ~346–372), `.agents/skills/architect/orchestrator/cli.mjs` (`parseArgs`, flag list at line ~42), `.agents/skills/architect/orchestrator/cli-dispatch.mjs` (lines ~150–160).
  - Change: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`.
  - Task & invariants: `runCheckCommand` gets a `probe = false` parameter. When `permissions` is `"allowlist"` and every static check passed: with `probe === false` it prints `– permission probe: skipped (a live model call; run --check --probe to check the permissions end to end)` and returns `allOk`; with `probe === true` it runs `probePermissions` exactly as today. The other skip branches keep their messages. `parseArgs` accepts `--probe` (boolean, default `false`; add it to the boolean flag list and to the initial `opts`); `cli-dispatch.mjs` passes `opts.probe`. `--dry-run`/readiness never call a model (unchanged).
  - Edge cases: `--probe` without `--check` is accepted and ignored; the exit code of `--check` without the probe depends only on the static checks.
  - Test cases: `.agents/skills/architect/orchestrator/check-probe.test.mjs`
  - Done when: the frozen test is green; `check.test.mjs`, `cli*.test.mjs`, `install-check.test.mjs` stay green.
  - Verify: `node --test .agents/skills/architect/orchestrator/check-probe.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs`

- [x] T-114: `--watch` / `--status` protocol matches the documentation
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/feed-protocol.test.mjs`, `.agents/skills/architect/orchestrator/events.mjs` (`milestonesFromEvents`, lines 64–115), `.agents/skills/architect/orchestrator/feed.mjs` (`statusText`, `milestones`, `watch`, lines 170–195, 250–345), `.agents/skills/architect/orchestrator/feed.test.mjs`, `.agents/skills/architect/orchestrator/events.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/events.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`.
  - Task & invariants: (1) `milestonesFromEvents` emits `T-NNN: rework N` and `T-NNN accepted (M min); next T-KKK` (English only). (2) `watch` always prints the count as `(milestones: N)` (drop the `isRu` branch). (3) `statusText` for a running loop appends ` (milestones: N)` to its first line, counting with the same function `watch` uses (events file → `milestonesFromEvents`, else `milestones(run.log)`). (4) `watch` with `since` given, when the loop is **not** running at the first look (no live lock owner) and the latest run has a `summary.md`, starts from the current count, so a restart with `--since 0` does not replay a finished run's milestones. `feed.mjs` must not grow (≤ 396 lines): remove the dead `isRu` code and compress; if still tight, move the count helper into `events.mjs`.
  - Edge cases: the Russian run-log parser `milestones(runLog)` keeps reading old Russian logs (do not break `feed.test.mjs`); `--status` of a stopped loop is unchanged.
  - Test cases: `.agents/skills/architect/orchestrator/feed-protocol.test.mjs`
  - Done when: the frozen test is green; `feed.test.mjs`, `feed-en.test.mjs`, `events.test.mjs`, `events-en.test.mjs` stay green; `feed.mjs` ≤ 396 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/feed-protocol.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs .agents/skills/architect/orchestrator/feed-en.test.mjs .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/events-en.test.mjs`

- [x] T-116: Test suite stable under load: no real-time limits, no nested full-suite run
  - Risk: medium.
  - Depends on: T-112
  - Read: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs` (lines 40–95), `.agents/skills/architect/orchestrator/evals-permissions.test.mjs` (lines ~60–95), `.agents/skills/architect/orchestrator/adapters/agy-parse.test.mjs` (lines ~90–135), `.agents/skills/architect/orchestrator/mechanics-frozen.test.mjs` (lines ~150–190), `.agents/skills/architect/orchestrator/check.test.mjs` (probe tests), `.agents/skills/architect/orchestrator/run.test.mjs` (the `--background` lock test).
  - Change: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/evals-permissions.test.mjs`, `.agents/skills/architect/orchestrator/adapters/agy-parse.test.mjs`, `.agents/skills/architect/orchestrator/mechanics-frozen.test.mjs`, `.agents/skills/architect/orchestrator/check.test.mjs`, `.agents/skills/architect/orchestrator/run.test.mjs`.
  - Task & invariants: the number of `test(`/`it(` blocks and `assert` calls per file never decreases (monotonicity); expected values of other cases are untouched. (1) `packaging-clean.test.mjs` T-054: stop re-running the whole suite; instead copy only the skill folder to a temp dir and check statically that every relative `import`/`from './…'` and `new URL('./…')` target of every `*.mjs` file under `orchestrator/` resolves to a file inside the copied skill folder (no path escapes the folder), then run **one** small test file (`layout.test.mjs`) from the copy as a smoke test with a 60 s safety cap. Keep the `assert` count of the file not lower. (2) `evals-permissions.test.mjs` and `agy-parse.test.mjs`: the 4–5 s `timeout`/`timeoutMs` values that only guard against hangs become 60 000 ms safety caps; titles saying «finishes in <4s» drop the speed claim (rename to «finishes»); the assertions stay. (3) `mechanics-frozen.test.mjs`: replace the `Date.now()` stopwatch (`elapsedMs`) by a structural check — assert that `runAgent` returned `ok: false`, that the stubborn process is dead (`process.kill(pid, 0)` throws) and that the log contains the SIGKILL line; no wall-clock in the test. (4) `check.test.mjs` permission-probe tests pass a temporary `home` so nothing reads the real `~/.gemini/antigravity-cli/brain` (works in the `claude` sandbox). (5) `run.test.mjs` «--background … released the lock»: wait for the condition with a bounded loop of 200 polling steps of 50 ms (counted steps, no `Date.now`) instead of a fixed time budget.
  - Edge cases: the forbidden-timer scan in `selfcheck.test.mjs` must stay green (no `Date.now(`, `performance.now(`, `process.hrtime`, `console.time(` anywhere in the changed test files).
  - Test cases: structural verification — the changed tests themselves are the check; per-file test and assert counts are guarded by the packaging monotonicity check and the self-check.
  - Done when: all six test files green; no real-time API in them; the isolated check in `packaging-clean.test.mjs` finishes in a few seconds instead of ~100 s.
  - Verify: `node --test .agents/skills/architect/orchestrator/packaging-clean.test.mjs .agents/skills/architect/orchestrator/evals-permissions.test.mjs .agents/skills/architect/orchestrator/adapters/agy-parse.test.mjs .agents/skills/architect/orchestrator/mechanics-frozen.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/run.test.mjs`

- [ ] T-117: Rules, documentation and version v3.52 match the new behavior
  - Risk: high.
  - Depends on: T-110, T-111, T-112, T-113, T-114, T-115, T-116
  - Read: `.agents/skills/architect/MAINTAINING.md` §1 (version sync checklist), `.agents/skills/architect/references/orchestrator.md`, `.agents/skills/architect/CHANGELOG.md` (top 30 lines), `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md` (grep for `--check`, `--status`, `v3.51`), `README.md` (grep), `package.json`.
  - Change: `.agents/skills/architect/SKILL.md`, `.agents/skills/architect/references/orchestrator.md`, `.agents/skills/architect/CHANGELOG.md`, `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md`, `README.md`, `package.json`.
  - Task & invariants: bump the Architect prompt to `# Architect Prompt v3.52` in `SKILL.md` (same byte length; do not add text there — 14 bytes of headroom; if a `--check` mention in `SKILL.md` lines ~102/117 contradicts the new behavior, shorten the sentence so the file does not grow) and `package.json` version `3.52.0`; sync `README.en.md`, `README.ru.md` (≤ 25 600 bytes, currently 25 521 — compress something of equal size), root `README.md` and `CHANGELOG.md` per `MAINTAINING.md` §1. In `references/orchestrator.md` (English only): `--check` skips the live permission probe unless `--probe` is passed (readiness and `--dry-run` never call a model); `--stop` stops a running loop (agent first, then guards, then lock); `--watch`/`--status` print `(milestones: N)` and English milestone lines exactly as in code; the `Verify` timeout is an environment stop, default 600 s. CHANGELOG lists `C-24`…`C-30`.
  - Edge cases: `--self-check` rejects skill-rule changes without a version bump, so the bump and the rule edits go in the same commit; byte limits of `SKILL.md` (≤ 33 792) and `README.ru.md` (≤ 25 600) are enforced by tests.
  - Test cases: structural verification (skill and documentation files); `maintaining.test.mjs`, `skill-packaging.test.mjs`, `skill-structure.test.mjs` are the mechanical check.
  - Done when: the packaging check is green; `README.*` and `CHANGELOG.md` mention v3.52 consistently.
  - Verify: `node --test .agents/skills/architect/orchestrator/maintaining.test.mjs .agents/skills/architect/orchestrator/skill-packaging.test.mjs .agents/skills/architect/orchestrator/skill-structure.test.mjs`

<!-- executor-policy-version: 1.9 -->
