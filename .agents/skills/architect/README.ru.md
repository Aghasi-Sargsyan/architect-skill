<!-- skill-readme-sync: v3.29 / 1.8 -->
# Скилл «Архитектор + Исполнитель» (`v3.29 / 1.8`)

Переносимый скилл разделения ролей **Главный Архитектор + Исполнитель** с двумя честными уровнями установки:
1. **Ядро скилла (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** работает в **любом ИИ-агенте** (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**, **Cursor**, Windsurf и др.), на **любом стеке** и в **любой ОС** (macOS, Linux, Windows) через ручную передачу задач или субагентов.
2. **Автоматический оркестратор (`orchestrator/run.mjs`):** цикл на чистом Node.js без npm-зависимостей; требует **Node.js 22+** и **git 2.31+**. **Оркестратор — только macOS. Linux и WSL2 не тестируются, Windows не поддерживается. Ядро правил работает в любой ОС.** Поддерживает только раннеры **`agy`** (Antigravity) и **`claude`** (Claude Code); системные уведомления работают на **macOS** (`osascript`), также поддерживается вебхук `AGENT_LOOP_WEBHOOK_URL`.

- **Рабочие промпты (единый источник правил на английском):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks}.md`.
- **Руководства для человека (`<= 25 КБ` каждое):** `README.ru.md` (на русском) и `README.en.md` (на английском).

---

## 1. Быстрый старт (2 шага)

1. **Установите скилл одной командой** (для Claude Code замените `.agents/skills/architect` на `.claude/skills/architect` — либо попросите агента: *«Установи скилл `architect` из `https://github.com/Aghasi-Sargsyan/architect-skill` в `.agents/skills/architect`»*):
   ```bash
   git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git /tmp/architect-skill && mkdir -p .agents/skills && cp -R /tmp/architect-skill/.agents/skills/architect .agents/skills/architect && rm -rf /tmp/architect-skill
   ```
2. **Откройте агента и напишите `/architect`** (или *«прочитай `.agents/skills/architect/SKILL.md`»*):
   - **Первый запуск в новом проекте:** в Фазе 1 (только чтение) Архитектор до утверждения не трогает файлы, одним вопросом спрашивает **модель Исполнителя** (предлагает варианты, доступные в текущем окружении, сам модель не выбирает) и предлагает добавить блок ролей в `AGENTS.md`. После утверждения плана в Фазе 2 Архитектор сам копирует `EXECUTOR.md` и записывает выбранную модель, блок ролей в `AGENTS.md`, `EXECUTOR.md` и `PLAN.md` вместе с первым коммитом плана (`arch: plan ...`). Если нужен автоматический оркестратор — Архитектор сам запускает `--init`, `--check` и `--dry-run`, а явное «да» спрашивает только для `--write-permissions`.

---

## 2. Как устроена работа двух моделей

| Роль | Зона ответственности | Файл правил | Префикс коммитов |
|---|---|---|---|
| **Главный Архитектор** | Исследует контекст, фильтрует идеи, ведёт ADR, пишет `PLAN.md` и эталонные тесты в `Frozen`, принимает работу по диффу (`REVIEW`), разбирает эскалации и закрывает цикл | `SKILL.md` + `references/*.md` | `arch: ...` |
| **Исполнитель** | Выполняет ровно одну атомарную задачу `T-NNN` строго в пределах списка `Менять` (`Change`), прогоняет `Проверка` (`Check`), делает коммит и возвращает отчёт (или останавливается по эскалации) | `EXECUTOR.md` | `T-NNN: ...` / `T-NNN (fix K): ...` |

### Ключевые гарантии безопасности
- **Двухфазный протокол (`§2.5`):** Фаза 1 строго только для чтения. Ни один файл не создаётся и не меняется до явного одобрения варианта пользователем.
- **Замороженные файлы (`## Frozen` / `## Заморожено`):** Эталонные тесты (`*.test.*`) для задач высокого риска, `EXECUTOR.md` и собственные `.md`-файлы скилла (`SKILL*.md`, `references/**`) защищены от правок Исполнителем и промптом, и механической проверкой `mechanics.mjs`.
- **Четырёхслойная защита от push и выхода за пределы проекта (`guards.mjs`, `runners.mjs`):** При `AGENT_LOOP=1` обёртки в `PATH`, `.git/hooks/pre-push` и `remote.<name>.pushurl` блокируют `git push`, опасные скрипты, переписывание истории и чтение файлов вне `workDir`.
- **Нулевая терпимость к обходам проверок:** `mechanics.mjs` и `--self-check` проверяют дифф на `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, удаление тестов, `git commit --no-verify`, мутацию глобальных прототипов и пустые `catch {}`.

---

## 3. Ручная установка и обновление по средам

### Ручная установка (по шагам)
1. **Скопируйте папку скилла в подпапку проекта** (например, `.agents/skills/architect/`, либо `.claude/skills/architect/` для Claude Code). Не распаковывайте скилл прямо в корень репозитория (`--check` отклоняет корневую раскладку).
2. **Скопируйте `EXECUTOR.md`** в корень проекта (`cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md`, либо в `.architect/EXECUTOR.md` при компактной раскладке).
3. **Задайте модель Исполнителя один раз на проект:**
   - **С оркестратором (`agy` или `claude`):** укажите `executor.model` в `.architect/config.json` или `.agents/orchestrator.json`.
   - **Без оркестратора:** добавьте строку `Executor model: <Модель / Уровень>` в `AGENTS.md` проекта (см. врезку в разделе 4). Для субагента Claude Code скопируйте шаблон `.agents/skills/architect/templates/claude-agent-executor.md` в `.claude/agents/executor.md` и задайте явное поле `model:` (не оставляйте `inherit` или пустое поле).
4. **Проверьте настройку и запускайте задачи (`T-NNN`):**
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --check
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --self-check
   node .agents/skills/architect/orchestrator/run.mjs --background
   node .agents/skills/architect/orchestrator/run.mjs --follow
   ```

