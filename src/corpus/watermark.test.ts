import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advanceWatermark, computeSourceWatermarks, readWatermark, resolveSince } from './watermark.js'

describe('computeSourceWatermarks', () => {
  it('takes the max observed tsIso per source', () => {
    const marks = computeSourceWatermarks({
      records: [
        { source: 'github', tsIso: '2024-01-02T00:00:00Z' },
        { source: 'github', tsIso: '2024-01-05T00:00:00Z' },
      ],
      fallbackUntil: '2024-01-09',
    })
    expect(marks).toEqual([{ source: 'github', cursor: '2024-01-05T00:00:00Z' }])
  })
})

describe('resolveSince', () => {
  it('slices a cursor to a date, else uses the fallback', () => {
    expect(resolveSince({ cursor: '2024-01-05T09:30:00Z', fallbackSince: 'fb' })).toBe('2024-01-05')
    expect(resolveSince({ cursor: undefined, fallbackSince: 'fb' })).toBe('fb')
  })
})

describe('advanceWatermark', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-wm-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('persists a cursor and never regresses it (MAX merge)', () => {
    advanceWatermark({ watermarks: [{ source: 'github', cursor: '2024-01-05T00:00:00Z' }], home })
    expect(readWatermark({ source: 'github', home })).toBe('2024-01-05T00:00:00Z')
    advanceWatermark({ watermarks: [{ source: 'github', cursor: '2024-01-03T00:00:00Z' }], home })
    expect(readWatermark({ source: 'github', home })).toBe('2024-01-05T00:00:00Z')
  })
})
