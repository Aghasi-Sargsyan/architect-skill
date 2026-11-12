// Crash-safe journal and recovery for git pushurl and pre-push hook guards after SIGKILL or power loss.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readLockOwner } from './run-lock.mjs';

const DISABLED_PUSH_URL = '/dev/null/agent-loop-push-disabled';
const HOOK_MARKER = '# agent-loop guard hook';
const RUNS_DIR = '.agent-runs';
const JOURNAL_REL = path.join('info', 'agent-loop-guards.json');

function resolveGitDir(workDir, realGit) {
  if (!workDir) return null;
  if (realGit) {
    try {
      const out = execFileSync(realGit, ['rev-parse', '--git-dir'], {
        cwd: workDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGENT_LOOP: '' },
      }).trim();
      if (out) return path.resolve(workDir, out);
    } catch {
      /* cleanup: abort git-dir lookup outside a valid repository */
      return null;
    }
  }
  const dotGit = path.join(workDir, '.git');
  return existsSync(dotGit) ? dotGit : null;
}

function resolveGitTopLevel(workDir, realGit) {
  if (!workDir || !realGit) return null;
  try {
    const out = execFileSync(realGit, ['rev-parse', '--show-toplevel'], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, AGENT_LOOP: '' },
    }).trim();
    return out ? path.resolve(workDir, out) : null;
  } catch {
    /* cleanup: abort toplevel lookup outside a valid worktree */
    return null;
  }
}

function candidateLockDirs(workDir, gitDir = null, realGit = null) {
  const dirs = new Set();
  if (workDir) dirs.add(path.resolve(workDir));
  const top = resolveGitTopLevel(workDir, realGit);
  if (top) dirs.add(top);
  if (gitDir && path.basename(gitDir) === '.git') {
    dirs.add(path.dirname(gitDir));
  }
  return [...dirs];
}

export function guardsJournalPath(workDir, realGit = null) {
  const gitDir = resolveGitDir(workDir, realGit);
  return gitDir ? path.join(gitDir, JOURNAL_REL) : path.join(workDir, '.git', JOURNAL_REL);
}

function activeLoopPid(workDir, gitDir = null, realGit = null) {
  for (const dir of candidateLockDirs(workDir, gitDir, realGit)) {
    const owner = readLockOwner(path.join(dir, RUNS_DIR));
    if (owner?.alive) return owner.pid;
  }
  return null;
}

function readPreGuardRemotes(workDir, realGit) {
  const run = (args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } });
  const remotes = [];
  for (const name of run(['remote']).split('\n').map((s) => s.trim()).filter(Boolean)) {
    const key = `remote.${name}.pushurl`;
    let previous = [];
    try {
      previous = run(['config', '--get-all', key]).split('\n').filter(Boolean);
    } catch (err) {
      if (!(err instanceof Error && 'status' in err && err.status === 1)) throw err;
    }
    remotes.push({ key, previous: previous.filter((u) => u !== DISABLED_PUSH_URL) });
  }
  return remotes;
}

