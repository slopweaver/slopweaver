import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { bronzeDir, cacheDir, distilCachePath, goldDir, silverDigestsDir, silverGraphDir, silverIndexDir, watermarkPath } from './corpusPaths.js'
import { stateHomePaths } from '../stateHome.js'

describe('corpusPaths delegate to the one home-path contract', () => {
  const home = '/tmp/sw-corpus-home'
  const contract = stateHomePaths({ home })

  it('resolves the corpus roots to the contract (no second layout vocabulary)', () => {
    expect(bronzeDir({ home })).toBe(contract.corpus.bronze)
    expect(goldDir({ home })).toBe(contract.corpus.gold)
    expect(cacheDir({ home })).toBe(contract.corpus.cache)
    expect(watermarkPath({ home })).toBe(contract.corpus.watermark)
  })

  it('builds silver leaves under the contract silver root', () => {
    expect(silverIndexDir({ home })).toBe(join(contract.corpus.silver, 'index'))
    expect(silverGraphDir({ home })).toBe(join(contract.corpus.silver, 'graph'))
    expect(silverDigestsDir({ home })).toBe(join(contract.corpus.silver, 'digests'))
  })

  it('keeps the distil cache under the corpus cache root', () => {
    expect(distilCachePath({ home })).toBe(join(contract.corpus.cache, 'distil', 'batches.json'))
  })

  it('roots the corpus under <home>/corpus after the warehouse→corpus rename', () => {
    expect(bronzeDir({ home })).toBe('/tmp/sw-corpus-home/corpus/bronze')
  })
})
