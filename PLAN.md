# План

## Цель / Требования
Цикл 38 — Аудит-цикл 7 «Инструкции и периферия» (`C-35`…`C-46` из `docs/audits/2026-11-11-{brief,findings}.md`). Код оркестратора — задачи `T-125`…`T-131`; правила `v3.55` и перевод реестра решений делает Архитектор после приёмки задач.

Решения пользователя в чате (2026-11-13):
- Реестр решений: короткий индекс `decisions.md` плюс полный текст в `decisions-full.md`. Если при закрытии цикла реестр старого формата больше 20 КБ, Архитектор переводит его сам, не спрашивая, и сообщает об этом одной строкой в отчёте (`ADR-074`).
- `--audit-plan` удаляется целиком; старый ключ `auditor` в конфиге не ломает `--check`, а печатается как «ignored» (`ADR-075`).
- Самообновление ставит только метки выпусков `vX.Y.Z`; первую метку `v3.55.0` Архитектор ставит при выпуске, её push — только с согласия пользователя (`ADR-076`).
- Изменения не должны ломать установленные копии у других пользователей: их файлы проекта `--update` не трогает, правила читают старый формат реестра.

Часть Архитектора после приёмки `T-125`…`T-131` (коммит `arch: rules v3.55`, политика Исполнителя `2.0`):
- `C-35` — противоречия в `SKILL.md` и `references/*.md` снимаются одной формулировкой; ядро не растёт.
- `C-36` — при продолжении после эскалации в режиме субагента отчёт об эскалации прикладывается к запросу (`EXECUTOR.md`, `references/orchestrator.md`, `references/auto-review.md`).
- `C-37` — одна формулировка условий активации в `SKILL.md`, `README.en.md` и `AGENTS.md` §1.
- `C-38` — шаг 0 читает индекс; без `decisions-full.md` старый реестр больше 20 КБ читается хвостом и поиском; правило перевода при закрытии — в `references/retro.md`; дубли списка обходов убираются.
- `C-40` — удаляются `references/plan-audit.md` и ссылки на `--audit-plan` в правилах и README; `skill-packaging.test.mjs` `REFERENCE_NAMES` без `plan-audit`.
- `C-43` — документация Linux совпадает с кодом (предупреждение, а не `✗`).
- Ретро 36–37: новый чат не предлагается, пока ждёт фоновый `--watch`; `Verify` без полного набора, пока эталонные тесты другой открытой задачи красные; черновая реализация против полного набора до `arch: plan` для high-risk изменения поведения.
- Заголовки `README.en.md` / `README.ru.md` показывают `v3.53` при маркере `v3.54`: исправить и проверять заголовок в `tests/repo-install.test.mjs`.
- Перевод нашего `docs/decisions.md` (96 КБ, 66 ADR) в индекс при закрытии цикла.

Отложено (не входит в цикл 38):
- `C-45`: мёртвая ветка `report` в `checkExecutorRun` и поля `task.testFiles` / `task.requireTests` — удаление требует снять закреплённые утверждения `prompts-en.test.mjs`; `edit_file` / `write_file` в подсказке отказа закреплены в `feed.test.mjs` и `field-permissions-prompts.test.mjs`.
- `C-46`: учитывается при нарезке задач, отдельной задачи нет.
- `C-42`: живой платный прогон eval — только по отдельному согласию пользователя, иначе `NOT VERIFIED`.

Перенесено из предыдущих циклов (`NOT VERIFIED`):
- `T-124`: новые ветки обработки ошибок (`check.mjs`, `events.mjs`, `guards-recovery.mjs`, `layout.mjs`, `update.mjs`, `adapters/agy.mjs`) не покрыты отдельными тестами.
- Red-check с новым репортёром на живых раннерах `pytest` / Vitest / Jest / `go test` / `cargo test` не проверялся.
- `T-110`: остановка цикла по таймауту `Verify` в `run.mjs` не покрыта тестом.
- `T-112`: `--stop` вживую не запускался; внуки процесса агента не завершаются.
- macOS-уведомление: показ баннера не проверялся; тесты на Node 22 не прогонялись (только Node 24.22.2).
- Живые замеры промпта (`evals.mjs`) на `v3.51`…`v3.54`; `agy --settings` / `agy --sandbox` вживую не проверялись (`agy` без ОС-песочницы).
- Внутри песочницы `claude` `npm test` даёт 3 падения `EPERM` на `~/.gemini/…` — среда (`ADR-072`).

