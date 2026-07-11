import { describe, expect, it } from 'vitest'
import { extractRefs } from './refs.js'

describe('extractRefs', () => {
  it('extracts issue numbers, mentions, ticket keys and URLs, deduped', () => {
    const refs = extractRefs({ text: 'fixes #12 cc @bob re TEAM-9 see https://example.com/x #12' })
    expect(new Set(refs)).toEqual(new Set(['#12', '@bob', 'TEAM-9', 'https://example.com/x']))
    expect(refs.filter((r) => r === '#12')).toHaveLength(1)
  })

  it('returns nothing for plain prose', () => {
    expect(extractRefs({ text: 'just some words here' })).toEqual([])
  })
})
