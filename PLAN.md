# PLAN

## Goal / Requirements
Цикл 15 (предпубликационные правки):
1. `.github/workflows/ci.yml`: добавить `fetch-depth: 0` в `actions/checkout@v4`, чтобы `--self-check` в CI проверял реальный диапазон коммитов, а не пустой `HEAD..HEAD` на неглубоком клоне; покрыть тестом, который падает при отсутствии `fetch-depth: 0`.
2. Корневые `README.md` (кратко на английском: назначение, установка, ссылки на `.agents/skills/architect/README.en.md` и `.agents/skills/architect/README.ru.md`) и `LICENSE` (побайтная копия MIT из `.agents/skills/architect/LICENSE`) с проверкой совпадения двух `LICENSE` тестом.
3. Устранить все пустые `catch {}` в не-тестовых `.mjs` модулях оркестратора (`events.mjs`, `guards.mjs`, `selfcheck.mjs`, `feed.mjs`) по правилам `AGENTS.md §4` (явная обработка или cleanup-комментарий со `stop`/`abort`/`close`) и зафиксировать эталонным тестом сканирование всех не-тестовых `.mjs` файлов оркестратора на пустой `catch`.
4. Убрать локальный абсолютный путь из `docs/plans/2026-10-31-stage-4-pre-publication.md:39`.

### Перенесено из предыдущего цикла (`NOT VERIFIED` и очередь)
- **Контроль ячейки eval `claude:haiku` `high_risk_frozen_test` (`NOT VERIFIED (sample < 5)`):** `eval 2026-10-30T22-22-26-632Z @ ad719e4: 10/10 PASS` (по ячейке `claude:haiku` `high_risk_frozen_test` в этом репозитории 1 прогон, с учётом предыдущих прогонов после S5 — 3 из 4 запусков, `NOT VERIFIED (sample < 5)`).
- **CI GitHub Actions (`.github/workflows/ci.yml`):** живой облачный прогон GitHub Actions (`macos-latest`, Node 22 и 24) — `NOT VERIFIED` до первого `git push` в удалённый репозиторий.
- **Отложено по параллельности оркестратора:** worktree-параллельность и пакетное ревью отложены, потому что у рабочих деревьев общие `.git/config` и `hooks`, а `guards` подменяют `remote.*.pushurl` и `pre-push`.
- **Публикация скилла (`E4`):** создание удалённого репозитория и `git push` — только по отдельной прямой команде пользователя.

## Decisions (ADR)
Актуальный реестр долговечных решений (`ADR-008`…`ADR-039`) хранится в `docs/decisions.md`. Следующий номер: `ADR-040`.
- Предпубликационная гигиена (Цикл 15): эталонный тест в `packaging-clean.test.mjs` сканирует все не-тестовые `.mjs` в `orchestrator/` и `orchestrator/adapters/` на пустые `catch` (включая `feed.mjs:204` помимо 10 мест в `events.mjs`, `guards.mjs`, `selfcheck.mjs`) и проверяет `findEmptyCatches` на изменённых модулях; `tests/repo-install.test.mjs` проверяет наличие `fetch-depth: 0` в `.github/workflows/ci.yml`, побайтное совпадение корневого `LICENSE` с `.agents/skills/architect/LICENSE`, наличие ссылок в корневом `README.md` и отсутствие локального пути в `docs/plans/2026-10-31-stage-4-pre-publication.md`.

## Frozen
- `EXECUTOR.md`
- `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`

## Rules
For Executor on task T-NNN: read EXECUTOR.md first and follow it; project invariants — AGENTS.md §2, §4, §6.

## Задачи

