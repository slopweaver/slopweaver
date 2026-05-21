/**
 * UI-server sibling of `packages/mcp-server/src/tools/shape-evidence.ts`.
 *
 * The UI returns a different wire shape than the MCP tools (a flat
 * `EvidenceTailRow` rather than the contract `EvidenceLogEntry` with a
 * `Reference`), so we don't import the mcp-server helper directly — but
 * we *do* want the same defensive behaviour for malformed
 * `citation_url`: parse-fail downgrades to `null` rather than echoing
 * bad data to the client.
 *
 * Kept dep-free (uses the built-in `URL` constructor) so the UI package
 * doesn't pick up a `zod` dependency just for one URL safe-parse.
 */

/**
 * Returns the input URL if it parses as an absolute URL, else `null`.
 * Treats empty / null inputs as null so callers don't need to pre-check.
 * Uses Node 22's `URL.canParse` so we don't pay the cost of a thrown
 * Error for malformed inputs.
 */
export function safeCitationUrl(url: string | null): string | null {
  if (url === null || url.length === 0) return null;
  return URL.canParse(url) ? url : null;
}
