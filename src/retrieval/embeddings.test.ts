import { describe, expect, it } from 'vitest'
import { embedInBatches, loadPipeline, resolveEmbedBatchSize, splitBatchVectors } from './embeddings.js'
import { unwrapErr } from '../lib/result.js'

describe('resolveEmbedBatchSize', () => {
  it('defaults, clamps, and rejects junk', () => {
    expect(resolveEmbedBatchSize({ raw: undefined })).toBe(16)
    expect(resolveEmbedBatchSize({ raw: '999' })).toBe(64)
    expect(resolveEmbedBatchSize({ raw: 'abc' })).toBe(16)
  })
})

describe('splitBatchVectors', () => {
  it('slices a flat tensor into per-text vectors', () => {
    const vectors = splitBatchVectors({ data: [1, 0, 0, 1], count: 2 })
    expect(vectors).toHaveLength(2)
    expect(Array.from(vectors[0])).toEqual([1, 0])
  })

  it('throws on a length mismatch', () => {
    expect(() => splitBatchVectors({ data: [1, 2, 3], count: 2 })).toThrow()
  })
})

describe('embedInBatches', () => {
  it('applies the prefix and batches through the injected run', async () => {
    const seen: string[][] = []
    const run = async (texts: readonly string[]) => { seen.push([...texts]); return { data: texts.flatMap(() => [1, 0]) } }
    const vectors = await embedInBatches({ texts: ['a', 'b', 'c'], run, batchSize: 2, prefix: 'P:' })
    expect(vectors).toHaveLength(3)
    expect(seen[0]).toEqual(['P:a', 'P:b'])
    expect(seen[1]).toEqual(['P:c'])
  })
})

describe('loadPipeline', () => {
  it('returns a typed error when the import fails (and does not throw)', async () => {
    const result = await loadPipeline({ importer: async () => { throw new Error('no binding') } })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result)[0]).toContain('embedder unavailable')
  })
})
