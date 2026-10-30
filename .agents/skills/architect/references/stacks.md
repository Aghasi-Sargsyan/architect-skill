<!-- When modifying rules in this file, read MAINTAINING.md in the skill folder first -->
# Stacks: Verification Commands, Compact Test Output, and Check Bypasses

Reference guide for the `SKILL.md` core. Read it when looking up verification commands in a project with an unfamiliar stack, running tests yourself in interactive chat outside `node --test`, or recording the list of check bypasses in Decisions of the first plan (if the project's AGENTS.md has no "Check bypasses in this project" section).

## 1. Where to Find Verification Commands

In tasks, specify only commands that actually exist in the project. Sources:
- TypeScript / JavaScript — scripts in `package.json`; package manager — by lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`).
- Python — `pyproject.toml`, `tox.ini`, `pytest.ini`, `setup.cfg`.
- Go — `go.mod` (`go test ./...`, `go vet ./...`).
- Rust — `Cargo.toml` (`cargo test`, `cargo clippy`).
- Any stack — `Makefile` / `justfile` and CI config (`.github/workflows/`, `.gitlab-ci.yml`, and equivalents).

## 2. Compact Test Output in Interactive Chat

Redirect full output to a temporary file, and print only the exit code, summary lines, and errors in chat. General form: `<command> > "${TMPDIR:-/tmp}/t.log" 2>&1; s=$?; echo "exit=$s"; grep -E '<pattern>' "${TMPDIR:-/tmp}/t.log"; (exit $s)`. `grep -E` patterns for summary lines:
- `node --test`: `'^(# |ℹ )(tests|pass|fail)|^not ok|✖'`;
- Vitest: `'^ *(Test Files|Tests) |FAIL|×'`;
- Jest: `'^(Tests|Test Suites):|●'`;
- pytest: `'^(FAILED|ERROR) |^=+ .*(passed|failed|error)'`;
- `go test`: `'^(--- FAIL|FAIL|ok )'`;
- `cargo test`: `'^test result:|^failures:|FAILED'`.

Do not use this form in the "Verify" (`Проверка`) field of `PLAN.md` tasks: put only simple standalone commands without shell operators there.

## 3. Check Bypasses by Stack

Starter examples: adapt them to the project, replace `src tests` with your code directories, and set `<base>` to the previous cycle's closure commit or `arch: план …` / `arch: plan …`. Categories match Section 1 of the core: Category 1 — unconditionally forbidden, Category 2 — only with Architect approval.

**TypeScript / JavaScript** — Category 1: `any`, `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`, `.skip` / `.only`; Category 2: `as unknown as`, `eslint-disable`.
```bash
git log -p --format='commit %h %s' <base>..HEAD -- src tests | grep -nE '^commit |^\+.*([:<,|=>&[(][[:space:]]*any\b|\bas[[:space:]]+any\b|as unknown as|@ts-(ignore|expect-error|nocheck)|eslint-disable|\.(skip|only)\()'
```

**Python** — Category 1: `Any`, `# type: ignore`, `# mypy: ignore-errors`, `# pyright: ignore`, `@pytest.mark.skip` / `skipif` / `xfail`, `pytest.skip(`, `@unittest.skip`; Category 2: `cast(`, `# noqa`, `# pylint: disable`.
```bash
git log -p --format='commit %h %s' <base>..HEAD -- src tests | grep -nE '^commit |^\+.*(#[[:space:]]*type:[[:space:]]*ignore|#[[:space:]]*(mypy|pyright):[[:space:]]*ignore|\bAny\b|\bcast\(|#[[:space:]]*noqa|#[[:space:]]*pylint:[[:space:]]*disable|@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip)|pytest\.skip\()'
```

**Go** — Category 1: `t.Skip(` / `t.Skipf(` / `t.SkipNow(`, `//go:build ignore`; Category 2: `unsafe.Pointer`, `//nolint`, `//lint:ignore`.
```bash
git log -p --format='commit %h %s' <base>..HEAD -- . | grep -nE '^commit |^\+.*(\bt\.Skip(Now|f)?\(|//go:build ignore|unsafe\.Pointer|//nolint|//lint:ignore)'
```

**Rust** — Category 1: `#[ignore]` on tests, `#![allow(...)]` on the whole crate; Category 2: local `#[allow(...)]`, `transmute`.
```bash
git log -p --format='commit %h %s' <base>..HEAD -- src tests | grep -nE '^commit |^\+.*(#!?\[(ignore\]|allow\()|\btransmute\b)'
```

Deleted tests and altered expected values are not caught by grep over added lines: they are visible in `git diff --stat` and in removed lines (`^-`) of test files and Frozen reference tests. The orchestrator checks added lines against `bypassPatterns` in its config — those are JavaScript regular expressions (`\s` instead of `[[:space:]]`).
