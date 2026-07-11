/**
 * derive — the free, deterministic silver synthesis. Pure orchestration over the corpus: build the
 * directory, the cross-ref graph, and the opportunities, then rewrite opaque handles in opportunity
 * subjects/summaries via the identity map (a pass-through when the map is empty). A full re-scan each
 * run — cheap and deterministic, so there's no diffing. The verb handles reading the corpus and writing
 * the JSON artifacts.
 */
import type { CorpusRecord } from '../corpus/types.js'
import { buildDirectory, type DirectoryEntry } from './directory.js'
import { buildCrossRefGraph, type GraphEdge } from './graph.js'
import { spotOpportunities, type Opportunity } from './opportunity.js'
import { type IdentityMap, resolveHandle } from './identity.js'

export interface SilverArtifacts {
  readonly directory: { readonly people: readonly DirectoryEntry[]; readonly containers: readonly DirectoryEntry[] }
  readonly graph: { readonly nodes: readonly string[]; readonly edges: readonly GraphEdge[] }
  readonly opportunities: readonly Opportunity[]
}

/** Rewrite an opportunity's subject to a resolved handle, and reflect that in its summary. */
function rewriteSubject({ opportunity, identityMap }: { opportunity: Opportunity; identityMap: IdentityMap }): Opportunity {
  const resolved = resolveHandle({ map: identityMap, raw: opportunity.subject })
  if (resolved === opportunity.subject) {
    return opportunity
  }
  return { ...opportunity, subject: resolved, summary: opportunity.summary.split(opportunity.subject).join(resolved) }
}

/**
 * Derive the silver artifacts from the corpus.
 *
 * @param records the bronze corpus records
 * @param identityMap resolves opaque handles (empty ⇒ pass-through)
 * @returns the directory, graph, and opportunities
 */
export function deriveSilver({ records, identityMap }: { records: readonly CorpusRecord[]; identityMap: IdentityMap }): SilverArtifacts {
  const directory = buildDirectory({ records })
  const graph = buildCrossRefGraph({ records })
  const opportunities = spotOpportunities({ records, edges: graph.edges })
    .map((opportunity) => rewriteSubject({ opportunity, identityMap }))
  return { directory, graph, opportunities }
}

/**
 * A human summary of a derive run.
 *
 * @param artifacts the derived silver artifacts
 * @param top how many top opportunities to list
 * @returns the summary lines
 */
export function planDeriveSummary({ artifacts, top }: { artifacts: SilverArtifacts; top: number }): readonly string[] {
  const { directory, graph, opportunities } = artifacts
  const lines = [
    `directory: ${String(directory.people.length)} people, ${String(directory.containers.length)} containers`,
    `graph: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`,
    `opportunities: ${String(opportunities.length)}`,
  ]
  for (const opportunity of opportunities.slice(0, top)) {
    lines.push(`  [${opportunity.kind}] ${opportunity.summary} (score ${String(opportunity.score)})`)
  }
  return lines
}
