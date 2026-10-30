# PLAN

## Goal / Requirements
Этап 1 (Цикл 11): Развязка скилла от хост-проекта.
1. Тесты из папки скилла не читают файлы проекта вне папки скилла; проверки установки (`EXECUTOR.md`, `AGENTS.md`, запрет установки скилла в корень репо) переносятся в `--check` и `--self-check`; проверка файлов этого репозитория выносится в `tests/repo-install.test.mjs`.
2. Все пути к скиллу (`layout.mjs`, `prompts.mjs`, `ask.mjs`, `selfcheck.mjs`) вычисляются динамически от `orchestratorDir` без жёсткого `.agents/skills/architect`.
3. Шаблоны тест-файлов (`testFilePatterns`), подсчёта тестов (`testPatterns`) и утверждений (`assertPatterns`, включая `expect(` по умолчанию) и команда `redCheckCommand` настраиваются в конфиге; эталонный тест без подходящей `redCheckCommand` и тест-файл с 0 утверждений дают `NOT VERIFIED` с именем файла (без шума на вспомогательных файлах вроде `tests/setup.ts`).
4. Из комментариев модулей оркестратора убираются `T-NNN`, а 39 тест-файлов с суффиксами `-sN` / `tNNN` переименовываются по модулям (`ADR-037`) без уменьшения числа тестов и утверждений.

