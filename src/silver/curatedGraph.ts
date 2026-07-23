/**
 * The curated relation graph (PR4.3): the explicit, DECLARED edges a curated artefact records — a Notion
 * relation/mention, a Linear sub-issue/relation, a GitHub Projects/milestone/CODEOWNERS grouping. Every
 * edge is 1:1 with a real relation the source system stored, so the edge set is bounded by the actual
 * relation count and CANNOT re-blow.
 *
 * This is a THIRD, separate graph — alongside the cross-ref token clique graph (`graph.ts`) and the
 * structural relation graph (`structures.ts`). It exists precisely so curated relations never touch the
 * token clique index: `buildCrossRefGraph` is left byte-for-byte unchanged, which is what guarantees the
 * PR3.5 de-noise bounds hold (the token graph's holder/clique caps still govern it exactly as before).
 * Like the structural graph, this uses NO clique heuristic — each edge is declared, not co-occurrence-mined.
 *
 * A defensive per-record cap ({@link MAX_EDGES_PER_RECORD}) truncates a pathological relation property
 * (thousands of targets) and surfaces the dropped count via `capped`, which the derive shell `log()`s.
 */
import { CURATED_EDGES_ATTR, type CuratedEdge, parseCuratedEdgeRef } from "../corpus/curated/types.js";
import type { CorpusRecord } from "../corpus/types.js";

/** Max declared edges a single record may contribute before the surplus is dropped (a runaway-property guard). */
export const MAX_EDGES_PER_RECORD = 200;

/** The node key for a record (`<source>:<sourceId>`) — the same convention as the cross-ref graph. Pure. */
export function curatedNodeKey({ record }: { record: CorpusRecord }): string {
  return `${record.source}:${record.sourceId}`;
}

/** The encoded curated-edge refs a record declares in `attrs.curatedEdges` (empty when absent/mis-shaped). Pure. */
export function recordEdgeRefs({ record }: { record: CorpusRecord }): readonly string[] {
  const value = record.attrs?.[CURATED_EDGES_ATTR];
  return Array.isArray(value) ? value : [];
}

/**
 * The declared edges one record contributes, capped at {@link MAX_EDGES_PER_RECORD}. Pure.
 *
 * @param record the corpus record
 * @returns the record's edges + how many were dropped by the per-record cap
 */
export function edgesForRecord({ record }: { record: CorpusRecord }): {
  edges: readonly CuratedEdge[];
  dropped: number;
} {
  const from = curatedNodeKey({ record });
  const refs = recordEdgeRefs({ record });
  const edges: CuratedEdge[] = [];
  let dropped = 0;
  for (const ref of refs) {
    const parsed = parseCuratedEdgeRef({ encoded: ref });
    if (parsed === undefined || parsed.target === from) {
      continue; // malformed, unknown kind, or a self-loop
    }
    if (edges.length >= MAX_EDGES_PER_RECORD) {
      dropped += 1;
      continue;
    }
    edges.push({ from, kind: parsed.kind, to: parsed.target });
  }
  return { dropped, edges };
}

/**
 * Build the curated relation graph over the corpus: one node per record (plus each edge's target) and one
 * edge per declared relation, deduped by `(from,to,kind)` and sorted deterministically. Pure.
 *
 * @param records the corpus records
 * @returns the sorted `nodes`, the declared `edges`, and `capped` (edges dropped by the per-record cap)
 */
export function buildCuratedGraph({ records }: { records: readonly CorpusRecord[] }): {
  nodes: readonly string[];
  edges: readonly CuratedEdge[];
  capped: number;
} {
  const nodes = new Set<string>();
  const edges = new Map<string, CuratedEdge>();
  let capped = 0;
  for (const record of records) {
    const contribution = edgesForRecord({ record });
    capped += contribution.dropped;
    for (const edge of contribution.edges) {
      nodes.add(edge.from);
      nodes.add(edge.to);
      edges.set(`${edge.from}|${edge.to}|${edge.kind}`, edge);
    }
  }
  return {
    capped,
    edges: [...edges.values()].toSorted(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
    ),
    nodes: [...nodes].toSorted(),
  };
}
