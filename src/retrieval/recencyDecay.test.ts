import { describe, expect, it } from 'vitest'
import { decayParamsFromDays, decayWeight, recordDecayWeight, tsIsoToMs } from './recencyDecay.js'

const DAY = 86_400_000

describe('decayWeight', () => {
  it('is 1 at now and ~0.5 one half-life ago', () => {
    expect(decayWeight({ tsMs: 1000, nowMs: 1000, halfLifeMs: 7 * DAY })).toBe(1)
    expect(decayWeight({ tsMs: 0, nowMs: 7 * DAY, halfLifeMs: 7 * DAY })).toBeCloseTo(0.5, 5)
  })

  it('clamps a future timestamp to 1', () => {
    expect(decayWeight({ tsMs: 2000, nowMs: 1000, halfLifeMs: 7 * DAY })).toBe(1)
  })
})

describe('recordDecayWeight', () => {
  it('floors a missing timestamp just above 0 rather than dropping it', () => {
    expect(recordDecayWeight({ tsMs: undefined, nowMs: 1000 })).toBeGreaterThan(0)
    expect(recordDecayWeight({ tsMs: undefined, nowMs: 1000 })).toBeLessThan(0.001)
  })
})

describe('tsIsoToMs', () => {
  it('parses an ISO string and rejects garbage', () => {
    expect(tsIsoToMs({ tsIso: '2024-01-01T00:00:00Z' })).toBe(Date.parse('2024-01-01T00:00:00Z'))
    expect(tsIsoToMs({ tsIso: 'nope' })).toBeUndefined()
  })
})

describe('decayParamsFromDays', () => {
  it('converts days to a half-life, else uses the default', () => {
    expect(decayParamsFromDays({ days: 3, nowMs: 10 })).toEqual({ nowMs: 10, halfLifeMs: 3 * DAY })
    expect(decayParamsFromDays({ days: undefined, nowMs: 10 })).toEqual({ nowMs: 10 })
  })
})
