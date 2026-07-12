import { describe, expect, it } from 'vitest'
import { renderAskJson } from './askJson.js'
import type { Answer } from '../../../retrieval/answerFromSlice.js'

const answer: Answer = {
  tldr: 'auth uses tokens (#1)',
  details: 'the longer body (#2)',
  answer: 'auth uses tokens (#1)\n\nthe longer body (#2)',
  citations: ['u1', 'u2'],
  citedTokens: ['#1', '#2'],
  retrievedRefs: [
    { sourceId: '#1', token: '#1', url: 'u1' },
    { sourceId: '#2', token: '#2', url: 'u2' },
    { sourceId: '#9', token: '#9', url: 'u9' },
  ],
  used: 2,
  retrieved: 3,
}

describe('renderAskJson', () => {
  it('serialises the answer to a parseable object exposing slice refs apart from citations', () => {
    const parsed = JSON.parse(renderAskJson({ question: 'how does auth work', answer }))
    expect(parsed).toEqual({
      question: 'how does auth work',
      tldr: 'auth uses tokens (#1)',
      details: 'the longer body (#2)',
      answer: 'auth uses tokens (#1)\n\nthe longer body (#2)',
      citations: ['u1', 'u2'],
      citedTokens: ['#1', '#2'],
      retrievedRefs: [
        { sourceId: '#1', token: '#1', url: 'u1' },
        { sourceId: '#2', token: '#2', url: 'u2' },
        { sourceId: '#9', token: '#9', url: 'u9' },
      ],
      retrieved: 3,
      used: 2,
    })
  })

  it('renders a missing details as null (a stable key the harness can rely on)', () => {
    const noDetails: Answer = { ...answer, details: undefined }
    expect(JSON.parse(renderAskJson({ question: 'q', answer: noDetails })).details).toBe(null)
  })
})
