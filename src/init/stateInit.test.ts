import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runInit } from './stateInit.js'
import { stateHomePaths } from '../stateHome.js'
import { parseProfile } from '../profile.js'
import { unwrap } from '../lib/result.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-init-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** Recursive relative-path + content listing, sorted — for the idempotency round-trip comparison. */
function snapshot({ dir, base = dir }: { dir: string; base?: string }): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    const rel = full.slice(base.length + 1)
    if (entry.isDirectory()) {
      out.push(`dir  ${rel}`)
      out.push(...snapshot({ dir: full, base }))
    } else {
      out.push(`file ${rel} :: ${readFileSync(full, 'utf8')}`)
    }
  }
  return out
}

describe('runInit', () => {
  it('scaffolds the full layout and seeds valid files', () => {
    const report = runInit({ home })
    const p = stateHomePaths({ home })
    for (const dir of [p.corpus.bronze, p.corpus.silver, p.corpus.gold, p.corpus.cache, p.beliefs, p.ledgers, p.modelCache]) {
      expect(existsSync(dir)).toBe(true)
    }
    expect(JSON.parse(readFileSync(p.homeVersion, 'utf8'))).toEqual({ version: 1 })
    expect(parseProfile({ value: JSON.parse(readFileSync(p.profileJson, 'utf8')) }).ok).toBe(true)
    expect(JSON.parse(readFileSync(p.identityJson, 'utf8'))).toEqual([])
    // Everything below the (pre-existing temp) home root is freshly created on a first run.
    const belowRoot = report.entries.filter((e) => e.path !== report.home).map((e) => e.outcome)
    expect([...new Set(belowRoot)]).toEqual(['created'])
  })

  it('is idempotent — a second run creates nothing and leaves the tree byte-identical', () => {
    runInit({ home })
    const before = snapshot({ dir: home })
    const report = runInit({ home })
    const after = snapshot({ dir: home })
    expect(after).toEqual(before)
    expect([...new Set(report.entries.map((e) => e.outcome))]).toEqual(['existed'])
  })

  it('never overwrites a hand-edited seed file', () => {
    runInit({ home })
    const p = stateHomePaths({ home })
    const edited = { schemaVersion: 1, id: 'me', displayName: 'Edited', gitNamespace: 'octocat', sources: ['github'] }
    writeFileSync(p.profileJson, JSON.stringify(edited), 'utf8')
    const mtimeBefore = statSync(p.profileJson).mtimeMs
    runInit({ home })
    expect(unwrap(parseProfile({ value: JSON.parse(readFileSync(p.profileJson, 'utf8')) })).displayName).toBe('Edited')
    expect(statSync(p.profileJson).mtimeMs).toBe(mtimeBefore)
  })
})
