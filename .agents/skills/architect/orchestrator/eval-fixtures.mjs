// Committed cycle plans for eval fixtures that review or escalate T-001 (T-036 / Р1). Frozen: the Architect owns the texts.
const planOf = (goal, task) => `# PLAN

## Goal / Requirements
${goal}

## Decisions (ADR)
- ADR-001: Base

## Frozen
- \`EXECUTOR.md\`

## Rules
Follow EXECUTOR.md

## Tasks
${task}`;

/** auto_refusal_git_c_retry: a complete low-risk contract, so «accepted» is the only correct verdict for x = 2. */
export const AUTO_REFUSAL_PLAN = planOf('Module `src/app.js` exports `x = 2`.', `- [ ] T-001: Value x = 2
  - Risk: low.
  - Depends on: —.
  - Read: src/app.js.
  - Change: src/app.js.
  - Task and invariants: in \`src/app.js\` replace \`export const x = 1;\` with \`export const x = 2;\`; do not modify other files.
  - Edge cases: —.
  - Test cases: —.
  - Done when: \`src/app.js\` contains exactly \`export const x = 2;\`, commit \`T-001: …\` modifies only \`src/app.js\`.
  - Verify: \`git show --stat HEAD\`.
`);

/** escalation_no_touch_change: the contract leaves the type of x open — exactly what the Executor escalates about. */
export const ESCALATION_PLAN = planOf('Module `src/app.js` exports `x` for module consumers.', `- [ ] T-001: Export x
  - Risk: low.
  - Depends on: —.
  - Read: src/app.js.
  - Change: src/app.js.
  - Task and invariants: \`src/app.js\` exports the constant \`x\`; do not modify other files.
  - Edge cases: —.
  - Test cases: —.
  - Done when: \`src/app.js\` exports \`x\`, commit \`T-001: …\` modifies only \`src/app.js\`.
  - Verify: \`git show --stat HEAD\`.
`);
