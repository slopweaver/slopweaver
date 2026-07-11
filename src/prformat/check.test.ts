import { describe, expect, it } from 'vitest'
import { countWords, MAX_WORDS, validatePrBody } from './check.js'

const badges = '![CI](https://img.shields.io/badge/CI-passing-2ea44f?style=flat) ![proof](https://img.shields.io/badge/proof-bronze-cd7f32?style=flat)'

function body({ problem, solution, proof = 'ok', withBadges = true }: {
  problem: string
  solution: string
  proof?: string
  withBadges?: boolean
}): string {
  return [
    withBadges ? badges : '(no badges)',
    '',
    '| | |',
    '|---|---|',
    `| **Problem** | ${problem} |`,
    `| **Solution** | ${solution} |`,
    `| **Proof** | ${proof} |`,
  ].join('\n')
}

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(' ')

describe('countWords', () => {
  it('ignores <br>, link URLs, inline code and markdown noise', () => {
    expect(countWords('• **Strip** the prototype<br>`argv → exit-code` [run](https://x.y/z)')).toBe(6)
  })
})

describe('validatePrBody', () => {
  it('accepts a conforming body', () => {
    expect(validatePrBody(body({ problem: words(10), solution: words(40) }))).toEqual({ ok: true, errors: [] })
  })

  it('accepts exactly MAX_WORDS', () => {
    expect(validatePrBody(body({ problem: words(MAX_WORDS), solution: words(1) })).ok).toBe(true)
  })

  it('rejects a Problem over the word cap', () => {
    const result = validatePrBody(body({ problem: words(MAX_WORDS + 1), solution: words(1) }))
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('Problem') && e.includes('max'))).toBe(true)
  })

  it('rejects a missing badge row', () => {
    const result = validatePrBody(body({ problem: words(2), solution: words(2), withBadges: false }))
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('badge'))).toBe(true)
  })

  it('rejects a missing Solution row', () => {
    const noSolution = `${badges}\n\n| **Problem** | ${words(3)} |\n| **Proof** | ok |`
    const result = validatePrBody(noSolution)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('Solution'))).toBe(true)
  })

  it('rejects a missing Proof row', () => {
    const noProof = `${badges}\n\n| **Problem** | ${words(3)} |\n| **Solution** | ${words(3)} |`
    expect(validatePrBody(noProof).errors.some((e) => e.includes('Proof'))).toBe(true)
  })
})
