// Agent git policy (ADR-065): evaluates `git <args>` against the table in git-policy-rules.mjs.
// Used twice: by the git shim on every agent git call (git-shim.mjs runs this file with the real node) and by
// permissions.mjs commandProblem for permission rule proposals. Imports only node built-ins and
// git-policy-rules.mjs: it runs on every agent git call, so it stays small and fast.
// CONTRACT: signatures, return shapes and the message substrings below are part of the contract.

/**
 * Why `git <args>` is blocked for an agent, or null when it may run.
 *
 * 1. Global options (before the subcommand), left to right:
 *    - `-C <dir>` and `-C<dir>`: cumulative like git (each relative dir resolves against the previous one;
 *      an empty dir is ignored); `-C` without a value → blocked;
 *    - `-c`, `-c<x>` and FORBIDDEN_GLOBAL_LONG by full name or any prefix of it (`--git-d=/x`), with or without
 *      `=value` → blocked, message contains the matched forbidden name (`-c` for `-c` / `-c<x>`);
 *    - any other argument starting with `-` is skipped; the first one that does not is the subcommand.
 *    No subcommand (`git`, `git --version`) → null.
 * 2. Scope, only when ctx.workReal is a non-empty string (the git shim); without it (rule proposals) the
 *    project rules apply and there are no directory checks:
 *    - E = realpath(resolve(ctx.cwd ?? process.cwd(), ...all -C dirs)); realpath fails → blocked,
 *      message contains `does not exist`;
 *    - E is ctx.workReal or inside it: if some directory D with E inside-or-equal D and D strictly inside
 *      ctx.workReal contains `.git` (file or directory) → nested repository → null; otherwise project scope;
 *    - otherwise E is ctx.sandboxRoot or inside it (when ctx.sandboxRoot is non-empty) → null;
 *    - otherwise → blocked, message contains `outside the project`.
 * 3. Project scope:
 *    - subcommand not in ALLOWED_SUBCOMMANDS → blocked, message contains `not an allowed subcommand`;
 *    - each argument after the subcommand; after `--` or `--end-of-options` every argument is a pathspec:
 *      - `--name[=value]`: the first option, in FORBIDDEN_LONG[sub] and then FORBIDDEN_LONG_ANY (table order),
 *        that starts with `--name` → blocked, message contains it; else, without `=`, `--name` is a prefix of an
 *        option in LONG_WITH_VALUE[sub] → the next argument is its value (skipped);
 *      - `-xyz` (a short cluster): letters left to right; a letter in FORBIDDEN_SHORT[sub] → blocked,
 *        message contains its long option; a letter in SHORT_WITH_ATTACHED_VALUE[sub] → the rest of the
 *        cluster is its value; a letter in SHORT_WITH_VALUE[sub] → the rest of the cluster is its value or,
 *        when the letter ends the cluster, the next argument is (skipped);
 *      - any other argument, for sub in PATHSPEC_SUBCOMMANDS, is a pathspec (see below).
 *    - pathspec → blocked (message contains `pathspec`) when it starts with `:`, contains `*`, or:
 *      with ctx.workReal — path.resolve(E, p) is ctx.workReal or outside it;
 *      without — path.posix.normalize(p) without trailing `/` is `.` or `..` or starts with `../`.
 *    Nothing blocked → null.
 * Messages are English, one line, start with `git` and never with `agent-loop guard:` (the CLI adds it).
 * Inside(a, b): a === b or a starts with b + path.sep.
 *
 * @param {string[]} args argv after `git`, as the program receives it (no shell parsing)
 * @param {{ cwd?: string, workReal?: string, sandboxRoot?: string }} [ctx]
 * @returns {string | null}
 */
export function gitArgsProblem(args, ctx = {}) {
  throw new Error('Not implemented');
}

/**
 * Shim entry. argv = [workReal, sandboxRoot, ...gitArgs] (workReal / sandboxRoot may be '').
 * Calls gitArgsProblem(gitArgs, { cwd, workReal, sandboxRoot }).
 * - allowed → returns 0, writes nothing;
 * - blocked → writes `agent-loop guard: <problem>\n` to stderr, returns 97;
 * - argv shorter than 2, or gitArgsProblem throws → writes `agent-loop guard: git policy failed: <message>\n`,
 *   returns 97 (fail-closed).
 * Never writes to stdout.
 * @param {{ argv: string[], cwd: string, stderr: { write(s: string): unknown } }} io
 * @returns {number} exit code
 */
export function runGitPolicyCli({ argv, cwd, stderr }) {
  throw new Error('Not implemented');
}

// Run as a program (`node git-policy.mjs ...`, compare realpaths): process.exitCode = runGitPolicyCli(...)
// with process.argv.slice(2), process.cwd() and process.stderr. Importing the module runs nothing.
