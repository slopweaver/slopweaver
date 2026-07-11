import { describe, expect, it } from 'vitest'
import { answerQuestion, retrieveRecords } from './askEngine.js'
import type { LlmClient } from '../llm/provider.js'
import { unwrap } from '../lib/result.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})
const records = [rec({ sourceId: '#1', text: 'authentication token flow' }), rec({ sourceId: '#2', text: 'deployment pipeline' })]

describe('retrieveRecords', () => {
  it('returns the BM25-ranked slice mapped back to records', () => {
    const slice = retrieveRecords({ question: 'authentication', records, sliceLimit: 5 })
    expect(slice.map((r) => r.sourceId)).toEqual(['#1'])
  })
})

describe('answerQuestion', () => {
  it('retrieves then composes an answer', async () => {
    const client: LlmClient = { complete: async () => ({ content: [{ type: 'tool_use', input: { tldr: 'auth flow (#1)', citations: ['#1'] } }] }) }
    const answer = unwrap(await answerQuestion({ question: 'authentication', client, records, sliceLimit: 5 }))
    expect(answer.used).toBe(1)
  })
})