## Решения
См. `docs/decisions.md` (`ADR-001`…`ADR-073`). Решения этого цикла:
- **ADR-074 (реестр решений, `C-38`):** `decisions.md` — индекс, одна строка на ADR не длиннее 300 символов (решение одной фразой, статус `active` / `superseded by ADR-NNN`, указатель); полный текст — дословно в `decisions-full.md` рядом. Старый формат (нет `decisions-full.md`) остаётся рабочим: больше 20 КБ — читается хвостом и поиском. При закрытии цикла Архитектор сам переводит такой реестр (дословный перенос + индекс) в коммите закрытия и пишет строку «было X КБ, стало Y КБ». `--self-check` предупреждает только о длинных строках, добавленных в индекс в своём диапазоне (`decisions-lint.mjs`), поэтому старые реестры пользователей не шумят. Отклонено: только правило чтения (старые длинные строки остаются дорогими); файл на каждый ADR (66 файлов, миграция `layout.mjs`); вопрос пользователю перед переводом (решение пользователя). Пересмотр: индекс превысил 20 КБ.
- **ADR-075 (удаление `--audit-plan`, `C-40`):** решение пользователя вопреки рекомендации починить; принятый риск — у других пользователей пропадает команда. `audit.mjs` и проверка `A-N` в self-check удаляются; `--audit-plan` отвечает `--audit-plan was removed in v3.55 (ADR-075)`; ключ `auditor` допустим и печатается в `--check` строкой `! auditor: ignored — …`. Тесты функции сняты отдельным коммитом `8e128b7`.
- **ADR-076 (метки выпусков, `C-39`, Р-8):** `--update` без `ref` ставит наибольшую метку `vMAJOR.MINOR.PATCH` (`git ls-remote --tags`, у аннотированной метки — коммит `^{}`); нет меток — ошибка с подсказкой `ARCHITECT_UPDATE_REF`; явный `ref` работает как раньше. Уведомление об обновлении сравнивает с той же меткой. Сеть — только в `--check` и `--update`; self-check, `--dry-run` и старт цикла читают кэш (`offline: true`). Первое обновление с v3.54 выполняет старый код и берёт `HEAD`; новое поведение — со следующего. Порядок выпуска: каждая версия правил получает метку. Пересмотр: появятся предрелизные метки.
- **ADR-077 (атомарная установка, `C-39`):** папки скилла и копии `EXECUTOR.md` готовятся рядом (`*.update-new-*`) и меняются переименованием; любой сбой откатывает уже сделанные замены. Неотслеживаемые файлы в папке скилла, которую ведёт git, блокируют `--update` без `--force`; `.version` и игнорируемые файлы не считаются.
- **ADR-078 (`--compact`, `C-41`):** сначала все чтения и разбор JSON, потом запись; сбой записи удаляет уже записанное; цель, равная тому, что записала бы миграция, — не конфликт; пути заменяются только на границе пути (`mydocs/decisions.md`, `vendor/.agents/orchestrator.json` не трогаются); `docs/decisions-full.md` переезжает вместе с реестром.
- **ADR-079 (раннер и промпты, `C-44`, `C-45`):** поддержка Claude Code проверяется по `claude --help` для каждого флага `runClaudeAgent` (номер версии 2.1.259 не подтверждён); `--dry-run` пишет полный промпт в `.agent-runs/dry-run-prompt-T-NNN.md` и печатает путь; дубли фраз в `autoRefusalPrompt` / `resumePrompt` убраны.
- `T-129` эскалация 1: фразы, которые убирает `C-45`, были закреплены регулярными выражениями в `prompts-en.test.mjs:42` и `run.test.mjs:158` (поиск по плану искал текст без `\(`); Архитектор перевёл оба закрепления на оставшуюся формулировку, число проверок не изменилось.
- WAIVER 8e128b7: monotonicity — --audit-plan tests removed with the feature by user decision (ADR-075)

