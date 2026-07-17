/**
 * PR-description format gate (logic). Every PR uses the schema in `.github/pull_request_template.md` +
 * AGENTS.md § Pull requests: a shields.io badge row, then an HTML Problem / Solution / Proof table where
 * Problem and Solution are each ≤ 50 words, and the Proof cell carries real evidence when graded silver or
 * gold (not just a present row — the proof goes IN the box, not in a comment). Pure `validatePrBody` for
 * tests + an IO edge (`runCheck`) that reads `$PR_BODY`. The tiny `check.ts` entry runs `runCheck`.
 */

/** Max words allowed in the Problem and Solution cells. Keeps descriptions lean. */
export const MAX_WORDS = 50;

export interface PrFormatResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Count human words in a table cell: drop HTML tags (`<img>`, `<strong>`, `<br>`, …) and markdown
 * noise, keep link text (not URLs).
 *
 * @param cell the table-cell content (HTML or markdown)
 * @returns the human word count
 */
export function countWords({ cell }: { cell: string }): number {
  const text = cell
    .replace(/<[^>]+>/g, " ") // strip HTML tags (img/strong/a/br/…)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/`([^`]*)`/g, "$1") // `code` -> code
    .replace(/[*_#>•|]/g, " ")
    .trim();
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/**
 * The content cell of a 2-column table row labelled `<label>`, or null if absent. Handles the canonical
 * HTML-table form (`<td>…Problem…</td><td>CONTENT</td>`) and a markdown-table fallback
 * (`| **Problem** | CONTENT |`). The capture group is guaranteed present when the regex matches, so a
 * non-null assertion is honest here (no empty-string fallback masking a miss).
 */
function tableCell({ body, label }: { body: string; label: string }): string | null {
  const html = new RegExp(
    `<td[^>]*>(?:(?!</td>)[\\s\\S])*?\\b${label}\\b(?:(?!</td>)[\\s\\S])*?</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    "i",
  );
  const htmlMatch = html.exec(body);
  if (htmlMatch !== null) {
    return htmlMatch[1]!.trim();
  }
  const md = new RegExp(`^\\|\\s*\\*\\*${label}\\*\\*\\s*\\|(.*?)\\|\\s*$`, "m");
  const mdMatch = md.exec(body);
  return mdMatch === null ? null : mdMatch[1]!.trim();
}

/** The proof grade from the shields.io `proof-<grade>` badge, or null when absent. */
function proofGrade({ body }: { body: string }): "bronze" | "silver" | "gold" | null {
  const match = /img\.shields\.io\/badge\/proof-(bronze|silver|gold)/i.exec(body);
  if (match === null) {
    return null;
  }
  // `as`: the capture is regex-constrained to exactly these three literals.
  return match[1]!.toLowerCase() as "bronze" | "silver" | "gold";
}

/** Whether a Proof cell carries real evidence — an image or a link (a screenshot, transcript, or run URL). */
function hasProofEvidence({ cell }: { cell: string }): boolean {
  const hasImage = /<img\b/i.test(cell) || /!\[[^\]]*\]\([^)]*\)/.test(cell);
  const hasLink = /\bhttps?:\/\/\S+/.test(cell) || /\[[^\]]+\]\(https?:[^)]*\)/.test(cell);
  return hasImage || hasLink;
}

/**
 * Pure: every way `body` violates the required PR format. Empty errors ⇒ conforms.
 *
 * @param body the PR description markdown
 * @returns `{ ok, errors }` — `ok` true when there are no violations
 */
export function validatePrBody({ body }: { body: string }): PrFormatResult {
  const errors: string[] = [];
  const normalised = body.replace(/\r\n/g, "\n");

  const hasMarkdownBadge = /!\[[^\]]*\]\(https:\/\/img\.shields\.io\//.test(normalised);
  const hasHtmlBadge = /<img[^>]+src="https:\/\/img\.shields\.io\//i.test(normalised);
  if (!hasMarkdownBadge && !hasHtmlBadge) {
    errors.push("No shields.io badge row found (need at least a `CI` badge — see the PR template).");
  }

  for (const label of ["Problem", "Solution"] as const) {
    const cell = tableCell({ body: normalised, label });
    if (cell === null) {
      errors.push(`Missing the **${label}** table row.`);
      continue;
    }
    const words = countWords({ cell });
    if (words > MAX_WORDS) {
      errors.push(
        `**${label}** is ${String(words)} words (max ${String(MAX_WORDS)}). Trim it; move detail to inline review comments.`,
      );
    }
  }

  const proofCell = tableCell({ body: normalised, label: "Proof" });
  if (proofCell === null || proofCell.length === 0) {
    errors.push("Missing/empty the **Proof** table row.");
  } else {
    const grade = proofGrade({ body: normalised });
    if ((grade === "silver" || grade === "gold") && !hasProofEvidence({ cell: proofCell })) {
      errors.push(
        `**Proof** is graded ${grade} but its cell has no evidence — put the screenshot/transcript or a run/PR link IN the Proof cell, not in a comment.`,
      );
    }
  }

  return { errors, ok: errors.length === 0 };
}

/** IO edge: read `$PR_BODY`, report, return 0 (conforms) or 1 (violation / no body). */
export function runCheck(): number {
  const body = process.env["PR_BODY"];
  if (body === undefined || body.trim().length === 0) {
    process.stderr.write("pr-format: $PR_BODY is empty — cannot validate the PR description.\n");
    return 1;
  }
  const { ok, errors } = validatePrBody({ body });
  if (ok) {
    process.stdout.write("pr-format: PR description conforms.\n");
    return 0;
  }
  process.stderr.write("pr-format: PR description does not conform:\n");
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  process.stderr.write("\nSee .github/pull_request_template.md and AGENTS.md § Pull requests.\n");
  return 1;
}
