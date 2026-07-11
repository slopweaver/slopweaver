import { describe, expect, it } from 'vitest'
import { completeStructured, type StructuredRequest } from './structuredComplete.js'
import type { LlmClient, LlmMessage } from './provider.js'
import { err, ok, type Result, unwrap } from '../lib/result.js'
import { isRecord } from '../lib/parsers.js'

const request: StructuredRequest = {
  system: 'sys', user: 'usr', toolName: 'emit', toolDescription: 'emit it',
  schema: { type: 'object', required: ['n'] },
}

/** A client that replays a fixed sequence of messages, one per attempt. */
const clientOf = (messages: readonly LlmMessage[]): LlmClient => {
  let call = 0
  return { complete: async () => messages[call++] ?? { content: [] } }
}

const toolUse = (input: unknown): LlmMessage => ({ content: [{ type: 'tool_use', input }] })
const textMsg = (text: string): LlmMessage => ({ content: [{ type: 'text', text }] })

const validate = (input: unknown): Result<number> =>
  isRecord(input) && typeof input.n === 'number' ? ok(input.n) : err(['expected { n: number }'])

const opts = { validate }

describe('completeStructured', () => {
  it('returns the validated value from a tool_use input', async () => {
    const result = await completeStructured({ request, client: clientOf([toolUse({ n: 7 })]), ...opts })
    expect(unwrap(result)).toBe(7)
  })

  it('retries past an invalid tool_use, then succeeds', async () => {
    const result = await completeStructured({ request, client: clientOf([toolUse({ n: 'nope' }), toolUse({ n: 3 })]), ...opts })
    expect(unwrap(result)).toBe(3)
  })

  it('falls back to JSON found in a text block when there is no tool_use', async () => {
    const result = await completeStructured({ request, client: clientOf([textMsg('here: {"n":5}')]), ...opts })
    expect(unwrap(result)).toBe(5)
  })

  it('errs when the transport throws', async () => {
    const throwing: LlmClient = { complete: async () => { throw new Error('spawn failed') } }
    expect((await completeStructured({ request, client: throwing, ...opts })).ok).toBe(false)
  })

  it('errs after exhausting attempts on invalid output', async () => {
    const result = await completeStructured({ request, client: clientOf([toolUse({ n: 'a' }), toolUse({ n: 'b' })]), ...opts })
    expect(result.ok).toBe(false)
  })
})