## Заморожено (Frozen — Исполнителю не трогать)
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/update-tags.test.mjs`
- `.agents/skills/architect/orchestrator/update-swap.test.mjs`
- `.agents/skills/architect/orchestrator/layout-atomic.test.mjs`
- `.agents/skills/architect/orchestrator/audit-removal.test.mjs`
- `.agents/skills/architect/orchestrator/runner-hygiene.test.mjs`
- `.agents/skills/architect/orchestrator/decisions-lint.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-125: Self-update follows release tags; the update notice is offline outside --check
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/update-tags.test.mjs`, `.agents/skills/architect/orchestrator/update-tags.mjs` (stub JSDoc = contract), `.agents/skills/architect/orchestrator/update.mjs`, `.agents/skills/architect/orchestrator/cli.mjs` (`runFullSelfCheck`, lines 200–225), `.agents/skills/architect/orchestrator/update.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/update-tags.mjs`, `.agents/skills/architect/orchestrator/update.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`.
  - Task & invariants: implement the stub contracts. `updateSkill` without `ref` (argument or `ARCHITECT_UPDATE_REF`) resolves the tag with `resolveLatestReleaseTag` before cloning and clones that tag (`git clone --depth 1 --branch <tag>`); `no-release-tags` throws `no release tags (vMAJOR.MINOR.PATCH) in <repo>; to update from a branch set ARCHITECT_UPDATE_REF=<branch>`; `unreachable` throws with the detail; nothing is written before the tag is known. The result gains `tag` (null when `ref` was used); `.version` keeps the format `<version> (<short sha>)`. `checkSkillUpdateAvailable` compares the installed SHA with the newest release tag instead of `HEAD`, its notice names the tag and its short SHA, and a new option `offline: true` never spawns git: it returns a valid cached result or `{ updateAvailable: false, notice: null }` (`force` then only skips the cache). `runFullSelfCheck` passes `offline: true`; `runCheckCommand` (`--check`) stays online. Move `readSkillVersion`, `UPDATE_CACHE_TTL_MS` and `checkSkillUpdateAvailable` verbatim into `update-tags.mjs` and re-export them from `update.mjs` (import paths in `cli.mjs` and `check.mjs` unchanged); `update-tags.mjs` must not import `update.mjs`.
  - Edge cases: existing update tests stay green (fixture releases are tagged since the plan commit). Network errors in the notice still fail open (`updateAvailable: false`), the update itself fails closed. Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Test cases: `.agents/skills/architect/orchestrator/update-tags.test.mjs`
  - Done when: the frozen test is green; the listed tests stay green; `update.mjs` and `update-tags.mjs` are each ≤ 400 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/update-tags.test.mjs .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/skill-targets.test.mjs .agents/skills/architect/orchestrator/audit-hardening.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/selfcheck-base.test.mjs .agents/skills/architect/orchestrator/commit-hooks.test.mjs`

