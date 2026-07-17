import { describe, expect, it } from 'vitest'

import { doorLedgerLine } from './ledger.js'
import type { DoorDecision, DoorRequest } from './types.js'

const request: DoorRequest = {
  action: { kind: 'verb', noun: 'demo', verb: 'run' },
  artifact: {},
  meta: { effect: 'external-write', requiresApproval: true, createsWorkItem: false, home: null },
}

describe('doorLedgerLine', () => {
  it('records a warn decision as one exact JSON object', () => {
    const decision: DoorDecision = {
      status: 'warn',
      findings: [{ code: 'demo.warn', severity: 'warn', summary: 's', correction: 'c', override: 'demo.run:v1' }],
      overridden: [],
    }
    expect(JSON.parse(doorLedgerLine({ request, decision, runId: 'r1', tsIso: '2026-07-14T00:00:00.000Z' }))).toEqual({
      schemaVersion: 1,
      runId: 'r1',
      tsIso: '2026-07-14T00:00:00.000Z',
      action: 'verb:demo.run',
      effect: 'external-write',
      status: 'warn',
      findings: [{ code: 'demo.warn', severity: 'warn' }],
      overridden: [],
    })
  })

  it('records an overridden pass with the waived finding codes', () => {
    const decision: DoorDecision = { status: 'pass', findings: [], overridden: [{ code: 'demo.warn', severity: 'warn', summary: 's', correction: 'c', override: 'demo.run:v1' }] }
    expect(JSON.parse(doorLedgerLine({ request, decision, runId: 'r2', tsIso: 't' })).overridden).toEqual(['demo.warn'])
  })

  it('records a raw-tool action label', () => {
    const rawRequest: DoorRequest = {
      action: { kind: 'raw-tool', tool: 'gh', command: 'gh pr merge 1' },
      artifact: {},
      meta: { effect: 'external-write', requiresApproval: true, createsWorkItem: false, home: null },
    }
    const decision: DoorDecision = { status: 'hold', findings: [], overridden: [] }
    expect(JSON.parse(doorLedgerLine({ request: rawRequest, decision, runId: 'r3', tsIso: 't' })).action).toBe('raw-tool:gh')
  })
})
