import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { throughDoor, type ThroughDoorResult } from './effects.js'
import { DEFAULT_GATES } from './door.js'
import { stateHomePaths } from '../stateHome.js'
import type { DoorGate, DoorRequest } from './types.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slop-door-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const request: DoorRequest = {
  action: { kind: 'verb', noun: 'demo', verb: 'run' },
  artifact: {},
  meta: { effect: 'external-write', requiresApproval: true, createsWorkItem: false, home: null },
}
const warnGate: DoorGate = () => [{ code: 'demo.warn', severity: 'warn', summary: 's', correction: 'c', override: 'demo.run:v1' }]

/** Read the door ledger's decision statuses for the temp home. */
function ledgerStatuses(): readonly string[] {
  const path = join(stateHomePaths({ home }).ledgers, 'door.jsonl')
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).status)
}

/** Assert an effect ran and return its result (throws otherwise — keeps assertions unconditional). */
function performedResult<T>({ result }: { result: ThroughDoorResult<T> }): T {
  if (!result.performed) {
    throw new Error('expected the effect to have been performed')
  }
  return result.result
}

describe('throughDoor', () => {
  it('does NOT perform the effect on warn, and records the decision', async () => {
    let ran = false
    const result = await throughDoor({
      request, gates: [warnGate], env: {}, home, runId: 'r1', nowIso: 't',
      perform: () => { ran = true; return 'done' },
    })
    expect(ran).toBe(false)
    expect(result.performed).toBe(false)
    expect(result.decision.status).toBe('warn')
    expect(ledgerStatuses()).toEqual(['warn'])
  })

  it('performs the effect on pass, returns its result, and records the decision', async () => {
    const result = await throughDoor({
      request, gates: DEFAULT_GATES, env: {}, home, runId: 'r2', nowIso: 't',
      perform: () => 'done',
    })
    expect(result.performed).toBe(true)
    expect(performedResult({ result })).toBe('done')
    expect(result.decision.status).toBe('pass')
    expect(ledgerStatuses()).toEqual(['pass'])
  })

  it('performs on pass when a warning is overridden', async () => {
    const result = await throughDoor({
      request, gates: [warnGate], env: { SLOPWEAVER_DOOR_OVERRIDE: 'demo.run:v1' }, home, runId: 'r3', nowIso: 't',
      perform: () => 'done',
    })
    expect(result.performed).toBe(true)
    expect(result.decision.overridden.map((f) => f.code)).toEqual(['demo.warn'])
  })
})