- [ ] T-062: Eliminate empty catch blocks in orchestrator production modules and enforce via frozen scanner test
  - Риск: высокий
  - Зависит от: —
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`, `.agents/skills/architect/orchestrator/events.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`
  - Менять: `.agents/skills/architect/orchestrator/events.mjs`, `.agents/skills/architect/orchestrator/guards.mjs`, `.agents/skills/architect/orchestrator/selfcheck.mjs`, `.agents/skills/architect/orchestrator/feed.mjs`
  - Задача и инварианты: Устранить все пустые и бездействующие блоки `catch` в рабочих модулях `events.mjs` (строки 53, 132, 213), `guards.mjs` (строки 31, 309), `selfcheck.mjs` (строки 55, 216, 225, 307, 308, 371) и `feed.mjs` (строка 204) в соответствии с `AGENTS.md §4`: либо явно обрабатывать ветку возврата/присваивания (`continue;`, `return null;`, `return true;`, `baseJson = {};`, `headJson = {};`, `tasks = [];` и т.д.), либо для подавления ошибок завершения/очистки внешних вызовов указывать cleanup-комментарий со словом `stop`, `abort` или `close` (`/* cleanup: abort ... */` / `/* cleanup: close ... */`). Все 4 изменённых файла должны оставаться `<= 400` строк (`split('\n').length <= 400`) и проходить как регулярную проверку на пустой `catch`, так и `findEmptyCatches` в замороженном тесте `packaging-clean.test.mjs`.
  - Граничные случаи: Сохранить прежнее поведение функций при отсутствии файлов, git-ссылок (`@{u}`, `PLAN.md`), недоступности `osascript` или невалидном JSON; не увеличивать длину `guards.mjs` (388 строк), `selfcheck.mjs` (377 строк) и `feed.mjs` (395 строк) сверх 400 строк (однострочные `catch` оставлять однострочными).
  - Тест-кейсы: `.agents/skills/architect/orchestrator/packaging-clean.test.mjs`
  - Готово, когда: Замороженный эталонный тест `packaging-clean.test.mjs` и модульные тесты изменённых файлов проходят с кодом 0.
  - Проверка: `node --test .agents/skills/architect/orchestrator/packaging-clean.test.mjs .agents/skills/architect/orchestrator/events.test.mjs .agents/skills/architect/orchestrator/guards-path.test.mjs .agents/skills/architect/orchestrator/selfcheck.test.mjs .agents/skills/architect/orchestrator/feed.test.mjs`

- [ ] T-063: Add fetch-depth: 0 to ci.yml, create root README.md and LICENSE, sanitize stage-4 plan archive, and add repo-install tests
  - Риск: низкий
  - Зависит от: T-062
  - Модель: Gemini Flash (subagent, уровень неизвестен)
  - Читать: `.github/workflows/ci.yml`, `.agents/skills/architect/LICENSE`, `.agents/skills/architect/README.en.md`, `docs/plans/2026-10-31-stage-4-pre-publication.md`, `tests/repo-install.test.mjs`
  - Менять: `.github/workflows/ci.yml`, `README.md`, `LICENSE`, `docs/plans/2026-10-31-stage-4-pre-publication.md`, `tests/repo-install.test.mjs`
  - Задача и инварианты: (1) В `.github/workflows/ci.yml` в шаге `uses: actions/checkout@v4` добавить блок `with:` с `fetch-depth: 0`, чтобы `--self-check` в CI проверял реальный диапазон коммитов. (2) Создать корневой `LICENSE` как точную побайтную копию `.agents/skills/architect/LICENSE` (MIT). (3) Создать компактный корневой `README.md` на английском языке (`<= 80` строк): краткое описание скилла `Architect + Executor` и zero-dependency оркестратора (`v3.28 / 1.8`), системные требования (Skill Core — любой агент, стек и ОС; Orchestrator — Node.js 22+ на macOS и git 2.31+), быстрая установка (копирование `.agents/skills/architect/` в подпапку проекта, копирование `EXECUTOR.md` в корень, настройка модели Исполнителя, команды `--check` / `--dry-run` / `--self-check`) и прямые ссылки на `.agents/skills/architect/README.en.md`, `.agents/skills/architect/README.ru.md` и `LICENSE`. (4) В `docs/plans/2026-10-31-stage-4-pre-publication.md` (строка 39) заменить локальный абсолютный домашний путь на нейтральный плейсхолдер `<local-home-path>`. (5) В `tests/repo-install.test.mjs` (без уменьшения существующих `test(...)` и `assert.*`) добавить проверки: `.github/workflows/ci.yml` содержит `fetch-depth: 0` (парсить блок шага `actions/checkout` так, чтобы тест падал при отсутствии `fetch-depth: 0`); корневой `LICENSE` побайтно совпадает с `.agents/skills/architect/LICENSE`; корневой `README.md` непустой и содержит ссылки на `.agents/skills/architect/README.en.md` и `.agents/skills/architect/README.ru.md`; файл `docs/plans/2026-10-31-stage-4-pre-publication.md` не содержит `['', 'Users', 'aghasi'].join('/')`.
  - Граничные случаи: В `tests/repo-install.test.mjs` собирать проверяемую подстроку домашнего пути через `['', 'Users', 'aghasi'].join('/')`, чтобы сам тест не содержал литерала локального пути.
  - Тест-кейсы: `tests/repo-install.test.mjs`: (1) `ci.yml` шаг `actions/checkout@v4` содержит `fetch-depth: 0`; (2) `readFileSync('LICENSE', 'utf8') === readFileSync('.agents/skills/architect/LICENSE', 'utf8')`; (3) `README.md` содержит `.agents/skills/architect/README.en.md` и `.agents/skills/architect/README.ru.md`; (4) `docs/plans/2026-10-31-stage-4-pre-publication.md` не содержит запрещённого локального пути.
  - Готово, когда: `tests/repo-install.test.mjs` и `packaging-clean.test.mjs` проходят, число `test(...)` и `assert.*` в `tests/repo-install.test.mjs` выросло.
  - Проверка: `node --test tests/repo-install.test.mjs .agents/skills/architect/orchestrator/packaging-clean.test.mjs`
