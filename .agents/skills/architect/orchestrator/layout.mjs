// Project layout ('classic' vs 'compact'), config autodiscovery, dynamic skill path, and always-frozen files.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const COMPACT_CONFIG_PATH = '.architect/config.json';
export const CLASSIC_CONFIG_PATH = '.agents/orchestrator.json';

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
