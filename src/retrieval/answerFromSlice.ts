/**
 * Compose a grounded answer from a retrieved slice via a forced-tool structured call over the keyless
 * `claude` transport. Grounding without over-stripping:
 *  - A citation survives only if its token is one the slice actually offered — the record's own cite
 *    token OR a cite-shaped token appearing INSIDE a sliced record (gold digests summarise and reference
 *    other records, so a gold record legitimately makes `#88` a citable evidence token). A truly invented
 *    citation — one in no sliced record — is still dropped.
 *  - Citations are gathered from BOTH the structured `citations[]` field and inline `(TOKEN)`s in the
 *    prose, so an answer that only cited inline still yields a citations block.
 *  - Any inline `(TOKEN)` whose token didn't survive is stripped, so the text never shows a citation the
 *    answer can't back.
 */
import { err, ok, type Result } from '../lib/result.js'
import { isRecord } from '../lib/parsers.js'
import { completeStructured } from '../llm/structuredComplete.js'
import type { JsonObjectSchema, LlmClient } from '../llm/provider.js'
import type { CorpusRecord } from '../corpus/types.js'
import { citeToken, tokenFromRef } from './citeToken.js'
import { buildPrompt, CITE_INLINE } from './askPrompt.js'

/** A record that made it into the retrieved slice, in the id spaces a caller may match against. */
export interface RetrievedRef {
  readonly sourceId: string
  /** The token the record is cited by (mined from its url, else its sourceId). */
  readonly token: string
  readonly url: string
}

export interface Answer {
  readonly tldr: string
  readonly details?: string
  /** Back-compat convenience: `tldr`, or `tldr\n\ndetails`. */
  readonly answer: string
  /** Source URLs the answer cites, first-appearance order. */
  readonly citations: readonly string[]
  /** The cited tokens (first-appearance order), the token-space twin of `citations`. */
  readonly citedTokens: readonly string[]
  /** Every record in the retrieved slice, so retrieval recall can be scored apart from citations. */
  readonly retrievedRefs: readonly RetrievedRef[]
  /** How many distinct records grounded the answer. */
  readonly used: number
  /** How many records were retrieved into the slice (0 = the query matched nothing). */
  readonly retrieved: number
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

/** Every cite-shaped token in a string: `#42`, `#42:comment:3`, `TEAM-9`, `gold:…`. */
const CITE_SHAPE = /#\d+(?::(?:review|comment|state)(?::\d+)?)?|\b[A-Z][A-Z0-9]+-\d+\b|gold:[^\s)]+/g

/** True when a parenthetical looks like a citation token (so normal prose parentheticals are left alone). */
function looksLikeToken({ inner }: { inner: string }): boolean {
  return new RegExp(`^(?:${CITE_SHAPE.source})$`).test(inner)
}

/**
 * The evidence a slice offers: every record's own cite token, plus every cite-shaped token appearing in
 * a sliced record's title/text/refs — each mapped to a URL (the record's own token wins over a mention).
 */
function buildEvidence({ slice }: { slice: readonly CorpusRecord[] }): { evidenceTokens: Set<string>; urlByToken: Map<string, string> } {
  const urlByToken = new Map<string, string>()
  for (const record of slice) {
    urlByToken.set(citeToken({ record }), record.url) // direct: the record IS the evidence
  }
  for (const record of slice) {
    const haystack = `${record.title ?? ''} ${record.text} ${record.refs.join(' ')}`
    for (const match of haystack.matchAll(CITE_SHAPE)) {
      if (!urlByToken.has(match[0])) {
        urlByToken.set(match[0], record.url) // mentioned in this record → grounded by it
      }
    }
  }
  return { evidenceTokens: new Set(urlByToken.keys()), urlByToken }
}

/** Map a retrieved slice to its per-record identifiers (sourceId, cite token, url). Pure. */
export function retrievedRefsFromSlice({ slice }: { slice: readonly CorpusRecord[] }): readonly RetrievedRef[] {
  return slice.map((record) => ({ sourceId: record.sourceId, token: citeToken({ record }), url: record.url }))
}

/** Normalise a model citation to its token. */
function citationToken({ citation }: { citation: string }): string {
  return tokenFromRef({ ref: citation }) ?? citation.trim()
}

/** The inline `(TOKEN)` citation tokens in a piece of prose. */
function inlineTokens({ text }: { text: string }): readonly string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(/\(([^()\s]+)\)/g)) {
    const inner = match[1] ?? ''
    if (looksLikeToken({ inner })) {
      tokens.push(inner)
    }
  }
  return tokens
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

