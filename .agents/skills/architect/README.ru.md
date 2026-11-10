<!-- skill-readme-sync: v3.43 / 1.8 -->
# Скилл «Архитектор + Исполнитель» (`v3.43 / 1.8`)

Переносимый скилл разделения ролей **Главный Архитектор + Исполнитель** с двумя честными уровнями установки:
1. **Ядро скилла (`SKILL.md` + `EXECUTOR.md` + `references/*.md`):** работает в **любом ИИ-агенте** (**Claude Code**, **Gemini CLI**, **Codex**, **Antigravity**, **Cursor**, Windsurf и др.), на **любом стеке** и в **любой ОС** (macOS, Linux, Windows) через ручную передачу задач или субагентов.
2. **Автоматический оркестратор (`orchestrator/run.mjs`):** CLI на чистом Node.js без npm-зависимостей; требует **Node.js 22+** и **git 2.31+**. **Детерминированные проверки (`--check`, `--check-task`, `--self-check`) официально поддерживаются на macOS и Linux (`ubuntu-latest`); цикл запуска агентов поддерживается только на macOS (Windows не поддерживается).** Поддерживает раннеры **`agy`** (Antigravity) и **`claude`** (Claude Code); системные уведомления работают на **macOS** (`osascript`), также поддерживается вебхук `AGENT_LOOP_WEBHOOK_URL`.

- **Рабочие промпты (единый источник правил на английском):** `SKILL.md`, `EXECUTOR.md`, `references/{auto-review,orchestrator,plan-audit,retro,stacks,team}.md`.
- **Руководства для человека (`<= 25 КБ` каждое):** `README.ru.md` (на русском) и `README.en.md` (на английском).

---

## 1. Быстрый старт (2 шага)

