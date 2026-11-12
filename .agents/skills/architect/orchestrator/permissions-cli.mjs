// CLI handler for --write-permissions: writes the allowlist; claude prunes unsafe rules (archived), agy never removes any.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from './adapters/index.mjs';
import { maskPaths, realOrResolved } from './permissions.mjs';

export function handleWritePermissionsCli({ config, workDir, home = os.homedir(), log = console.log }) {
  const adapter = getAdapter(config);
  const realWork = realOrResolved(workDir);
  const realHome = realOrResolved(home);
  const settingsPath = adapter.permissions.settingsPath(home, realWork);
  const ctx = { workDir: realWork, home: realHome };
  const pruneCtx = { config, blockedScripts: config.blockedScripts ?? config.blockedNpmScripts ?? [], workDir: realWork, home: realHome };
  let origBackup = false;
  if (existsSync(settingsPath) && !existsSync(`${settingsPath}.orig.bak`)) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    copyFileSync(settingsPath, `${settingsPath}.orig.bak`);
    origBackup = true;
  }
  const rules = adapter.permissions.rulesFor(config, realWork);
  const res = adapter.permissions.writeAllowlist({ settingsPath, workDir: realWork, home: realHome, ...rules, pruneCtx });
  const addedAllow = res.addedAllow ?? [];
  const addedDeny = res.addedDeny ?? [];
  const removedAllow = res.removedAllow ?? [];
  const backup = Boolean(res.backup);
  const added = [...addedAllow, ...addedDeny.map((r) => `deny ${r}`)];

  let prunedArchivePath = null;
  if (removedAllow.length > 0) {
    prunedArchivePath = `${settingsPath}.pruned.json`;
    let prevRules = [];
    if (existsSync(prunedArchivePath)) {
      try {
        const parsed = JSON.parse(readFileSync(prunedArchivePath, 'utf8'));
        if (Array.isArray(parsed?.rules)) prevRules = parsed.rules.filter((x) => typeof x === 'string');
      } catch {
        /* close corrupted archive before rewriting */
        prevRules = [];
      }
    }
    const mergedRules = [...new Set([...prevRules, ...removedAllow])];
    writeFileSync(prunedArchivePath, `${JSON.stringify({ rules: mergedRules }, null, 2)}\n`, { mode: 0o600 });
  }

  if (!added.length && !removedAllow.length) {
    log(`• ${adapter.permissions.settingsShown}: all rules already present, file unchanged`);
  } else {
    const summary = [];
    if (added.length) summary.push(`added ${added.length} rules`);
    if (removedAllow.length) summary.push(`removed ${removedAllow.length} unsafe/other-project rules`);
    const backupNotice = backup ? ', previous version saved to settings.json.bak' : '';
    const origNotice = origBackup ? ' (initial snapshot saved to settings.json.orig.bak)' : '';
    log(`• ${adapter.permissions.settingsShown}: ${summary.join(', ')}${backupNotice}${origNotice}`);
    for (const rule of added) log(`    ${maskPaths(rule, ctx)}`);
    for (const rule of removedAllow) log(`    - ${maskPaths(rule, ctx)}`);
    if (prunedArchivePath) log(`  archived removed rules to ${maskPaths(prunedArchivePath, ctx)}`);
  }

  const perm = adapter.permissions.check({ config, settingsPath, workDir: realWork, home: realHome });
  if (!perm.ok) log(`✗ ${perm.detail}\n  --check and loop will not start until this is resolved`);
  log('next: run with --check');
  return { addedAllow, addedDeny, removedAllow, backup, origBackup, prunedArchivePath, ok: perm.ok };
}
