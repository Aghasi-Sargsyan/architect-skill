// Stack-neutral script/target runner rules and PATH shims (npm, pnpm, yarn, bun, make, just).
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findExecutable } from './events.mjs';

export const RUNNER_TOOLS = ['npm', 'pnpm', 'yarn', 'bun', 'make', 'just'];
export const PATH_GUARDED_TOOLS = ['grep', 'ls', 'wc', 'node'];

const shQuote = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

export function pathCheckSnippet(tool, effDirVar = 'cur_pwd') {
  return `  check_path() {
    p="$1"
    [ -z "$p" ] && return 0
    case "$p" in /*) ;; *) p="$${effDirVar}/$p" ;; esac
    if [ ! -e "$p" ] && [ ! -L "$p" ]; then return 0; fi
    hops=0
    while [ -L "$p" ]; do
      hops=$((hops + 1))
      if [ "$hops" -gt 40 ]; then
        echo "agent-loop guard: ${tool} path outside workDir is blocked for agents" >&2
        exit 97
      fi
      target=$(readlink "$p" 2>/dev/null) || {
        echo "agent-loop guard: ${tool} path outside workDir is blocked for agents" >&2
        exit 97
      }
      case "$target" in /*) p="$target" ;; *) p="\${p%/*}/$target" ;; esac
    done
    if [ -d "$p" ]; then
      real=$(cd "$p" 2>/dev/null && pwd -P)
    else
      case "$p" in */*) d="\${p%/*}"; b="\${p##*/}" ;; *) d="."; b="$p" ;; esac
      d_real=$(cd "$d" 2>/dev/null && pwd -P)
      if [ -z "$d_real" ]; then
        echo "agent-loop guard: ${tool} path outside workDir is blocked for agents" >&2
        exit 97
      fi
      if [ "$d_real" = "/" ]; then real="/$b"; else real="$d_real/$b"; fi
    fi
    if [ -z "$real" ]; then
      echo "agent-loop guard: ${tool} path outside workDir is blocked for agents" >&2
      exit 97
    fi
    case "$real" in
      "$WORK_REAL"|"$WORK_REAL"/*) ;;
      *)
        echo "agent-loop guard: ${tool} path outside workDir is blocked for agents" >&2
        exit 97
        ;;
    esac
  }
  check_arg() {
    arg="$1"
    check_path "$arg"
    case "$arg" in --*=*) check_path "\${arg#*=}" ;; esac
    case "$arg" in -[!-]*f*) check_path "\${arg#*f}" ;; -[!-]*) check_path "\${arg#-[!-]}" ;; esac
  }`;
}

