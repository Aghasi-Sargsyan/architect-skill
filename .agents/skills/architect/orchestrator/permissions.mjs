// Which commands and files the agents may use without a prompt, and the Antigravity settings file.
// Rule kinds: command(<binary_and_subcommand>), read_file(<abs>), write_file(<abs>), mcp(<tool>).
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedRunnerCommands } from './runners.mjs';
import { skillFilePath } from './layout.mjs';

export const AGY_SETTINGS_SHOWN = '~/.gemini/antigravity-cli/settings.json';
export const agySettingsPath = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');

/** Safe base set: read-only git, local commits, verification commands and read-only listings. */
export const BASE_COMMANDS = [
  'git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git branch --show-current', 'git ls-files', 'git grep', 'git blame', 'git ls-tree', 'git merge-base', 'git rev-list', 'git describe', 'git shortlog', 'git stash list', 'git tag -l', 'git branch -a', 'git branch -r', 'git branch --list', 'git check-ignore', 'git add', 'git commit', 'node --test', 'node --version', 'npm ls', 'wc -l', 'grep', 'ls', 'pwd', 'which',
];

const TOO_BROAD = new Set([
  'git', 'npm', 'npm run', 'npm run-script', 'npx', 'node', 'sh', 'bash', 'zsh', 'env', 'xargs', 'pnpm', 'pnpm run', 'yarn', 'yarn run', 'bun', 'bun run', 'make', 'just',
]);
export const WRAPPERS = new Set(['time', 'timeout', 'nice', 'nohup', 'caffeinate', 'stdbuf', 'command', 'builtin', 'arch']);
export const FILE_BINARIES = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'perl', 'python', 'python3', 'tee', 'find', 'touch', 'mkdir', 'cp', 'mv', 'shasum', 'sha256sum', 'md5']);
const DENIED_BINARIES = new Set([
  'sh', 'bash', 'zsh', 'env', 'xargs', 'sudo', 'su', 'eval', 'exec', 'rm', 'rmdir', 'chmod', 'chown', 'ln', 'dd', 'kill', 'pkill', 'killall', 'curl', 'wget', 'ssh', 'scp', 'nc', 'open', 'osascript',
  ...WRAPPERS, ...FILE_BINARIES,
]);
const SHELL_OPERATORS_RE = /&&|\||;|>|<|\$\(|`/;
const RULE_RE = /^([a-z_]+)\((.*)\)$/;

const words = (cmd) => String(cmd).trim().split(/\s+/).filter(Boolean);
const startsWithWords = (cmd, prefix) => {
  const a = words(cmd);
  const b = words(prefix);
  return b.length > 0 && b.length <= a.length && b.every((w, i) => w === a[i]);
};
export const normalizeCommand = (cmd) => words(cmd).join(' ');
export const binName = (p) => path.posix.basename(String(p).replaceAll('\\', '/'));

/** Strips leading command wrappers (e.g. time, nice -n 5, timeout 10, stdbuf -o0, arch -arm64) and their flags. */
export function unwrapTokens(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const base = binName(tokens[i]);
    if (!WRAPPERS.has(base)) break;
    i++;
    const skipFlag = (f) => { while (i < tokens.length && tokens[i].startsWith('-')) i += (tokens[i] === f && i + 1 < tokens.length) ? 2 : 1; };
    if (base === 'timeout') {
      while (i < tokens.length && tokens[i].startsWith('-')) i += (['-s', '-k', '--signal', '--kill-after'].includes(tokens[i]) && i + 1 < tokens.length) ? 2 : 1;
      if (i < tokens.length && /^\d+(\.\d+)?[smhd]?$/i.test(tokens[i])) i++;
    } else if (base === 'nice') skipFlag('-n');
    else if (base === 'arch') skipFlag('-arch');
    else if (base === 'stdbuf') { while (i < tokens.length && tokens[i].startsWith('-')) i += (['-i', '-o', '-e'].includes(tokens[i]) && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) ? 2 : 1; }
    else if (base === 'caffeinate') { while (i < tokens.length && tokens[i].startsWith('-')) i += (['-t', '-w'].includes(tokens[i]) && i + 1 < tokens.length) ? 2 : 1; }
    else { while (i < tokens.length && tokens[i].startsWith('-')) i++; }
  }
  return tokens.slice(i);
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveSkillDir({ skillDir, skillFilePath: sfp, workDir }) {
  if (skillDir) return realOrResolved(path.resolve(workDir, skillDir));
  const file = sfp ? path.resolve(workDir, sfp) : path.resolve(workDir, skillFilePath(workDir, here));
  return realOrResolved(path.dirname(file));
}

/** Real path of an existing path; a missing one resolves ancestors and symlinks. */
export function realOrResolved(p) {
  const abs = path.resolve(p);
  try { return realpathSync(abs); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const link = readlinkSync(abs);
      return realOrResolved(path.isAbsolute(link) ? link : path.resolve(path.dirname(abs), link));
    }
  } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  const resolvedParent = realOrResolved(parent);
  return resolvedParent === parent ? abs : realOrResolved(path.join(resolvedParent, path.basename(abs)));
}
export const isInside = (p, dir) => dir === path.parse(dir).root || p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);

export function forbiddenCommands(blockedScripts = []) {
  return ['git push', 'git reset', 'git clean', 'git config', 'git remote', ...blockedRunnerCommands(blockedScripts)];
}

const LEADING_FLAG_RUNNERS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'make', 'just']);

/** Why allowing `command(<command>)` is unsafe, or null. */
export function commandProblem(command, blockedScripts = []) {
  const c = normalizeCommand(command);
  if (!c) return 'empty command';
  if (SHELL_OPERATORS_RE.test(c)) return 'contains shell operators (; && || | > < ` $()) — only simple commands are allowed';
  const rawWords = words(c);
  const rawFirst = rawWords[0] ?? '';
  const unwrappedTokens = unwrapTokens(rawWords);
  if (unwrappedTokens.length === 0) return `command wrapper "${rawFirst}" is not allowed`;
  const unwrappedBin = binName(unwrappedTokens[0]);
  const unwrappedStr = [unwrappedBin, ...unwrappedTokens.slice(1)].join(' ');
  const unwrappedSecond = unwrappedTokens[1] ?? '';
  if (TOO_BROAD.has(c) || TOO_BROAD.has(unwrappedStr)) return `rule is too broad: allows any command "${c} ..."`;
  const isPython = unwrappedBin === 'python' || unwrappedBin === 'python3';
  const isPythonTestRunner = isPython && unwrappedSecond === '-m' && (unwrappedTokens[2] === 'pytest' || unwrappedTokens[2] === 'unittest');
  if ((isPython || FILE_BINARIES.has(unwrappedBin)) && !isPythonTestRunner) return `"${unwrappedBin}" is forbidden in the terminal: use built-in file tools for reading and modifying files`;
  const hit = forbiddenCommands(blockedScripts).find((f) => startsWithWords(f, c) || startsWithWords(c, f) || startsWithWords(f, unwrappedStr) || startsWithWords(unwrappedStr, f));
  if (hit) return `covers forbidden command "${hit}"`;
  if (DENIED_BINARIES.has(unwrappedBin) && !isPythonTestRunner) return `"${unwrappedBin}" is forbidden for agents with any arguments`;
  if (unwrappedBin === 'git') {
    const rest = unwrappedTokens.slice(2);
    if (unwrappedTokens.some((t) => t === '--no-verify' || t.startsWith('--no-verify='))) return 'git with --no-verify is forbidden';
    if (unwrappedSecond === 'commit' && rest.some((t) => t.startsWith('-') && !t.startsWith('--') && t.includes('n'))) return 'git commit with -n is forbidden (--no-verify)';
    if (unwrappedTokens.some((t) => t === '--output' || t.startsWith('--output='))) return 'git with --output argument is forbidden: use built-in tools to output to a file';
    if (unwrappedSecond === 'grep' && rest.some((t) => t.startsWith('-O') || t === '--open-files-in-pager' || t.startsWith('--open-files-in-pager='))) return 'git grep with -O / --open-files-in-pager is forbidden';
    const okBranch = (rest.length === 1 && (rest[0] === '--show-current' || rest[0] === '-a' || rest[0] === '-r')) || (rest[0] === '--list' && rest.slice(1).every((t) => !t.startsWith('-')));
    if (unwrappedSecond === 'branch' && !okBranch) return 'git branch is allowed only for reading (--show-current / -a / -r / --list)';
    if (unwrappedSecond === 'add' && rest.some((t) => t === '.' || t === '-A' || t === '-u' || t === '--all')) return 'forbidden git add without explicit file paths (git add . / -A / -u)';
    if (unwrappedSecond === 'tag' && ((rest[0] !== '-l' && rest[0] !== '--list') || rest.slice(1).some((t) => t.startsWith('-')))) return 'git tag is allowed only for reading (-l / --list)';
  }
  if (unwrappedBin === 'node' && unwrappedSecond !== '--test' && !((unwrappedSecond === '--version' || unwrappedSecond === '-v') && unwrappedTokens.length === 2)) return 'node executes arbitrary code; only node --test and node --version are allowed';
  if (unwrappedBin === 'npx') {
    if (unwrappedSecond === 'tsx' || unwrappedSecond === 'ts-node') return `npx ${unwrappedSecond} executes arbitrary scripts (including release)`;
    if (unwrappedSecond === 'grep' || unwrappedSecond === 'ls') return `npx ${unwrappedSecond} is not allowed: run ${unwrappedSecond} directly`;
    if (!STANDALONE_TOOLS.has(unwrappedSecond)) return 'arbitrary script execution via npx is not allowed for agents (use npm test / npx tsc / npx vitest)';
  }
  if (LEADING_FLAG_RUNNERS.has(unwrappedBin) && unwrappedSecond.startsWith('-')) return `rule is too broad: leading flag "${unwrappedSecond}" before ${unwrappedBin} subcommand`;
  if (rawFirst.includes('/')) return `calling by path ("${rawFirst}") is forbidden: use command from PATH`;
  if (WRAPPERS.has(binName(rawFirst))) return `command wrapper "${rawFirst}" is not allowed`;
  return null;
}

