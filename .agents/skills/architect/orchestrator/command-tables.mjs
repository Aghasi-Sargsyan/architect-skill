// Command tables for permission rules (permissions.mjs commandProblem and proposeRules): data only, no imports.

/** Safe base set: read-only git, local commits, verification commands and read-only listings. */
export const BASE_COMMANDS = [
  'git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git branch --show-current', 'git ls-files', 'git grep', 'git blame', 'git ls-tree', 'git merge-base', 'git rev-list', 'git describe', 'git shortlog', 'git stash list', 'git tag -l', 'git branch -a', 'git branch -r', 'git branch --list', 'git check-ignore', 'git add', 'git commit', 'node --test', 'node --version', 'npm ls', 'wc -l', 'grep', 'ls', 'pwd', 'which',
];

export const TOO_BROAD = new Set([
  'git', 'npm', 'npm run', 'npm run-script', 'npx', 'node', 'sh', 'bash', 'zsh', 'env', 'xargs', 'pnpm', 'pnpm run', 'yarn', 'yarn run', 'bun', 'bun run', 'make', 'just',
]);
export const WRAPPERS = new Set(['time', 'timeout', 'nice', 'nohup', 'caffeinate', 'stdbuf', 'command', 'builtin', 'arch']);
export const FILE_BINARIES = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'perl', 'python', 'python3', 'tee', 'find', 'touch', 'mkdir', 'cp', 'mv', 'shasum', 'sha256sum', 'md5']);
export const DENIED_BINARIES = new Set([
  'sh', 'bash', 'zsh', 'env', 'xargs', 'sudo', 'su', 'eval', 'exec', 'rm', 'rmdir', 'chmod', 'chown', 'ln', 'dd', 'kill', 'pkill', 'killall', 'curl', 'wget', 'ssh', 'scp', 'nc', 'open', 'osascript', ...WRAPPERS, ...FILE_BINARIES,
]);
export const PY_SAFE_MODULES = new Set(['pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'black', 'isort', 'pyright', 'doctest']);

export const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'make', 'just', 'cargo', 'go', 'uv', 'poetry', 'pipenv', 'dotnet', 'composer', 'bundle', 'mix', 'gradle', 'mvn']);
export const STANDALONE_TOOLS = new Set(['pytest', 'ruff', 'mypy', 'flake8', 'black', 'isort', 'pyright', 'eslint', 'prettier', 'tsc', 'vitest', 'jest', 'playwright', 'golangci-lint', 'clippy', 'ls', 'grep']);
export const LEADING_FLAG_RUNNERS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'make', 'just']);