export function writePathShims({ shimDir, workDir, realBins = {}, exemptNodeScripts = [] }) {
  mkdirSync(shimDir, { recursive: true });
  const workReal = workDir ? (() => { try { return realpathSync(workDir); } catch { return ''; } })() : '';
  const exemptList = (exemptNodeScripts ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const exemptStr = exemptList.join(' ');

  for (const tool of PATH_GUARDED_TOOLS) {
    const file = path.join(shimDir, tool);
    const realBin = realBins[tool] || (tool === 'node' ? process.execPath : (findExecutable(tool) ?? ''));
    let guardBody = '';
    if (tool === 'node') {
      guardBody = `  if [ "$1" != "--test" ]; then
    if [ -n "$REAL_BIN" ]; then exec "$REAL_BIN" "$@"; fi
    echo "node: command not found" >&2
    exit 127
  fi
  if [ -n "$WORK_REAL" ]; then
    cur_pwd=$(pwd -P 2>/dev/null)
    case "$cur_pwd" in
      "$WORK_REAL"|"$WORK_REAL"/*) ;;
      *)
        echo "agent-loop guard: $TOOL outside workDir is blocked for agents" >&2
        exit 97
        ;;
    esac
  fi
${pathCheckSnippet(tool, 'cur_pwd')}
  for a in "$@"; do
    check_arg "$a"
  done`;
    } else {
      guardBody = `  if [ -n "$WORK_REAL" ]; then
    cur_pwd=$(pwd -P 2>/dev/null)
    case "$cur_pwd" in
      "$WORK_REAL"|"$WORK_REAL"/*) ;;
      *)
        echo "agent-loop guard: $TOOL outside workDir is blocked for agents" >&2
        exit 97
        ;;
    esac
  fi
${pathCheckSnippet(tool, 'cur_pwd')}
  for a in "$@"; do
    check_arg "$a"
  done`;
    }

    const content = `#!/bin/sh
# agent-loop guard: ${tool} shim
REAL_BIN=${shQuote(realBin)}
WORK_REAL=${shQuote(workReal)}
TOOL=${shQuote(tool)}
EXEMPT_SCRIPTS=${shQuote(exemptStr)}
if [ "$AGENT_LOOP" = "1" ]; then
${guardBody}
fi
if [ -n "$REAL_BIN" ]; then
  exec "$REAL_BIN" "$@"
fi
echo "${tool}: command not found" >&2
exit 127
`;
    writeFileSync(file, content);
    chmodSync(file, 0o755);
  }
}

export function effectiveBlockedScripts(config = {}) {
  const a = Array.isArray(config?.blockedScripts) ? config.blockedScripts : [];
  const b = Array.isArray(config?.blockedNpmScripts) ? config.blockedNpmScripts : [];
  return [...new Set([...a, ...b].filter((x) => typeof x === 'string'))];
}

export function blockedRunnerCommands(blockedScripts = []) {
  return (blockedScripts ?? []).flatMap((s) => [
    `npm run ${s}`,
    `npm run-script ${s}`,
    `npm ${s}`,
    `pnpm run ${s}`,
    `pnpm ${s}`,
    `yarn run ${s}`,
    `yarn ${s}`,
    `bun run ${s}`,
    `bun ${s}`,
    `make ${s}`,
    `just ${s}`,
  ]);
}

export function writeRunnerShims({ shimDir, blockedScripts = [], realBins = {} }) {
  mkdirSync(shimDir, { recursive: true });
  const blockedList = Array.isArray(blockedScripts) ? blockedScripts : [];
  const blockedStr = blockedList.join(' ');

  for (const tool of RUNNER_TOOLS) {
    const file = path.join(shimDir, tool);
    const realBin = realBins[tool] ?? '';
    let checkBody = '';

    if (tool === 'make' || tool === 'just') {
      checkBody = `  skip=""
  for a in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case "$a" in
      -C|-f|--file|--makefile|--directory|--justfile|--working-directory|-d)
        skip=1
        ;;
      -*)
        ;;
      *=*)
        ;;
      *)
        for b in $BLOCKED; do
          if [ "$a" = "$b" ]; then
            echo "agent-loop guard: ${tool} $a is blocked for agents" >&2
            exit 97
          fi
        done
        ;;
    esac
  done`;
    } else {
      checkBody = `  sub=""; script=""; skip=""
  for a in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case "$a" in
      --prefix|-C|--dir|--cwd|--workspace|-w|--filter|-F) skip=1; continue ;;
      -*) continue ;;
    esac
    if [ -z "$sub" ]; then
      sub="$a"
    elif [ -z "$script" ]; then
      script="$a"
      break
    fi
  done
  case "$sub" in run|run-script|rum|urn) target="$script" ;; *) target="$sub" ;; esac
  for b in $BLOCKED; do
    if [ "$target" = "$b" ]; then
      echo "agent-loop guard: ${tool} $target is blocked for agents" >&2
      exit 97
    fi
  done`;
    }

    const content = `#!/bin/sh
# agent-loop guard: ${tool} shim
REAL_BIN=${shQuote(realBin)}
BLOCKED=${shQuote(blockedStr)}
if [ "$AGENT_LOOP" = "1" ]; then
${checkBody}
fi
if [ -n "$REAL_BIN" ]; then
  exec "$REAL_BIN" "$@"
fi
echo "${tool}: command not found" >&2
exit 127
`;

    writeFileSync(file, content);
    chmodSync(file, 0o755);
  }
}
