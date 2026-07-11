import { describe, expect, it } from 'vitest'
import { buildPrompt, envelopeToMessage } from './claudeCli.js'
import type { LlmCreateParams } from './provider.js'

const baseParams: LlmCreateParams = {
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'summarise this' }],
}

describe('buildPrompt', () => {
  it('joins system + messages', () => {
    expect(buildPrompt({ params: baseParams })).toBe('You are helpful.\n\nsummarise this')
  })

  it('appends a schema instruction when a forced tool is present', () => {
    const params: LlmCreateParams = {
      ...baseParams,
      tools: [{ name: 'emit', description: 'd', inputSchema: { type: 'object', required: ['x'] } }],
      toolChoice: { type: 'tool', name: 'emit' },
    }
    const prompt = buildPrompt({ params })
    expect(prompt).toContain('Respond with ONLY a JSON object')
    expect(prompt).toContain('"required":["x"]')
  })
})

describe('envelopeToMessage', () => {
  it('recovers a tool_use block + text block from a good envelope', () => {
    const stdout = JSON.stringify({ is_error: false, result: 'answer: {"summary":"hi"}' })
    const message = envelopeToMessage({ stdout })
    expect(message.content[0]).toEqual({ type: 'tool_use', input: { summary: 'hi' } })
    expect(message.content[1].type).toBe('text')
  })

  it('throws on an error envelope', () => {
    expect(() => envelopeToMessage({ stdout: JSON.stringify({ is_error: true, result: 'boom' }) })).toThrow()
  })

  it('throws when result is not a string', () => {
    expect(() => envelopeToMessage({ stdout: JSON.stringify({ result: 42 }) })).toThrow()
  })
})
