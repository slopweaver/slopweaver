import { describe, expect, it } from 'vitest'

import { composeGate, evalRegressionResult, gateLogLines, prFormatResult, runDevGate, type GateCheckResult } from './devGate.js'
import { fixturePath, loadBaseline, loadFixtureRecords } from '../eval/regression.js'
import { EXIT_USAGE } from '../cli/exitCodes.js'
import { isRecord } from '../lib/parsers.js'

/** Parse a JSONL line to a record, THROWING if it is not one — keeps assertions conditional-free. */
function parseLogLine({ line }: { line: string }): Record<string, unknown> {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value)) {
    throw new Error('log line is not a JSON object')
  }
  return value
}

const conformingBody = [
  '![CI](https://img.shields.io/badge/CI-x-2ea44f)',
  '<table><tr><td><strong>Problem</strong></td><td>p</td></tr>',
  '<tr><td><strong>Solution</strong></td><td>s</td></tr>',
  '<tr><td><strong>Proof</strong></td><td>x</td></tr></table>',
].join('\n')

describe('prFormatResult', () => {
  it('passes a conforming body', () => {
    expect(prFormatResult({ body: conformingBody }).ok).toBe(true)
  })

  it('fails a missing body (never a skip)', () => {
    const result = prFormatResult({ body: undefined })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('no PR body provided')
  })

  it('fails a malformed body (no badge, no table)', () => {
    const result = prFormatResult({ body: 'just some prose' })
    expect(result.ok).toBe(false)
  })
})

describe('evalRegressionResult', () => {
  it('passes the full frozen fixture against its own baseline', () => {
    const { result, diff } = evalRegressionResult({ records: loadFixtureRecords({ path: fixturePath() }), baseline: loadBaseline() })
    expect(result.ok).toBe(true)
    expect(diff.ok).toBe(true)
    expect(diff.failures).toEqual([])
  })

  it('fails when the corpus is degraded below the baseline floors', () => {
    const degraded = loadFixtureRecords({ path: fixturePath() }).slice(0, 8)
    const { result, diff } = evalRegressionResult({ records: degraded, baseline: loadBaseline() })
    expect(result.ok).toBe(false)
    expect(diff.ok).toBe(false)
    // Deterministic: the frozen fixture is PR-number-sorted, so the first 8 records keep the (early) #2
    // recency records but drop the aggregation/cross-cutting support — an exact, stable set of failures.
    expect(diff.failures.map((f) => f.scope)).toEqual(['overall', 'single-fact', 'aggregation', 'cross-cutting'])
  })
})

describe('runDevGate arg rejection', () => {
  it('rejects an unknown flag with EXIT_USAGE before running any check', () => {
    // argv: [node, cli, dev, gate, --bogus] — parse fails first, so no ledger/check I/O happens.
    expect(runDevGate(['node', 'cli', 'dev', 'gate', '--bogus'])).toBe(EXIT_USAGE)
  })
})

describe('composeGate', () => {
  const pass: GateCheckResult = { name: 'hygiene', ok: true, summary: 'clean' }
  const fail: GateCheckResult = { name: 'pr-format', ok: false, summary: 'bad' }

  it('passes (exit 0) only when every check passes', () => {
    expect(composeGate({ results: [pass, { name: 'eval-regression', ok: true, summary: 'ok' }] })).toEqual({ ok: true, exit: 0 })
  })

  it('fails (exit 1) when any check fails', () => {
    expect(composeGate({ results: [pass, fail] })).toEqual({ ok: false, exit: 1 })
  })
})

describe('gateLogLines', () => {
  it('emits one JSONL line per check with the run id, status, and summary', () => {
    const results: GateCheckResult[] = [
      { name: 'hygiene', ok: true, summary: 'clean' },
      { name: 'pr-format', ok: false, summary: 'bad' },
    ]
    const lines = gateLogLines({ runId: 'run-1', tsIso: '2026-07-14T00:00:00.000Z', results })
    expect(lines).toHaveLength(2)
    expect(parseLogLine({ line: lines[0]! })).toEqual({ schemaVersion: 1, runId: 'run-1', tsIso: '2026-07-14T00:00:00.000Z', check: 'hygiene', status: 'pass', summary: 'clean' })
    expect(parseLogLine({ line: lines[1]! })).toEqual({ schemaVersion: 1, runId: 'run-1', tsIso: '2026-07-14T00:00:00.000Z', check: 'pr-format', status: 'fail', summary: 'bad' })
  })
})
