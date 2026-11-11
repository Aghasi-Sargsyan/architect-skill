// Project layout ('classic' vs 'compact'), config autodiscovery, dynamic skill path, and always-frozen files.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockHolder } from './guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const COMPACT_CONFIG_PATH = '.architect/config.json';
export const CLASSIC_CONFIG_PATH = '.agents/orchestrator.json';
export const COMPACT_LOCAL_CONFIG_PATH = '.architect/config.local.json';
export const CLASSIC_LOCAL_CONFIG_PATH = '.agents/orchestrator.local.json';

export function resolveLocalConfigPath(configPath = '') {
  if (!configPath) return COMPACT_LOCAL_CONFIG_PATH;
  const s = String(configPath);
  if (s.endsWith('.local.json')) return s;
  if (s.endsWith('.json')) return s.slice(0, -5) + '.local.json';
  return s + '.local.json';
}

const LAYOUTS = {
  classic: {
    layout: 'classic',
    planPath: 'PLAN.md',
    executorPath: 'EXECUTOR.md',
    decisionsPath: 'docs/decisions.md',
    plansArchiveDir: 'docs/plans',
    profilesPath: 'docs/executor-profiles.md',
  },
  compact: {
    layout: 'compact',
    planPath: '.architect/PLAN.md',
    executorPath: '.architect/EXECUTOR.md',
    decisionsPath: '.architect/decisions.md',
    plansArchiveDir: '.architect/plans',
    profilesPath: '.architect/executor-profiles.md',
  },
};

export function resolveConfigPath({ workDir = process.cwd(), configPath = null, init = false } = {}) {
  if (configPath) return configPath;
  if (init) return COMPACT_CONFIG_PATH;
  if (existsSync(path.join(workDir, COMPACT_CONFIG_PATH))) return COMPACT_CONFIG_PATH;
  if (existsSync(path.join(workDir, CLASSIC_CONFIG_PATH))) return CLASSIC_CONFIG_PATH;
  return COMPACT_CONFIG_PATH;
}

export function resolveLayout({ config = {}, configPath = '' } = {}) {
  let layout;
  if (config?.layout === 'compact' || config?.layout === 'classic') {
    layout = config.layout;
  } else {
    const norm = String(configPath ?? '').replace(/\\/g, '/');
    if (norm === COMPACT_CONFIG_PATH || norm.endsWith('/' + COMPACT_CONFIG_PATH) || norm.startsWith('.architect/')) {
      layout = 'compact';
    } else {
      layout = 'classic';
    }
  }
  return { ...LAYOUTS[layout] };
}

export function skillFilePath(workDir = process.cwd(), orchestratorDir = here) {
  const skillFile = path.resolve(path.dirname(orchestratorDir), 'SKILL.md');
  const root = path.resolve(workDir);
  const rel = path.relative(root, skillFile);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return skillFile.replace(/\\/g, '/');
}

export function reviewFilePath(workDir = process.cwd(), orchestratorDir = here) {
  const reviewFile = path.resolve(path.dirname(orchestratorDir), 'references', 'auto-review.md');
  const root = path.resolve(workDir);
  const rel = path.relative(root, reviewFile);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return reviewFile.replace(/\\/g, '/');
}

export function isSkillAtWorkDirRoot(workDir = process.cwd(), orchestratorDir = here) {
  if (!orchestratorDir) return false;
  return path.resolve(path.dirname(orchestratorDir)) === path.resolve(workDir);
}

export function resolveInstalledSkillDir(workDir = process.cwd(), orchestratorDir = here) {
  const root = path.resolve(workDir);
  if (orchestratorDir) {
    const candidate = path.resolve(path.dirname(orchestratorDir));
    const rel = path.relative(root, candidate);
    if (rel === '') return null;
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(path.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  for (const dotDir of ['.agents', '.claude']) {
    const sub = path.join(root, dotDir, 'skills', 'architect');
    if (existsSync(path.join(sub, 'SKILL.md'))) return sub;
  }
  return null;
}

export function isAlwaysFrozenFile(filePath, opts = {}) {
  let cfg = '';
  let options = opts;
  if (typeof opts === 'string') {
    cfg = opts;
    options = {};
  } else if (typeof opts === 'object' && opts !== null) {
    cfg = opts.configPath ?? '';
  }
  const { workDir = process.cwd(), orchestratorDir = here } = options;
  const norm = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('.github/workflows/')) return true;
  const list = alwaysFrozenFiles(cfg, { workDir, orchestratorDir });
  if (list.includes(norm)) return true;

  if (orchestratorDir) {
    const skillDir = path.dirname(orchestratorDir);
    const root = path.resolve(workDir);
    const rel = path.relative(root, skillDir).replace(/\\/g, '/');
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      const prefix = `${rel}/`;
      if (norm.startsWith(prefix)) {
        const sub = norm.slice(prefix.length);
        if (sub.startsWith('references/')) return true;
        if (!sub.includes('/') && sub.endsWith('.md')) return true;
      }
    }
  }
  return false;
}