/**
 * Validate + ground a model answer: keep only citations backed by the slice, strip invented inline ones.
 *
 * @param input the raw model output
 * @param evidenceTokens the tokens the slice offered to cite
 * @param urlByToken maps an evidence token to its source URL
 * @param retrievedRefs the records in the retrieved slice (their count is the reported `retrieved`)
 * @returns the grounded `Answer`, or an error (triggering a retry)
 */
export function validateAnswer(
  { input, evidenceTokens, urlByToken, retrievedRefs }: {
    input: unknown
    evidenceTokens: ReadonlySet<string>
    urlByToken: ReadonlyMap<string, string>
    retrievedRefs: readonly RetrievedRef[]
  },
): Result<Answer> {
  if (!isRecord(input) || typeof input.tldr !== 'string' || !Array.isArray(input.citations)) {
    return err(['answer must have a string tldr and a citations array'])
  }
  const details = typeof input.details === 'string' && input.details.trim().length > 0 ? input.details : undefined
  // Candidate tokens: the structured citations[] AND anything cited inline in the prose.
  const structured = input.citations.filter((c): c is string => typeof c === 'string').map((c) => citationToken({ citation: c }))
  const inline = [...inlineTokens({ text: input.tldr }), ...(details !== undefined ? inlineTokens({ text: details }) : [])]
  // `surviving` = every grounded token (so valid inline cites are kept in the prose); `citations` =
  // the distinct source URLs those tokens point to (several tokens can share one record's URL).
  const surviving = new Set<string>()
  const citations: string[] = []
  const citedTokens: string[] = []
  const seenUrls = new Set<string>()
  for (const token of [...structured, ...inline]) {
    const url = urlByToken.get(token)
    if (!evidenceTokens.has(token) || url === undefined) {
      continue
    }
    if (!surviving.has(token)) {
      surviving.add(token)
      citedTokens.push(token)
    }
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      citations.push(url)
    }
  }
  const tldr = stripUnresolvedCitations({ text: input.tldr, surviving })
  const strippedDetails = details !== undefined ? stripUnresolvedCitations({ text: details, surviving }) : undefined
  const answer = strippedDetails !== undefined && strippedDetails.length > 0 ? `${tldr}\n\n${strippedDetails}` : tldr
  return ok({
    tldr,
    ...(strippedDetails !== undefined && strippedDetails.length > 0 ? { details: strippedDetails } : {}),
    answer,
    citations,
    citedTokens,
    retrievedRefs,
    used: citations.length,
    retrieved: retrievedRefs.length,
  })
}

/**
 * Answer a question from a retrieved slice.
 *
 * @param question the user's question
 * @param client the LLM transport
 * @param slice the retrieved records
 * @returns the grounded answer (empty slice ⇒ a "nothing matched" answer with `retrieved: 0`, not an error)
 */
export async function answerFromSlice(
  { question, client, slice }: { question: string; client: LlmClient; slice: readonly CorpusRecord[] },
): Promise<Result<Answer>> {
  if (slice.length === 0) {
    const tldr = 'No records in the world model matched that question.'
    return ok({ tldr, answer: tldr, citations: [], citedTokens: [], retrievedRefs: [], used: 0, retrieved: 0 })
  }
  const retrievedRefs = retrievedRefsFromSlice({ slice })
  const { evidenceTokens, urlByToken } = buildEvidence({ slice })
  const { system, user } = buildPrompt({ question, slice })
  return completeStructured({
    request: { system, user, toolName: 'emit_answer', toolDescription: 'Emit the grounded answer.', schema: ANSWER_SCHEMA },
    client,
    validate: (input) => validateAnswer({ input, evidenceTokens, urlByToken, retrievedRefs }),
  })
}