### Очередь следующих этапов
- **Этап 2 (`v3.28`):** нейтральное ядро `SKILL.md`, два уровня установки и обновление в `README.ru.md` / `README.en.md`, раздел «Когда не использовать», контроль роста правил (`references/retro.md`, `MAINTAINING.md`), правила эскалаций `(а)–(г)` в `references/auto-review.md`, технические детали пользователя как предложения в `SKILL.md`, пояснение к `### 🔐 Command Permission` в `references/orchestrator.md`, расширение `BASE_COMMANDS` в `permissions.mjs`, продолжение после эскалации и валидный `stop.diff`.
- **Этап 3:** приёмка «глазами чужого человека» на временных репо (TS + Vitest, Python + pytest) в `.claude/skills/architect/` и `.agents/skills/architect/`, обновление скилла в `~/Desktop/Workspace`.
- **Этап 4 и после Этапа 3:** CI GitHub Actions (ubuntu + macos, Node 22 + 24), проверка на личные данные перед публичным push; контроль ячейки `claude:haiku`, `HEAD` в `runLiveEvals` и замена таймера в `shim-speed`.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-036`) хранится в `docs/decisions.md`.
- **ADR-037:** Полная автономия пакета `.agents/skills/architect/`: (1) тесты внутри `orchestrator/` работают во временном каталоге, где нет ничего кроме папки скилла, а проверки установки скилла в хост-проекте (`checkSkillInstallation`: запрет раскладки скилла в корне `workDir`, побайтное совпадение проектной копии `EXECUTOR.md` с `<skillDir>/EXECUTOR.md` и наличие `--check`/`--self-check` при описании `npm run agents` в `AGENTS.md`) выполняются в `localChecks` и `runFastSelfCheck`; (2) `layout.mjs`, `prompts.mjs`, `ask.mjs` и `selfcheck.mjs` определяют пути скилла и `config.example.json` от `orchestratorDir` без литерала `.agents/skills/architect`; (3) `config.example.json` (`DEFAULTS`) и `validateConfig` задают настраиваемые `testFilePatterns`, `testPatterns`, `assertPatterns` (по умолчанию `\bassert\.` и `\bexpect\s*\(`) и `redCheckCommand` (`"node --test {file}"`), а `runSelfCheckGit` и `runRedCheck` возвращают `NOT VERIFIED` с именем файла при 0 распознанных утверждений в явном тест-файле (пропуская вспомогательные файлы в `tests/` без тестов и без тестового имени вроде `tests/setup.ts`) или при отсутствии подходящей `redCheckCommand`; (4) 39 тест-файлов оркестратора переименовываются с циклов/задач (`-sN`, `tNNN`) на имена по модулям с сохранением `>= 49` файлов, `>= 207` `test`/`it` и `>= 1258` `assert.`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/skill-path.test.mjs`
- `.agents/skills/architect/orchestrator/install-check.test.mjs`
- `.agents/skills/architect/orchestrator/stack-config.test.mjs`
- `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`
- `tests/repo-install.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [x] T-051: Dynamic skill paths and root-install guard in layout.mjs, prompts.mjs, ask.mjs, and selfcheck.mjs
  - Риск: высокий.
  - Зависит от: —.
  - Модель: Gemini 4 Argon / High (subagent).
  - Читать: `.agents/skills/architect/orchestrator/layout.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/ask.mjs` (строки 145–175), `.agents/skills/architect/orchestrator/selfcheck.mjs` (строки 15–35, 225–298), `.agents/skills/architect/orchestrator/skill-path.test.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/layout.mjs`, `.agents/skills/architect/orchestrator/prompts.mjs`, `.agents/skills/architect/orchestrator/ask.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`.
  - Задача и инварианты: динамическое определение путей скилла и `config.example.json` от `orchestratorDir` без `.agents/skills/architect`; `isSkillAtWorkDirRoot` и `resolveInstalledSkillDir` в `layout.mjs`.
  - Граничные случаи: `.claude/skills/architect/`, внешняя папка скилла, скилл в корне `workDir`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/skill-path.test.mjs`.
  - Готово, когда: `skill-path.test.mjs` и существующие тесты проходят.
  - Проверка: `node --test .agents/skills/architect/orchestrator/skill-path.test.mjs`.

- [x] T-052: Skill installation checks in check.mjs and cli.mjs (--check and --self-check)
  - Риск: высокий.
  - Зависит от: T-051.
  - Модель: Gemini 4 Argon / High (subagent).
  - Читать: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/layout.mjs`, `.agents/skills/architect/orchestrator/install-check.test.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/check.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`.
  - Задача и инварианты: `checkSkillInstallation` в `check.mjs` (запрет установки скилла в корень `workDir`, сверка копии `EXECUTOR.md`, сверка `--check`/`--self-check` в `AGENTS.md`), подключение в `localChecks` и `runFastSelfCheck`.
  - Граничные случаи: временные репо без установленной внутри папки скилла.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/install-check.test.mjs`.
  - Готово, когда: `install-check.test.mjs`, `check.test.mjs` и `cli.test.mjs` проходят.
  - Проверка: `node --test .agents/skills/architect/orchestrator/install-check.test.mjs`.

- [x] T-053: Stack-configurable test/assert patterns, redCheckCommand, and fail-loud NOT VERIFIED
  - Риск: высокий.
  - Зависит от: T-052.
  - Модель: Gemini 4 Argon / High (subagent).
  - Читать: `.agents/skills/architect/orchestrator/config.example.json`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/evidence.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`, `.agents/skills/architect/orchestrator/stack-config.test.mjs`.
  - Менять: `.agents/skills/architect/orchestrator/config.example.json`, `.agents/skills/architect/orchestrator/config.mjs`, `.agents/skills/architect/orchestrator/mechanics.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/evidence.mjs`, `.agents/skills/architect/orchestrator/cli.mjs`.
  - Задача и инварианты: настраиваемые `testFilePatterns`, `testPatterns`, `assertPatterns` (`expect(` по умолчанию) и `redCheckCommand` (`node --test {file}`); `NOT VERIFIED` с именем файла при 0 утверждений в тест-файле (без шума на `tests/setup.ts`) или неподходящей `redCheckCommand`.
  - Граничные случаи: монотонность массивов конфига, лимит `<= 400` строк.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/stack-config.test.mjs`.
  - Готово, когда: `stack-config.test.mjs` и существующие тесты проходят.
  - Проверка: `node --test .agents/skills/architect/orchestrator/stack-config.test.mjs`.

- [x] T-054: Clean Workspace task IDs from orchestrator comments and rename -sN/tNNN test files by module (ADR-037)
  - Риск: высокий.
  - Зависит от: T-053.
  - Модель: Gemini 4 Argon / High (subagent).
  - Читать: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/events.mjs`, `.agents/skills/architect/orchestrator/evals.mjs`, `.agents/skills/architect/orchestrator/run.mjs`, `.agents/skills/architect/orchestrator/adapters/claude.mjs`, `.agents/skills/architect/orchestrator/adapters/index.mjs`, `.agents/skills/architect/MAINTAINING.md`, `package.json`, `AGENTS.md`.
  - Менять: 5 модулей оркестратора, `MAINTAINING.md`, `package.json`, `AGENTS.md`, 39 переименованных `.test.mjs` файлов.
  - Задача и инварианты: удаление кодов задач/циклов из комментариев модулей, переименование 39 тест-файлов по модулям (`ADR-037`), прогон в изолированном временном каталоге только с папкой скилла.
  - Граничные случаи: сохранение `>= 49` тест-файлов, `>= 207` `test`/`it`, `>= 1258` `assert.`.
  - Тест-кейсы: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`.
  - Готово, когда: `packaging-clean.test.mjs` и `npm test` проходят.
  - Проверка: `node --test .agents/skills/architect/orchestrator/packaging-clean.test.mjs`.

## Ретроспектива Цикла 11 (Этап 1: Развязка от хоста)

- **Прогон тестов оркестратора по версиям Node:**
  - Node `v24.22.2`: `179/179 PASS` (`VERIFY_STEP_A1=1 npm test`)
  - Node `v22.23.4`: `179/179 PASS` (`npx -y -p node@22 -c 'node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs tests/*.test.mjs'`)
- **Self-check:** `✓ Self-check PASSED (adabbfa..cbe9ee6)`, `0 violations`.

| Измерение | Статус | Детали |
|---|---|---|
| Boundaries | OK | Коммиты `T-051` (`6c4d847`), `T-052` (`4fa8ced`), `T-053` (`49446e1`), `T-054` (`b745aac`) меняли строго файлы из `Менять`; `Frozen` не затронут Исполнителем; правка существующих эталонных тестов выполнена отдельным коммитом `arch: fix-frozen T-051` (`de9823a`). |
| Git | OK | Разделение `arch:` (`2ad9683`, `de9823a`, `d17a723`, `6b2c788`, `92f8f37`, `cbe9ee6`) и `T-NNN` (`6c4d847`, `4fa8ced`, `49446e1`, `b745aac`), без amend и сторонних коммитов. |
| Bypasses | OK | Независимый grep по `adabbfa..HEAD -- .agents/skills/architect/orchestrator` — 0 совпадений. |
| Escalations | OK | 0 эскалаций, 0 молчаливых отступлений от плана. |
| Acceptance | OK | 4 из 4 задач высокого риска приняты с первой попытки (0 раундов `rework`). |
| Context | OK | `PLAN.md`, `EXECUTOR.md` и эталонных тестов было достаточно изолированным сессиям Исполнителя без истории чата. |
| Профили Исполнителей | Обновлено | `Gemini 4 Argon / High (subagent)`: добавлены `T-051`…`T-054` в отдельный раздел профиля субагента. |
