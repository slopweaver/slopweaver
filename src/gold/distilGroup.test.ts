import { describe, expect, it } from 'vitest'
import { groupForDistil } from './distilGroup.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-06-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

describe('groupForDistil', () => {
  it('buckets by source+container into one batch with a 16-char content hash', () => {
    const batches = groupForDistil({ records: [rec({ sourceId: '#1' }), rec({ sourceId: '#2' })] })
    expect(batches).toHaveLength(1)
    expect(batches[0].records).toHaveLength(2)
    expect(batches[0].hash).toHaveLength(16)
  })

  it('gives a stable hash for identical content and a new hash when text changes', () => {
    const a = groupForDistil({ records: [rec({ text: 'v1' })] })[0].hash
    const same = groupForDistil({ records: [rec({ text: 'v1' })] })[0].hash
    const changed = groupForDistil({ records: [rec({ text: 'v2' })] })[0].hash
    expect(same).toBe(a)
    expect(changed).not.toBe(a)
  })

  it('chunks a bucket by maxPerBatch', () => {
    const batches = groupForDistil({ records: [rec({ sourceId: '#1' }), rec({ sourceId: '#2' })], maxPerBatch: 1 })
    expect(batches).toHaveLength(2)
  })

  it('recentOnly keeps a single batch of the newest records', () => {
    const batches = groupForDistil({
      records: [rec({ sourceId: '#old', tsIso: '2024-01-01T00:00:00Z' }), rec({ sourceId: '#new', tsIso: '2024-06-01T00:00:00Z' })],
      maxPerBatch: 1,
      recentOnly: true,
    })
    expect(batches).toHaveLength(1)
    expect(batches[0].records[0].sourceId).toBe('#new')
  })
})
