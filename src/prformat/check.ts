/**
 * PR-description format gate. Every PR in this repo uses the schema in `.github/pull_request_template.md`
 * and AGENTS.md § Pull requests: a shields.io badge row, then an HTML Problem / Solution / Proof table
 * where Problem and Solution are each at most 50 words. This module is the enforcer — pure `validatePrBody`
 * for tests, plus an IO edge that reads `$PR_BODY` (the PR body, passed by CI) and exits non-zero on any
 * violation. Runs in CI via `yarn check:pr-format`.
 */

/** Max words allowed in the Problem and Solution cells. Keeps descriptions lean. */
export const MAX_WORDS = 50

export interface PrFormatResult {
  readonly ok: boolean
  readonly errors: readonly string[]
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
    .replace(/<[^>]+>/g, ' ') // strip HTML tags (img/strong/a/br/…)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/`([^`]*)`/g, '$1') // `code` -> code
    .replace(/[*_#>•|]/g, ' ')
    .trim()
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

/**
 * The content cell of a 2-column table row labelled `<label>`, or null if absent. Handles the canonical
 * HTML-table form (`<td>…Problem…</td><td>CONTENT</td>`) and a markdown-table fallback
 * (`| **Problem** | CONTENT |`).
 */
function tableCell({ body, label }: { body: string; label: string }): string | null {
  const html = new RegExp(
    `<td[^>]*>(?:(?!</td>)[\\s\\S])*?\\b${label}\\b(?:(?!</td>)[\\s\\S])*?</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    'i',
  )
  const htmlMatch = html.exec(body)
  if (htmlMatch !== null) {
    return (htmlMatch[1] ?? '').trim()
  }
  const md = new RegExp(`^\\|\\s*\\*\\*${label}\\*\\*\\s*\\|(.*?)\\|\\s*$`, 'm')
  const mdMatch = md.exec(body)
  return mdMatch === null ? null : (mdMatch[1] ?? '').trim()
}

/**
 * Pure: every way `body` violates the required PR format. Empty errors ⇒ conforms.
 *
 * @param body the PR description markdown
 * @returns `{ ok, errors }` — `ok` true when there are no violations
 */
export function validatePrBody({ body }: { body: string }): PrFormatResult {
  const errors: string[] = []
  const normalised = body.replace(/\r\n/g, '\n')

  const hasMarkdownBadge = /!\[[^\]]*\]\(https:\/\/img\.shields\.io\//.test(normalised)
  const hasHtmlBadge = /<img[^>]+src="https:\/\/img\.shields\.io\//i.test(normalised)
  if (!hasMarkdownBadge && !hasHtmlBadge) {
    errors.push('No shields.io badge row found (need at least a `CI` badge — see the PR template).')
  }

  for (const label of ['Problem', 'Solution'] as const) {
    const cell = tableCell({ body: normalised, label })
    if (cell === null) {
      errors.push(`Missing the **${label}** table row.`)
      continue
    }
    const words = countWords({ cell })
    if (words > MAX_WORDS) {
      errors.push(`**${label}** is ${String(words)} words (max ${String(MAX_WORDS)}). Trim it; move detail to inline review comments.`)
    }
  }

  if (tableCell({ body: normalised, label: 'Proof' }) === null) {
    errors.push('Missing the **Proof** table row.')
  }

  return { ok: errors.length === 0, errors }
}

/** IO edge: read `$PR_BODY`, report, return 0 (conforms) or 1 (violation / no body). */
export function runCheck(): number {
  const body = process.env.PR_BODY
  if (body === undefined || body.trim().length === 0) {
    process.stderr.write('pr-format: $PR_BODY is empty — cannot validate the PR description.\n')
    return 1
  }
  const { ok, errors } = validatePrBody({ body })
  if (ok) {
    process.stdout.write('pr-format: PR description conforms.\n')
    return 0
  }
  process.stderr.write('pr-format: PR description does not conform:\n')
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`)
  }
  process.stderr.write('\nSee .github/pull_request_template.md and AGENTS.md § Pull requests.\n')
  return 1
}

const isDirectInvocation = import.meta.url.endsWith(process.argv[1] ?? '')
  || import.meta.url === `file://${process.argv[1] ?? ''}`
if (isDirectInvocation) {
  process.exit(runCheck())
}
