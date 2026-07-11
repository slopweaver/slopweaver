/**
 * Shared CLI exit-code vocabulary.
 *
 * Most verbs follow the Unix convention: `0` = success, non-zero = something went wrong. But a
 * reliability harness that reads every non-zero exit as a verb FAULT over-counts two legitimate
 * non-zero shapes that are the verb working exactly as designed:
 *
 *  - `EXIT_USAGE` (2): the caller passed wrong/incomplete args; the verb refused and printed usage
 *    BEFORE its act phase. A caller mistake, not a verb malfunction.
 *  - `EXIT_EXPECTED_EMPTY` (3): the verb ran its full pipeline and is reporting a legitimate
 *    non-success STATUS — no results, nothing to do, a prerequisite absent. The non-zero exit is the
 *    SIGNAL (so `verb || alert` still fires), not a fault.
 *
 * A code-`1` exit stays the "genuine runtime fault" channel (an unexpected error, a crash, a write
 * that failed). Keeping the meanings distinct lets a caller separate "this verb is flaky" from "this
 * verb correctly told me there was nothing to do".
 */

/** Success. */
export const EXIT_OK = 0

/** A genuine runtime fault. */
export const EXIT_ERROR = 1

/** Arg/usage rejection: the verb refused a wrong/incomplete invocation before its act phase. */
export const EXIT_USAGE = 2

/**
 * Expected-empty / nothing-to-do / prerequisite-absent / legitimate-non-success-status. The verb ran
 * correctly; the non-zero exit is a deliberate signal, not a fault.
 */
export const EXIT_EXPECTED_EMPTY = 3
