/**
 * Pure xoxc-token extraction from a dump of Slack's browser-side
 * localStorage. The Slack web client stores a workspace user token in
 * `localStorage[localConfig_v2]` (and a handful of other keys
 * depending on workspace tier). The token has the shape `xoxc-<digits>-...`.
 *
 * This module intentionally takes the dump as a plain string array
 * (or a JSON object whose string values get scanned) so the actual
 * Playwright drive-loop lives in the skill body, not in compiled code.
 * The unit suite then locks the regex behaviour without bringing the
 * browser into the tests.
 */

/**
 * Anchored xoxc token shape. Matches `xoxc-` followed by ASCII
 * alphanumerics and dashes only (the documented token grammar). The
 * `+` ensures we never return a bare `xoxc-` prefix with no payload.
 */
const XOXC_TOKEN_PATTERN = /xoxc-[A-Za-z0-9-]+/;

/**
 * Find the first xoxc token in a list of localStorage values. Returns
 * `null` when nothing matches. Whitespace inside individual values is
 * not significant; the pattern itself is anchored on the `xoxc-` prefix
 * and only consumes the alphanumeric run that follows.
 */
export function findXoxcInValues({ values }: { values: ReadonlyArray<string> }): string | null {
  for (const value of values) {
    const match = XOXC_TOKEN_PATTERN.exec(value);
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * Walk a parsed JSON-like dump (an object, array, or scalar) and
 * collect every string-typed leaf, then run `findXoxcInValues` over
 * the collection. Convenience for callers that have a JSON snapshot
 * of `localStorage` keyed by key name rather than a flat values list.
 */
export function findXoxcInDump({ dump }: { dump: unknown }): string | null {
  const values: string[] = [];
  collectStrings(dump, values);
  return findXoxcInValues({ values });
}

function collectStrings(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, sink);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, sink);
  }
}