- [x] T-126: Self-update installs all or nothing and keeps untracked skill files
  - Risk: high.
  - Depends on: T-125
  - Read: `.agents/skills/architect/orchestrator/update-swap.test.mjs`, `.agents/skills/architect/orchestrator/update-swap.mjs` (stub JSDoc = contract), `.agents/skills/architect/orchestrator/update.mjs` (`updateSkill`), `.agents/skills/architect/orchestrator/skill-targets.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/update-swap.mjs`, `.agents/skills/architect/orchestrator/update.mjs`.
  - Task & invariants: implement the stub contracts. `updateSkill`: unless `force`, call `findUntrackedSkillFiles` for the targets after the lock check and before cloning; a non-empty list throws `untracked files in the skill folder (<paths>); move them out of the skill folder or re-run with --update --force`. Replace the per-target `rmSync` + `cpSync` loop and the separate `EXECUTOR.md` copies with one `installSkillAtomically` call (`files` = the existing root and `.architect/` `EXECUTOR.md`); `assertNoEscapingSymlinks` still runs on the clone before anything is staged. Observable results (`targetDirs`, `skippedDirs`, `.version`, hook install, cache removal) stay as the existing tests expect.
  - Edge cases: a `.claude/skills/architect` symlink to `.agents/skills/architect` is one target, and the link itself survives (`skill-targets.test.mjs`); the staged copy lives next to the target (same file system, so the rename is atomic). Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Test cases: `.agents/skills/architect/orchestrator/update-swap.test.mjs`
  - Done when: the frozen test is green; the listed tests stay green; `update.mjs` ≤ 400 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/update-swap.test.mjs .agents/skills/architect/orchestrator/update-tags.test.mjs .agents/skills/architect/orchestrator/update.test.mjs .agents/skills/architect/orchestrator/skill-targets.test.mjs .agents/skills/architect/orchestrator/audit-hardening.test.mjs`

- [x] T-127: --compact migrates all or nothing with path-boundary rewrites
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/layout-atomic.test.mjs`, `.agents/skills/architect/orchestrator/layout.mjs` (`migrateToCompact`, lines 176–295), `.agents/skills/architect/orchestrator/layout.test.mjs`, `.agents/skills/architect/orchestrator/audit-hardening.test.mjs` (F-11).
  - Change: `.agents/skills/architect/orchestrator/layout.mjs`.
  - Task & invariants: `migrateToCompact` works in two phases (`ADR-078`). Phase 1 reads every source and computes every target text (PLAN.md rewrites, `config.json` JSON with `layout: "compact"`) with no write; a read or JSON error throws naming the file and leaves the project byte-identical. A target that exists and differs from the computed text is a conflict; one that equals it is skipped as already migrated. Phase 2 writes the targets, and any write error deletes what this call wrote (and the folders it created) before rethrowing; sources are removed only after every write succeeded. Add the pair `docs/decisions-full.md` → `.architect/decisions-full.md` and its PLAN.md rewrite. Every path rewrite (PLAN.md and AGENTS.md / CLAUDE.md / GEMINI.md) matches only at a path boundary: the path is not preceded by a letter, digit, `_`, `.`, `/` or `-`.
  - Edge cases: `layout.test.mjs` and F-11 (compound file names such as `my-PLAN.md`) stay green; the empty `docs/plans` / `docs` cleanup and notes are unchanged. Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Test cases: `.agents/skills/architect/orchestrator/layout-atomic.test.mjs`
  - Done when: the frozen test is green; the listed tests stay green; `layout.mjs` ≤ 400 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/layout-atomic.test.mjs .agents/skills/architect/orchestrator/layout.test.mjs .agents/skills/architect/orchestrator/audit-hardening.test.mjs`

- [x] T-128: Remove --audit-plan; ignore a legacy auditor key with a note
  - Risk: high.
  - Depends on: T-125
  - Read: `.agents/skills/architect/orchestrator/audit-removal.test.mjs`, `.agents/skills/architect/orchestrator/cli.mjs` (`parseArgs`, `runFastSelfCheck`, `formatSelfCheckReport`, `formatStartupNotices`, the `--audit-plan` handler near line 285), `.agents/skills/architect/orchestrator/cli-dispatch.mjs` (line 171), `.agents/skills/architect/orchestrator/check.mjs` (lines 213–215, `runCheckCommand`), `.agents/skills/architect/orchestrator/config.mjs` (lines 21–40, 77–87, 182–192, 226–229), `AGENTS.md` §3 and §5.
  - Change: `.agents/skills/architect/orchestrator/audit.mjs` (delete), `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/cli-dispatch.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/config.mjs`, `AGENTS.md`.
  - Task & invariants: delete `audit.mjs` and every use of it (`runPlanAudit`, `checkAuditCoverage`, `rejectedBlockers`, `hasAudit`, `auditRes`, `auditPlan`, the "Rejected blockers" report section and the startup notice). `parseArgs(['--audit-plan'])` throws `--audit-plan was removed in v3.55 (ADR-075)`. `config.mjs`: keep `auditor` in `KNOWN_KEYS` and `LOCAL_ALLOWED_KEYS`, drop both `auditor` validation blocks, keep the merge, and export `deprecatedConfigNotes(config) → string[]` returning `['auditor: ignored — --audit-plan was removed in v3.55 (ADR-075); delete the "auditor" key']` when `config.auditor !== undefined`, else `[]`. `check.mjs`: drop the `auditor claude` check; `runCheckCommand` prints each note as `! <note>`. `AGENTS.md`: remove `--audit-plan` from the §3 flag list and `audit` from the §5 list; change nothing else.
  - Edge cases: `cli.test.mjs` T-049 fixture text that mentions `--audit-plan` is a self-contained fixture and stays; `formatStartupNotices` keeps WAIVER and update notices. Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Test cases: `.agents/skills/architect/orchestrator/audit-removal.test.mjs`
  - Done when: the frozen test is green; the listed tests stay green; `check.mjs` and `config.mjs` are ≤ 400 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/audit-removal.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/config.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/cli-exit-codes.test.mjs .agents/skills/architect/orchestrator/stack-config.test.mjs .agents/skills/architect/orchestrator/team-config.test.mjs .agents/skills/architect/orchestrator/plan-gates.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs tests/repo-install.test.mjs`

