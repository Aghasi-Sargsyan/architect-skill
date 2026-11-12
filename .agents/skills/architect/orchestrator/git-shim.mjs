// The git shim written into the agent PATH while AGENT_LOOP=1 (guards layer 1). Legacy rules stay in shell and
// answer first; every other check is the agent git policy (git-policy.mjs, ADR-065), run with the real node.
// Imports nothing from guards.mjs: guards.mjs re-exports writeGitShim and unwrapGit.
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathCheckSnippet } from './runners.mjs';
import { SHIM_MAX_BYTES } from './events.mjs';

const DEFAULT_POLICY_PATH = fileURLToPath(new URL('./git-policy.mjs', import.meta.url));

export function unwrapGit(bin, depth = 0) {
  if (depth > 5) {
    throw new Error(`unwrapGit loop detected (> 5 levels) for ${bin}`);
  }
  try {
    const st = statSync(bin, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size <= 0 || st.size > SHIM_MAX_BYTES) {
      return bin;
    }
    const src = readFileSync(bin, 'utf8');
    if (src.includes('agent-loop guard: git shim')) {
      const m = src.match(/^REAL_GIT='([^']+)'/m);
      if (m && m[1]) return unwrapGit(m[1], depth + 1);
      throw new Error(`git wrapper in ${bin} does not contain a valid REAL_GIT=...`);
    }
  } catch (err) {
    if (err instanceof Error && (err.message.includes('unwrapGit') || err.message.includes('does not contain a valid REAL_GIT'))) throw err;
  }
  return bin;
}

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** git shim: blocks `git push` while AGENT_LOOP=1 unless both the repository and the remote are inside the sandbox root. */
export function writeGitShim({ shimDir, realGit, sandboxRoot, workDir = '', realNode = process.execPath, policyPath = DEFAULT_POLICY_PATH }) {
  if (!realGit || typeof realGit !== 'string' || !path.isAbsolute(realGit)) {
    throw new Error(`writeGitShim: realGit must be a non-empty string with an absolute path (path.isAbsolute): ${realGit}`);
  }
  mkdirSync(shimDir, { recursive: true });
  const file = path.join(shimDir, 'git');
  const actualGit = unwrapGit(realGit);
  if (!actualGit || typeof actualGit !== 'string' || !path.isAbsolute(actualGit)) {
    throw new Error(`writeGitShim: unwrapGit(realGit) must be a non-empty string with an absolute path (path.isAbsolute): ${actualGit}`);
  }
  const workReal = workDir ? (() => { try { return realpathSync(workDir); } catch { return ''; } })() : '';
  writeFileSync(file, `#!/bin/sh
# agent-loop guard: git shim
REAL_GIT=${shQuote(actualGit)}
POLICY_NODE=${shQuote(realNode)}
POLICY=${shQuote(policyPath)}
SANDBOX_ROOT="\${AGENT_LOOP_SANDBOX_ROOT:-${sandboxRoot}}"
WORK_REAL=${shQuote(workReal)}
WORK_DIR=${shQuote(workDir)}
if [ "$AGENT_LOOP" = "1" ]; then
  for a in "$@"; do
    case "$a" in
      --output|--output=*) echo "agent-loop guard: --output is blocked for agents" >&2; exit 97 ;;
      --no-index) echo "agent-loop guard: --no-index is blocked for agents" >&2; exit 97 ;;
      --no-verify) echo "agent-loop guard: --no-verify is blocked for agents" >&2; exit 97 ;;
    esac
  done
  sub=""; dir="."; skip=""; remote=""; branch_args=""
  for a in "$@"; do
    if [ -n "$skip" ]; then
      [ "$skip" = "C" ] && dir="$a"
      skip=""; continue
    fi
    if [ -z "$sub" ]; then
      case "$a" in
        -c|-c*|--config-env|--config-env=*|--git-dir|--git-dir=*|--work-tree|--work-tree=*) echo "agent-loop guard: git configuration/directory override ($a) is blocked for agents" >&2; exit 97 ;;
        -C) skip="C" ;;
        -C*) dir="\${a#-C}"; dir="\${dir#=}" ;;
        --namespace|--exec-path) skip="x" ;;
        -*) ;;
        *) sub="$a" ;;
      esac
    elif [ "$sub" = "commit" ]; then
      case "$a" in
        --no-verify|--no-verify=*) echo "agent-loop guard: --no-verify is blocked for agents" >&2; exit 97 ;;
        -m|-F|-C|-c|--message|--file) skip="m" ;;
        -m?*|-F?*) ;;
        --*) ;;
        -*n*) echo "agent-loop guard: --no-verify (-n) is blocked for agents" >&2; exit 97 ;;
        -[!-]*[mFcC]) skip="m" ;;
      esac
    elif [ "$sub" = "push" ] && [ -z "$remote" ]; then
      case "$a" in -*) ;; *) remote="$a" ;; esac
    elif [ "$sub" = "branch" ]; then
      case "$branch_args:$a" in
        :--show-current|:-a|:-r|:--list) branch_args="$a" ;;
        --list:[!-]*|--list-pat:[!-]*) branch_args="--list-pat" ;;
        *) branch_args="bad" ;;
      esac
    elif [ "$sub" = "grep" ]; then
      case "$a" in
        -O|-O*|--open-files-in-pager|--open-files-in-pager=*) echo "agent-loop guard: git grep $a is blocked for agents" >&2; exit 97 ;;
      esac
    fi
  done
  if [ "$sub" = "checkout" ] || [ "$sub" = "restore" ] || [ "$sub" = "switch" ]; then
    echo "agent-loop guard: git $sub is blocked for agents" >&2; exit 97
  fi
  if [ "$sub" = "branch" ] && { [ -z "$branch_args" ] || [ "$branch_args" = "bad" ]; }; then
    echo "agent-loop guard: git branch is blocked for agents" >&2; exit 97
  fi
  if [ "$sub" = "diff" ] && [ -n "$WORK_REAL" ]; then
    eff_dir=$(cd "$dir" 2>/dev/null && pwd -P)
    case "$eff_dir" in
      "$WORK_REAL"|"$WORK_REAL"/*) ;;
      *)
        echo "agent-loop guard: git diff outside workDir is blocked for agents" >&2
        exit 97
        ;;
    esac
${pathCheckSnippet('git diff', 'eff_dir')}
    for a in "$@"; do
      check_arg "$a"
    done
  fi
  NODE_OPTIONS= NODE_PATH= "$POLICY_NODE" "$POLICY" "$WORK_REAL" "$SANDBOX_ROOT" "$@" </dev/null || exit 97
  if [ "$sub" = "push" ]; then
    [ -n "$remote" ] || remote="origin"
    common=$(cd "$dir" 2>/dev/null && "$REAL_GIT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    url=$(cd "$dir" 2>/dev/null && "$REAL_GIT" remote get-url --push "$remote" 2>/dev/null) || url="$remote"
    url="\${url#file://}"
    repo_real=$(cd "$common" 2>/dev/null && pwd -P)
    remote_real=$(cd "$dir" 2>/dev/null && cd "$url" 2>/dev/null && pwd -P)
    root_real=$(cd "$SANDBOX_ROOT" 2>/dev/null && pwd -P)
    if [ -n "$root_real" ] && [ -n "$repo_real" ] && [ -n "$remote_real" ]; then
      case "$repo_real/" in "$root_real"/*)
        case "$remote_real/" in "$root_real"/*) exec "$REAL_GIT" "$@" ;; esac ;;
      esac
    fi
    echo "agent-loop guard: git push is blocked for agents" >&2
    exit 97
  fi
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(file, 0o755);
  return file;
}
