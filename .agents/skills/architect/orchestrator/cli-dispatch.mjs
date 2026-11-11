// Dispatches standalone CLI subcommands for run.mjs before starting the automated agent loop.

/**
 * Handles early CLI subcommands (--repair, --compact, --models/--set-model, --check-task, --self-check,
 * --init, --install-hooks, --update, --write-permissions, views, --answer, --check, --audit-plan).
 * Sets process.exitCode on failure and returns { handled: true } when main() should exit early,
 * or { handled: false, config, layout, workDir } when execution should continue to preflight/loop.
 * @param {{ opts: object, configPath: string, realGit: string, cwd?: string }} _ctx
 * @returns {Promise<{ handled: boolean, config?: object, layout?: object, workDir?: string }>}
 */
export async function dispatchCliSubcommand(_ctx) {
  throw new Error('Not implemented: dispatchCliSubcommand');
}
