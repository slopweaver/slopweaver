/**
 * The effectful helpers shared by the `ask` + `facts` shells — the on-device semantic-context prep (embed
 * the query + corpus, fail-soft to BM25) routed with STDERR-only progress so it never corrupts the answer
 * or `--json` on stdout. Kept here (not in the pure `core`) because it drives the embedder + disk cache;
 * both verbs inject it as the `prepareSemantic` seam so their tests stay IO-free.
 */
import { cacheDir } from "../../../corpus/corpusPaths.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter } from "../../../lib/progress.js";
import { defaultEmbedder } from "../../../retrieval/embeddings.js";
import { prepareSemanticContext, type SemanticPreparation } from "../../../retrieval/semanticRetrieval.js";
import { diskVectorCacheStore } from "../../../retrieval/vectorCacheStore.js";

/**
 * Prepare the semantic retrieval context for a query (production wiring of the `prepareSemantic` seam):
 * when `semantic` is on, embed the query + corpus via the on-device embedder + disk cache, emitting embed
 * progress to STDERR; when off, return a non-degraded no-op. Fail-soft is inside `prepareSemanticContext`.
 *
 * @param home the world-model home (locates the vector cache)
 * @param question the query to embed
 * @param records the corpus to embed
 * @param semantic whether semantic retrieval is enabled (`--no-semantic` turns it off)
 * @returns the semantic preparation (a `context` when available)
 */
export async function prepareSemanticForQuery({
  home,
  question,
  records,
  semantic,
}: {
  home: string;
  question: string;
  records: readonly CorpusRecord[];
  semantic: boolean;
}): Promise<SemanticPreparation> {
  if (!semantic) {
    return { degraded: false };
  }
  const embedProgress = createProgressEmitter({
    sink: (line) => {
      process.stderr.write(line);
    },
    verb: "embed",
  });
  return prepareSemanticContext({
    deps: { embedder: defaultEmbedder, store: diskVectorCacheStore({ cacheDir: cacheDir({ home }) }) },
    enabled: true,
    onProgress: (p) => {
      embedProgress.update({ done: p.done, phase: "records", total: p.total });
    },
    query: question,
    records,
    warn: (m) => {
      logger.warn(m);
    },
  });
}
