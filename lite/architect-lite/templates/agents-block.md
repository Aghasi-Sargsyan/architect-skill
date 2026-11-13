## Engineering rules (architect-lite)

- **Sizeable changes start with agreement.** For a new feature, a data-model change, or anything expensive to undo: read `docs/decisions.md`, propose options, and wait for approval before editing files. `/architect-lite` runs this pass.
- **Decisions are recorded.** Add each design decision to `docs/decisions.md` (one line if reversible; chosen, rejected, why, and revisit trigger if not). Do not silently contradict a recorded decision; raise the conflict.
- **Risk areas:** `<paths or topics: money, access control, migrations, concurrency, personal data>`. In these areas, tests with expected outcomes are written before the implementation, and their expected values are not edited to make them pass.
- **No check bypasses:** do not skip, focus, or delete tests, disable type checks, or commit with `--no-verify`.
- **Done means verified.** Run `<verification command>` before calling work done. Anything not run or not confirmed is reported as `NOT VERIFIED`, never as passed.
