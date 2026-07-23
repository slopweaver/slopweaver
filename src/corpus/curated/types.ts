/**
 * The curated-knowledge layer's shared vocabulary (PR4.3). Two additive concepts ride on the existing
 * {@link CorpusRecord} via `attrs`, so nothing about the record contract changes:
 *
 *  - **Classification** ({@link CuratedClassification}) — a lightweight `strategy|decision|status|ownership`
 *    tag a curated artefact carries in `attrs.classification`, so gold (and later the belief layer) can
 *    weight the deliberately-authored records above the firehose. Assigned by a cheap deterministic
 *    heuristic at projection time (never an LLM call).
 *  - **Explicit relation edges** ({@link CuratedEdge}) — a Notion relation/mention, a Linear sub-issue/
 *    relation, a GitHub Projects/milestone/CODEOWNERS grouping. Each is a DECLARED 1:1 link (never a
 *    token co-occurrence), so it is bounded by the real relation count and CANNOT re-blow the cross-ref
 *    token graph. Edges are carried on the source record as `attrs.curatedEdges` (a `readonly string[]`
 *    of `"<kind>|<targetNode>"` refs — the only attribute shape the corpus allows) and lifted into the
 *    silver {@link CuratedEdge} graph by `buildCuratedGraph`. The token clique graph (`graph.ts`) is left
 *    entirely untouched.
 */

/** The lightweight weighting tag a curated artefact carries. */
export type CuratedClassification = "strategy" | "decision" | "status" | "ownership";

/**
 * The kind of a declared curated relation. Each is an explicit link the source system records — never a
 * fuzzy or inferred match. `mention` is EXPLICIT-tag only (a Notion rich-text mention span carrying a
 * concrete target id), never a name/nickname text match.
 */
export type CuratedEdgeKind =
  | "relation"
  | "mention"
  | "sub-issue"
  | "blocks"
  | "duplicate"
  | "project-item"
  | "milestone"
  | "owns";

/** Runtime mirror of {@link CuratedEdgeKind}. */
export const CURATED_EDGE_KINDS: readonly CuratedEdgeKind[] = [
  "relation",
  "mention",
  "sub-issue",
  "blocks",
  "duplicate",
  "project-item",
  "milestone",
  "owns",
];

/** One explicit, declared relation edge between two record nodes (`<source>:<sourceId>`). */
export interface CuratedEdge {
  /** The holder node (`<source>:<sourceId>`) — the record that declared the relation. */
  readonly from: string;
  /** The target node (`<source>:<sourceId>`). */
  readonly to: string;
  /** The declared relation kind. */
  readonly kind: CuratedEdgeKind;
}

/** The `attrs` key an edge-bearing record stores its encoded curated edges under. */
export const CURATED_EDGES_ATTR = "curatedEdges";
/** The `attrs` key a curated artefact stores its classification under. */
export const CURATED_CLASS_ATTR = "classification";

/** The separator between an encoded edge's kind and its target node — never present in a node key. */
const EDGE_SEP = "|";

/**
 * Encode one edge as the compact `"<kind>|<targetNode>"` ref stored in `attrs.curatedEdges`. Pure.
 *
 * @param kind the relation kind
 * @param target the target node key (`<source>:<sourceId>`)
 * @returns the encoded ref
 */
export function encodeCuratedEdgeRef({ kind, target }: { kind: CuratedEdgeKind; target: string }): string {
  return `${kind}${EDGE_SEP}${target}`;
}

/**
 * Whether a candidate string is a valid {@link CuratedEdgeKind}. Type predicate — positional per the
 * house rules (TS1230 forbids destructuring a predicate).
 */
function isCuratedEdgeKind(value: string): value is CuratedEdgeKind {
  return (CURATED_EDGE_KINDS as readonly string[]).includes(value);
}

/**
 * Decode a `"<kind>|<targetNode>"` ref back into its parts, or `undefined` when malformed or the kind is
 * unknown (an unrecognised ref is dropped, never fatal). Pure.
 *
 * @param encoded the encoded edge ref
 * @returns the decoded `{ kind, target }`, or undefined
 */
export function parseCuratedEdgeRef({
  encoded,
}: {
  encoded: string;
}): { kind: CuratedEdgeKind; target: string } | undefined {
  const sep = encoded.indexOf(EDGE_SEP);
  if (sep <= 0) {
    return undefined;
  }
  const kind = encoded.slice(0, sep);
  const target = encoded.slice(sep + 1);
  if (target.length === 0 || !isCuratedEdgeKind(kind)) {
    return undefined;
  }
  return { kind, target };
}