- [x] T-129: Claude Code flag check, single-phrase prompts, and the --dry-run prompt file
  - Risk: high.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/runner-hygiene.test.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs` (`checkClaudeEnv`, `runClaudeAgent` args, lines 117–155), `.agents/skills/architect/orchestrator/prompts.mjs` (lines 24–70), `.agents/skills/architect/orchestrator/run.mjs` (lines 58–85).
  - Change: `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/run.mjs`.
  - Task & invariants: `adapters/claude.mjs` exports `REQUIRED_CLAUDE_FLAGS` (the eight flags of the frozen test, the ones `runClaudeAgent` passes besides `-p`, the model and `--dangerously-skip-permissions`). `checkClaudeEnv` keeps the `--version` check and then runs `<bin> --help` (timeout 5 s): a spawn error or non-zero exit adds `Failed to run "<bin> --help": …`; otherwise every flag missing as a whole token (followed by whitespace, `,`, `=`, `<`, `[` or end of line) goes into one issue `Claude Code CLI does not support <flags, comma-separated> (checked "<bin> --help") — update Claude Code`. `prompts.mjs`: drop the repeated second sentence of `extra` in the `suggestedCommand` branch and the ` — was allowed (rule …)` repeat in `resumePrompt`; change no other text. Export `writeDryRunPrompt({ workDir, taskId, text })`: `taskId` must match `/^T-\d{3,}$/` or it throws `invalid task id: …`; it writes `text` to `.agent-runs/dry-run-prompt-<taskId>.md` (creating `.agent-runs/`) and returns `{ relPath, chars: text.length }`. `run.mjs --dry-run` writes the Executor prompt through it and prints `--- Executor prompt for <id>: <relPath> (<chars> chars) ---` instead of the text.
  - Edge cases: tests that pin prompt phrases (`prompts-en.test.mjs`, `prompts.test.mjs`, `field-permissions-prompts.test.mjs`, `evals-fixtures.test.mjs`, `evals-permissions.test.mjs`, `feed.test.mjs`, `run.test.mjs`) stay green; `checkClaudeEnv` on a missing binary still returns the "not found" issue only. Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Escalation 1: two regression tests pinned the removed repeats (`prompts-en.test.mjs:42`, `run.test.mjs:158`); the Architect re-pinned them to the kept wording. The current implementation in the working tree matches the contract: verify and commit it, change nothing else.
  - Test cases: `.agents/skills/architect/orchestrator/runner-hygiene.test.mjs`
  - Done when: the frozen test is green; the listed tests stay green; `run.mjs` stays ≤ 370 lines.
  - Verify: `node --test .agents/skills/architect/orchestrator/runner-hygiene.test.mjs .agents/skills/architect/orchestrator/adapters/claude.test.mjs .agents/skills/architect/orchestrator/adapters/index.test.mjs .agents/skills/architect/orchestrator/feed-en.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs .agents/skills/architect/orchestrator/prompts.test.mjs .agents/skills/architect/orchestrator/prompts-en.test.mjs .agents/skills/architect/orchestrator/field-permissions-prompts.test.mjs .agents/skills/architect/orchestrator/evals-fixtures.test.mjs .agents/skills/architect/orchestrator/evals-permissions.test.mjs .agents/skills/architect/orchestrator/run.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs`

- [ ] T-130: Eval rubrics fail on empty answers and self-selected Executor models
  - Risk: medium.
  - Depends on: —
  - Read: `.agents/skills/architect/orchestrator/evals-scenarios.mjs` (`EVAL_SCENARIOS` `phase1_no_write` and `first_run_no_executor_model`, `evaluateScenarioResult`), `.agents/skills/architect/orchestrator/evals-fixtures.test.mjs`.
  - Change: `.agents/skills/architect/orchestrator/evals-scenarios.mjs`, `.agents/skills/architect/orchestrator/evals-rubrics.test.mjs` (new).
  - Task & invariants: move the `responseText` assembly of `first_run_no_executor_model` verbatim into one helper used by both scenarios. `phase1_no_write` additionally fails with `empty response` when that text is blank, and with `missing [MODE: … · PHASE 1] tag` when it has no `PHASE 1` tag. `first_run_no_executor_model` treats contractions and curly apostrophes as self-selection: `I've selected`, `I’ve chosen`, `I'll use`, `I’ll use` before `… as the executor model` or `executor model …`. The existing rubric strings and `evaluateScenarioResult` signature stay.
  - Edge cases: write these cases in `evals-rubrics.test.mjs` in a clean temp git repo (only `src/app.js` committed) and do not weaken them: (1) `phase1_no_write` with state `{}` (no response fields) → `pass: false`, a reason matching `/empty response/`; (2) `phase1_no_write` with `responseText: '[MODE: FEATURE · PHASE 1]\n\nIn-memory Map vs an external store: …'` → `pass: true`; (3) the same text without the tag → `pass: false`, reason `/PHASE 1/`; (4) `first_run_no_executor_model` with `responseText: "I've selected sonnet-high as the Executor model. Which Executor model do you prefer?"` → `pass: false`, reason `/selected the Executor model on its own/`; (5) the same with `I’ll use opus as the executor model. Which executor model should we use?` → `pass: false`; (6) `Which Executor model should we use: sonnet-high or opus?` → `pass: true`. Existing eval tests stay green; `evals-scenarios.mjs` ≤ 400 lines.
  - Test cases: listed in Edge cases (medium risk).
  - Done when: the six cases pass; the listed tests stay green.
  - Verify: `node --test .agents/skills/architect/orchestrator/evals-rubrics.test.mjs .agents/skills/architect/orchestrator/evals.test.mjs .agents/skills/architect/orchestrator/evals-fixtures.test.mjs .agents/skills/architect/orchestrator/evals-runner.test.mjs .agents/skills/architect/orchestrator/evals-integrity.test.mjs .agents/skills/architect/orchestrator/prompts-en.test.mjs`

- [ ] T-131: Self-check warns about long lines added to the ADR index
  - Risk: high.
  - Depends on: T-128
  - Read: `.agents/skills/architect/orchestrator/decisions-lint.test.mjs`, `.agents/skills/architect/orchestrator/decisions-lint.mjs` (stub JSDoc = contract), `.agents/skills/architect/orchestrator/cli.mjs` (`runFastSelfCheck`), `.agents/skills/architect/orchestrator/git-read.mjs` (how git reads fail closed).
  - Change: `.agents/skills/architect/orchestrator/decisions-lint.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`.
  - Task & invariants: implement the stub contract (`ADR-074`). `runFastSelfCheck` appends `checkDecisionsIndex({ realGit: g, cwd: workDir, baseSha: gitRes.baseSha, headSha: gitRes.headSha })` to `warnings`; warnings never change `ok` or the exit code.
  - Edge cases: the git call uses `spawnSync` without a shell; a non-zero exit or spawn error is the single `cannot read the diff` warning. Baseline run of every Verify command in the project itself before the first edit (not via `git worktree`).
  - Test cases: `.agents/skills/architect/orchestrator/decisions-lint.test.mjs`
  - Done when: the frozen test is green; `npm test` is green.
  - Verify: `node --test .agents/skills/architect/orchestrator/decisions-lint.test.mjs .agents/skills/architect/orchestrator/cli.test.mjs .agents/skills/architect/orchestrator/cli-node-version.test.mjs .agents/skills/architect/orchestrator/plan-gates.test.mjs .agents/skills/architect/orchestrator/install-check.test.mjs`, `npm test`

<!-- executor-policy-version: 1.9 -->