export const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'make', 'just', 'cargo', 'go', 'uv', 'poetry', 'pipenv', 'dotnet', 'composer', 'bundle', 'mix', 'gradle', 'mvn']);
export const STANDALONE_TOOLS = new Set(['pytest', 'ruff', 'mypy', 'flake8', 'black', 'isort', 'pyright', 'eslint', 'prettier', 'tsc', 'vitest', 'jest', 'playwright', 'golangci-lint', 'clippy', 'ls', 'grep']);

export function suggestAllowedCommand(command, blockedScripts = [], optsOrWorkDir = {}) {
  const workDir = typeof optsOrWorkDir === 'string' ? optsOrWorkDir : (optsOrWorkDir?.workDir ?? null);
  if (!workDir) return null;
  const unwrapped = unwrapTokens(words(normalizeCommand(command)));
  if (!unwrapped.length) return null;
  const bin = binName(unwrapped[0]);
  if (!LEADING_FLAG_RUNNERS.has(bin)) return null;

  const realWork = realOrResolved(workDir);
  const realGitDir = realOrResolved(path.join(workDir, '.git'));
  let i = 1;
  let strippedAny = false;

  while (i < unwrapped.length && unwrapped[i].startsWith('-')) {
    const tok = unwrapped[i];
    let target = null;
    let isGitDir = false;
    if (tok === '-C') {
      if (i + 1 >= unwrapped.length) return null;
      target = unwrapped[++i];
    } else if (tok.startsWith('-C')) {
      target = tok.startsWith('-C=') ? tok.slice(3) : tok.slice(2);
    } else if (['--prefix', '--cwd', '--dir', '--work-tree', '--git-dir'].includes(tok)) {
      if (i + 1 >= unwrapped.length) return null;
      target = unwrapped[++i];
      if (tok === '--git-dir') isGitDir = true;
    } else {
      const match = tok.match(/^(--prefix|--cwd|--dir|--work-tree|--git-dir)=(.*)$/);
      if (!match) return null;
      target = match[2];
      if (match[1] === '--git-dir') isGitDir = true;
    }
    if (!target) return null;
    const resolved = realOrResolved(path.resolve(workDir, target));
    if (isGitDir ? (resolved !== realGitDir && resolved !== realWork) : resolved !== realWork) return null;
    strippedAny = true;
    i++;
  }
  if (!strippedAny || i >= unwrapped.length) return null;
  const candidate = [bin, ...unwrapped.slice(i)].join(' ');
  return commandProblem(candidate, blockedScripts) === null ? candidate : null;
}

