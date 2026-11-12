// Agent git policy (ADR-065): evaluates `git <args>` against the table in git-policy-rules.mjs.
// Used twice: by the git shim on every agent git call (git-shim.mjs runs this file with the real node) and by
// permissions.mjs commandProblem for permission rule proposals. Imports only node built-ins and
// git-policy-rules.mjs: it runs on every agent git call, so it stays small and fast.
// CONTRACT: signatures, return shapes and the message substrings below are part of the contract.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_SUBCOMMANDS, FORBIDDEN_GLOBAL_LONG, FORBIDDEN_LONG, FORBIDDEN_LONG_ANY, FORBIDDEN_SHORT, LONG_WITH_VALUE,
  PATHSPEC_SUBCOMMANDS, SHORT_WITH_ATTACHED_VALUE, SHORT_WITH_VALUE,
} from './git-policy-rules.mjs';

const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Global options before the subcommand: `{ dirs, sub, rest }` or `{ problem }`. */
function parseGlobals(args) {
  const dirs = [];
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    if (a === '-C') {
      if (i + 1 >= args.length) return { problem: 'git -C needs a directory' };
      dirs.push(args[++i]);
    } else if (a.startsWith('-C')) dirs.push(a.slice(2));
    else if (a.startsWith('--')) {
      const name = a.split('=')[0];
      const hit = name.length > 2 ? FORBIDDEN_GLOBAL_LONG.find((f) => f.startsWith(name)) : undefined;
      if (hit) return { problem: `git global option ${hit} is forbidden` };
    } else if (a.startsWith('-c')) return { problem: 'git -c is forbidden: it overrides configuration' };
  }
  return { dirs, sub: args[i], rest: args.slice(i + 1) };
}

/** Where git runs: `{ effective }` for the project repository, `{ nested: true }` for legacy-rule repositories, or `{ problem }`. */
function resolveScope(dirs, { cwd, workReal, sandboxRoot }) {
  const target = path.resolve(cwd ?? process.cwd(), ...dirs.filter(Boolean));
  let effective;
  try { effective = realpathSync(target); } catch (err) { return { problem: `git directory ${JSON.stringify(target)} does not exist or cannot be resolved (${errText(err)})` }; }
  if (inside(effective, workReal)) {
    for (let d = effective; d !== workReal && d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, '.git'))) return { nested: true };
    return { effective };
  }
  if (sandboxRoot && inside(effective, sandboxRoot)) return { nested: true };
  return { problem: `git directory ${JSON.stringify(effective)} is outside the project` };
}

function pathspecProblem(sub, p, effective, workReal) {
  const bad = (why) => `git ${sub} pathspec ${JSON.stringify(p)} ${why}: name explicit files or directories inside the project`;
  if (p.startsWith(':')) return bad('uses pathspec magic');
  if (p.includes('*')) return bad('uses a wildcard');
  if (workReal) {
    const resolved = path.resolve(effective, p);
    return resolved === workReal || !inside(resolved, workReal) ? bad('is the project root or outside it') : null;
  }
  const n = path.posix.normalize(p);
  const trimmed = n.length > 1 ? n.replace(/\/+$/, '') : n;
  return trimmed === '.' || trimmed === '..' || trimmed.startsWith('../') ? bad('is the project root or outside it') : null;
}

/** Options and pathspecs after the allowed subcommand, in the project repository. */
function optionsProblem(sub, rest, effective, workReal) {
  const forbiddenLong = [...(FORBIDDEN_LONG[sub] ?? []), ...FORBIDDEN_LONG_ANY];
  const longWithValue = LONG_WITH_VALUE[sub] ?? [];
  const forbiddenShort = FORBIDDEN_SHORT[sub] ?? {};
  const attached = SHORT_WITH_ATTACHED_VALUE[sub] ?? '';
  const valued = SHORT_WITH_VALUE[sub] ?? '';
  let onlyPaths = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!onlyPaths && (a === '--' || a === '--end-of-options')) onlyPaths = true;
    else if (!onlyPaths && a.startsWith('--')) {
      const name = a.split('=')[0];
      const hit = forbiddenLong.find((f) => f.startsWith(name));
      if (hit) return `git ${sub} ${hit} is forbidden`;
      if (!a.includes('=') && longWithValue.some((o) => o.startsWith(name))) i++;
    } else if (!onlyPaths && a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const letter = a[k];
        if (Object.hasOwn(forbiddenShort, letter)) return `git ${sub} -${letter} is forbidden (${forbiddenShort[letter]})`;
        if (attached.includes(letter)) break;
        if (valued.includes(letter)) {
          if (k === a.length - 1) i++;
          break;
        }
      }
    } else if (PATHSPEC_SUBCOMMANDS.includes(sub)) {
      const problem = pathspecProblem(sub, a, effective, workReal);
      if (problem) return problem;
    }
  }
  return null;
}

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
  const globals = parseGlobals(args);
  if (globals.problem) return globals.problem;
  const { dirs, sub, rest } = globals;
  if (sub === undefined) return null;
  const workReal = typeof ctx.workReal === 'string' ? ctx.workReal : '';
  let effective = null;
  if (workReal) {
    const scope = resolveScope(dirs, { cwd: ctx.cwd, workReal, sandboxRoot: ctx.sandboxRoot });
    if (scope.problem) return scope.problem;
    if (scope.nested) return null;
    effective = scope.effective;
  }
  if (!ALLOWED_SUBCOMMANDS.includes(sub)) return `git ${JSON.stringify(sub)} is not an allowed subcommand for agents`;
  return optionsProblem(sub, rest, effective, workReal);
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
  let message;
  try {
    if (argv.length < 2) throw new Error('expected <workReal> <sandboxRoot> <git args>');
    const [workReal, sandboxRoot, ...gitArgs] = argv;
    const problem = gitArgsProblem(gitArgs, { cwd, workReal, sandboxRoot });
    if (problem === null) return 0;
    message = problem;
  } catch (err) {
    message = `git policy failed: ${errText(err)}`;
  }
  stderr.write(`agent-loop guard: ${message}\n`);
  return 97;
}

// Run as a program (`node git-policy.mjs ...`, compare realpaths): process.exitCode = runGitPolicyCli(...)
// with process.argv.slice(2), process.cwd() and process.stderr. Importing the module runs nothing.
const entry = process.argv[1];
if (typeof entry === 'string' && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = runGitPolicyCli({ argv: process.argv.slice(2), cwd: process.cwd(), stderr: process.stderr });
}
