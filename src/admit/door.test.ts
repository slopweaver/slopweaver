import { describe, expect, it } from 'vitest'

import { DEFAULT_GATES, admitDoor } from './door.js'
import type { DoorFinding, DoorGate, DoorRequest } from './types.js'

const request: DoorRequest = {
  action: { kind: 'verb', noun: 'demo', verb: 'run' },
  artifact: {},
  meta: { effect: 'external-write', requiresApproval: true, createsWorkItem: false, home: null },
}

const warnFinding: DoorFinding = { code: 'demo.warn', severity: 'warn', summary: 's', correction: 'c', override: 'demo.run:v1' }
const holdFinding: DoorFinding = { code: 'demo.hold', severity: 'hold', summary: 's', correction: 'c' }

const warnGate: DoorGate = () => [warnFinding]
const holdGate: DoorGate = () => [holdFinding]

describe('admitDoor', () => {
  it('passes when there are no gates (the empty compose seam)', () => {
    const decision = admitDoor({ request, env: {}, gates: DEFAULT_GATES })
    expect(decision.status).toBe('pass')
    expect(decision.findings).toEqual([])
    expect(decision.overridden).toEqual([])
  })

  it('warns on a warn finding, returning it self-correctably with its override token', () => {
    const decision = admitDoor({ request, env: {}, gates: [warnGate] })
    expect(decision.status).toBe('warn')
    // The whole finding (incl. its required `override: 'demo.run:v1'`) is returned for self-correction.
    expect(decision.findings).toEqual([warnFinding])
  })

  it('flips warn → pass when $SLOPWEAVER_DOOR_OVERRIDE carries the matching token, recording the waiver', () => {
    const decision = admitDoor({ request, env: { SLOPWEAVER_DOOR_OVERRIDE: 'demo.run:v1' }, gates: [warnGate] })
    expect(decision.status).toBe('pass')
    expect(decision.findings).toEqual([])
    expect(decision.overridden).toEqual([warnFinding])
  })

  it('does not flip on a non-matching override token', () => {
    const decision = admitDoor({ request, env: { SLOPWEAVER_DOOR_OVERRIDE: 'other:v1' }, gates: [warnGate] })
    expect(decision.status).toBe('warn')
    expect(decision.overridden).toEqual([])
  })

  it('holds on a hold finding and the per-action override does NOT waive it', () => {
    const decision = admitDoor({ request, env: { SLOPWEAVER_DOOR_OVERRIDE: 'demo.run:v1' }, gates: [holdGate] })
    expect(decision.status).toBe('hold')
    expect(decision.findings).toEqual([holdFinding])
  })

  it('holds when both a hold and a warn fire (hold dominates)', () => {
    const decision = admitDoor({ request, env: {}, gates: [warnGate, holdGate] })
    expect(decision.status).toBe('hold')
    expect(decision.findings).toEqual([warnFinding, holdFinding])
  })
})
