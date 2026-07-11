import { describe, expect, it } from 'vitest'

import { lazy } from './manifest.js'
import { isNoun, resolveNoun } from './router.js'
import type { NounGroups } from './router.js'

const meta = { summary: 's', usage: 'u' } as const
const groups: NounGroups = {
  doctor: {
    '': lazy({ meta, load: () => Promise.resolve(() => 0) }),
    run: lazy({ meta, load: () => Promise.resolve(() => 0) }),
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

  it('returns null for an unknown verb under a known noun', () => {
    expect(resolveNoun({ groups, argv: argv('doctor', 'nope') })).toBeNull()
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
