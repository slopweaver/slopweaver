/**
 * The single source of truth for how a record is cited — used both when telling the model "cite as
 * (TOKEN)" and when validating the model's citations back. A record's token is a stable id the model can
 * echo; for GitHub that's the `sourceId` (`#42`). Pure.
 */
import type { CorpusRecord } from "../corpus/types.js";

/** A citation token parsed out of a URL (Slack channel, Linear issue), or undefined. */
export function tokenFromRef({ ref }: { ref: string }): string | undefined {
  const slack = /\/archives\/([A-Z0-9]+)/.exec(ref);
  if (slack?.[1] !== undefined) {
    return slack[1];
  }
  const linear = /\/issue\/([A-Za-z]+-\d+)/.exec(ref);
  if (linear?.[1] !== undefined) {
    return linear[1].toUpperCase();
  }
  return undefined;
}

/** The token a record is cited by: a token mined from its url, else its `sourceId`. */
export function citeToken({ record }: { record: CorpusRecord }): string {
  return tokenFromRef({ ref: record.url }) ?? record.sourceId;
}
