import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGoldRecords } from './goldRecords.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-gold-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('readGoldRecords', () => {
  it('reads one record per ## section with stable ids', () => {
    const dir = join(home, 'warehouse', 'gold')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'overview.md'), '# World model\n\n## Busiest containers\n\nslopweaver is busy\n\n## Owners\n\nalice owns it\n', 'utf8')
    const records = readGoldRecords({ home, tsIso: '2026-01-01T00:00:00Z' })
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ source: 'gold', kind: 'finding', sourceId: 'gold:overview.md#busiest-containers', container: 'gold' })
    expect(records[0].title).toBe('World model — Busiest containers')
  })

  it('returns [] when there is no gold dir', () => {
    expect(readGoldRecords({ home, tsIso: 't' })).toEqual([])
  })
})
