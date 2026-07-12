/**
 * Compose a grounded answer from a retrieved slice via a forced-tool structured call over the keyless
 * `claude` transport. Two grounding guards:
 *  1. a model citation survives only if its token is one the slice actually offered (`evidenceTokens`) —
 *     a hallucinated/invented citation is dropped;
 *  2. any inline `(TOKEN)` in the prose whose token didn't survive is stripped, so the text never shows
 *     a citation the answer can't back.
 */
import { err, ok, type Result } from '../lib/result.js'
import { isRecord } from '../lib/parsers.js'
import { completeStructured } from '../llm/structuredComplete.js'
import type { JsonObjectSchema, LlmClient } from '../llm/provider.js'
import type { CorpusRecord } from '../corpus/types.js'
import { citeToken, tokenFromRef } from './citeToken.js'
import { buildPrompt, CITE_INLINE } from './askPrompt.js'

export interface Answer {
  readonly tldr: string
  readonly details?: string
  /** Back-compat convenience: `tldr`, or `tldr\n\ndetails`. */
  readonly answer: string
  /** Source-record URLs the answer cites, first-appearance order. */
  readonly citations: readonly string[]
  /** How many distinct records grounded the answer (0 = nothing matched / nothing survived). */
  readonly used: number
}

export const ANSWER_SCHEMA: JsonObjectSchema = {
  type: 'object',
  properties: {
    tldr: { type: 'string', description: `A short, direct lead answer. ${CITE_INLINE}` },
    details: { type: 'string', description: `Optional longer body. ${CITE_INLINE}` },
    citations: { type: 'array', items: { type: 'string' }, description: 'The (TOKEN) values you cited, verbatim.' },
  },
  required: ['tldr', 'citations'],
}

/** A parenthetical that looks like a citation token (so normal prose parentheticals are left alone). */
function looksLikeToken({ inner }: { inner: string }): boolean {
  return /^#\d+$/.test(inner) || /^[A-Za-z]+-\d+$/.test(inner) || /^[A-Z0-9]{6,}$/.test(inner) || inner.startsWith('gold:')
}

/** Strip inline `(TOKEN)` citations whose token didn't survive; tidy whitespace. */
export function stripUnresolvedCitations({ text, surviving }: { text: string; surviving: ReadonlySet<string> }): string {
  return text
    .replace(/\(([^()\s]+)\)/g, (match, inner: string) =>
      surviving.has(inner) || !looksLikeToken({ inner }) ? match : '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .trim()
}

/** Normalise a model citation to its token. */
function citationToken({ citation }: { citation: string }): string {
  return tokenFromRef({ ref: citation }) ?? citation.trim()
}

/**
 * Validate + ground a model answer: keep only real citations, strip hallucinated inline tokens.
 *
 * @param input the raw model output
 * @param evidenceTokens the tokens the slice offered to cite
 * @param urlByToken maps a surviving token to its record URL
 * @returns the grounded `Answer`, or an error (triggering a retry)
 */
export function validateAnswer(
  { input, evidenceTokens, urlByToken }: { input: unknown; evidenceTokens: ReadonlySet<string>; urlByToken: ReadonlyMap<string, string> },
): Result<Answer> {
  if (!isRecord(input) || typeof input.tldr !== 'string' || !Array.isArray(input.citations)) {
    return err(['answer must have a string tldr and a citations array'])
  }
  const survivingTokens: string[] = []
  const citations: string[] = []
  for (const raw of input.citations) {
    if (typeof raw !== 'string') {
      continue
    }
    const token = citationToken({ citation: raw })
    const url = urlByToken.get(token)
    if (evidenceTokens.has(token) && url !== undefined && !survivingTokens.includes(token)) {
      survivingTokens.push(token)
      citations.push(url)
    }
  }
  const surviving = new Set(survivingTokens)
  const tldr = stripUnresolvedCitations({ text: input.tldr, surviving })
  const details = typeof input.details === 'string' && input.details.trim().length > 0
    ? stripUnresolvedCitations({ text: input.details, surviving })
    : undefined
  const answer = details !== undefined && details.length > 0 ? `${tldr}\n\n${details}` : tldr
  return ok({ tldr, ...(details !== undefined && details.length > 0 ? { details } : {}), answer, citations, used: survivingTokens.length })
}

/**
 * Answer a question from a retrieved slice.
 *
 * @param question the user's question
 * @param client the LLM transport
 * @param slice the retrieved records
 * @returns the grounded answer (empty slice ⇒ a "nothing matched" answer, not an error)
 */
export async function answerFromSlice(
  { question, client, slice }: { question: string; client: LlmClient; slice: readonly CorpusRecord[] },
): Promise<Result<Answer>> {
  if (slice.length === 0) {
    const tldr = 'No records in the world model matched that question.'
    return ok({ tldr, answer: tldr, citations: [], used: 0 })
  }
  const evidenceTokens = new Set(slice.map((record) => citeToken({ record })))
  const urlByToken = new Map(slice.map((record) => [citeToken({ record }), record.url]))
  const { system, user } = buildPrompt({ question, slice })
  return completeStructured({
    request: { system, user, toolName: 'emit_answer', toolDescription: 'Emit the grounded answer.', schema: ANSWER_SCHEMA },
    client,
    validate: (input) => validateAnswer({ input, evidenceTokens, urlByToken }),
  })
}
