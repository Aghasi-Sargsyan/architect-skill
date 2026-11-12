// Self-check range (ADR-073, C-31): base resolution plus what the report must show about the range
// (commit count, EMPTY status, shallow clone, close commit without a plan archive).
import { spawnSync } from 'node:child_process';
import { git } from './git.mjs';

const CLOSE_CYCLE_RE = /^arch:\s*(?:close cycle|закрытие цикла)\b/i;
const ARCHIVE_PLAN_RE = /(?:^|\/)(?:docs|\.architect)\/plans\/[^/]+\.md$/;

function commitFiles(realGit, cwd, sha) {
  return git(realGit, cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', sha])
    .split('\n').map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

// `git rev-parse @{u}` through piped stdio: a non-zero exit means "no upstream" and prints nothing.
function resolveUpstream(realGit, cwd) {
  const res = spawnSync(realGit, ['rev-parse', '@{u}'], { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AGENT_LOOP: '' } });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Moved from selfcheck.mjs with the same priority and result: `--base` (`source: 'explicit'`, unresolvable →
 * throw with the fetch-depth hint) > last `arch: close cycle` / `arch: закрытие цикла` commit that is not
 * HEAD (`'close-cycle'`) > `@{u}` only when no close commit exists (`'upstream'`) > root commit (`'root'`).
 * Change: a close commit that changes no files (an empty commit) is never a candidate — it cannot reset the
 * range. A close commit without a plan archive still is (selfcheck.test.mjs), see resolveSelfCheckRange.
 * @param {{ realGit: string, cwd: string, baseRef?: string|null }} opts
 * @returns {{ sha: string, source: 'explicit'|'close-cycle'|'upstream'|'root' }}
 */
export function resolveSelfCheckBase({ realGit, cwd, baseRef = null }) {
  if (baseRef) {
    try { return { sha: git(realGit, cwd, ['rev-parse', `${baseRef}^{commit}`]), source: 'explicit' }; } catch {
      // cleanup: abort base resolution with fail-closed hint
      throw new Error(`Cannot resolve --base "${baseRef}" to a commit — ensure the branch/ref is fetched (e.g. fetch-depth: 0)`);
    }
  }
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const log = git(realGit, cwd, ['log', '--format=%H %s', 'HEAD']).split('\n').filter(Boolean);
  const closes = log.filter((l) => CLOSE_CYCLE_RE.test(l.slice(41)));
  const cand = closes.find((l) => l.slice(0, 40) !== headSha && commitFiles(realGit, cwd, l.slice(0, 40)).length > 0);
  if (cand) return { sha: cand.slice(0, 40), source: 'close-cycle' };
  if (!closes.length) {
    const upstream = resolveUpstream(realGit, cwd);
    if (upstream) return { sha: upstream, source: 'upstream' };
  }
  return { sha: git(realGit, cwd, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0].trim(), source: 'root' };
}

/**
 * The self-check range (base, HEAD] with what the report must show about it.
 *  - `commitCount` = `git rev-list --count <base>..HEAD`; `empty` = baseSha === headSha;
 *  - violations: shallow repository (`git rev-parse --is-shallow-repository` → `true`) without an explicit
 *    `baseRef` → `shallow clone: the self-check range cannot be verified — fetch the full history
 *    (fetch-depth: 0) or pass --base <ref>`;
 *  - warnings: `source === 'close-cycle'` and the base commit changes no `docs/plans/*.md` /
 *    `.architect/plans/*.md` file → `self-check base <sha7> is an arch: close cycle commit without a plan
 *    archive (docs/plans/*.md)`.
 * @param {{ realGit: string, cwd: string, baseRef?: string|null }} opts
 * @returns {{ baseSha: string, headSha: string, source: string, commitCount: number, empty: boolean,
 *   violations: string[], warnings: string[] }}
 */
export function resolveSelfCheckRange({ realGit, cwd, baseRef = null }) {
  const { sha: baseSha, source } = resolveSelfCheckBase({ realGit, cwd, baseRef });
  const headSha = git(realGit, cwd, ['rev-parse', 'HEAD']);
  const commitCount = Number.parseInt(git(realGit, cwd, ['rev-list', '--count', `${baseSha}..HEAD`]), 10);
  const violations = [];
  const warnings = [];
  if (!baseRef && git(realGit, cwd, ['rev-parse', '--is-shallow-repository']) === 'true') {
    violations.push('shallow clone: the self-check range cannot be verified — fetch the full history (fetch-depth: 0) or pass --base <ref>');
  }
  if (source === 'close-cycle' && !commitFiles(realGit, cwd, baseSha).some((f) => ARCHIVE_PLAN_RE.test(f))) {
    warnings.push(`self-check base ${baseSha.slice(0, 7)} is an arch: close cycle commit without a plan archive (docs/plans/*.md)`);
  }
  return { baseSha, headSha, source, commitCount, empty: baseSha === headSha, violations, warnings };
}
