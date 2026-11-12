# Architect Skill — правила для агентов

Переносимый скилл разделения ролей Главный Архитектор + Исполнитель (`.agents/skills/architect/`) и детерминированный оркестратор на чистом Node.js (`orchestrator/run.mjs`) без внешних npm-зависимостей. Системные требования оркестратора: Node.js 22+ и `git 2.31+`; команды `--check`, `--check-task` и `--self-check` поддерживаются на macOS и Linux, автоматический цикл агентов — только на macOS.

## 1. Роли и язык
- **Сессия Архитектора** (вызов `/architect` или запрос на архитектуру, план `PLAN.md`, ревью или разбор проблемы): первым действием прочитай `.agents/skills/architect/SKILL.md` и следуй двухфазному протоколу (`[MODE: ... · PHASE 1/2]`).
- **Сессия Исполнителя** (запрос выполнить задачу `T-NNN` из `PLAN.md`): первым действием прочитай `EXECUTOR.md` и `PLAN.md`, меняй только файлы из поля `Менять` (`Change`) задачи `T-NNN`, не трогай `Frozen` и `PLAN.md`, перед коммитом `T-NNN: ...` выполни команду из `Проверка` (`Check`). Исполнитель по умолчанию — `sonnet-high`.
- **Язык:** общение с пользователем — на русском; код, идентификаторы, комментарии в коде, сообщения коммитов (`T-NNN: ...`, `arch: ...`) и рабочие файлы правил скилла (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) — на английском. Тон прямой и спокойный, без воды.

## 2. Стек и структура
- Чистый Node.js 22+ (`node:fs`, `node:path`, `node:child_process`, `node:test`, `node:assert/strict`), ES-модули (`.mjs`), без внешних зависимостей.
- `.agents/skills/architect/` — ядро скилла (`SKILL.md`, `EXECUTOR.md`, `MAINTAINING.md`, `README.ru.md`, `README.en.md`, `LICENSE`, `CHANGELOG.md`, `references/*.md`) и оркестратор (`orchestrator/*.mjs`, `orchestrator/adapters/*.mjs`, `orchestrator/schemas/*.json`).
- Корневой `EXECUTOR.md` — побайтная копия `.agents/skills/architect/EXECUTOR.md`.
- `.claude/skills/architect` — относительный симлинк на `.agents/skills/architect` (обнаружение скилла в Claude Code, `ADR-063`); правки делаются только в `.agents/skills/architect`.
- Конфиг оркестратора — `.agents/orchestrator.json` (или `.architect/config.json`), личный gitignored-оверлей — `.agents/orchestrator.local.json` / `.architect/config.local.json`, логи прогонов — `.agent-runs/`.
- Файлы больше ~400 строк — архитектурный долг; при чтении сначала ищи по символу/grep, затем читай участок 30–80 строк.

## 3. Команды

| Команда | Назначение |
|---|---|
| `npm test` | запуск всех тестов оркестратора, скилла и `tests/*.test.mjs` |
| `node --test .agents/skills/architect/orchestrator/*.test.mjs .agents/skills/architect/orchestrator/adapters/*.test.mjs tests/*.test.mjs` | полный набор тестов напрямую через `node --test` (совместимо с Node 22 и Node 24) |
| `VERIFY_STEP_A1=1 npm test` | полная проверка упаковки скилла и синхронизации `README.*.md` (`MAINTAINING.md` Step A1) |
| `npm run agents` | автоматический цикл по `PLAN.md` (Исполнитель → проверка механики → приёмка Архитектором). Флаги: `-- --init [--team]`, `-- --install-hooks`, `-- --update [--force]`, `-- --compact`, `-- --repair`, `-- --models`, `-- --set-model <executor\|architect> <id> [--local]`, `-- --check`, `-- --check-task T-NNN [--base <ref>]`, `-- --write-permissions` (только после явного «да» пользователя), `-- --dry-run`, `-- --self-check [--base <ref>]`, `-- --audit-plan`, `-- --background`, `-- --watch [мин] [--since N]`, `-- --status`, `-- --follow`, `-- --answer <1\|2\|3>`, `-- --pause`, `-- --only T-NNN` |

