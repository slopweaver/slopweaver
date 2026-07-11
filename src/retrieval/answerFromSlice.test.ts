import { describe, expect, it } from 'vitest'
import { answerFromSlice, stripUnresolvedCitations, validateAnswer } from './answerFromSlice.js'
import type { LlmClient } from '../llm/provider.js'
import { unwrap } from '../lib/result.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec: CorpusRecord = { source: 'github', sourceId: '#1', url: 'u1', tsIso: 't', kind: 'pr', container: 'o/r', text: 'x', refs: [] }
const evidenceTokens = new Set(['#1'])
const urlByToken = new Map([['#1', 'u1']])

describe('stripUnresolvedCitations', () => {
  it('drops inline tokens that did not survive, keeps prose parentheticals', () => {
    expect(stripUnresolvedCitations({ text: 'a (#1) b (#99) c (see note)', surviving: new Set(['#1']) })).toBe('a (#1) b c (see note)')
  })
})

describe('validateAnswer', () => {
  it('keeps real citations, drops hallucinated ones, strips their inline tokens', () => {
    const answer = unwrap(validateAnswer({ input: { tldr: 'found it (#1) and (#99)', citations: ['#1', '#99'] }, evidenceTokens, urlByToken }))
    expect(answer.citations).toEqual(['u1'])
    expect(answer.used).toBe(1)
    expect(answer.tldr).toBe('found it (#1) and')
  })

  it('errs on a malformed answer', () => {
    expect(validateAnswer({ input: { tldr: 5 }, evidenceTokens, urlByToken }).ok).toBe(false)
  })
})

describe('answerFromSlice', () => {
  it('returns a "nothing matched" answer for an empty slice without calling the model', async () => {
    const client: LlmClient = { complete: async () => { throw new Error('should not be called') } }
    const answer = unwrap(await answerFromSlice({ question: 'q', client, slice: [] }))
    expect(answer.used).toBe(0)
  })

  it('composes a grounded answer from the slice', async () => {
    const client: LlmClient = { complete: async () => ({ content: [{ type: 'tool_use', input: { tldr: 'the answer (#1)', citations: ['#1'] } }] }) }
    const answer = unwrap(await answerFromSlice({ question: 'q', client, slice: [rec] }))
    expect(answer.used).toBe(1)
    expect(answer.citations).toEqual(['u1'])
  })
})
