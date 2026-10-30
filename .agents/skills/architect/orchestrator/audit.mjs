// Advisory read-only plan audit via Claude Code and PLAN.md coverage check.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, head, porcelain } from './git.mjs';
import { findBinary } from './check.mjs';
import { isInside, realOrResolved, resolveSkillDir } from './permissions.mjs';
import { runClaudeAgent } from './adapters/claude.mjs';
import { resolveSelfCheckBase } from './selfcheck.mjs';

const AUDIT_PROMPT = `You are an advisory plan auditor. Your task is to perform an advisory read-only audit of PLAN.md (or .architect/PLAN.md) and frozen test files following the checklist in references/plan-audit.md.
Do not modify any files. Use only Read, Grep, and Glob tools.
Inspect PLAN.md, Frozen reference tests, and target modules. Check:
1. Completeness of invariants and negative cases in Frozen reference tests (frozen_tests).
2. Holes in regular expressions and contracts (regex_contracts).
3. Hidden overlaps of Change and Frozen across tasks (change_frozen_overlap).
Output strictly conforming to the requested JSON schema.`;

export function modelFamily(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku') || m.includes('anthropic')) return 'claude';
  if (m.includes('gemini') || m.includes('argon') || m.includes('flash') || m.includes('google')) return 'gemini';
  if (m.includes('gpt') || m.includes('openai') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('llama') || m.includes('meta')) return 'llama';
  if (m.includes('mistral') || m.includes('codestral')) return 'mistral';
  return m.split(/[-_/:]/)[0] || m;
}

export function buildAuditClaudeSettings({ workDir, skillDir = null, settingsPath }) {
  const w = realOrResolved(workDir);
  const abs = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const allow = [
    `Read(${abs(w)}/**)`,
    `Grep(${abs(w)}/**)`,
    `Glob(${abs(w)}/**)`,
  ];
  const additionalDirectories = [];
  const resolvedSkill = skillDir ? realOrResolved(path.resolve(w, skillDir)) : resolveSkillDir({ workDir: w });
  if (resolvedSkill && !isInside(resolvedSkill, w)) {
    additionalDirectories.push(resolvedSkill);
    allow.push(`Read(${abs(resolvedSkill)}/**)`);
  }
  const deny = ['Bash(*)', 'Edit(*)', 'Write(*)'];
  const settings = {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      allow,
      deny,
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    },
  };
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settings;
}

export function countAuditsForBase(auditsDir, cycleBaseSha) {
  if (!auditsDir || !existsSync(auditsDir) || !cycleBaseSha) return 0;
  let count = 0;
  const entries = readdirSync(auditsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const jsonPath = path.join(auditsDir, ent.name, 'audit.json');
    if (!existsSync(jsonPath)) continue;
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const sha = data.cycleBaseSha ?? data.baseSha;
    if (sha === cycleBaseSha || (typeof sha === 'string' && (sha.startsWith(cycleBaseSha) || cycleBaseSha.startsWith(sha)))) {
      count++;
    }
  }
  return count;
}

