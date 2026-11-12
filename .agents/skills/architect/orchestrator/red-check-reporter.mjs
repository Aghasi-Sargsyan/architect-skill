// node --test reporter for the red-check (ADR-073, C-34): separates failed test cases from failures of the whole file.

const MAX_MESSAGE = 200;

/**
 * Custom `node --test` reporter (async generator over test-runner events, no dependencies).
 * Yields exactly one line after the source ends:
 *   `ARCHITECT_RED_CHECK <json>\n` with json = {
 *     caseFailures:  [{ name, errorName, code, message }],   // test:fail, failureType 'testCodeFailure' and
 *                                                            // details.error.cause is a non-null object
 *     otherFailures: [{ name, failureType, message }],       // every other test:fail except failureType
 *   }                                                         // 'subtestsFailed' (suite aggregate, ignored)
 * A failure of the whole file (top-level throw, process.exit, load error) arrives as testCodeFailure whose
 * cause is the string 'test failed' — it is an otherFailure. `errorName` = cause.name ?? 'Error',
 * `code` = cause.code ?? null, `message` = String(cause.message ?? error.message ?? '') cut to 200 chars.
 * @param {AsyncIterable<{ type: string, data: object }>} source
 * @returns {AsyncGenerator<string>}
 */
export default async function* redCheckReporter(source) {
  const caseFailures = [];
  const otherFailures = [];
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data?.details?.error;
    const failureType = error?.failureType;
    if (failureType === 'subtestsFailed') continue;
    const name = event.data?.name;
    const cause = error?.cause;
    if (failureType === 'testCodeFailure' && typeof cause === 'object' && cause !== null) {
      caseFailures.push({
        name,
        errorName: cause.name ?? 'Error',
        code: cause.code ?? null,
        message: String(cause.message ?? error.message ?? '').slice(0, MAX_MESSAGE),
      });
    } else {
      otherFailures.push({ name, failureType, message: String(error?.message ?? '').slice(0, MAX_MESSAGE) });
    }
  }
  yield `ARCHITECT_RED_CHECK ${JSON.stringify({ caseFailures, otherFailures })}\n`;
}