/** Proposes safe rules for a denied command: [1] prefix rule, [2] exact command; or auto refusal. */
export function proposeRules(command, blockedScripts = [], optsOrWorkDir = null) {
  const full = normalizeCommand(command);
  const w = words(full);
  const problem = commandProblem(full, blockedScripts);
  if (problem) {
    const unwrapped = unwrapTokens(w);
    const unwrappedBin = binName(unwrapped[0] ?? w[0] ?? '');
    const unwrappedSecond = unwrapped[1] ?? '';
    let reason = problem;
    let suggestedCommand = null;
    if (LEADING_FLAG_RUNNERS.has(unwrappedBin) && unwrappedSecond.startsWith('-')) {
      reason = `leading flag "${unwrappedSecond}" before ${unwrappedBin} subcommand is not allowed: the subcommand must immediately follow ${unwrappedBin}`;
      suggestedCommand = suggestAllowedCommand(full, blockedScripts, optsOrWorkDir);
    } else if (unwrappedBin === 'npx' && (unwrappedSecond === 'grep' || unwrappedSecond === 'ls')) {
      suggestedCommand = unwrapped.slice(1).join(' ');
    }
    return { auto: true, reason, fileTool: FILE_BINARIES.has(unwrappedBin), ...(suggestedCommand !== null ? { suggestedCommand } : {}) };
  }

  if (w[0] === 'npm' && w[1] === 'list') return { auto: true, reason: 'use "npm ls" instead of "npm list"', fileTool: false, suggestedCommand: ['npm', 'ls', ...w.slice(2)].join(' ') };

  let p = null;
  const [b0 = '', b1 = '', b2 = ''] = w;

  if (SUBCOMMAND_TOOLS.has(b0)) {
    if (b1 && !b1.startsWith('-')) {
      const isRun = b1 === 'run' || b1 === 'run-script';
      const isPkg = (b0 === 'npm' || b0 === 'pnpm' || b0 === 'yarn' || b0 === 'bun') && isRun;
      const isPy = (b0 === 'uv' || b0 === 'poetry' || b0 === 'pipenv') && b1 === 'run';
      p = ((isPkg || isPy) && b2 && !b2.startsWith('-')) ? `${b0} ${b1} ${b2}` : `${b0} ${b1}`;
    }
  } else if (b0 === 'node' && b1 === '--test') p = 'node --test';
  else if ((b0 === 'python' || b0 === 'python3') && b1 === '-m' && (b2 === 'pytest' || b2 === 'unittest')) p = `${b0} -m ${b2}`;
  else if (b0 === 'wc' && b1 === '-l') p = 'wc -l';
  else if (STANDALONE_TOOLS.has(b0)) p = b0;

  const allowList = optsOrWorkDir?.allow;
  if (Array.isArray(allowList) && allowList.length > 0) {
    const allowSet = new Set(allowList.map((r) => normalizeCommand(String(r).replace(/^command\((.*)\)$|^Bash\((.*?)(?::\*)?\)$/, '$1$2'))));
    const existing = (p && allowSet.has(p)) ? p : (allowSet.has(full) ? full : null);
    if (existing) return { auto: true, reason: `rule "command(${existing})" is already in allowlist, but runner rejected this command form (avoid unquoted globs like *.css or pass a directory path)`, fileTool: false };
  }

  const options = [], choices = [];
  if (p && p !== full && !commandProblem(p, blockedScripts)) {
    options.push({ answer: '1', rule: p });
    choices.push({ key: '1', rule: p, label: `Allow prefix for command family: command(${p})` });
  }
  options.push({ answer: '2', rule: full });
  choices.push({ key: '2', rule: full, label: `Allow this exact command: command(${full})` }, { key: '3', rule: null, label: 'Do not allow (stop / escalate)' });
  return Object.defineProperty({ auto: false, options }, 'choices', { value: choices, enumerable: false, writable: true, configurable: true });
}

