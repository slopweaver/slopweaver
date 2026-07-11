import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDistilCache, saveDistilCache } from './distilCache.js'
import type { BatchDigest } from './distil.js'

const digest: BatchDigest = { source: 'github', container: 'o/r', summary: 's', points: [{ point: 'p', citations: ['u'] }] }

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-cache-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('distilCache', () => {
  it('round-trips digests through save + load', () => {
    saveDistilCache({ cache: new Map([['h1', digest]]), home })
    const loaded = loadDistilCache({ home })
    expect(loaded.get('h1')).toEqual(digest)
  })

  it('loads an empty cache when there is no file', () => {
    expect(loadDistilCache({ home }).size).toBe(0)
  })
})
