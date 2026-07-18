/**
 * Tokenise text for BM25. Pure. Lowercase, split on alphanumeric runs, drop very short tokens and a
 * small stopword set. Repeats are kept (BM25 needs term frequency).
 *
 * Plus an entity-id pass: whole tokens like `cli-2727` or `#12193` are appended verbatim (in ADDITION
 * to their split parts), so an exact-key query hits the rare whole token (high IDF) while a fuzzy query
 * still hits the split prefix.
 */

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "was",
  "are",
  "has",
  "have",
  "had",
  "not",
  "but",
  "you",
  "your",
  "our",
  "their",
  "its",
  "can",
  "will",
  "would",
  "should",
  "about",
  "into",
]);

const WORD = /[a-z0-9]+/g;
const ENTITY_ID = /\b[a-z][a-z0-9]{1,9}-\d+\b|#\d+\b/g;

/**
 * Tokenise text into BM25 terms.
 *
 * @param text the text to tokenise
 * @returns the tokens (repeats preserved)
 */
export function tokenise({ text }: { text: string }): readonly string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(WORD)) {
    const token = match[0];
    if (token.length >= 3 && !STOPWORDS.has(token)) {
      tokens.push(token);
    }
  }
  for (const match of lower.matchAll(ENTITY_ID)) {
    tokens.push(match[0]);
  }
  return tokens;
}
