/**
 * The ask engine: question → ranked slice → grounded answer. Pure orchestration over the injected
 * client + records (the verb supplies both). One flat corpus — no per-asker scope, no source bias.
 * Semantic context is optional; absent, retrieval is BM25-only (byte-identical to the plain path).
 */
import type { CorpusRecord } from "../corpus/types.js";
import type { Result } from "../lib/result.js";
import type { LlmClient } from "../llm/provider.js";
import { type Answer, answerFromSlice } from "./answerFromSlice.js";
import { hybridSearch } from "./hybridSearch.js";
import type { DecayParams } from "./recencyDecay.js";
import { buildRetrievalIndex, search } from "./retrievalIndex.js";
import type { SemanticContext } from "./semanticRetrieval.js";

/**
 * Retrieve the top-`sliceLimit` records for a question (hybrid when a semantic context is given, else BM25).
 *
 * @param question the query
 * @param records the corpus to search
 * @param sliceLimit max records to return
 * @param decay optional recency-decay params
 * @param semantic optional prepared semantic context (enables hybrid ranking)
 * @param alpha semantic weight for hybrid (only used with `semantic`)
 * @returns the ranked slice of records
 */
export function retrieveRecords({
  question,
  records,
  sliceLimit,
  decay,
  semantic,
  alpha,
}: {
  question: string;
  records: readonly CorpusRecord[];
  sliceLimit: number;
  decay?: DecayParams;
  semantic?: SemanticContext;
  alpha?: number;
}): readonly CorpusRecord[] {
  const index = buildRetrievalIndex({ records });
  const ids =
    semantic !== undefined
      ? hybridSearch({
          index,
          limit: sliceLimit,
          query: question,
          queryVector: semantic.queryVector,
          vectorIndex: semantic.vectorIndex,
          ...(alpha !== undefined ? { alpha } : {}),
          ...(decay !== undefined ? { decay } : {}),
        })
      : search({ index, limit: sliceLimit, query: question, ...(decay !== undefined ? { decay } : {}) });
  const byId = new Map(records.map((record) => [record.sourceId, record]));
  return ids
    .flatMap((id) => {
      const record = byId.get(id);
      return record !== undefined ? [record] : [];
    })
    .slice(0, Math.max(0, sliceLimit));
}

/**
 * Answer a question over the corpus: retrieve a slice, then compose a grounded answer.
 *
 * @param question the query
 * @param client the LLM transport
 * @param records the corpus
 * @param sliceLimit max records to ground in
 * @param decay optional recency-decay params
 * @param semantic optional prepared semantic context
 * @param alpha semantic weight for hybrid
 * @returns the grounded answer
 */
export async function answerQuestion({
  question,
  client,
  records,
  sliceLimit,
  decay,
  semantic,
  alpha,
}: {
  question: string;
  client: LlmClient;
  records: readonly CorpusRecord[];
  sliceLimit: number;
  decay?: DecayParams;
  semantic?: SemanticContext;
  alpha?: number;
}): Promise<Result<Answer>> {
  const slice = retrieveRecords({
    question,
    records,
    sliceLimit,
    ...(decay !== undefined ? { decay } : {}),
    ...(semantic !== undefined ? { semantic } : {}),
    ...(alpha !== undefined ? { alpha } : {}),
  });
  return answerFromSlice({ client, question, slice });
}
