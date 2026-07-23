/**
 * Generic PII / secret scrubbing, applied to a record's free text before it is written to disk. Pure,
 * deterministic, no I/O. This is defence-in-depth: content ingested from a repo can carry a leaked
 * token or an email in a comment, and the corpus is meant to be shareable, so we neutralise the common
 * classes here rather than trust every upstream author.
 *
 * It deliberately preserves graph-edge tokens — `@mention`, `#123`, `TEAM-123` — so cross-referencing
 * still works after redaction. Order matters: secrets run first (a token can contain `@` and digits, so
 * scrubbing it first stops the email/number passes from carving it up).
 */

export type RedactionCategory = "token" | "email" | "number";

interface Pass {
  readonly category: RedactionCategory;
  readonly re: RegExp;
  readonly replacement: string;
}

/** Ordered passes. Secret shapes first, then emails, then long digit runs. */
const PASSES: readonly Pass[] = [
  { category: "token", re: /xox[bp]-[A-Za-z0-9-]{10,}/g, replacement: "[token]" },
  { category: "token", re: /gh[posr]_[A-Za-z0-9]{20,}/g, replacement: "[token]" },
  { category: "token", re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[token]" },
  { category: "token", re: /\bsecret_[A-Za-z0-9]{16,}/g, replacement: "[token]" },
  { category: "token", re: /\bsk-[A-Za-z0-9]{20,}/g, replacement: "[token]" },
  { category: "token", re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g, replacement: "[token]" },
  { category: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, replacement: "[email]" },
  { category: "number", re: /\d{9,}/g, replacement: "[number]" },
];

/**
 * Redact a string, returning the scrubbed text and which categories fired (deduped, in pass order).
 *
 * @param text the raw text to scrub
 * @returns the scrubbed text and the categories that matched
 */
export function redactText({ text }: { text: string }): { text: string; redactions: readonly RedactionCategory[] } {
  return applyPasses({ passes: PASSES, text });
}

/**
 * Scrub only the SECRET classes (tokens + long digit runs), deliberately PRESERVING emails. Member bronze
 * captures each person's email as the cross-source join key (D8) and lives off-repo under `$SLOPWEAVER_HOME`,
 * so the email-scrubbing {@link redactText} would destroy the very field member hydration exists to keep —
 * while tokens/secrets must still never touch disk.
 *
 * @param text the raw text to scrub
 * @returns the scrubbed text (emails intact) and the categories that matched
 */
export function redactSecrets({ text }: { text: string }): { text: string; redactions: readonly RedactionCategory[] } {
  return applyPasses({ passes: PASSES.filter((pass) => pass.category !== "email"), text });
}

/** Apply an ordered pass list to text, tracking which categories fired (deduped, in pass order). Pure. */
function applyPasses({ passes, text }: { passes: readonly Pass[]; text: string }): {
  text: string;
  redactions: readonly RedactionCategory[];
} {
  let out = text;
  const fired: RedactionCategory[] = [];
  for (const { category, re, replacement } of passes) {
    // `String.replace` with a global regex is stateless (resets lastIndex), so no `.test()` footgun.
    const next = out.replace(re, replacement);
    if (next !== out && !fired.includes(category)) {
      fired.push(category);
    }
    out = next;
  }
  return { redactions: fired, text: out };
}