export function alwaysFrozenFiles(configPath = '', opts = {}) {
  let cfg = configPath;
  let options = opts;
  if (typeof configPath === 'object' && configPath !== null) {
    options = configPath;
    cfg = options.configPath ?? '';
  }
  const { workDir = process.cwd(), orchestratorDir = here } = options;
  const list = [
    'EXECUTOR.md',
    '.architect/EXECUTOR.md',
    '.agents/orchestrator.json',
    '.architect/config.json',
    COMPACT_LOCAL_CONFIG_PATH,
    CLASSIC_LOCAL_CONFIG_PATH,
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
  ];
  if (orchestratorDir) {
    const skillDir = path.dirname(orchestratorDir);
    const root = path.resolve(workDir);
    const rel = path.relative(root, skillDir).replace(/\\/g, '/');
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      for (const name of ['SKILL.md', 'EXECUTOR.md', 'MAINTAINING.md']) {
        const item = `${rel}/${name}`;
        if (!list.includes(item)) list.push(item);
      }
    }
  }
  if (typeof cfg === 'string' && cfg) {
    const norm = cfg.replace(/\\/g, '/');
    if (!path.isAbsolute(cfg) && norm && !list.includes(norm)) {
      list.push(norm);
    }
  }
  return list;
}

export function migrateToCompact({ workDir = process.cwd() } = {}) {
  if (process.env.AGENT_LOOP === '1') {
    throw new Error('cannot run --compact from inside the agent loop (AGENT_LOOP=1)');
  }
  const pid = lockHolder(path.join(workDir, '.agent-runs'));
  if (pid !== null) {
    throw new Error('cannot migrate layout while orchestrator loop is running (PID ' + pid + ' in .agent-runs/.lock)');
  }

  const pairs = [
    ['EXECUTOR.md', '.architect/EXECUTOR.md'],
    ['PLAN.md', '.architect/PLAN.md'],
    ['docs/decisions.md', '.architect/decisions.md'],
    ['docs/executor-profiles.md', '.architect/executor-profiles.md'],
    ['.agents/orchestrator.json', '.architect/config.json'],
    ['.agents/orchestrator.local.json', '.architect/config.local.json'],
  ];

  const docsPlansDir = path.join(workDir, 'docs', 'plans');
  if (existsSync(docsPlansDir)) {
    try {
      for (const entry of readdirSync(docsPlansDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          pairs.push([`docs/plans/${entry.name}`, `.architect/plans/${entry.name}`]);
        }
      }
    } catch { /* cleanup: abort reading docs/plans */ }
  }

  for (const [from, to] of pairs) {
    const fromPath = path.join(workDir, from);
    const toPath = path.join(workDir, to);
    if (existsSync(fromPath) && existsSync(toPath)) {
      const fromBuf = readFileSync(fromPath);
      const toBuf = readFileSync(toPath);
      if (!fromBuf.equals(toBuf)) {
        throw new Error(`conflicting classic and compact files: ${from} vs ${to}`);
      }
    }
  }

  const moved = [];
  for (const [from, to] of pairs) {
    const fromPath = path.join(workDir, from);
    if (!existsSync(fromPath)) continue;
    const toPath = path.join(workDir, to);
    mkdirSync(path.dirname(toPath), { recursive: true });

    if (from === 'PLAN.md') {
      let content = readFileSync(fromPath, 'utf8');
      content = content
        .replaceAll('- `EXECUTOR.md`', '- `.architect/EXECUTOR.md`')
        .replaceAll('read EXECUTOR.md', 'read .architect/EXECUTOR.md')
        .replaceAll('docs/decisions.md', '.architect/decisions.md')
        .replaceAll('docs/executor-profiles.md', '.architect/executor-profiles.md')
        .replaceAll('docs/plans/', '.architect/plans/');
      writeFileSync(toPath, content, 'utf8');
    } else if (from === '.agents/orchestrator.json') {
      const raw = JSON.parse(readFileSync(fromPath, 'utf8'));
      writeFileSync(toPath, JSON.stringify({ layout: 'compact', ...raw }, null, 2) + '\n', 'utf8');
    } else {
      writeFileSync(toPath, readFileSync(fromPath));
    }
    moved.push({ from, to });
  }
  for (const { from } of moved) {
    rmSync(path.join(workDir, from), { force: true });
  }

  for (const dirRel of ['docs/plans', 'docs']) {
    const dirFull = path.join(workDir, dirRel);
    if (existsSync(dirFull)) {
      try {
        if (readdirSync(dirFull).length === 0) rmSync(dirFull, { recursive: true, force: true });
      } catch { /* cleanup: abort directory cleanup */ }
    }
  }

  const updated = [];
  for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const p = path.join(workDir, rel);
    if (!existsSync(p)) continue;
    try {
      const original = readFileSync(p, 'utf8');
      const transformed = original
        .replace(/\.agents\/orchestrator\.local\.json/g, '.architect/config.local.json')
        .replace(/\.agents\/orchestrator\.json/g, '.architect/config.json')
        .replace(/(?<![/\w.-])EXECUTOR\.md\b/g, '.architect/EXECUTOR.md')
        .replace(/(?<![/\w.-])PLAN\.md\b/g, '.architect/PLAN.md');
      if (transformed !== original) {
        writeFileSync(p, transformed, 'utf8');
        updated.push(rel);
      }
    } catch { /* cleanup: abort updating reference file */ }
  }

  const notes = [];
  if (moved.length === 0 && updated.length === 0) {
    notes.push('project is already using compact layout (.architect/)');
  } else {
    for (const m of moved) notes.push(`moved ${m.from} -> ${m.to}`);
    for (const u of updated) notes.push(`updated references in ${u}`);
  }

  return {
    ok: true,
    alreadyCompact: moved.length === 0 && updated.length === 0,
    moved,
    updated,
    notes,
  };
}

export function handleCompactCli({ workDir = process.cwd(), print = console.log } = {}) {
  const res = migrateToCompact({ workDir });
  for (const n of res.notes) print(n.startsWith('• ') ? n : `• ${n}`);
  return res;
}
