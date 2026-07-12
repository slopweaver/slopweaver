import { describe, expect, it } from 'vitest'
import { answerFromSlice, stripUnresolvedCitations, validateAnswer } from './answerFromSlice.js'
import type { LlmClient } from '../llm/provider.js'
import { unwrap } from '../lib/result.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec: CorpusRecord = { source: 'github', sourceId: '#1', url: 'u1', tsIso: 't', kind: 'pr', container: 'o/r', text: 'x', refs: [] }
const evidenceTokens = new Set(['#1'])
const urlByToken = new Map([['#1', 'u1']])

const toolClient = (input: unknown): LlmClient => ({ complete: async () => ({ content: [{ type: 'tool_use', input }] }) })

describe('stripUnresolvedCitations', () => {
  it('drops unresolved token parentheticals (incl. compound ids), keeps prose parentheticals', () => {
    expect(stripUnresolvedCitations({ text: 'a (#1) b (#99:comment:1) c (see note)', surviving: new Set(['#1']) }))
      .toBe('a (#1) b c (see note)')
  })
})

describe('validateAnswer', () => {
  it('keeps backed citations, drops invented ones, passes retrieved through', () => {
    const answer = unwrap(validateAnswer({ input: { tldr: 'found it (#1) and (#99)', citations: ['#1', '#99'] }, evidenceTokens, urlByToken, retrieved: 1 }))
    expect(answer.citations).toEqual(['u1'])
    expect(answer.used).toBe(1)
    expect(answer.retrieved).toBe(1)
    expect(answer.tldr).toBe('found it (#1) and')
  })

  it('captures a citation the model only wrote inline (empty citations[])', () => {
    const answer = unwrap(validateAnswer({ input: { tldr: 'grounded here (#1)', citations: [] }, evidenceTokens, urlByToken, retrieved: 1 }))
    expect(answer.citations).toEqual(['u1'])
    expect(answer.used).toBe(1)
  })

  it('errs on a malformed answer', () => {
    expect(validateAnswer({ input: { tldr: 5 }, evidenceTokens, urlByToken, retrieved: 1 }).ok).toBe(false)
  })
})

describe('answerFromSlice', () => {
  it('returns a "nothing matched" answer with retrieved 0 for an empty slice, without calling the model', async () => {
    const client: LlmClient = { complete: async () => { throw new Error('should not be called') } }
    const answer = unwrap(await answerFromSlice({ question: 'q', client, slice: [] }))
    expect(answer).toMatchObject({ used: 0, retrieved: 0 })
  })

  it('composes a grounded answer from the slice', async () => {
    const answer = unwrap(await answerFromSlice({ question: 'q', client: toolClient({ tldr: 'the answer (#1)', citations: ['#1'] }), slice: [rec] }))
    expect(answer.citations).toEqual(['u1'])
    expect(answer.retrieved).toBe(1)
  })

  it('lets a gold record ground a citation to an id it MENTIONS (the gold-digest case)', async () => {
    const gold: CorpusRecord = {
      source: 'gold', sourceId: 'gold:x#y', url: 'gold://gold:x#y', tsIso: 't', kind: 'finding', container: 'gold',
      title: 'Summary', text: 'PR #88 added the cache (#88:comment:2).', refs: [],
    }
    // The model cites #88:comment:2 — not gold's own token, but an id the gold record references.
    const answer = unwrap(await answerFromSlice({ question: 'q', client: toolClient({ tldr: 'cache added (#88:comment:2)', citations: ['#88:comment:2'] }), slice: [gold] }))
    expect(answer.used).toBe(1)
    expect(answer.citations).toEqual(['gold://gold:x#y'])
  })
})
