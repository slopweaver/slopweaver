import { describe, expect, it } from 'vitest'

import { parseFlags, tokenizeFlags } from './parseFlags.js'
import { unwrap, unwrapErr } from '../lib/result.js'

const spec = { string: ['home', 'limit'], boolean: ['json', 'no-semantic'] } as const

describe('tokenizeFlags', () => {
  it('parses string values and boolean switches', () => {
    const t = tokenizeFlags({ args: ['--home', '/x', '--json'], spec })
    expect(t.values).toEqual({ home: '/x', json: true })
    expect(t.positionals).toEqual([])
    expect(t.errors).toEqual([])
  })

  it('keeps positionals as the free-text tail when allowed', () => {
    const t = tokenizeFlags({ args: ['what', 'is', 'auth', '--limit', '5'], spec, allowPositionals: true })
    expect(t.positionals).toEqual(['what', 'is', 'auth'])
    expect(t.values).toEqual({ limit: '5' })
    expect(t.errors).toEqual([])
  })

  it('accepts the --flag=value form', () => {
    expect(tokenizeFlags({ args: ['--home=/x'], spec }).values).toEqual({ home: '/x' })
  })

  it('reports an unknown flag AND a bad positional together (no short-circuit)', () => {
    const t = tokenizeFlags({ args: ['stray', '--bogus'], spec })
    expect(t.errors).toContain('unknown flag: --bogus')
    expect(t.errors).toContain('unexpected argument: stray')
  })

  it('reports a value flag given with no value', () => {
    expect(tokenizeFlags({ args: ['--home'], spec }).errors).toEqual(['--home requires a value'])
  })

  it('rejects a value flag that would swallow the next flag as its value', () => {
    const t = tokenizeFlags({ args: ['--home', '--json'], spec })
    expect(t.errors).toEqual(['--home requires a value'])
    expect(t.values).toEqual({})
  })
})

describe('parseFlags', () => {
  it('is ok with typed values when clean', () => {
    const result = parseFlags({ args: ['--home', '/x', '--json'], spec })
    expect(result.ok).toBe(true)
    expect(unwrap(result).values).toEqual({ home: '/x', json: true })
  })

  it('errors on an unknown flag', () => {
    const result = parseFlags({ args: ['--nope'], spec })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result)).toEqual(['unknown flag: --nope'])
  })

  it('errors on a stray positional when positionals are disallowed', () => {
    const result = parseFlags({ args: ['stray'], spec })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result)).toEqual(['unexpected argument: stray'])
  })
})
