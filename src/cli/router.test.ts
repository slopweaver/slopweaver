import { describe, expect, it } from 'vitest'

import { lazy } from './manifest.js'
import { isNoun, resolveNoun } from './router.js'
import type { NounGroups } from './router.js'

const meta = {
  summary: 's', usage: 'u', example: null,
  requiresApproval: false, createsWorkItem: false, effect: 'none', doorRouted: false,
  dryParseSafe: false, parseRejectIsIoFree: false, diagnostic: false,
} as const
const groups: NounGroups = {
  doctor: {
    '': lazy({ meta, load: () => Promise.resolve(() => 0) }),
    run: lazy({ meta, load: () => Promise.resolve(() => 0) }),
  },
  // A noun with named verbs but NO default handler.
  plain: {
    go: lazy({ meta, load: () => Promise.resolve(() => 0) }),
  },
}

const argv = (...rest: string[]): readonly string[] => ['node', 'cli', ...rest]

describe('resolveNoun', () => {
  it('resolves a named verb to a manifest route', () => {
    const route = resolveNoun({ groups, argv: argv('doctor', 'run') })!
    expect(route.kind).toBe('manifest')
    expect(route.verb).toBe('run')
  })

  it('resolves a bare noun to its default verb', () => {
    const route = resolveNoun({ groups, argv: argv('doctor') })!
    expect(route.verb).toBe('')
  })

  it('treats a flag after the noun as the default-verb tail', () => {
    const route = resolveNoun({ groups, argv: argv('doctor', '--json') })!
    expect(route.verb).toBe('')
  })

  it('returns null for an unknown noun', () => {
    expect(resolveNoun({ groups, argv: argv('nope') })).toBeNull()
  })

  it('routes an unknown verb to the default handler when the noun has one (free-text tail)', () => {
    const route = resolveNoun({ groups, argv: argv('doctor', 'nope') })!
    expect(route.verb).toBe('')
  })

  it('returns null for an unknown verb under a noun with no default', () => {
    expect(resolveNoun({ groups, argv: argv('plain', 'nope') })).toBeNull()
  })
})

describe('isNoun', () => {
  it('is true for a registered noun even with no verb', () => {
    expect(isNoun({ groups, argv: argv('doctor') })).toBe(true)
  })

  it('is false for an unregistered noun', () => {
    expect(isNoun({ groups, argv: argv('nope') })).toBe(false)
  })
})
