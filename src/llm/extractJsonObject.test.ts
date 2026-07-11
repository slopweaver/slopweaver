import { describe, expect, it } from 'vitest'
import { extractJsonObject, extractJsonObjects } from './extractJsonObject.js'

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject({ text: '{"a":1}' })).toEqual({ a: 1 })
  })

  it('extracts JSON embedded in prose / fences', () => {
    expect(extractJsonObject({ text: 'Sure:\n```json\n{"a":1,"b":"x"}\n```\ndone' })).toEqual({ a: 1, b: 'x' })
  })

  it('is not fooled by braces inside strings', () => {
    expect(extractJsonObject({ text: '{"s":"a } b { c"}' })).toEqual({ s: 'a } b { c' })
  })

  it('returns every object in order (echoed schema then the answer)', () => {
    const objects = extractJsonObjects({ text: '{"type":"object"} then {"summary":"real"}' })
    expect(objects).toEqual([{ type: 'object' }, { summary: 'real' }])
  })

  it('returns undefined when there is no JSON object', () => {
    expect(extractJsonObject({ text: 'no json here' })).toBeUndefined()
  })
})
