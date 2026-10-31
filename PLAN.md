# PLAN

## Goal / Requirements
Цикл 16 (предпубликационная доработка 5 — обязательный выбор модели Исполнителя человеком):
- `--init` (`initProject` в `config.mjs`) не подставляет дефолтные `executor.model` и `architect.model` из `config.example.json` (`DEFAULTS`), а записывает `"executor": { "model": "" }` и `"architect": { "model": "" }`.
- `templates/claude-agent-executor.md` не содержит предзаполненного `model: sonnet` (использует закомментированный плейсхолдер `# model: <set-executor-model-here, e.g. sonnet or haiku — never inherit>`), чтобы копирование шаблона без выбора модели не маскировало отсутствие выбора.
- Без явного выбора модели человеком `checkExecutorModelConfig` (`hooks.mjs`) и `--check` (`localChecks` / `runnerChecks` в `check.mjs`) краснеют (`✗ Executor model: ...`) с подсказкой, а Архитектор на первом плане задаёт вопрос пользователю (`SKILL.md:21`).

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **CI GitHub Actions (`.github/workflows/ci.yml`):** живой облачный прогон GitHub Actions (`macos-latest`, Node 22 и 24) — `NOT VERIFIED` до первого `git push` в удалённый репозиторий.
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** создание удалённого репозитория и `git push` — только по отдельной прямой команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-040`) хранится в `docs/decisions.md`. Следующий номер: `ADR-041`.
- **ADR-041:** Запрет молчаливой подстановки модели Исполнителя при `--init` и из шаблона субагента: (1) `initProject` в `config.mjs` записывает `"executor": { "model": "" }` и `"architect": { "model": "" }` как для `compact` (`.architect/config.json`), так и для `classic` (`.agents/orchestrator.json`), при этом `DEFAULTS` (`config.example.json`) сохраняет эталонные примеры; `validateConfig` проверяет строковый тип `executor.model` и `architect.model` (`typeof model === 'string'`), допуская `""` при загрузке свежего конфига, чтобы `--init`, `--write-permissions` и `--check` не падали до запуска проверок; (2) `templates/claude-agent-executor.md` не задаёт `model: sonnet`, а `checkExecutorModelConfig` (`hooks.mjs`), `localChecks` и `runnerChecks` (`check.mjs`) на свежем `--init` или неизменённом шаблоне возвращают `ok: false` с подсказкой выбрать модель.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/check-task.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [ ] T-064: Require explicit human model choice after --init and in claude-agent-executor.md template
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/check-task.test.mjs`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/hooks.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/templates/claude-agent-executor.md`, `.agents/skills/architect/orchestrator/config.test.mjs`, `.agents/skills/architect/orchestrator/layout.test.mjs`
  - Менять: `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/hooks.mjs`, `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/templates/claude-agent-executor.md`, `.agents/skills/architect/orchestrator/config.test.mjs`, `.agents/skills/architect/orchestrator/layout.test.mjs`
  - Задача и инварианты: (1) В `config.mjs` в `initProject`: при создании нового файла конфига (и для `compact`, и для `classic`) всегда записывать `executor: { model: '' }` и `architect: { model: '' }` поверх `DEFAULTS` (не копировать модели из `EXAMPLE_PATH`); в `validateConfig` для `executor` и `architect` проверять `typeof model !== 'string'` (чтобы `executor: 'x'` или `executor: {}` по-прежнему отклонялись, а `executor: { model: '' }` из свежего `--init` проходил `loadConfig` и доходил до `--check`). (2) В `templates/claude-agent-executor.md` заменить `model: sonnet` на закомментированный плейсхолдер `# model: <set-executor-model-here, e.g. sonnet or haiku — never inherit>`. (3) В `hooks.mjs` (`checkExecutorModelConfig`) считать невалидными пустую строку, `inherit` и угловые плейсхолдеры `/^<.*>$/` как в `.claude/agents/executor.md`, так и в конфиге/документации; в `check.mjs` (`runnerChecks` и `modelResolver`, без увеличения числа строк `check.mjs` сверх 400) при пустом `config[role].model` возвращать `ok: false` с подсказкой `not set in config — choose a model from "<runner> models"`. (4) В `config.test.mjs` (строка 66) и `layout.test.mjs` (строка 100) обновить ожидания под новый контракт `initProject` (`executor: { model: '' }, architect: { model: '' }`) без уменьшения числа `test(...)` и `assert.*`.
  - Граничные случаи: Не менять `config.example.json` (`DEFAULTS`), чтобы не ломать модульные тесты, использующие `DEFAULTS` как готовый валидный конфиг; сохранять длину всех `.mjs` файлов `<= 400` строк (`check.mjs` сейчас 388 строк) и `0` пустых `catch {}` (`packaging-clean.test.mjs`).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/check-task.test.mjs`
  - Готово, когда: Замороженный эталонный тест `check-task.test.mjs`, а также `config.test.mjs`, `layout.test.mjs`, `check.test.mjs` и `packaging-clean.test.mjs` проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/check-task.test.mjs .agents/skills/architect/orchestrator/config.test.mjs .agents/skills/architect/orchestrator/layout.test.mjs .agents/skills/architect/orchestrator/check.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