/** Validates allow rules against project boundaries and sensitive directories. */
export function ruleProblem(rule, { blockedScripts, blockedNpmScripts, workDir, home, deny = [], skillDir, skillFilePath }) {
  const blocked = blockedScripts ?? blockedNpmScripts ?? [];
  const m = String(rule).match(RULE_RE);
  if (!m) return null;
  const [, kind, target] = m;
  if (target.trim() === '*') return `"${kind}(*)" allows everything`;
  if (kind === 'command') return commandProblem(target, blocked);
  if (kind !== 'read_file' && kind !== 'write_file') return null;
  if (!path.isAbsolute(target)) return 'path is not absolute';
  const t = realOrResolved(target);
  const realHome = realOrResolved(home);
  const realWork = realOrResolved(workDir);
  if (isInside(realHome, t)) return 'home directory or above';
  if (t !== realWork && isInside(realWork, t)) return 'parent directory of the project';
  if (kind === 'read_file') {
    const resolvedSkill = resolveSkillDir({ skillDir, skillFilePath, workDir: realWork });
    if (!isInside(t, realWork) && !isInside(t, resolvedSkill)) return 'reading outside project and skill directory is forbidden';
    return null;
  }
  for (const h of ['.gemini', '.claude']) if (isInside(t, path.join(realHome, h))) return `writing to ~/${h} — agent could modify its permissions`;
  for (const d of ['.git', '.claude']) {
    const p = path.join(realWork, d);
    if (isInside(t, p)) return `writing to project ${d}`;
    if (isInside(p, t) && !deny.includes(`write_file(${p})`)) return `covers project ${d}, but deny write_file(<workDir>/${d}) is missing`;
  }
  if (!isInside(t, realWork)) return 'outside the current project — remove other project rule or run project loops one at a time';
  return null;
}

