// Hard guards that do not depend on the model obeying the rules.
// Layer 1: git/npm shims first in PATH while AGENT_LOOP=1: block `git push` (except sandbox-to-sandbox
//          pushes of test fixtures) and forbidden npm scripts.
// Layer 2: pre-push hook refusing pushes while AGENT_LOOP=1 (catches absolute-path git without --no-verify).
//          Skipped when core.hooksPath points outside .git (e.g. a tracked .husky/): writing there would dirty the tree.
// Layer 3: remote.<name>.pushurl of every remote points nowhere for the duration of the loop (catches everything else).
// Layer 4 (in the project's dangerous CLIs themselves) is outside this module.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PATH_GUARDED_TOOLS, pathCheckSnippet, writePathShims, writeRunnerShims } from './runners.mjs';
import { findExecutable, isGuardShimFile, SHIM_MAX_BYTES, SHIM_HEADER_BYTES } from './events.mjs';

export { SHIM_MAX_BYTES, SHIM_HEADER_BYTES, isGuardShimFile } from './events.mjs';

export const DISABLED_PUSH_URL = '/dev/null/agent-loop-push-disabled';
export const GUARDED_UNTRACKED_FILES = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md', '.mcp.json', '.git/info/exclude'];
const HOOK_MARKER = '# agent-loop guard hook';

export function cleanShimPath(p = process.env.PATH ?? '', candidate = null) {
  return p
    .split(path.delimiter)
    .filter((dir) => {
      try {
        if (isGuardShimFile(path.join(dir, 'git'))) return false;
        if (candidate && isGuardShimFile(path.join(dir, candidate))) return false;
        for (const tool of PATH_GUARDED_TOOLS) {
          if (isGuardShimFile(path.join(dir, tool))) return false;
        }
      } catch { return true; }
      return true;
    })
    .join(path.delimiter);
}

process.env.PATH = cleanShimPath(process.env.PATH);

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

export function which(bin, envPath = process.env.PATH) {
  const p = findExecutable(bin, envPath);
  if (p) return p;
  throw new Error(`binary not found in PATH: ${bin}`);
}

export function whichOptional(bin, envPath = process.env.PATH) {
  return findExecutable(bin, envPath) ?? '';
}

export function defaultSandboxRoot() {
  return realpathSync(os.tmpdir());
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** git shim: blocks `git push` while AGENT_LOOP=1 unless both the repository and the remote are inside the sandbox root. */
export function writeGitShim({ shimDir, realGit, sandboxRoot, workDir = '' }) {
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
        -c|-c*|--config-env|--config-env=*) echo "agent-loop guard: git configuration override ($a) is blocked for agents" >&2; exit 97 ;;
        -C) skip="C" ;;
        --git-dir|--work-tree|--namespace|--exec-path) skip="x" ;;
        -*) ;;
        *) sub="$a" ;;
      esac
    elif [ "$sub" = "commit" ]; then
      case "$a" in
        --no-verify) echo "agent-loop guard: --no-verify is blocked for agents" >&2; exit 97 ;;
        --*) ;;
        -*n*) echo "agent-loop guard: --no-verify (-n) is blocked for agents" >&2; exit 97 ;;
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

/** npm shim: blocks `npm run <script>` (and `npm <script>`) for the listed scripts while AGENT_LOOP=1. */
export function writeNpmShim({ shimDir, realNpm, blockedNpmScripts }) {
  writeRunnerShims({ shimDir, blockedScripts: blockedNpmScripts, realBins: { npm: realNpm } });
  return path.join(shimDir, 'npm');
}

const isInside = (p, dir) => p === dir || p.startsWith(`${dir}${path.sep}`);

/**
 * Installs the pre-push hook; an existing foreign hook is kept and chained.
 * Only inside --git-dir / --git-common-dir: a hooks directory elsewhere (core.hooksPath to a tracked .husky/,
 * a shared directory outside the repository) is left alone, and layers 1 and 3 still block pushes.
 * @returns {{ restore: () => void, skipped: string | null }}
 */