1. **Установите или обновите скилл одной командой** (либо попросите агента: *«Установи скилл `architect` из `https://github.com/Aghasi-Sargsyan/architect-skill` в `.agents/skills/architect`»*):
   - **Antigravity, Gemini CLI, Codex, Cursor (`.agents/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .agents/skills && rm -rf .agents/skills/architect && cp -R "$tmp/.agents/skills/architect" .agents/skills/ && rm -rf "$tmp"
     ```
   - **Claude Code (`.claude/skills/`):**
     ```bash
     tmp=$(mktemp -d) && git clone --depth 1 https://github.com/Aghasi-Sargsyan/architect-skill.git "$tmp" && mkdir -p .claude/skills && rm -rf .claude/skills/architect && cp -R "$tmp/.agents/skills/architect" .claude/skills/ && rm -rf "$tmp"
     ```
   - **Обновление уже установленного скилла (одной командой):** напишите в чате **`/architect update`** или выполните в терминале:
     ```bash
     node .agents/skills/architect/orchestrator/run.mjs --update
     # или: npm run agents -- --update
     ```
2. **Откройте агента и напишите `/architect`** (или *«прочитай `.agents/skills/architect/SKILL.md`»*):
   - **Первый запуск в новом проекте:** в Фазе 1 (только чтение) Архитектор не трогает файлы, спрашивает **модель Исполнителя** и предлагает блок ролей в `AGENTS.md`. В Фазе 2 по умолчанию создаёт файлы в `.architect/` (`.architect/EXECUTOR.md`, `.architect/PLAN.md`) в коммите `arch: plan ...`, сам запускает `--init`, `--check` и `--dry-run`, спрашивая «да» только для `--write-permissions` (для миграции `classic`-проекта в `.architect/` напишите **`/architect compact`** или `--compact`).

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
   - **Без оркестратора:** добавьте строку `Executor model: <Модель / Уровень>` в `AGENTS.md`, `CLAUDE.md` или `GEMINI.md` проекта (см. врезку в разделе 4). Для субагента Claude Code скопируйте шаблон `.agents/skills/architect/templates/claude-agent-executor.md` в `.claude/agents/executor.md` и задайте явное поле `model:` (не оставляйте `inherit` или пустое поле).
4. **Проверьте настройку и запускайте задачи (`T-NNN`):**
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --check
   node .agents/skills/architect/orchestrator/run.mjs --dry-run
   node .agents/skills/architect/orchestrator/run.mjs --self-check
   node .agents/skills/architect/orchestrator/run.mjs --background
   node .agents/skills/architect/orchestrator/run.mjs --follow
   ```

### A. Antigravity (`agy`) — Ядро + Оркестратор
1. Положите скилл в `.agents/skills/architect/` и скопируйте `EXECUTOR.md` в корень проекта.
2. Для автоматического цикла (`runner: "agy"`, macOS, Node 22+) выполните `--init`, затем запишите allowlist в `~/.gemini/antigravity-cli/settings.json`:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### B. Claude Code (`claude`) — Ядро + Оркестратор или Субагент
1. Положите скилл в `.agents/skills/architect/` или `.claude/skills/architect/` и скопируйте `EXECUTOR.md` в корень.
2. **Субагент:** скопируйте `.agents/skills/architect/templates/claude-agent-executor.md` в `.claude/agents/executor.md` и задайте явное поле `model:` (например, `model: sonnet`, никогда `inherit`).
3. **Оркестратор (macOS, Node 22+):** укажите `"runner": "claude"`, `"executor": { "model": "sonnet" }` и `"architect": { "model": "opus" }` в конфиге, затем выполните:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --write-permissions
   node .agents/skills/architect/orchestrator/run.mjs --check
   ```

### C. Gemini CLI, OpenAI Codex CLI, Cursor и другие агенты — Только ядро
- Положите скилл в `.agents/skills/architect/`, скопируйте `EXECUTOR.md` в корень и добавьте врезку из раздела 4 (включая `Executor model: …`) в `GEMINI.md`, `AGENTS.md` или `.cursorrules`. Запускайте Архитектора и Исполнителя в отдельных чатах.

### D. Обновление скилла в существующем проекте
1. **С оркестратором (основной способ):** одной командой:
   ```bash
   node .agents/skills/architect/orchestrator/run.mjs --update
   # или: npm run agents -- --update
   ```
   Клонирует свежий коммит, обновляет папки скилла (`.agents/skills/architect` / `.claude/skills/architect`), пишет SHA в `.version`, синхронизирует `EXECUTOR.md` и хуки, не затрагивая конфиги (`config.json`, `config.local.json`) и историю. Команды `--check`, `--dry-run`, `--self-check` и старт цикла проверяют наличие новых коммитов раз в 24 часа (кэш в `.agent-runs/.update-check.json`) и выводят строку `! skill update available:`.
2. **Без Node.js:** однострочник из раздела 1 с `mktemp -d` (`rm -rf` перед `cp -R`), затем:
   ```bash
   cp .agents/skills/architect/EXECUTOR.md EXECUTOR.md
   ```
3. Выполните `node .agents/skills/architect/orchestrator/run.mjs --check` для проверки синхронизации.

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

Рабочие файлы можно хранить в корне (`PLAN.md`, `EXECUTOR.md`, `docs/decisions.md`, `docs/executor-profiles.md`, `docs/plans/`) или компактно в `.architect/` (`planPath: ".architect/PLAN.md"`, `executorPath: ".architect/EXECUTOR.md"`). Парсер `plan.mjs` поддерживает русские и английские поля задачи `T-NNN`:
- `Риск` (`Risk`): `низкий` | `средний` | `высокий` (`low` | `medium` | `high`)
- `Зависит от` (`Depends on`): `—` или `T-NNN`; `Параллельно с` (`Parallel with`): `T-MMM`
- `Исполнитель` (`Executor`): `@<github-ник> · <Окружение> · <Модель (\`id\`)>`; `Модель` (`Model`): целевая модель
- `Читать` (`Read`), `Менять` (`Change`, `<= 3–5` файлов), `Задача и инварианты` (`Task and invariants`), `Граничные случаи` (`Edge cases`), `Тест-кейсы` (`Test cases`), `Готово, когда` (`Done when`), `Проверка` (`Check`).

### Настройка под свой стек (`config.json` / `orchestrator.json`)
Для стеков вне `node:test` (`pytest`, `go test`, `cargo test`, Vitest/Jest) задайте `testFilePatterns`, `testPatterns`, `assertPatterns` (`assert.` и `expect(` по умолчанию) и `redCheckCommand` (например, `"pytest {file}"`). При отсутствии подходящей `redCheckCommand` или 0 утверждений в тесте `--self-check` выдаёт явный `NOT VERIFIED`.

---

## 6. Справочник команд оркестратора (`orchestrator/run.mjs`)

Добавьте `"agents": "node .agents/skills/architect/orchestrator/run.mjs"` в `scripts` файла `package.json`:

| Флаг | Назначение |
|---|---|
| `--init [--team]` | Создание конфига, установка `.git/hooks/commit-msg`, добавление `.agent-runs/` и `*.local.json` в `.gitignore`; с `--team` пишет `"team": true` и `.github/workflows/team-ci.yml` |
| `--install-hooks` | Установка Node-хука `.git/hooks/commit-msg` (без перезаписи существующего хука или `core.hooksPath`) |
| `--update [--force]` | Обновление папки скилла, `.version`, `EXECUTOR.md` и хуков |
| `--compact` | Миграция существующего проекта из `classic` (корень / `docs/`) в компактную раскладку `.architect/` (`/architect compact`) |
| `--models` / `--set-model <executor\|architect> <id> [--local]` | Список моделей окружения с `effort` (`--models`) или запись модели роли в конфиг и `AGENTS.md` (`--set-model`, `/architect model`) |
| `--check` | Проверка ОС, Node 22+, git 2.31+, подпапки скилла, копии `EXECUTOR.md`, хука `commit-msg`, итоговой модели Исполнителя и её источника, `PLAN.md`, параллельных задач, раннеров и allowlist |
| `--check-task T-NNN [--base <ref>]` | Шлюз задачи `T-NNN` по `<base>:PLAN.md` и `git merge-base <base> HEAD` (`Change`, `Frozen`, обходы, коммиты, запрет squash и `Verify`-команды задачи) |
| `--write-permissions` | Запись allowlist команд и путей для `agy` или `claude` (после явного согласия пользователя) |
| `--dry-run` | Проверка готовности, `--self-check` (`red-check`) и показ промпта следующей задачи без вызова LLM |
| `--self-check [--base <ref>]` | Самопроверка Архитектора (обходы, пустой `catch`, таймеры, монотонность, `fix-frozen`, `eval`, аудит, параллельные задачи и `red-check`) |
| `--audit-plan` | Read-only аудит плана другой моделью (`references/plan-audit.md`) через `config.auditor` (до 1 повтора на базу цикла) |
| `--background` | Запуск цикла в фоне (`.agent-runs/.lock`) |
| `--watch [мин] [--since N]` | Ожидание запроса разрешения (`2`), остановки (`3`) или вехи задачи (`4`) |
| `--status` / `--follow` | Сводка состояния цикла (`--status`) или живая лента в терминале (`--follow`) |
| `--answer <1\|2\|3>` / `--pause` / `--only T-NNN` | Ответ на запрос разрешения, пауза после задачи или прогон одной задачи `T-NNN` |

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

- **Полностью (Ядро + Оркестратор):** долгоживущие продукты с зонами высокого риска (права доступа, биллинг, миграции БД, конкурентность) на macOS с раннерами `agy` или `claude`.
- **Только ядро (`SKILL.md` + `EXECUTOR.md`):** проекты любого размера, другие стеки и агенты (`Gemini CLI`, `Codex`, `Cursor`), Linux или Windows (двухфазное планирование, `Frozen`, изоляция контекста без цикла Node.js).
- **Не использовать:** одноразовые прототипы, геймджемы, разовые скрипты и задачи с чисто визуальной приёмкой.
- **Командные проекты с PR и CI:** командный режим (`--init --team`, раздел 9) или базовые практики ядра (Фаза 1 только для чтения, `Frozen`, изолированный Исполнитель).

---

## 9. Командный режим и настройки репозитория GitHub

В командном режиме (1 Главный Архитектор / техлид + N Исполнителей в Antigravity, Claude Code, Codex) инициализируйте проект командой:
```bash
node .agents/skills/architect/orchestrator/run.mjs --init --team
```
Команда прописывает `"team": true` и `"fullTestCommand": "npm test"` в общий конфиг, добавляет `.architect/config.local.json` и `.agents/orchestrator.local.json` в `.gitignore` и создаёт `.github/workflows/team-ci.yml` (из шаблона `templates/github-team-ci.yml`).

### Личный локальный конфиг и общий конфиг политики
- **Общий конфиг (`.architect/config.json` или `.agents/orchestrator.json`, в git):** хранит политику проекта (`team`, `commitLanguage`, `permissions`, `allowedCommands`, `blockedScripts`, `protectedConfigFiles`, `bypassScanPaths`, `bypassPatterns`, `fullTestCommand`).
- **Личный локальный конфиг (`.architect/config.local.json` или `.agents/orchestrator.local.json`, в `.gitignore`):** переопределяет только личное окружение (`executor`, `architect`, `auditor`, `runner`, `runnerBin`, `agyBin`, `notify`). Поля политики в `.local.json` отклоняются fail-closed.
- **Цепочка выбора модели (`--check` выводит модель и источник):** `.local.json` → общий конфиг → файл агента (`.claude/agents/executor.md` / `AGENTS.md`). В карточке задачи поле `Executor:` задаёт назначение, а `Parallel with: T-MMM` — параллельные задачи; при несовпадении окружения с локальным `runner` оркестратор задачу не берёт.

### Поток веток (`cycle/<N>`, `task/T-NNN`, `master`)
1. **Старт цикла:** Архитектор создаёт `cycle/<N>` от `master`, коммитит `arch: plan ...` с `PLAN.md` и красными `Frozen`-тестами, техлид пушит `cycle/<N>`.
2. **Выполнение задачи:** разработчик отводит `task/T-NNN` от `cycle/<N>`, запускает агента локально (агент коммитит `T-NNN: ...` без push), пушит `task/T-NNN` и открывает PR `task/T-NNN → cycle/<N>` с отчётом.
3. **Шлюз PR и приёмка:** на PR в `cycle/*` CI запускает `run.mjs --check-task T-NNN --base origin/cycle/<N>` (границы `Change`, `Frozen`, коммиты, запрет squash и `Verify`-команды задачи). После ревью по `references/auto-review.md` техлид вливает PR через **Create a merge commit** (`--no-ff`), делает коммит `arch: accept T-NNN` (`- [x] T-NNN:` в `PLAN.md`) и пушит в `cycle/<N>`.
4. **Закрытие цикла:** когда все задачи `[x]`, Архитектор коммитит `arch: close cycle <N>` в `cycle/<N>` и открывает PR `cycle/<N> → master`. CI гоняет `fullTestCommand` и `--self-check --base origin/master`; техлид вливает PR через **Create a merge commit**.

### Точные настройки GitHub для репозитория команды
1. **Способы слияния PR ([Configuring commit merging for pull requests](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-merging-for-pull-requests)):**
   - Включите **Allow merge commits**.
   - **Отключите Allow squash merging** и **Allow rebase merging**, чтобы сохранять атомарные коммиты `T-NNN:` и `arch:` для `--check-task` и `--self-check`.
2. **Ruleset для `cycle/*` ([About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)):**
   - **Target branches:** `cycle/*`.
   - **Bypass list:** добавьте **Tech Lead / Architect** (чтобы Архитектор пушил `arch: plan`, `arch: accept T-NNN` и `arch: close cycle <N>` напрямую в `cycle/<N>`, а Исполнители работали только через PR).
   - **Rules:** включите *Require a pull request before merging* (только **Merge**), *Require status checks to pass* (`Task PR Gate (task/T-NNN -> cycle/*)`) и *Block force pushes*.
3. **Ruleset / Branch Protection для `master` / `main` ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)):**
   - **Target branches:** основная ветка (`master` или `main`), без обхода прямым пушем.
   - **Rules:** включите *Require a pull request before merging* (только **Merge**), *Require status checks to pass* (`Full Test Suite & Self-Check (master/main)`) и *Block force pushes*.
