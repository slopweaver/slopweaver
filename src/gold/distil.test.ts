import { describe, expect, it } from 'vitest'
import { buildDigestPrompt, distilBatch, distilBatches, reduceToSourceDigest, validateBatchDigest } from './distil.js'
import type { DistilBatch } from './distilGroup.js'
import type { BatchDigest } from './distil.js'
import type { LlmClient } from '../llm/provider.js'
import { unwrap } from '../lib/result.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec: CorpusRecord = { source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-06-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 'did a thing', refs: [] }
const batch: DistilBatch = { source: 'github', container: 'o/r', records: [rec], hash: 'h1' }

const clientReturning = (input: unknown): LlmClient => ({ complete: async () => ({ content: [{ type: 'tool_use', input }] }) })

describe('validateBatchDigest', () => {
  it('keeps only cited points and drops uncited ones', () => {
    const digest = unwrap(validateBatchDigest({ batch, input: { summary: 's', points: [{ point: 'p1', citations: ['u1'] }, { point: 'p2', citations: [] }] } }))
    expect(digest.points).toEqual([{ point: 'p1', citations: ['u1'] }])
  })

  it('errs when neither a summary nor a cited point survives', () => {
    expect(validateBatchDigest({ batch, input: { summary: '', points: [{ point: 'p', citations: [] }] } }).ok).toBe(false)
  })
})

describe('buildDigestPrompt', () => {
  it('includes the container and the record body', () => {
    const { user } = buildDigestPrompt({ batch })
    expect(user).toContain('Container: o/r')
    expect(user).toContain('did a thing')
  })
})

describe('distilBatch', () => {
  it('returns a validated digest from the client', async () => {
    const client = clientReturning({ summary: 'sum', points: [{ point: 'p', citations: ['u'] }] })
    expect(unwrap(await distilBatch({ batch, client })).summary).toBe('sum')
  })
})

describe('distilBatches', () => {
  it('serves a cache hit without calling the model', async () => {
    const cached: BatchDigest = { source: 'github', container: 'o/r', summary: 'cached', points: [] }
    const cache = new Map([['h1', cached]])
    const throwing: LlmClient = { complete: async () => { throw new Error('should not be called') } }
    const run = await distilBatches({ batches: [batch], cache, client: throwing })
    expect(run).toMatchObject({ called: 0, hits: 1 })
    expect(run.digests[0].summary).toBe('cached')
  })

  it('calls the model on a cache miss and caches the result', async () => {
    const cache = new Map<string, BatchDigest>()
    const run = await distilBatches({ batches: [batch], cache, client: clientReturning({ summary: 'fresh', points: [{ point: 'p', citations: ['u'] }] }) })
    expect(run.called).toBe(1)
    expect(cache.get('h1')!.summary).toBe('fresh')
  })
})

describe('reduceToSourceDigest', () => {
  it('orders containers by point count desc', () => {
    const thin: BatchDigest = { source: 'github', container: 'a', summary: 's', points: [{ point: 'p', citations: ['u'] }] }
    const rich: BatchDigest = { source: 'github', container: 'b', summary: 's', points: [{ point: 'p1', citations: ['u'] }, { point: 'p2', citations: ['u'] }] }
    const reduced = reduceToSourceDigest({ source: 'github', digests: [thin, rich], recordCount: 3 })
    expect(reduced.containers.map((c) => c.container)).toEqual(['b', 'a'])
  })
})
