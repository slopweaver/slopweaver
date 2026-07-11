/**
 * PR-description format gate. Every PR in this repo uses the schema in `.github/pull_request_template.md`
 * and AGENTS.md § Pull requests: a shields.io badge row, then a Problem / Solution / Proof table where
 * Problem and Solution are each at most 50 words. This module is the enforcer — pure `validatePrBody`
 * for tests, plus an IO edge that reads `$PR_BODY` (the PR body, passed by CI) and exits non-zero on any
 * violation. Runs in CI via `yarn check:pr-format`.
 */

/** Max words allowed in the Problem and Solution cells. Keeps descriptions lean. */
export const MAX_WORDS = 50

export interface PrFormatResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/** Count human words in a table cell: drop `<br>`, keep link text (not URLs), strip markdown noise. */
export function countWords(cell: string): number {
  const text = cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/`([^`]*)`/g, '$1') // `code` -> code
    .replace(/[*_#>•|]/g, ' ')
    .trim()
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

/** The cell text of a 2-column table row whose label is `**<label>**`, or null if the row is absent. */
function tableCell(body: string, label: string): string | null {
  const re = new RegExp(`^\\|\\s*\\*\\*${label}\\*\\*\\s*\\|(.*?)\\|\\s*$`, 'm')
  const match = re.exec(body)
  return match === null ? null : (match[1] ?? '').trim()
}

/** Pure: every way `body` violates the required PR format. Empty errors ⇒ conforms. */
export function validatePrBody(body: string): PrFormatResult {
  const errors: string[] = []
  const normalised = body.replace(/\r\n/g, '\n')

  if (!/!\[[^\]]*\]\(https:\/\/img\.shields\.io\//.test(normalised)) {
    errors.push('No shields.io badge row found (need at least a `CI` badge — see the PR template).')
  }

  for (const label of ['Problem', 'Solution'] as const) {
    const cell = tableCell(normalised, label)
    if (cell === null) {
      errors.push(`Missing the **${label}** table row.`)
      continue
    }
    const words = countWords(cell)
    if (words > MAX_WORDS) {
      errors.push(`**${label}** is ${String(words)} words (max ${String(MAX_WORDS)}). Trim it; move detail to inline review comments.`)
    }
  }

  if (tableCell(normalised, 'Proof') === null) {
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
  const { ok, errors } = validatePrBody(body)
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
