import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PROFILE_SCHEMA_VERSION, parseProfile } from './profile.js'
import { unwrap, unwrapErr } from './lib/result.js'

const template: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../templates/profile.template.json', import.meta.url)), 'utf8'),
)

describe('parseProfile', () => {
  it('accepts the shipped template', () => {
    const result = parseProfile({ value: template })
    expect(result.ok).toBe(true)
    const profile = unwrap(result)
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION)
    expect(profile.id).toBe('me')
    expect(profile.displayName).toBe('')
    expect(profile.gitNamespace).toBe('')
    expect(profile.sources).toEqual([])
  })

  it('accepts a populated profile', () => {
    const result = parseProfile({ value: { schemaVersion: 1, id: 'me', displayName: 'Dev', gitNamespace: 'octocat', sources: ['github'] } })
    expect(result.ok).toBe(true)
    expect(unwrap(result).sources).toEqual(['github'])
  })

  it('rejects a wrong schemaVersion', () => {
    const result = parseProfile({ value: { schemaVersion: 2, id: 'me', displayName: '', gitNamespace: '', sources: [] } })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('schemaVersion must be 1')
  })

  it('rejects a non-string id', () => {
    const result = parseProfile({ value: { schemaVersion: 1, id: 7, displayName: '', gitNamespace: '', sources: [] } })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('id must be a string')
  })

  it('rejects non-array sources', () => {
    const result = parseProfile({ value: { schemaVersion: 1, id: 'me', displayName: '', gitNamespace: '', sources: 'github' } })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('sources must be an array of strings')
  })

  it('rejects sources with a non-string element', () => {
    const result = parseProfile({ value: { schemaVersion: 1, id: 'me', displayName: '', gitNamespace: '', sources: ['github', 3] } })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result).join(' ')).toContain('sources must be an array of strings')
  })

  it('rejects a non-object value', () => {
    const result = parseProfile({ value: 'nope' })
    expect(result.ok).toBe(false)
    expect(unwrapErr(result)).toEqual(['profile.json is not a JSON object'])
  })
})
