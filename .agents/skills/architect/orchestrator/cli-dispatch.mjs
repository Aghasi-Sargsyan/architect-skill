// Dispatches standalone CLI subcommands for run.mjs before starting the automated agent loop.
import path from 'node:path';
import { handleRepairCli } from './guards-recovery.mjs';
import { RUNS_DIR } from './config.mjs';
import { stopLoop } from './run-lock.mjs';
import { handleModelsCli } from './models.mjs';
import { handleCompactCli, resolveInstalledSkillDir } from './layout.mjs';
import {
  handleCheckTaskCli,
  handleSelfCheckCli,
  handleUpdateCli,
  safeLoadConfig,
  loadConfigOrDefaults,
} from './cli.mjs';
import { initProject, loadConfig as loadProjectConfig } from './config.mjs';
import { getAdapter } from './adapters/index.mjs';
import { realOrResolved } from './permissions.mjs';
import { installCommitMsgHook } from './hooks.mjs';
import { handleWritePermissionsCli } from './permissions-cli.mjs';
import { runView } from './feed.mjs';
import { submitAnswer } from './ask.mjs';
import { findBinary, runCheckCommand } from './check.mjs';
import { detectInitRunner, ensureClaudeSkillLink } from './claude-setup.mjs';

/**
 * Handles early CLI subcommands (--repair, --compact, --models/--set-model, --check-task, --self-check,
 * --init, --install-hooks, --update, --write-permissions, views, --answer, --check).
 * Sets process.exitCode on failure and returns { handled: true } when main() should exit early,
 * or { handled: false, config, layout, workDir } when execution should continue to preflight/loop.
 * @param {{
 *   opts: object,
 *   configPath: string,
 *   realGit: string,
 *   cwd?: string,
 *   loadConfig?: () => object,
 *   writePermissions?: (ctx: { config: object, workDir: string }) => object
 * }} ctx
 * @returns {Promise<{ handled: boolean, config?: object, layout?: object, workDir?: string }>}
 */
export async function dispatchCliSubcommand({
  opts,
  configPath,
  realGit,
  cwd = process.cwd(),
  loadConfig = () => safeLoadConfig(configPath),
  writePermissions = handleWritePermissionsCli,
}) {
  if (opts.repair) {
    const code = handleRepairCli({ workDir: cwd, realGit });
    const isErr = typeof code === 'number'
      ? code !== 0
      : Boolean(typeof code === 'object' && code !== null && !code.ok);
    if (isErr) {
      process.exitCode = typeof code === 'number' ? code : 1;
    }
    return { handled: true };
  }

  if (opts.compact) {
    handleCompactCli({ workDir: cwd });
    return { handled: true };
  }

  if (opts.models || opts.setModel) {
    handleModelsCli({ workDir: cwd, opts });
    return { handled: true };
  }

  if (opts.checkTask) {
    handleCheckTaskCli({
      opts,
      config: loadConfigOrDefaults(configPath, cwd),
      workDir: cwd,
      realGit,
    });
    return { handled: true };
  }

  if (opts.selfCheck) {
    const cfg = safeLoadConfig(configPath);
    handleSelfCheckCli({
      opts,
      config: cfg,
      workDir: path.resolve(cfg.workDir ?? cwd),
      realGit,
    });
    return { handled: true };
  }

  if (process.platform === 'win32') {
    throw new Error('Windows is not supported: git/npm shims are sh scripts (see skill README)');
  }

  if (opts.init) {
    const runner = detectInitRunner({ env: process.env, hasBin: (b) => Boolean(findBinary(b)) });
    for (const note of initProject({ workDir: cwd, configPath, realGit, team: opts.team, runner })) {
      console.log(`• ${note}`);
    }
    const ready = loadProjectConfig(configPath);
    const link = ensureClaudeSkillLink({
      workDir: cwd,
      skillDir: resolveInstalledSkillDir(cwd),
      env: process.env,
      runner: ready.runner,
    });
    if (link.created) {
      console.log(`• ${link.reason}`);
    }
    const adapter = getAdapter(ready);
    console.log(
      `\nAllowlist for ${adapter.displayName}: ${adapter.permissions.settingsShown}, keys permissions.allow and permissions.deny.\nRules for command(...) are configured once per computer, with subcommand only: Antigravity matches by prefix, "command(git)" would allow git push too.\nwrite_file(<project>) and denying writes to its .git are configured once per project.\n\n${adapter.permissions.allowlistBlock(adapter.permissions.rulesFor(ready, realOrResolved(ready.workDir ?? cwd)))}\n\nInsert the block manually or add it with backup: run with --write-permissions. Then run with --check.`
    );
    return { handled: true };
  }

  if (opts.installHooks) {
    const res = installCommitMsgHook({ workDir: cwd, realGit });
    console.log(res.installed ? '• installed .git/hooks/commit-msg' : `• skipped commit-msg hook: ${res.reason}`);
    return { handled: true };
  }

  if (opts.update) {
    const res = await handleUpdateCli({ workDir: cwd, realGit, force: opts.force });
    if (!res?.ok) {
      process.exitCode = 1;
    }
    return { handled: true };
  }

  const config = loadConfig();
  const layout = config.paths;
  const workDir = path.resolve(config.workDir ?? cwd);

  if (opts.writePermissions) {
    const res = writePermissions({ config, workDir });
    if (!res?.ok) {
      process.exitCode = 1;
    }
    return { handled: true };
  }

  if (opts.stop) {
    const res = await stopLoop({ runsDir: path.join(workDir, RUNS_DIR) });
    console.log(res.stopped ? `loop stopped (PID ${res.pid})` : res.reason);
    if (!res.stopped) process.exitCode = 1;
    return { handled: true };
  }

  // Read-only views (--status, --watch for a chat; --follow for a terminal): no lock, nothing written.
  if (await runView(opts, workDir)) {
    return { handled: true };
  }

  if (opts.answer !== null) {
    // --answer is unavailable to the agent (AGENT_LOOP is checked in the caller), and an answer.json placed
    // earlier does not match the random id of the question, so only the person's reply is accepted.
    const question = submitAnswer({ workDir, answer: opts.answer });
    console.log(`• answer "${opts.answer}" sent to the loop: ${question.command}`);
    return { handled: true };
  }

  if (opts.check) {
    const ok = await runCheckCommand({ config, workDir, realGit, probe: opts.probe });
    if (!ok) {
      process.exitCode = 1;
    }
    return { handled: true };
  }

  return { handled: false, config, layout, workDir };
}
