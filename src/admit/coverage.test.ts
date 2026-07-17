import { describe, expect, it } from 'vitest'

import { analyzeCoverage, type SourceFile } from './coverage.js'
import { lazy } from '../cli/manifest.js'
import type { CommandMeta } from '../cli/defineCommand.js'
import type { NounGroups } from '../cli/router.js'
import type { DoorEffect } from './types.js'

/** A complete CommandMeta fixture varying only the door-relevant fields. */
function metaWith({ effect, doorRouted = false }: { effect: DoorEffect; doorRouted?: boolean }): CommandMeta {
  return {
    summary: 's', usage: 'u', example: null,
    requiresApproval: false, createsWorkItem: false, effect, doorRouted,
    dryParseSafe: false, parseRejectIsIoFree: false, diagnostic: false,
  }
}

/** A registry with one fully-accounted verb (external-write + doorRouted). */
const routedGroups: NounGroups = {
  demo: { run: lazy({ meta: metaWith({ effect: 'external-write', doorRouted: true }), load: () => Promise.resolve(() => 0) }) },
}

const cleanFiles: readonly SourceFile[] = [
  { path: 'src/lib/jsonFile.ts', content: 'writeFileSync(path, x)' }, // sanctioned local-state
  { path: 'src/admit/door.ts', content: 'const x = 1' }, // no seam
]

describe('analyzeCoverage', () => {
  it('is ok when every seam is sanctioned and every verb accounts for its effect', () => {
    const report = analyzeCoverage({ files: cleanFiles, groups: routedGroups })
    expect(report.ok).toBe(true)
    expect(report.open).toEqual([])
    expect(report.verbGaps).toEqual([])
  })

  it('reports a direct write in an un-sanctioned file as an OPEN seam and fails', () => {
    const report = analyzeCoverage({ files: [{ path: 'src/connectors/slack.ts', content: 'writeFileSync(p, x)' }], groups: routedGroups })
    expect(report.ok).toBe(false)
    expect(report.open.map((s) => s.file)).toEqual(['src/connectors/slack.ts'])
    expect(report.open[0]!.seam).toBe('writeFileSync')
  })

  it('classes a sanctioned file\'s seam by its declared class, not open', () => {
    const report = analyzeCoverage({ files: [{ path: 'src/llm/claudeCli.ts', content: 'spawn(cmd)' }], groups: routedGroups })
    expect(report.seams[0]!.seamClass).toBe('llm-transport')
    expect(report.open).toEqual([])
  })

  it('fails when an external-write verb is not routed through the door', () => {
    const groups: NounGroups = { demo: { run: lazy({ meta: metaWith({ effect: 'external-write' }), load: () => Promise.resolve(() => 0) }) } }
    const report = analyzeCoverage({ files: cleanFiles, groups })
    expect(report.verbGaps).toEqual([{ noun: 'demo', verb: 'run', reason: 'external-write-not-routed' }])
  })
})