/** Snapshots pre-guard pushurl values and pre-push hook paths inside .git/info before installGuards mutates .git. */
export function writeGuardsJournal({ workDir, realGit }) {
  const gitDir = resolveGitDir(workDir, realGit);
  if (!gitDir || !realGit) return null;
  try {
    const jPath = path.join(gitDir, JOURNAL_REL);
    if (existsSync(jPath) && activeLoopPid(workDir, gitDir, realGit) === null) {
      recoverCrashedGuards({ workDir, realGit });
    }
    const run = (args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } });
    const hooksDir = path.resolve(workDir, run(['rev-parse', '--git-path', 'hooks']).trim());
    const hook = path.join(hooksDir, 'pre-push');
    const savedHook = path.join(hooksDir, 'pre-push.agent-loop-saved');
    const hadForeignHook = existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARKER);
    const remotes = readPreGuardRemotes(workDir, realGit);
    const payload = { hook, savedHook, hadForeignHook, remotes };
    mkdirSync(path.dirname(jPath), { recursive: true });
    const tmp = `${jPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, jPath);
    return jPath;
  } catch {
    /* cleanup: abort journal write outside a valid git repo */
    return null;
  }
}

export function clearGuardsJournal(workDir, realGit = null) {
  if (!workDir) return;
  rmSync(guardsJournalPath(workDir, realGit), { force: true });
}

/**
 * Restores leftover pushurl = /dev/null/agent-loop-push-disabled, guard pre-push hook, and stale .lock
 * when no live orchestrator process holds .agent-runs/.lock.
 */
export function recoverCrashedGuards({ workDir = process.cwd(), realGit }) {
  const notes = [];
  const gitDir = resolveGitDir(workDir, realGit);
  if (!gitDir || !realGit) {
    return { recovered: false, activePid: null, notes };
  }
  const pid = activeLoopPid(workDir, gitDir, realGit);
  if (pid !== null) {
    return { recovered: false, activePid: pid, notes };
  }

  for (const dir of candidateLockDirs(workDir, gitDir, realGit)) {
    const lockFile = path.join(dir, RUNS_DIR, '.lock');
    if (existsSync(lockFile)) {
      rmSync(lockFile, { force: true });
      notes.push('removed stale .agent-runs/.lock');
    }
  }

  const run = (args) => execFileSync(realGit, args, { cwd: workDir, encoding: 'utf8', env: { ...process.env, AGENT_LOOP: '' } });
  const jPath = path.join(gitDir, JOURNAL_REL);
  let journal = null;
  if (existsSync(jPath)) {
    try {
      journal = JSON.parse(readFileSync(jPath, 'utf8'));
    } catch {
      /* cleanup: abort reading corrupted journal and fall back to git scan */
      journal = null;
    }
  }

  try {
    if (Array.isArray(journal?.remotes)) {
      for (const { key, previous = [] } of journal.remotes) {
        if (typeof key !== 'string' || !key.startsWith('remote.')) continue;
        let current = [];
        try { current = run(['config', '--get-all', key]).split('\n').filter(Boolean); } catch { current = []; }
        if (current.includes(DISABLED_PUSH_URL)) {
          try { run(['config', '--unset-all', key]); } catch { /* cleanup: close unset-all */ }
          for (const url of previous) {
            if (typeof url === 'string' && url && url !== DISABLED_PUSH_URL) run(['config', '--add', key, url]);
          }
          notes.push(`restored ${key}`);
        }
      }
    }
    for (const name of run(['remote']).split('\n').map((s) => s.trim()).filter(Boolean)) {
      const key = `remote.${name}.pushurl`;
      let current = [];
      try { current = run(['config', '--get-all', key]).split('\n').filter(Boolean); } catch { current = []; }
      if (current.includes(DISABLED_PUSH_URL)) {
        const keep = current.filter((u) => u !== DISABLED_PUSH_URL);
        try { run(['config', '--unset-all', key]); } catch { /* cleanup: close unset-all */ }
        for (const url of keep) run(['config', '--add', key, url]);
        notes.push(`cleared leftover disabled pushurl on remote "${name}"`);
      }
    }

    const hooksDir = path.resolve(workDir, run(['rev-parse', '--git-path', 'hooks']).trim());
    const hook = journal?.hook ? path.resolve(journal.hook) : path.join(hooksDir, 'pre-push');
    const saved = journal?.savedHook ? path.resolve(journal.savedHook) : path.join(hooksDir, 'pre-push.agent-loop-saved');
    if (existsSync(hook) && readFileSync(hook, 'utf8').includes(HOOK_MARKER)) {
      rmSync(hook, { force: true });
      if (existsSync(saved)) renameSync(saved, hook);
      notes.push('restored .git/hooks/pre-push');
    } else if (!existsSync(hook) && existsSync(saved)) {
      renameSync(saved, hook);
      notes.push('restored saved .git/hooks/pre-push');
    }
  } catch {
    /* cleanup: abort git guard recovery on unreadable repo */
  }

  if (existsSync(jPath)) {
    rmSync(jPath, { force: true });
    if (!notes.length) notes.push('cleared stale .git/info/agent-loop-guards.json');
  }
  return { recovered: notes.length > 0, activePid: null, notes };
}

export function handleRepairCli({ workDir = process.cwd(), realGit, stdout = process.stdout, stderr = process.stderr }) {
  const res = recoverCrashedGuards({ workDir, realGit });
  if (res.activePid !== null) {
    stderr.write(`✗ Cannot repair guards while orchestrator loop is running (PID ${res.activePid}).\n`);
    return 1;
  }
  if (res.notes.length === 0) {
    stdout.write('✓ No leftover orchestrator guards or stale locks found.\n');
    return 0;
  }
  for (const n of res.notes) stdout.write(`✓ ${n}\n`);
  return 0;
}
