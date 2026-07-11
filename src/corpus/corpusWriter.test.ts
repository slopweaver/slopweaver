import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCorpusRecords } from './corpusWriter.js'
import { readCorpusDir } from './corpusStore.js'
import { bronzeSourceDir } from './corpusPaths.js'
import { unwrap } from '../lib/result.js'
import type { CorpusRecord, ExportWindow } from './types.js'

const window: ExportWindow = { since: '2024-01-01', until: '2024-01-03' }
const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-02T00:00:00Z', kind: 'pr', container: 'o/r', text: 'hi', refs: [], ...over,
})

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-writer-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('writeCorpusRecords', () => {
  it('writes new records and redacts their text on disk', () => {
    const result = writeCorpusRecords({ records: [rec({ text: 'ping a@b.co' })], window, home })
    expect(unwrap(result).written).toBe(1)
    const back = readCorpusDir({ dir: bronzeSourceDir({ source: 'github', home }) })
    expect(unwrap(back)[0].text).toBe('ping [email]')
  })

  it('is idempotent — re-writing identical records dedups them', () => {
    writeCorpusRecords({ records: [rec()], window, home })
    const again = writeCorpusRecords({ records: [rec()], window, home })
    expect(unwrap(again)).toMatchObject({ written: 0, deduped: 1 })
  })

  it('writes a genuine update but drops a stale (older) re-fetch', () => {
    writeCorpusRecords({ records: [rec({ text: 'v1', tsIso: '2024-01-02T00:00:00Z' })], window, home })
    const updated = writeCorpusRecords({ records: [rec({ text: 'v2', tsIso: '2024-01-03T00:00:00Z' })], window, home })
    expect(unwrap(updated).written).toBe(1)
    const stale = writeCorpusRecords({ records: [rec({ text: 'v0', tsIso: '2024-01-01T00:00:00Z' })], window, home })
    expect(unwrap(stale).written).toBe(0)
  })
})
