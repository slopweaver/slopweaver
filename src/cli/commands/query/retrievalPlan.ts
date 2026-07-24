/**
 * The shared owner-lens retrieval plan for the query verbs (`ask`/`facts`): resolve the owner, apply the
 * scope + first-person lens ({@link planOwnerScopedRetrieval}), and prepare the semantic context over the
 * SELECTED (scoped) record set + the (possibly rewritten) query. Extracted so both shells stay thin and
 * the "scope-before-embed" ordering — a non-owner's vector index never contains a private record — lives
 * in one place. The `ownerContext`/`prepareSemantic` seams are injected (fakes in the shells' tests).
 */
import type { CorpusRecord } from "../../../corpus/types.js";
import { planOwnerScopedRetrieval } from "../../../retrieval/accessScope.js";
import type { OwnerIdentity } from "../../../retrieval/ownerScope.js";
import { type DecayParams, decayParamsFromDays } from "../../../retrieval/recencyDecay.js";
import type { SemanticPreparation } from "../../../retrieval/semanticRetrieval.js";

/** The resolved plan: the record set to search, the retrieval query, its decay, and the semantic context. */
export interface QueryRetrievalPlan {
  readonly records: readonly CorpusRecord[];
  readonly query: string;
  readonly decay?: DecayParams;
  readonly semantic: SemanticPreparation;
}

/**
 * Plan owner-scoped retrieval for a query verb + prepare its semantic context. Pure orchestration over the
 * injected `ownerContext` (identity resolution) + `prepareSemantic` (embedder) seams.
 *
 * @param home the world-model home
 * @param nowMs the reference "now" for recency decay
 * @param question the original question
 * @param halfLifeDays the recency half-life override, when set
 * @param semantic whether semantic ranking is enabled
 * @param records the full loaded corpus
 * @param ownerContext resolve the owner's cross-source identity
 * @param prepareSemantic prepare the semantic context over a record set + query
 * @returns the scoped records, the retrieval query + decay, and the prepared semantic context
 */
export async function planQueryRetrieval({
  home,
  nowMs,
  question,
  halfLifeDays,
  semantic,
  records,
  ownerContext,
  prepareSemantic,
}: {
  home: string;
  nowMs: number;
  question: string;
  halfLifeDays: number | undefined;
  semantic: boolean;
  records: readonly CorpusRecord[];
  ownerContext: (args: { home: string; records: readonly CorpusRecord[] }) => { owner: OwnerIdentity | undefined };
  prepareSemantic: (args: {
    home: string;
    question: string;
    records: readonly CorpusRecord[];
    semantic: boolean;
  }) => Promise<SemanticPreparation>;
}): Promise<QueryRetrievalPlan> {
  const { owner } = ownerContext({ home, records });
  const planned = planOwnerScopedRetrieval({
    decay: decayParamsFromDays({ days: halfLifeDays, nowMs }),
    owner,
    question,
    records,
  });
  const prepared = await prepareSemantic({ home, question: planned.query, records: planned.records, semantic });
  return {
    query: planned.query,
    records: planned.records,
    semantic: prepared,
    ...(planned.decay !== undefined ? { decay: planned.decay } : {}),
  };
}