/** Base set minus anything the project blocks, plus the project's own allowedCommands (validated in config.mjs). */
export function allowedCommandsFor(config) {
  const blocked = config.blockedScripts ?? config.blockedNpmScripts ?? [];
  return [...new Set([...BASE_COMMANDS.filter((c) => !commandProblem(c, blocked)), ...config.allowedCommands.map(normalizeCommand)])];
}

export const toRules = (commands) => commands.map((c) => `command(${normalizeCommand(c)})`);

/** Every rule the loop needs in this project. `workDir` must be a real path. */
export function rulesFor(config, workDir) {
  return {
    allow: [...toRules(allowedCommandsFor(config)), `write_file(${workDir})`],
    deny: [`write_file(${path.join(workDir, '.git')})`, `write_file(${path.join(workDir, '.claude')})`],
  };
}

/** The block a person pastes into the settings file (or lets --write-permissions merge). */
export function allowlistBlock({ allow, deny }) {
  return JSON.stringify({ permissions: { allow, deny } }, null, 2);
}

/** Replaces the project path with <workDir> and the home directory with ~ for console output. */
export function maskPaths(text, { workDir, home }) {
  return String(text).split(workDir).join('<workDir>').split(home).join('~');
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Reads the allow and deny rules from the settings file. Never returns other fields of the file. */
export function readAgyRules(settingsPath) {
  const none = { exists: existsSync(settingsPath), allow: [], deny: [], error: null };
  if (!none.exists) return none;
  let json;
  try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (err) { return { ...none, error: `not JSON (${errText(err)})` }; }
  const perms = isObject(json) && isObject(json.permissions) ? json.permissions : {};
  for (const key of ['allow', 'deny']) if (perms[key] !== undefined && !Array.isArray(perms[key])) return { ...none, error: `permissions.${key} is not an array` };
  const strings = (v) => (v ?? []).filter((r) => typeof r === 'string');
  return { ...none, allow: strings(perms.allow), deny: strings(perms.deny) };
}

/** Unsafe allow rules, each with the reason. */
export const unsafeRules = (allow, ctx) => allow.flatMap((rule) => {
  const problem = ruleProblem(rule, ctx);
  return problem ? [`${rule} — ${problem}`] : [];
});

/** Merges rules into settings.json keeping existing entries; backs up existing file. */
export function writeAgyAllowlist({ settingsPath, allow, deny = [] }) {
  const existed = existsSync(settingsPath);
  let json = {};
  if (existed) {
    try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (err) { throw new Error(`${AGY_SETTINGS_SHOWN} is not JSON, file unchanged (${errText(err)})`); }
    if (!isObject(json)) throw new Error(`${AGY_SETTINGS_SHOWN} is not a JSON object, file unchanged`);
  }
  if (json.permissions === undefined) json.permissions = {};
  if (!isObject(json.permissions)) throw new Error(`${AGY_SETTINGS_SHOWN}: permissions is not an object, file unchanged`);
  for (const key of ['allow', 'deny']) {
    if (json.permissions[key] !== undefined && !Array.isArray(json.permissions[key])) throw new Error(`${AGY_SETTINGS_SHOWN}: permissions.${key} is not an array, file unchanged`);
  }
  const merge = (key, rules) => {
    const current = json.permissions[key] ?? [];
    const added = rules.filter((r) => !current.includes(r));
    if (added.length) json.permissions[key] = [...current, ...added];
    return added;
  };
  const addedAllow = merge('allow', allow);
  const addedDeny = merge('deny', deny);
  if (!addedAllow.length && !addedDeny.length) return { addedAllow, addedDeny, backup: false };
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const mode = existed ? statSync(settingsPath).mode & 0o777 : 0o600;
  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  const tmp = `${settingsPath}.agent-loop-tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode });
  renameSync(tmp, settingsPath);
  return { addedAllow, addedDeny, backup: existed };
}

/** Checks that write_file rule exists for project and deny exists for .git. */
export function checkProjectWriteRule(workDir, settingsPath = agySettingsPath()) {
  if (!existsSync(settingsPath)) return { ok: false, issue: 'settings.json not found' };
  let json;
  try { json = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (err) { return { ok: false, issue: `invalid JSON in settings.json: ${errText(err)}` }; }
  const perms = isObject(json) && isObject(json.permissions) ? json.permissions : {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  const deny = Array.isArray(perms.deny) ? perms.deny : [];
  const realWork = realOrResolved(workDir);
  const writeRule = `write_file(${realWork})`;
  if (!allow.includes(writeRule)) return { ok: false, issue: `missing write_file rule for project (${realWork}) — execute: npm run agents -- --write-permissions` };
  const gitPath = path.join(realWork, '.git');
  if (!deny.includes(`write_file(${gitPath})`) && !deny.includes(`write_file(${gitPath}/**)`)) {
    return { ok: false, issue: `missing deny rule write_file(${gitPath}/**) — execute: npm run agents -- --write-permissions` };
  }
  return { ok: true, issue: null };
}

/** Checks project permissions against settings.json. */
export function checkPermissions(config, workDir, home = os.homedir()) {
  const settingsPath = agySettingsPath(home);
  const issues = [];
  const realWork = realOrResolved(workDir);
  const ctx = { blockedNpmScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], blockedScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], workDir: realWork, home: realOrResolved(home), deny: [] };
  const { exists, allow, deny, error } = readAgyRules(settingsPath);
  if (!exists) return { ok: false, issues: ['settings.json not found'], warnings: [] };
  if (error) return { ok: false, issues: [`invalid JSON in settings.json: ${error}`], warnings: [] };
  ctx.deny = deny;
  const writeRes = checkProjectWriteRule(workDir, settingsPath);
  if (!writeRes.ok) issues.push(writeRes.issue);
  for (const u of unsafeRules(allow, ctx)) issues.push(`contains unsafe rule in allow: ${maskPaths(u, ctx)}`);
  const wanted = rulesFor(config, realWork);
  const missing = [...wanted.allow.filter((r) => !allow.includes(r)), ...wanted.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`)];
  if (missing.length) issues.push(`missing required rules in settings.json (${missing.length}): ${missing.join(', ')}`);
  return { ok: issues.length === 0, issues, warnings: [] };
}

/** Static check of settings file: validates required and unsafe rules. */
export function permissionsCheck({ config, settingsPath, workDir, home = os.homedir(), skillDir = null, skillFilePath = null }) {
  const name = 'allowlist Antigravity';
  const blocked = config.blockedScripts ?? config.blockedNpmScripts ?? [];
  const ctx = { blockedNpmScripts: blocked, blockedScripts: blocked, workDir: realOrResolved(workDir), home: realOrResolved(home), deny: [], skillDir, skillFilePath };
  const mask = (s) => maskPaths(s, ctx);
  const { exists, allow, deny, error } = readAgyRules(settingsPath);
  if (!exists) return { ok: false, name, detail: `${AGY_SETTINGS_SHOWN} is missing — run with --write-permissions (--init prints the ready block)` };
  if (error) return { ok: false, name, detail: `${AGY_SETTINGS_SHOWN}: ${error}` };
  ctx.deny = deny;
  const unsafe = unsafeRules(allow, ctx);
  if (unsafe.length) return { ok: false, name, detail: mask(`unsafe rules — remove them from ${AGY_SETTINGS_SHOWN}:\n    ${unsafe.join('\n    ')}`) };
  const wanted = rulesFor(config, ctx.workDir);
  const missing = [...wanted.allow.filter((r) => !allow.includes(r)), ...wanted.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`)];
  if (missing.length) return { ok: false, name, detail: mask(`missing rules: ${missing.join(', ')} — run with --write-permissions`) };
  const commandRules = allow.filter((r) => r.startsWith('command(')).length;
  return { ok: true, name, detail: `command(…) rules: ${commandRules}, project write without .git, no unsafe rules` };
}
