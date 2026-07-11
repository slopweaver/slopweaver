/**
 * Extract cross-references from a record's text — the raw edges the silver graph is built from. Pure,
 * deterministic. We capture the reference *classes* that survive across sources: issue/PR numbers
 * (`#123`), @mentions, ticket keys (`TEAM-123`), and bare URLs. Deduped, first-seen order preserved so
 * the output is stable across runs (stable output ⇒ stable fingerprints ⇒ correct dedup).
 */

const PATTERNS: readonly RegExp[] = [
  /#\d+/g, // issue / PR numbers
  /@[A-Za-z0-9][A-Za-z0-9-]{0,38}/g, // @mentions (GitHub-login shaped)
  /\b[A-Z][A-Z0-9]+-\d+\b/g, // ticket keys (TEAM-123)
  /https?:\/\/[^\s)<>"']+/g, // bare URLs
]

/**
 * Every distinct cross-reference in the text.
 *
 * @param text the content to scan
 * @returns the deduped references (grouped by class, then text position)
 */
export function extractRefs({ text }: { text: string }): readonly string[] {
  const seen = new Set<string>()
  for (const re of PATTERNS) {
    for (const match of text.matchAll(re)) {
      seen.add(match[0])
    }
  }
  return [...seen]
}