export function installPrePushHook({ workDir, realGit }) {
  const rev = (...args) => path.resolve(workDir, execFileSync(realGit, ['rev-parse', ...args], { cwd: workDir, encoding: 'utf8' }).trim());
  const hooksDir = rev('--git-path', 'hooks');
  if (![rev('--git-dir'), rev('--git-common-dir')].some((d) => isInside(hooksDir, d))) {
    const where = isInside(hooksDir, path.resolve(workDir)) ? path.relative(workDir, hooksDir) : 'outside repository';
    return { restore: () => {}, skipped: `pre-push hook not installed: core.hooksPath (${where}) is outside .git; git wrapper and pushurl block pushes`, hooksDir, hook: null, content: null };
  }
  mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-push');
  const saved = path.join(hooksDir, 'pre-push.agent-loop-saved');
  const hadForeign = existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARKER);
  if (hadForeign) renameSync(hook, saved);
  const content = `#!/bin/sh
${HOOK_MARKER}
if [ "$AGENT_LOOP" = "1" ]; then echo "agent-loop guard: push refused by pre-push hook" >&2; exit 1; fi
if [ -x ${shQuote(saved)} ]; then exec ${shQuote(saved)} "$@"; fi
exit 0
`;
  writeFileSync(hook, content);
  chmodSync(hook, 0o755);
  return {
    restore: () => {
      rmSync(hook, { force: true });
      if (hadForeign) renameSync(saved, hook);
    },
    skipped: null,
    hooksDir,
    hook,
    content,
  };
}

