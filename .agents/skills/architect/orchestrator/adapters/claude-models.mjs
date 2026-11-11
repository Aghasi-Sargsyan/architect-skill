// Claude Code model ids with an optional effort suffix: `<alias>-<effort>` maps to `--model <alias> --effort <effort>`.

/** Claude Code model aliases, in listing order (the first three keep their historical positions). */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];

/** Effort levels accepted by `claude --effort` and by the `effort` field of `.claude/agents/*.md`. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const LEVEL_NAMES = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

function aliasName(alias) {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

/**
 * Models offered by the `claude` runner.
 * First the plain aliases in `CLAUDE_MODEL_ALIASES` order (`{ id: 'sonnet', name: 'Claude Sonnet' }`, ...),
 * then, for each alias in the same order, one entry per level in `CLAUDE_EFFORT_LEVELS` order:
 * `{ id: '<alias>-<level>', name: 'Claude <Alias> (<Level>)' }` where `<Level>` is
 * `Low`, `Medium`, `High`, `XHigh` or `Max`. 24 entries in total, ids unique.
 * @returns {Array<{ id: string, name: string }>}
 */
export function listClaudeModels() {
  const result = [];
  for (const alias of CLAUDE_MODEL_ALIASES) {
    result.push({ id: alias, name: `Claude ${aliasName(alias)}` });
  }
  for (const alias of CLAUDE_MODEL_ALIASES) {
    for (const level of CLAUDE_EFFORT_LEVELS) {
      result.push({
        id: `${alias}-${level}`,
        name: `Claude ${aliasName(alias)} (${LEVEL_NAMES[level] || level})`,
      });
    }
  }
  return result;
}

/**
 * Splits a configured model id into the `claude` model and an optional effort level.
 * - The input is trimmed; a non-string or empty value throws `TypeError` with "non-empty string" in the message.
 * - The effort suffix is split off only when the id ends with `-<level>` (a level from `CLAUDE_EFFORT_LEVELS`)
 *   AND the remaining base is a Claude model: one of `CLAUDE_MODEL_ALIASES` or a string starting with `claude-`.
 * - Anything else is returned whole with `effort: null` (for example `gemini-3.8-flash-high`, `opus-turbo`,
 *   `claude-sonnet-4-5`).
 * @param {string} id
 * @returns {{ model: string, effort: string | null }}
 */
export function splitClaudeModel(id) {
  if (typeof id !== 'string') {
    throw new TypeError('Model id must be a non-empty string');
  }
  const trimmed = id.trim();
  if (!trimmed) {
    throw new TypeError('Model id must be a non-empty string');
  }
  const dashIndex = trimmed.lastIndexOf('-');
  if (dashIndex > 0) {
    const base = trimmed.slice(0, dashIndex);
    const suffix = trimmed.slice(dashIndex + 1);
    const isClaude = CLAUDE_MODEL_ALIASES.includes(base) || base.startsWith('claude-');
    if (CLAUDE_EFFORT_LEVELS.includes(suffix) && isClaude) {
      return { model: base, effort: suffix };
    }
  }
  return { model: trimmed, effort: null };
}

/**
 * CLI arguments for `claude -p`: `['--model', model]`, plus `['--effort', effort]` when `splitClaudeModel`
 * returns an effort. Throws the same `TypeError` as `splitClaudeModel` for an invalid id.
 * @param {string} id
 * @returns {string[]}
 */
export function claudeModelArgs(id) {
  const { model, effort } = splitClaudeModel(id);
  const args = ['--model', model];
  if (effort) {
    args.push('--effort', effort);
  }
  return args;
}

/**
 * Rewrites the YAML frontmatter of a Claude Code subagent file (`.claude/agents/executor.md`) for a model id.
 * - Works only inside the leading frontmatter block: the text must start with a `---` line and contain a closing
 *   `---` line; otherwise returns `null`.
 * - Returns `null` when the frontmatter has no `model:` line (a commented `# model:` line does not count).
 * - Uses `splitClaudeModel(id)`: the `model:` line becomes `model: <model>`; when there is an effort, an existing
 *   `effort:` line becomes `effort: <effort>`, or a new `effort: <effort>` line is inserted right after `model:`;
 *   when there is no effort, an existing `effort:` line is removed.
 * - All other lines (including the body after the closing `---`) are returned unchanged.
 * @param {string} text
 * @param {string} id
 * @returns {string | null}
 */
export function syncClaudeAgentFile(text, id) {
  if (typeof text !== 'string' || !text.startsWith('---')) {
    return null;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return null;
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return null;
  }

  const fmLines = lines.slice(1, closingIndex);
  const modelLineIdx = fmLines.findIndex((line) => /^model:(?:\s.*)?$/.test(line));
  if (modelLineIdx === -1) {
    return null;
  }

  const { model, effort } = splitClaudeModel(id);
  fmLines[modelLineIdx] = `model: ${model}`;

  const effortLineIdx = fmLines.findIndex((line) => /^effort:(?:\s.*)?$/.test(line));
  if (effort) {
    if (effortLineIdx !== -1) {
      fmLines[effortLineIdx] = `effort: ${effort}`;
    } else {
      fmLines.splice(modelLineIdx + 1, 0, `effort: ${effort}`);
    }
  } else if (effortLineIdx !== -1) {
    fmLines.splice(effortLineIdx, 1);
  }

  const reconstructed = [
    lines[0],
    ...fmLines,
    ...lines.slice(closingIndex),
  ];
  return reconstructed.join(eol);
}
