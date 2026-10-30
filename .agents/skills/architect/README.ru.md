<!-- skill-readme-sync: v3.27 / 1.8 -->
# Скилл «Архитектор + Исполнитель» (`v3.27 / 1.8`)

Переносимый скилл разделения ролей **Главный Архитектор + Исполнитель** для ИИ-агентов (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**) со встроенным детерминированным оркестратором на чистом Node.js (`orchestrator/run.mjs` без внешних npm-зависимостей).

- **Рабочие промпты (единый источник правил на английском для экономии токенов и точности следования инструкциям):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks}.md`.
- **Руководства для человека (`<= 25 КБ` каждое):** `README.ru.md` (на русском) и `README.en.md` (на английском).
- **Системные требования:** Автоматический оркестратор (`orchestrator/run.mjs`) требует **Node.js 22+ на macOS или Linux** (и `git 2.31+`). Работа по правилам скилла (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) с ручной передачей задач Исполнителю от версии Node.js не зависит.

---

## 1. Быстрый старт (за 5 минут)

1. **Скопируйте папку скилла** в проект (например, `.agents/skills/architect/`, либо `.claude/skills/architect/` для Claude Code).
2. **Скопируйте `EXECUTOR.md`** в корень проекта (или в `.architect/EXECUTOR.md`).
3. **Откройте чат Архитектора** (`/architect` или попросите модель прочитать `SKILL.md`):
   - **Фаза 1 (Read-Only брейншторм):** Архитектор проводит диагностику, критикует слабые решения и предлагает 1–3 варианта без изменения файлов.
   - **Фаза 2 (План и выполнение):** После выбора варианта Архитектор фиксирует ADR, создаёт замороженные эталонные тесты (`Frozen`) для задач высокого риска и коммитит `PLAN.md`.
4. **Выполняйте задачи (`T-NNN`)** вручную в чате Исполнителя (`Read EXECUTOR.md and PLAN.md. Execute task T-001.`) или автоматически через оркестратор:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --background
   node .agents/skills/architect/orchestrator/run.mjs --follow
   ```

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
- **Нулевая терпимость к обходам проверок:** `mechanics.mjs` проверяет дифф Исполнителя на `: any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, удаление тестов и пустые `catch {}`.

---

## 3. Установка по средам (Claude Code, Gemini CLI, Codex, Antigravity)

### A. Antigravity (`agy`)
1. Положите скилл в `.agents/skills/architect/` вашего репозитория.
2. В чате вызывайте `/architect`.
3. Для автоматического цикла (`runner: "agy"`) настройте `.agents/orchestrator.json` и один раз запишите allowlist в `~/.gemini/antigravity-cli/settings.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   ```

### B. Claude Code (`claude`)
1. Положите скилл в `.agents/skills/architect/` (или создайте симлинк/копию в `.claude/skills/architect/`).
2. В `.agents/orchestrator.json` укажите `"executor": { "runner": "claude", "model": "sonnet" }` и `"architect": { "runner": "claude", "model": "opus" }`.
3. Запишите проектные правила allowlist и файловой песочницы в `.claude/settings.local.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   ```

### C. Gemini CLI и OpenAI Codex CLI
- **Интерактивный режим:** Подключите скилл через врезку ниже в `GEMINI.md` (для Gemini CLI) или `AGENTS.md` (для Codex CLI), направляя сессии Архитектора в `.agents/skills/architect/SKILL.md`, а сессии Исполнителя по задачам `T-NNN` — в `EXECUTOR.md`.

---

## 4. Готовая врезка для `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`

Скопируйте этот блок в `AGENTS.md`, `CLAUDE.md` или `GEMINI.md` вашего проекта:

```markdown
### Роли: Главный Архитектор и Исполнитель
- **Сессия Архитектора** (вызов `/architect` или запрос на архитектуру, план `PLAN.md`, ревью или разбор проблемы): первым действием прочитай `.agents/skills/architect/SKILL.md` и следуй двухфазному протоколу (`[MODE: ... · PHASE 1/2]`).
- **Сессия Исполнителя** (запрос выполнить задачу `T-NNN` из `PLAN.md`): первым действием прочитай `EXECUTOR.md` и `PLAN.md`, меняй только файлы из поля `Менять` (`Change`) задачи `T-NNN`, не трогай `Frozen` и `PLAN.md`, перед коммитом `T-NNN: ...` выполни команду из `Проверка` (`Check`).
```

---

## 5. Структура `PLAN.md` и раскладка файлов в проекте

Рабочие файлы можно хранить как в корне проекта (`PLAN.md`, `EXECUTOR.md`, `docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`), так и компактно в папке `.architect/` (`planPath: ".architect/PLAN.md"`, `executorPath: ".architect/EXECUTOR.md"` в `.agents/orchestrator.json`).

Парсер `plan.mjs` поддерживает и русские, и английские названия полей задачи `T-NNN`:
- `Риск` (`Risk`): `низкий` | `средний` | `высокий` (`low` | `medium` | `high`)
- `Зависит от` (`Depends on`): `—` или `T-NNN`
- `Модель` (`Model`): рекомендуемая модель Исполнителя
- `Читать` (`Read`): файлы для чтения перед работой
- `Менять` (`Change`): точный список файлов, которые разрешено создать или изменить (`<= 3–5` файлов)
- `Задача и инварианты` (`Task and invariants`), `Граничные случаи` (`Edge cases`), `Тест-кейсы` (`Test cases`), `Готово, когда` (`Done when`), `Проверка` (`Check`).

---

## 6. Справочник команд оркестратора (`orchestrator/run.mjs`)

Добавьте `"agents": "node .agents/skills/architect/orchestrator/run.mjs"` в `scripts` файла `package.json` (или вызывайте `node .agents/skills/architect/orchestrator/run.mjs` напрямую):

| Флаг | Назначение |
|---|---|
| `--init` | Интерактивный мастер создания `.agents/orchestrator.json` |
| `--check` | Проверка ОС, Node.js, git, `PLAN.md`, CLI раннеров, доступа к моделям и allowlist |
| `--write-permissions` | Запись безопасного allowlist команд и путей для `agy` или `claude` (после согласия пользователя) |
| `--dry-run` | Проверка готовности, `--self-check` (включая `red-check`) и показ промпта следующей задачи без вызова LLM |
| `--self-check [--base <ref>]` | Детерминированная самопроверка Архитектора (обходы, пустой `catch`, таймеры в тестах, монотонность, `fix-frozen`, сверка `eval`, покрытие аудита и `red-check`) |
| `--audit-plan` | Совещательный read-only аудит плана другой моделью (`references/plan-audit.md`) через `config.auditor` (платный вызов, не более 1 повтора на базу цикла) |
| `--background` | Запуск цикла в фоне (с PID-блокировкой `.agent-runs/active.lock`) |
| `--watch [мин] [--since N]` | Ожидание запроса разрешения (код `2`), остановки цикла (код `3`) или вехи задачи (код `4`) |
| `--status` | Короткая сводка состояния цикла и прогресса задач |
| `--follow` | Живая лента мыслей агента, вызовов инструментов, команд и вердиктов в терминале |
| `--answer <1\|2\|3>` | Ответ на запрос разрешения (`1` точная команда, `2` префикс, `3` отказ) |
| `--pause` | Плавная остановка фонового цикла после завершения текущего шага |
| `--only T-NNN` | Прогон только одной указанной задачи `T-NNN` |

---

## 7. Поведенческие eval-сценарии и сопровождение (`evals.mjs`, `MAINTAINING.md`)

- **Юнит- и эталонные тесты (без вызова LLM):**
  ```bash
  node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  VERIFY_STEP_A1=1 node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs
  ```
- **Живые поведенческие eval-сценарии (5 сценариев: `phase1_no_write`, `quick_fix_no_adr`, `high_risk_frozen_test`, `escalation_no_touch_change`, `auto_refusal_git_c_retry`):**
  ```bash
  node .agents/skills/architect/orchestrator/evals.mjs --model claude:haiku
  ```
- **Сопровождение скилла:** При изменении правил в `SKILL.md`, `EXECUTOR.md` или `references/*.md` следуйте `MAINTAINING.md`, синхронно обновляя заголовки версий, корневую копию `EXECUTOR.md` и метку `<!-- skill-readme-sync: vX.Y / A.B -->`.
