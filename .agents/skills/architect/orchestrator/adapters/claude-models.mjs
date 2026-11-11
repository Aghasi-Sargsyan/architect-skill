// Claude Code model ids with an optional effort suffix: `<alias>-<effort>` maps to `--model <alias> --effort <effort>`.

/** Claude Code model aliases, in listing order (the first three keep their historical positions). */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];

/** Effort levels accepted by `claude --effort` and by the `effort` field of `.claude/agents/*.md`. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Models offered by the `claude` runner.
 * First the plain aliases in `CLAUDE_MODEL_ALIASES` order (`{ id: 'sonnet', name: 'Claude Sonnet' }`, ...),
 * then, for each alias in the same order, one entry per level in `CLAUDE_EFFORT_LEVELS` order:
 * `{ id: '<alias>-<level>', name: 'Claude <Alias> (<Level>)' }` where `<Level>` is
 * `Low`, `Medium`, `High`, `XHigh` or `Max`. 24 entries in total, ids unique.
 * @returns {Array<{ id: string, name: string }>}
 */
export function listClaudeModels() {
  throw new Error('Not implemented: listClaudeModels');
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
  throw new Error(`Not implemented: splitClaudeModel(${id})`);
}

/**
 * CLI arguments for `claude -p`: `['--model', model]`, plus `['--effort', effort]` when `splitClaudeModel`
 * returns an effort. Throws the same `TypeError` as `splitClaudeModel` for an invalid id.
 * @param {string} id
 * @returns {string[]}
 */
export function claudeModelArgs(id) {
  throw new Error(`Not implemented: claudeModelArgs(${id})`);
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
  throw new Error(`Not implemented: syncClaudeAgentFile(${text.length}, ${id})`);
}
