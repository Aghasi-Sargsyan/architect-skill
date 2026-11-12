// Git policy table for agents (AGENT_LOOP=1, ADR-065): the single source of git rules for the git shim
// (git-shim.mjs → git-policy.mjs) and for permission rule proposals (permissions.mjs commandProblem).
// Architect-owned contract: data only, no logic. The evaluator is gitArgsProblem in git-policy.mjs.
//
// Scope: the rules protect the project repository. A nested repository inside the project and any repository
// under the sandbox root (os.tmpdir()) keep only the legacy shim rules: test suites of target projects create
// throwaway repositories there. Everything else outside the project is blocked.

/**
 * Global options (before the subcommand) that redirect git's configuration, repository or executables.
 * Blocked by full name and by any prefix of the name, with or without `=value`. `-c` / `-c<x>` are blocked as well.
 */
export const FORBIDDEN_GLOBAL_LONG = ['--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'];

/**
 * Subcommands an agent may run in the project repository. Anything else — including aliases and external
 * `git-<name>` commands — is blocked. The legacy shim rules still apply on top (branch read-only, push sandbox only).
 */
export const ALLOWED_SUBCOMMANDS = [
  'status', 'diff', 'log', 'show', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'blame', 'merge-base',
  'describe', 'shortlog', 'check-ignore', 'check-attr', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev',
  'diff-tree', 'diff-files', 'diff-index', 'whatchanged', 'range-diff', 'show-branch', 'version', 'help',
  'add', 'commit', 'rm', 'mv', 'stash', 'tag', 'branch', 'push',
];

/** Long options blocked after any subcommand: by full name and by every prefix (git accepts unambiguous abbreviations). */
export const FORBIDDEN_LONG_ANY = ['--no-verify', '--output', '--no-index', '--exec', '--upload-pack', '--receive-pack'];

/** Per-subcommand long options blocked by full name and by every prefix. `commit -a` / `--all` stay allowed: they stage tracked files only (the F-03 test commits with `-am`). */
export const FORBIDDEN_LONG = {
  commit: ['--amend', '--pathspec-from-file'],
  add: ['--all', '--update', '--no-ignore-removal', '--force', '--renormalize', '--pathspec-from-file'],
  rm: ['--pathspec-from-file'],
  grep: ['--open-files-in-pager'],
};

/** Per-subcommand short option letters blocked anywhere in a cluster (`-qn`, `-Av`), mapped to the long option they stand for. */
export const FORBIDDEN_SHORT = {
  commit: { n: '--no-verify' },
  add: { A: '--all', u: '--update', f: '--force' },
  grep: { O: '--open-files-in-pager' },
};

/** Short options taking a value: the rest of the cluster is the value or, when the letter ends the cluster, the next argument. */
export const SHORT_WITH_VALUE = {
  commit: 'mFCct',
  grep: 'efABCm',
};

/** Short options with an optional value that can only be attached (`-S<keyid>`, `-uno`): the rest of the cluster is the value. */
export const SHORT_WITH_ATTACHED_VALUE = {
  commit: 'Su',
};

/**
 * Long options whose value may be the next argument (`--message <msg>`). An argument without `=` that is
 * this name or a prefix of it consumes the next argument as its value (after the forbidden-option checks).
 */
export const LONG_WITH_VALUE = {
  commit: ['--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer'],
  grep: ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--threads', '--max-depth'],
};

/**
 * Subcommands whose pathspecs must name explicit files or directories inside the project: no pathspec magic
 * (`:/`, `:(top)`, `:!x`), no `*` wildcard, and nothing that resolves to the project root (`.`, `./`, `..` from a
 * subdirectory) or outside it.
 */
export const PATHSPEC_SUBCOMMANDS = ['add', 'commit', 'rm'];
