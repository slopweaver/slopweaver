import { describe, expect, it } from 'vitest'

import { decideRebaseline } from './rebaselineCore.js'
import { unwrap, unwrapErr } from '../lib/result.js'

describe('decideRebaseline authorisation', () => {
  it('refuses without --write', () => {
    const result = decideRebaseline({ args: ['--reason', 'x'], ci: false, allowInCi: false })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('pass --write')
  })

  it('refuses --write without a --reason', () => {
    const result = decideRebaseline({ args: ['--write'], ci: false, allowInCi: false })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('pass --reason')
  })

  it('refuses a --reason that is just another flag', () => {
    const result = decideRebaseline({ args: ['--write', '--reason', '--write'], ci: false, allowInCi: false })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('pass --reason')
  })

  it('authorises with --write and a non-empty --reason', () => {
    const result = decideRebaseline({ args: ['--write', '--reason', 'tuned decay half-life'], ci: false, allowInCi: false })
    expect(result.ok).toBe(true)
    expect(unwrap(result).reason).toBe('tuned decay half-life')
  })

  it('refuses in CI without the explicit override', () => {
    const result = decideRebaseline({ args: ['--write', '--reason', 'x'], ci: true, allowInCi: false })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('CI')
  })

  it('allows CI only with the explicit override', () => {
    const result = decideRebaseline({ args: ['--write', '--reason', 'x'], ci: true, allowInCi: true })
    expect(result.ok).toBe(true)
    expect(unwrap(result).reason).toBe('x')
  })
})
