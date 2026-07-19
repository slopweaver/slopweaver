/**
 * derive — the free, deterministic silver synthesis. Pure orchestration over the corpus: build the
 * directory, the cross-ref graph, and the opportunities, then rewrite opaque handles in opportunity
 * subjects/summaries via the identity map (a pass-through when the map is empty). A full re-scan each
 * run — cheap and deterministic, so there's no diffing. The verb handles reading the corpus and writing
 * the JSON artifacts.
 */
import type { CorpusRecord } from "../corpus/types.js";
import { buildDirectory, type DirectoryEntry } from "./directory.js";
import { buildCrossRefGraph, type GraphEdge } from "./graph.js";
import { type IdentityMap, type IdentityResolution, resolveHandle } from "./identity.js";
import { type Opportunity, spotOpportunities } from "./opportunity.js";

/** The empty resolution — the default, so a caller that doesn't resolve identities gets raw per-source ids. */
const EMPTY_RESOLUTION: IdentityResolution = { candidates: [], conflicts: [], index: new Map(), people: [] };

export interface SilverArtifacts {
  readonly directory: { readonly people: readonly DirectoryEntry[]; readonly containers: readonly DirectoryEntry[] };
  readonly graph: { readonly nodes: readonly string[]; readonly edges: readonly GraphEdge[] };
  readonly opportunities: readonly Opportunity[];
  /** The cross-source identity resolution the directory was merged with (empty when none supplied). */
  readonly identities: IdentityResolution;
}

/** Rewrite an opportunity's subject to a resolved handle, and reflect that in its summary. */
function rewriteSubject({
  opportunity,
  identityMap,
}: {
  opportunity: Opportunity;
  identityMap: IdentityMap;
}): Opportunity {
  const resolved = resolveHandle({ map: identityMap, raw: opportunity.subject });
  if (resolved === opportunity.subject) {
    return opportunity;
  }
  return { ...opportunity, subject: resolved, summary: opportunity.summary.split(opportunity.subject).join(resolved) };
}

/**
 * Derive the silver artifacts from the corpus.
 *
 * @param records the bronze corpus records
 * @param identityMap resolves opaque handles in opportunity subjects (empty ⇒ pass-through)
 * @param resolution the cross-source identity resolution to merge the directory with (defaults to empty)
 * @returns the directory, graph, opportunities, and identity resolution
 */
export function deriveSilver({
  records,
  identityMap,
  resolution = EMPTY_RESOLUTION,
}: {
  records: readonly CorpusRecord[];
  identityMap: IdentityMap;
  resolution?: IdentityResolution;
}): SilverArtifacts {
  const directory = buildDirectory({ records, resolution });
  const graph = buildCrossRefGraph({ records });
  const opportunities = spotOpportunities({ edges: graph.edges, records }).map((opportunity) =>
    rewriteSubject({ identityMap, opportunity }),
  );
  return { directory, graph, identities: resolution, opportunities };
}

/**
 * A human summary of a derive run.
 *
 * @param artifacts the derived silver artifacts
 * @param top how many top opportunities to list
 * @returns the summary lines
 */
export function planDeriveSummary({ artifacts, top }: { artifacts: SilverArtifacts; top: number }): readonly string[] {
  const { directory, graph, opportunities, identities } = artifacts;
  const linked = identities.people.filter((person) => person.confidence !== "single-source").length;
  const lines = [
    `directory: ${String(directory.people.length)} people, ${String(directory.containers.length)} containers`,
    `graph: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`,
    `opportunities: ${String(opportunities.length)}`,
    `identities: ${String(identities.people.length)} people (${String(linked)} cross-source linked, ${String(identities.candidates.length)} held, ${String(identities.conflicts.length)} conflicts)`,
  ];
  for (const opportunity of opportunities.slice(0, top)) {
    lines.push(`  [${opportunity.kind}] ${opportunity.summary} (score ${String(opportunity.score)})`);
  }
  return lines;
}
