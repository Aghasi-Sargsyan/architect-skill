# PLAN

## Goal / Requirements
Этап 2 (Цикл 12): Готовность для других (`v3.28`).
- П6: Ядро `SKILL.md` — только правила, нейтральные к стеку и раннеру (вынос порядка `--self-check` / `--audit-plan` / `red-check`, `fix-frozen` и `WAIVER` в `references/orchestrator.md`, eval-дисциплины — в `MAINTAINING.md`, условный `--self-check` в `references/retro.md` §1; размер `SKILL.md` `<= 27780` байт).
- П7: Два уровня установки («Ядро» и «Оркестратор») и процедура обновления скилла без потери конфига и копии `EXECUTOR.md` синхронно в `README.ru.md` и `README.en.md`.
- П8: Раздел «Когда скилл не использовать» в `README.*.md` и одно предложение в режиме `NEW PROJECT` (`SKILL.md`).
- П9: Контроль роста правил в `references/retro.md` и `MAINTAINING.md`.
- П10: Правила эскалаций `(а)–(г)` в `references/auto-review.md`; технические детали от пользователя как предложения в `SKILL.md`; пояснение простым языком к `### 🔐 Command Permission` в `references/orchestrator.md`; расширение `BASE_COMMANDS` в `permissions.mjs` командами только для чтения; продолжение после эскалации на грязном дереве и валидный патч `stop.diff` (`check.mjs`, `prompts.mjs`, `run.mjs`, `git.mjs`).

### Перенесено из предыдущего цикла (Этапы 3–4 и очередь после Этапа 3)
- **Этап 3:** приёмка «глазами чужого человека» на временных репо (TS + Vitest, Python + pytest) в `.claude/skills/architect/` и `.agents/skills/architect/`, обновление скилла в `~/Desktop/Workspace`.
- **Этап 4:** CI на GitHub Actions (ubuntu + macos, Node 22 + 24; Linux до первого зелёного прогона CI — `NOT VERIFIED`), grep на личные данные перед первым публичным push.
- **После Этапа 3:** контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`), контроль неизменности `HEAD` хоста во время `runLiveEvals` (`evals.mjs`), замена проверки времени в `guards-shim-speed.test.mjs`.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-037`) хранится в `docs/decisions.md`. Следующий номер: `ADR-038`.

## Frozen
- `EXECUTOR.md`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи
Следующий номер задачи: `T-055`.
