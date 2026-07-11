import { describe, expect, it } from 'vitest'
import { parseQueryArgs } from './queryArgs.js'

describe('parseQueryArgs', () => {
  it('joins non-flag tokens into the question and parses flags', () => {
    const args = parseQueryArgs({ rest: ['what', 'is', 'auth', '--limit', '5', '--no-semantic'], defaultLimit: 12 })
    expect(args.question).toBe('what is auth')
    expect(args.limit).toBe(5)
    expect(args.semantic).toBe(false)
    expect(args.errors).toEqual([])
  })

  it('records errors for a bad limit and an unknown flag', () => {
    const args = parseQueryArgs({ rest: ['q', '--limit', 'x', '--bogus'], defaultLimit: 12 })
    expect(args.errors.some((e) => e.includes('--limit'))).toBe(true)
    expect(args.errors.some((e) => e.includes('unknown flag'))).toBe(true)
  })
})
