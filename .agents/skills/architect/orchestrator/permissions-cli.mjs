// CLI handler for --write-permissions: writes allowlist and prunes unsafe or cross-project rules.
import os from 'node:os';
import { getAdapter } from './adapters/index.mjs';
import { maskPaths, realOrResolved } from './permissions.mjs';

export function handleWritePermissionsCli({ config, workDir, home = os.homedir(), log = console.log }) {
  const adapter = getAdapter(config);
  const realWork = realOrResolved(workDir);
  const realHome = realOrResolved(home);
  const settingsPath = adapter.permissions.settingsPath(home, realWork);
  const ctx = { workDir: realWork, home: realHome };
  const pruneCtx = { config, blockedScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], workDir: realWork, home: realHome };
  const rules = adapter.permissions.rulesFor(config, realWork);
  const res = adapter.permissions.writeAllowlist({ settingsPath, workDir: realWork, home: realHome, ...rules, pruneCtx });
  const addedAllow = res.addedAllow ?? [];
  const addedDeny = res.addedDeny ?? [];
  const removedAllow = res.removedAllow ?? [];
  const backup = Boolean(res.backup);
  const added = [...addedAllow, ...addedDeny.map((r) => `deny ${r}`)];

  if (!added.length && !removedAllow.length) {
    log(`• ${adapter.permissions.settingsShown}: all rules already present, file unchanged`);
  } else {
    const summary = [];
    if (added.length) summary.push(`added ${added.length} rules`);
    if (removedAllow.length) summary.push(`removed ${removedAllow.length} unsafe/other-project rules`);
    const backupNotice = backup ? ', previous version saved to settings.json.bak' : '';
    log(`• ${adapter.permissions.settingsShown}: ${summary.join(', ')}${backupNotice}`);
    for (const rule of added) log(`    ${maskPaths(rule, ctx)}`);
    for (const rule of removedAllow) log(`    - ${maskPaths(rule, ctx)}`);
  }

  const perm = adapter.permissions.check({ config, settingsPath, workDir: realWork, home: realHome });
  if (!perm.ok) log(`✗ ${perm.detail}\n  --check and loop will not start until this is resolved`);
  log('next: run with --check');
  return { addedAllow, addedDeny, removedAllow, backup, ok: perm.ok };
}