## 4. Инварианты и обходы проверок
- Рабочие файлы правил (`SKILL.md`, `EXECUTOR.md`, `references/*.md`) — только на английском; единственная разрешённая `.ru.md` копия в папке скилла — `README.ru.md` (`ADR-032`).
- При любом изменении правил в `.agents/skills/architect/{SKILL.md,EXECUTOR.md,references/*.md}` обязательно прочитай `MAINTAINING.md` §1 и в том же коммите (или до закрытия цикла) подними версию (`# Architect Prompt vX.Y` / `<!-- executor-policy-version: A.B -->`), синхронизируй `README.en.md`, `README.ru.md`, корневой `README.md`, `CHANGELOG.md` и `package.json` (`--self-check` механически отклоняет правки правил скилла без увеличения версии).
- Ошибки процессов, JSON и git обрабатываются явно (fail-closed). Запрещены пустой `catch {}`, `catch` с одним комментарием и `.catch(() => {})`; исключение — cleanup (`stop`/`abort`/`close`) с комментарием-причиной.
- В тестах запрещены таймеры реального времени (`performance.now(`, `Date.now(`, `process.hrtime`, `console.time(`) — скорость проверяется структурно (счётчиками вызовов/чтений или размером файла).
- Обходы проверок в этом проекте:
  - безусловно запрещены: `any`, `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`, `.skip` / `.only`, удаление тестов, смена ожидаемых значений в эталонных тест-кейсах и мутация глобальных объектов и встроенных прототипов (`String.prototype`, `Object.prototype`, `globalThis`, `__proto__`);
  - только по согласованию с Архитектором и с комментарием-обоснованием в коде: `as unknown as` и локальный `eslint-disable`;
  - пути кода — `.agents/skills/architect/orchestrator`; grep ретро по добавленным строкам: `git log -p --format='commit %h %s' <база>..HEAD -- .agents/skills/architect/orchestrator | grep -nE '^commit |^\+.*([:<,|=>&[(][[:space:]]*any\b|\bas[[:space:]]+any\b|as unknown as|@ts-(ignore|expect-error|nocheck)|eslint-disable|\.(skip|only)\(|(?:Object\.assign|(?:Object|Reflect)\.(?:defineProperty|defineProperties|setPrototypeOf))[[:space:]]*\([[:space:]]*(?:[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\.[[:space:]]*prototype|globalThis)\b|\b(?:[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\.[[:space:]]*prototype|globalThis)[[:space:]]*(?:\.[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*|\[[^]]+\])[[:space:]]*=[^=]|(^|[^A-Za-z0-9_$])__proto__[[:space:]]*(=[^=]| :))'`.

## 5. Зоны высокого риска
`.agents/skills/architect/orchestrator/{guards,guards-recovery,permissions,permissions-cli,runners,mechanics,selfcheck,evidence,audit,hooks,eval-fixtures,ask,plan,plan-validate,run,check,cli,cli-dispatch,events,layout,skill-targets,claude-setup}.mjs` · `.agents/skills/architect/orchestrator/adapters/` · `.agents/skills/architect/{SKILL,EXECUTOR}.md` и `.agents/skills/architect/references/` · `.agents/orchestrator.json`.

## 6. Git и секреты
- Коммиты — только с явными путями: `git add <пути>`, затем `git commit --only <те же пути>`, после — `git show --stat HEAD`. `git add .` и `git add -A` не использовать.
- Перед правками проверяй `git status`: чужие незакоммиченные изменения не трогай. `git reset --hard`, `git clean`, force push и переписывание истории — только с разрешения пользователя.
- `git push` — только по прямой команде пользователя в текущей сессии (Исполнитель не пушит никогда). До push: перечислить `NOT VERIFIED` из `PLAN.md`, показать `git log --oneline @{u}..HEAD`, прогнать `npm test` и `npm run agents -- --self-check`.
- Секреты, API-ключи и URL вебхуков (`AGENT_LOOP_WEBHOOK_URL`) не коммитить и не вписывать в код.
