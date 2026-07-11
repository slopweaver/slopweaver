/**
 * The cross-ref graph: undirected edges between records that share a reference token — the same issue
 * key, PR number, URL, or @mention. Pure, deterministic. Each shared token forms a clique over the
 * records that hold it; the edge's `via` records which token linked them.
 *
 * A hub-token cap drops any token held by more than `MAX_HOLDERS_PER_TOKEN` records: that's a status
 * enum, a templated URL, or a generic mention whose O(H²) clique is noise (and would blow past V8's Map
 * size ceiling on a large corpus). Real shared entities never fan out that far.
 */
import { extractRefs } from '../corpus/refs.js'
import type { CorpusRecord } from '../corpus/types.js'

export const MAX_HOLDERS_PER_TOKEN = 200

export interface GraphEdge {
  readonly a: string
  readonly b: string
  readonly via: string
}

/** Stable node key for a record. */
function nodeKey({ record }: { record: CorpusRecord }): string {
  return `${record.source}:${record.sourceId}`
}

/** The link tokens a record contributes: its refs plus tokens mined from its url/title/sourceId. */
function linkTokens({ record }: { record: CorpusRecord }): readonly string[] {
  const identity = [record.url, ...extractRefs({ text: `${record.url} ${record.title ?? ''} ${record.sourceId}` })]
  return [...record.refs, ...identity].filter((token) => token.length > 0)
}

/**
 * Build the cross-ref graph over the corpus.
 *
 * @param records the corpus records
 * @returns sorted `nodes` (node keys) and undirected `edges` (`a < b`, with the linking `via` token)
 */
export function buildCrossRefGraph({ records }: { records: readonly CorpusRecord[] }): {
  nodes: readonly string[]
  edges: readonly GraphEdge[]
} {
  const nodes = new Set<string>()
  const tokenIndex = new Map<string, Set<string>>()
  for (const record of records) {
    const key = nodeKey({ record })
    nodes.add(key)
    for (const token of linkTokens({ record })) {
      const holders = tokenIndex.get(token) ?? new Set<string>()
      holders.add(key)
      tokenIndex.set(token, holders)
    }
  }

  const edges = new Map<string, GraphEdge>()
  for (const [token, holderSet] of tokenIndex) {
    if (holderSet.size < 2 || holderSet.size > MAX_HOLDERS_PER_TOKEN) {
      continue
    }
    const holders = [...holderSet]
    for (let i = 0; i < holders.length; i += 1) {
      for (let j = i + 1; j < holders.length; j += 1) {
        const first = holders[i] ?? ''
        const second = holders[j] ?? ''
        const [a, b] = first < second ? [first, second] : [second, first]
        const edgeKey = `${a} ${b}`
        const existing = edges.get(edgeKey)
        if (existing === undefined || token < existing.via) {
          edges.set(edgeKey, { a, b, via: token })
        }
      }
    }
  }

  return {
    nodes: [...nodes].sort(),
    edges: [...edges.values()].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0)),
  }
}