/** Points the pushurl of every remote nowhere (no remotes is fine). Returns a restore function. */
export function disablePushUrls({ workDir, realGit }) {
  const run = (args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8' });
  const saved = [];
  const restore = () => {
    for (const { key, previous } of saved) {
      try {
        run(['config', '--unset-all', key]);
      } catch (err) {
        // Exit 5: the key is already gone (the remote was removed during the loop).
        if (!(err instanceof Error && 'status' in err && err.status === 5)) throw err;
      }
      for (const url of previous) run(['config', '--add', key, url]);
    }
  };
  try {
    for (const name of run(['remote']).split('\n').map((s) => s.trim()).filter(Boolean)) {
      const key = `remote.${name}.pushurl`;
      let previous = [];
      try {
        previous = run(['config', '--get-all', key]).split('\n').filter(Boolean);
      } catch (err) {
        // `git config --get-all` exits 1 when the key is not set; anything else is a real failure.
        if (!(err instanceof Error && 'status' in err && err.status === 1)) throw err;
      }
      run(['config', '--replace-all', key, DISABLED_PUSH_URL]);
      // A leftover from a crashed run is not restored: the key is unset instead.
      saved.push({ key, previous: previous.filter((url) => url !== DISABLED_PUSH_URL) });
    }
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}

/** PID of a live loop holding the lock in the runs directory, or null (no lock or a stale one). */
export function lockHolder(runsDir) {
  const lock = path.join(runsDir, '.lock');
  if (!existsSync(lock)) return null;
  const pid = Number(readFileSync(lock, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // ESRCH: no such process → stale lock from a crashed run; EPERM: the process exists.
    return err instanceof Error && 'code' in err && err.code === 'EPERM' ? pid : null;
  }
}

/** One loop per working tree. The lock lives in the git-ignored runs directory. */
export function acquireLock(runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const lock = path.join(runsDir, '.lock');
  const pid = lockHolder(runsDir);
  if (pid !== null) throw new Error(`loop is already running (PID ${pid}, ${lock})`);
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

/**
 * Installs all in-repo guards. Returns the agent environment, a single restore function
 * and notes for the run log (a skipped layer).
 */
export function installGuards({
  workDir,
  shimDir,
  blockedScripts,
  blockedNpmScripts,
  sandboxRoot = defaultSandboxRoot(),
  realGit = which('git'),
  realNpm = which('npm'),
  realGrep = whichOptional('grep'),
  realLs = whichOptional('ls'),
  realWc = whichOptional('wc'),
  realNode = whichOptional('node') || process.execPath,
}) {
  if (!realGit || typeof realGit !== 'string' || !path.isAbsolute(realGit)) {
    throw new Error(`installGuards: realGit must be a non-empty string with an absolute path (path.isAbsolute): ${realGit}`);
  }
  const effectiveBlocked = blockedScripts ?? blockedNpmScripts ?? [];
  writeGitShim({ shimDir, realGit, sandboxRoot, workDir });
  const realBins = { npm: realNpm, pnpm: whichOptional('pnpm'), yarn: whichOptional('yarn'), bun: whichOptional('bun'), make: whichOptional('make'), just: whichOptional('just'), grep: realGrep, ls: realLs, wc: realWc, node: realNode };
  writeRunnerShims({ shimDir, blockedScripts: effectiveBlocked, realBins });
  const exemptNodeScripts = [realNpm, realBins.pnpm, realBins.yarn].filter((s) => typeof s === 'string' && s.length > 0);
  for (const s of [...exemptNodeScripts]) {
    try { exemptNodeScripts.push(realpathSync(s)); } catch { continue; }
  }
  writePathShims({
    shimDir,
    workDir,
    realBins,
    exemptNodeScripts: [...new Set(exemptNodeScripts)],
  });
  const hook = installPrePushHook({ workDir, realGit });
  let restorePushUrls;
  try {
    restorePushUrls = disablePushUrls({ workDir, realGit });
  } catch (err) {
    hook.restore();
    throw err;
  }
  const env = { ...process.env, AGENT_LOOP: '1', PATH: `${shimDir}${path.delimiter}${cleanShimPath(process.env.PATH)}` };
  const backupDir = path.dirname(shimDir);
  const fileSnapshot = GUARDED_UNTRACKED_FILES.map((rel) => {
    const file = path.join(workDir, rel);
    const exists = existsSync(file);
    return { rel, file, exists, content: exists ? readFileSync(file, 'utf8') : null };
  });
  const verify = () => verifyGuards({ workDir, realGit, hook, fileSnapshot, backupDir });
  const restore = () => {
    // Both restores run even if the first one fails; the first error is rethrown.
    const errors = [];
    for (const fn of [restorePushUrls, hook.restore]) {
      try { fn(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw errors[0];
  };
  return { realGit, realNpm, env, restore, verify, notes: hook.skipped ? [hook.skipped] : [] };
}

/**
 * After every agent run: did anything undo the guards? An agent may write files in the project, so it could
 * edit .git/config or the hook directly. Every remote (including new ones) must still push nowhere,
 * core.hooksPath must not move, and the installed hook must be byte for byte the same.
 * @returns {string[]} problems; empty when the guards are intact
 */
export function verifyGuards({ workDir, realGit, hook, fileSnapshot = [], backupDir = null }) {
  const run = (args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } });
  const problems = [];
  for (const name of run(['remote']).split('\n').map((s) => s.trim()).filter(Boolean)) {
    let urls = [];
    try {
      urls = run(['config', '--get-all', `remote.${name}.pushurl`]).split('\n').filter(Boolean);
    } catch (err) {
      // Exit 1: no pushurl at all — reported below as a problem, not a crash.
      if (!(err instanceof Error && 'status' in err && err.status === 1)) throw err;
    }
    if (urls.length !== 1 || urls[0] !== DISABLED_PUSH_URL) problems.push(`pushurl of remote "${name}" was modified`);
  }
  const hooksDir = path.resolve(workDir, run(['rev-parse', '--git-path', 'hooks']).trim());
  if (hooksDir !== hook.hooksDir) problems.push('core.hooksPath was modified');
  if (hook.hook && (!existsSync(hook.hook) || readFileSync(hook.hook, 'utf8') !== hook.content)) problems.push('pre-push hook was modified or removed');
  for (const item of fileSnapshot) {
    const nowExists = existsSync(item.file);
    const nowContent = nowExists ? readFileSync(item.file, 'utf8') : null;
    let mismatch = null;
    if (!item.exists && nowExists) {
      mismatch = `settings file ${item.rel} was created during the turn`;
    } else if (item.exists && !nowExists) {
      mismatch = `settings file ${item.rel} was removed during the turn`;
    } else if (item.exists && nowExists && nowContent !== item.content) {
      mismatch = `settings file ${item.rel} was modified during the turn`;
    }
    if (mismatch) {
      problems.push(mismatch);
      if (backupDir) {
        mkdirSync(backupDir, { recursive: true });
        const safeName = item.rel.replace(/\//g, '__');
        if (item.exists) writeFileSync(path.join(backupDir, `${safeName}.before`), item.content);
        if (nowExists) writeFileSync(path.join(backupDir, `${safeName}.after`), nowContent);
      }
    }
  }
  return problems;
}