### A. Antigravity (`agy`) — Ядро + Оркестратор
1. Положите скилл в подпапку `.agents/skills/architect/`.
2. Скопируйте `.agents/skills/architect/EXECUTOR.md` в `EXECUTOR.md` в корне проекта.
3. Для автоматического цикла (`runner: "agy"`, только macOS, Node 22+) выполните `--init` для создания `.architect/config.json` (или `.agents/orchestrator.json`), затем после проверки правил запишите allowlist в `~/.gemini/antigravity-cli/settings.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### B. Claude Code (`claude`) — Ядро + Оркестратор или Субагент
1. Положите скилл в `.agents/skills/architect/` или `.claude/skills/architect/` и скопируйте `EXECUTOR.md` в корень проекта.
2. **Режим субагента:** скопируйте `.agents/skills/architect/templates/claude-agent-executor.md` в `.claude/agents/executor.md` и проверьте, что поле `model:` задано явно (например, `model: sonnet`, никогда `inherit`).
3. **Режим оркестратора (только macOS, Node 22+):** укажите `"runner": "claude"`, `"executor": { "model": "sonnet" }` и `"architect": { "model": "opus" }` в `.architect/config.json` (или `.agents/orchestrator.json`), затем выполните:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### C. Gemini CLI, OpenAI Codex CLI, Cursor и другие агенты — Только ядро
- Положите скилл в `.agents/skills/architect/`, скопируйте `EXECUTOR.md` в корень проекта и добавьте врезку из раздела 4 (включая `Executor model: …`) в `GEMINI.md`, `AGENTS.md` или `.cursorrules`. Запускайте Архитектора и Исполнителя в отдельных чатах.

### D. Обновление скилла в существующем проекте
1. Замените содержимое папки `.agents/skills/architect/` (или `.claude/skills/architect/`) новой версией. Ваш конфиг (`.architect/config.json` или `.agents/orchestrator.json`) и история (`docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`) лежат вне папки скилла и сохраняются.
2. Обновите проектную копию `EXECUTOR.md`:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. Если используете оркестратор, выполните `node .agents/skills/architect/orchestrator/run.mjs --check` для проверки совпадения копии `EXECUTOR.md` и базового набора разрешённых команд.

---

## 4. Готовая врезка для `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`

Скопируйте этот блок в `AGENTS.md`, `CLAUDE.md` или `GEMINI.md` вашего проекта:

```markdown
### Роли: Главный Архитектор и Исполнитель
- **Сессия Архитектора** (вызов `/architect` или запрос на архитектуру, план `PLAN.md`, ревью или разбор проблемы): первым действием прочитай `.agents/skills/architect/SKILL.md` и следуй двухфазному протоколу (`[MODE: ... · PHASE 1/2]`).
- **Сессия Исполнителя** (запрос выполнить задачу `T-NNN` из `PLAN.md`): первым действием прочитай `EXECUTOR.md` и `PLAN.md`, меняй только файлы из поля `Менять` (`Change`) задачи `T-NNN`, не трогай `Frozen` и `PLAN.md`, перед коммитом `T-NNN: ...` выполни команду из `Проверка` (`Check`).
- **Executor model:** `<Модель / Уровень>` (используется для всех задач `T-NNN`, если в поле `Модель` задачи не указано иное).
- **Язык коммитов:** английский (`T-NNN: ...`, `arch: ...`).
```

---

## 5. Структура `PLAN.md` и раскладка файлов в проекте

Рабочие файлы можно хранить как в корне проекта (`PLAN.md`, `EXECUTOR.md`, `docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`), так и компактно в папке `.architect/` (`planPath: ".architect/PLAN.md"`, `executorPath: ".architect/EXECUTOR.md"`).

Парсер `plan.mjs` поддерживает и русские, и английские названия полей задачи `T-NNN`:
- `Риск` (`Risk`): `низкий` | `средний` | `высокий` (`low` | `medium` | `high`)
- `Зависит от` (`Depends on`): `—` или `T-NNN`
- `Модель` (`Model`): целевая модель Исполнителя
- `Читать` (`Read`): файлы для чтения перед работой
- `Менять` (`Change`): точный список файлов, которые разрешено создать или изменить (`<= 3–5` файлов)
- `Задача и инварианты` (`Task and invariants`), `Граничные случаи` (`Edge cases`), `Тест-кейсы` (`Test cases`), `Готово, когда` (`Done when`), `Проверка` (`Check`).

### Настройка под свой стек (`config.json` / `orchestrator.json`)
Для стеков вне `node:test` (Python/`pytest`, Go/`go test`, Rust/`cargo test`, Vitest/Jest) настройте в конфиге `testFilePatterns`, `testPatterns`, `assertPatterns` (по умолчанию включены `assert.` и `expect(`) и `redCheckCommand` (например, `"pytest {file}"` или `"npx vitest run {file}"`). Если для эталонного теста из `Frozen` не подходит `redCheckCommand` или в тест-файле 0 распознанных утверждений, `--self-check` выдаёт явный `NOT VERIFIED` с именем файла, а не молчаливый `PASS`.

---

## 6. Справочник команд оркестратора (`orchestrator/run.mjs`)

Добавьте `"agents": "node .agents/skills/architect/orchestrator/run.mjs"` в `scripts` файла `package.json` (или вызывайте `node .agents/skills/architect/orchestrator/run.mjs` напрямую):

| Флаг | Назначение |
|---|---|
| `--init` | Создание `.architect/config.json` (или `.agents/orchestrator.json`), установка `.git/hooks/commit-msg`, добавление `.agent-runs/` в `.gitignore` и вывод блока allowlist |
| `--install-hooks` | Установка zero-dependency Node-хука `.git/hooks/commit-msg` (без перезаписи существующего хука или `core.hooksPath`) |
| `--check` | Проверка ОС, Node.js 22+, git 2.31+, установки скилла в подпапку, совпадения копии `EXECUTOR.md`, хука `commit-msg`, модели Исполнителя, `PLAN.md`, CLI раннеров и allowlist |
| `--check-task T-NNN [--base <ref>]` | Механическая проверка коммитов Исполнителя по задаче `T-NNN` вне цикла оркестратора (границы `Change`, `Frozen`, обходы проверок) |
| `--write-permissions` | Запись безопасного allowlist команд и путей для `agy` или `claude` (после явного согласия пользователя) |
| `--dry-run` | Проверка готовности, `--self-check` (включая `red-check`) и показ промпта следующей задачи без вызова LLM |
| `--self-check [--base <ref>]` | Детерминированная самопроверка Архитектора (обходы, пустой `catch`, таймеры в тестах, монотонность, `fix-frozen`, сверка `eval`, покрытие аудита и `red-check`) |
| `--audit-plan` | Совещательный read-only аудит плана другой моделью (`references/plan-audit.md`) через `config.auditor` (платный вызов, не более 1 повтора на базу цикла) |
| `--background` | Запуск цикла в фоне (с PID-блокировкой `.agent-runs/.lock`) |
| `--watch [мин] [--since N]` | Ожидание запроса разрешения (код `2`), остановки цикла (код `3`) или вехи задачи (код `4`) |
| `--status` | Короткая сводка состояния цикла и прогресса задач |
| `--follow` | Живая лента мыслей агента, вызовов инструментов, команд и вердиктов в терминале |
| `--answer <1\|2\|3>` | Ответ на запрос разрешения (`1` префикс, `2` точная команда, `3` отказ) |
| `--pause` | Остановка после каждой принятой задачи для подтверждения в терминале |
| `--only T-NNN` | Прогон только одной указанной задачи `T-NNN` |

---

## 7. Поведенческие eval-сценарии и сопровождение (`evals.mjs`, `MAINTAINING.md`)

- **Юнит- и эталонные тесты (без вызова LLM, проходят и во временном репо только с папкой скилла):**
  ```bash
  node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  VERIFY_STEP_A1=1 node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  ```
- **Живые поведенческие eval-сценарии (для контрибьюторов при разработке самого скилла; см. `MAINTAINING.md`):**
  ```bash
  node .agents/skills/architect/orchestrator/evals.mjs --model claude:haiku
  ```

---

## 8. Когда скилл использовать и когда не использовать

- **Полностью (Ядро + Оркестратор):** долгоживущие продукты с зонами высокого риска (аутентификация и права доступа, биллинг, миграции БД, конкурентность, инварианты данных) на macOS с раннерами `agy` или `claude`.
- **Только ядро (`SKILL.md` + `EXECUTOR.md`):** проекты среднего размера, другие стеки и агенты (`Gemini CLI`, `Codex`, `Cursor`), Linux/WSL2 или Windows, где важны двухфазное планирование, замороженные контракты (`Frozen`) и изоляция контекста Исполнителя без цикла на Node.js.
- **Не использовать:** одноразовые прототипы, быстрая проверка продуктовых гипотез, геймджемы, разовые скрипты и задачи с чисто визуальной приёмкой.
- **Командные проекты с существующими PR и CI:** берите ключевые идеи (Фаза 1 только для чтения, эталонные тесты в `Frozen` до реализации, изолированный контекст Исполнителя) без обязательных конвенций сообщений коммитов `arch:` / `T-NNN:`.