export function formatAuditMarkdown(audit) {
  const lines = [
    `# Advisory Plan Audit (${audit.model})`,
    '',
    `- Cycle Base: \`${audit.cycleBaseSha}\``,
    `- Created: ${audit.createdAt}`,
    `- Total findings: ${audit.findings.length}`,
    '',
    `## Summary`,
    '',
    audit.summary || 'No summary.',
    '',
    `## Findings`,
    '',
  ];
  if (audit.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const f of audit.findings) {
      lines.push(`### ${f.id} [${f.severity}] (${f.category}): \`${f.file}\``);
      lines.push(`- **Summary**: ${f.summary}`);
      lines.push(`- **Recommendation**: ${f.recommendation}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function runPlanAudit({
  config,
  workDir,
  realGit,
  authorModel = null,
  runAgent = runClaudeAgent,
  env = process.env,
  baseRef = null,
}) {
  if (!config?.auditor?.model) {
    throw new Error('config.auditor with a valid model is required for plan audit');
  }

  if (runAgent === runClaudeAgent) {
    const claudeBin = findBinary('claude', env.PATH);
    if (!claudeBin) {
      throw new Error('claude binary not found in PATH — install Claude Code CLI for plan audit');
    }
  }

  if (authorModel && modelFamily(authorModel) === modelFamily(config.auditor.model)) {
    throw new Error(`Plan audit model (${config.auditor.model}, family: ${modelFamily(config.auditor.model)}) must be from a different family than the plan author model (${authorModel}, family: ${modelFamily(authorModel)})`);
  }

  let cycleBaseSha;
  if (baseRef) {
    cycleBaseSha = git(realGit, workDir, ['rev-parse', baseRef]);
  } else {
    const headSha = git(realGit, workDir, ['rev-parse', 'HEAD']);
    const headMsg = git(realGit, workDir, ['log', '-1', '--format=%s', 'HEAD']);
    if (/^arch:\s*(?:close cycle|закрытие цикла)\b/i.test(headMsg)) {
      cycleBaseSha = headSha;
    } else {
      cycleBaseSha = resolveSelfCheckBase({ realGit, cwd: workDir }).sha;
    }
  }

  const auditsDir = path.join(workDir, '.agent-runs', 'audits');
  const auditCount = countAuditsForBase(auditsDir, cycleBaseSha);
  if (auditCount >= 2) {
    throw new Error(`Audit limit reached: max 1 re-run (2 audits total) allowed for cycle base ${cycleBaseSha}`);
  }

  let ts = new Date().toISOString().replace(/[:.]/g, '-');
  let runDir = path.join(auditsDir, ts);
  if (existsSync(runDir)) {
    ts += `-${Math.random().toString(16).slice(2, 6)}`;
    runDir = path.join(auditsDir, ts);
  }
  mkdirSync(runDir, { recursive: true });

  const settingsPath = path.join(runDir, 'claude-settings.json');
  const orchDir = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.resolve(orchDir, '..');
  buildAuditClaudeSettings({ workDir, skillDir, settingsPath });

  const schemaPath = path.join(orchDir, 'schemas', 'audit.json');
  const headBefore = head(realGit, workDir);
  const statusBefore = porcelain(realGit, workDir);

  const claudeBin = findBinary('claude', env.PATH) ?? 'claude';
  const res = await runAgent({
    bin: claudeBin,
    model: config.auditor.model,
    prompt: AUDIT_PROMPT,
    cwd: workDir,
    schemaPath,
    settingsPath,
    env,
    skipPermissions: false,
    timeoutMs: config.timeoutMinutes ? config.timeoutMinutes * 60_000 : 15 * 60_000,
  });

  const headAfter = head(realGit, workDir);
  const statusAfter = porcelain(realGit, workDir);
  if (headAfter !== headBefore || statusAfter !== statusBefore) {
    throw new Error(`Read-only invariant violated: working tree or HEAD was modified during plan audit (head changed: ${headAfter !== headBefore}, status: "${statusAfter}")`);
  }

  if (!res || !res.ok) {
    throw new Error(`Plan audit agent failed: ${res?.error || 'unknown error'}`);
  }

  let parsed = res.json;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = { findings: [], summary: parsed }; }
  } else if (!parsed && res.stdout) {
    try { parsed = JSON.parse(res.stdout); } catch { parsed = { findings: [], summary: String(res.stdout) }; }
  }

  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const findings = rawFindings.map((f, i) => ({
    ...f,
    id: `A-${i + 1}`,
  }));

  const audit = {
    cycleBaseSha,
    model: config.auditor.model,
    createdAt: new Date().toISOString(),
    findings,
    summary: parsed?.summary || '',
  };

  const auditJsonPath = path.join(runDir, 'audit.json');
  writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2) + '\n');

  const auditMdPath = path.join(runDir, 'audit.md');
  writeFileSync(auditMdPath, formatAuditMarkdown(audit) + '\n');

  return {
    ok: true,
    audit,
    auditJsonPath,
    auditMdPath,
  };
}

function parseResolutions(planText) {
  const resolutions = new Map();
  if (!planText) return resolutions;
  const lines = planText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^-\s*(A-\d+)\s*\[(blocker|important)\]:\s*(принято|accepted|(?:отклонено|rejected):\s*(.+))$/i);
    if (m) {
      const id = m[1].toUpperCase();
      const severity = m[2].toLowerCase();
      const actionRaw = m[3];
      if (/^(?:принято|accepted)$/i.test(actionRaw)) {
        resolutions.set(id, { id, severity, status: 'accepted', reason: null });
      } else {
        const reasonMatch = actionRaw.match(/^(?:отклонено|rejected):\s*(.+)$/i);
        const reason = reasonMatch ? reasonMatch[1].trim() : '';
        resolutions.set(id, { id, severity, status: 'rejected', reason });
      }
    }
  }
  return resolutions;
}

export function checkAuditCoverage({ workDir, planText = null, cycleBaseSha = null }) {
  if (planText === null) {
    const p1 = path.join(workDir, 'PLAN.md');
    const p2 = path.join(workDir, '.architect', 'PLAN.md');
    if (existsSync(p1)) planText = readFileSync(p1, 'utf8');
    else if (existsSync(p2)) planText = readFileSync(p2, 'utf8');
    else planText = '';
  }

  const auditsDir = path.join(workDir, '.agent-runs', 'audits');
  if (!existsSync(auditsDir)) {
    return { ok: true, hasAudit: false, violations: [], rejectedBlockers: [] };
  }

  const matchingAudits = [];
  const entries = readdirSync(auditsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const name of entries) {
    const jsonPath = path.join(auditsDir, name, 'audit.json');
    if (!existsSync(jsonPath)) continue;
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const sha = data.cycleBaseSha ?? data.baseSha;
    if (!cycleBaseSha || sha === cycleBaseSha || (typeof sha === 'string' && (sha.startsWith(cycleBaseSha) || cycleBaseSha.startsWith(sha)))) {
      matchingAudits.push({ name, path: jsonPath, data });
    }
  }

  if (matchingAudits.length === 0) {
    return { ok: true, hasAudit: false, violations: [], rejectedBlockers: [] };
  }

  matchingAudits.sort((a, b) => {
    const timeA = a.data?.createdAt ? new Date(a.data.createdAt).getTime() : 0;
    const timeB = b.data?.createdAt ? new Date(b.data.createdAt).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.name.localeCompare(b.name);
  });

  const latestAudit = matchingAudits[matchingAudits.length - 1].data;
  const requiredFindings = (latestAudit.findings || []).filter(
    (f) => f.severity === 'blocker' || f.severity === 'important'
  );

  const violations = [];
  const rejectedBlockers = [];
  const resolutions = parseResolutions(planText);

  for (const f of requiredFindings) {
    const res = resolutions.get(f.id.toUpperCase());
    if (!res) {
      violations.push(`Unresolved audit finding ${f.id} [${f.severity}]: missing resolution in PLAN.md (- ${f.id} [${f.severity}]: принято | отклонено: <причина>)`);
    } else {
      if (res.status === 'rejected' && f.severity === 'blocker') {
        rejectedBlockers.push({
          id: f.id,
          severity: f.severity,
          reason: res.reason,
          finding: f,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    hasAudit: true,
    violations,
    rejectedBlockers,
    latestAudit,
  };
}
