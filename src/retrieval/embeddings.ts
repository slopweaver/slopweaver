/**
 * On-device text embeddings via `@xenova/transformers` (transformers.js, ONNX CPU) — the local-first,
 * zero-key half of retrieval. The model (`nomic-embed-text-v1.5`, 768-dim) downloads once then runs
 * offline; no API key. The library is imported DYNAMICALLY so merely importing this module pulls in no
 * ONNX runtime, and a broken/absent binding degrades to a typed `Result` error (semantic search then
 * fails soft to BM25) rather than throwing at import.
 *
 * nomic is asymmetric: documents and queries get different task prefixes, applied here, never by callers.
 * Output is mean-pooled + L2-normalised, so a downstream dot product IS cosine.
 */
import { err, ok, type Result } from "../lib/result.js";
import { stateHomePaths } from "../stateHome.js";

export const EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
export const EMBEDDING_DIM = 768;
/** Per-text char cap (~512 tokens) applied before the forward pass. */
export const MAX_EMBED_CHARS = 2048;

const DOCUMENT_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";
const DEFAULT_EMBED_BATCH_SIZE = 16;
const MAX_EMBED_BATCH_SIZE = 64;

/** The embedder seam — production nomic, or `fakeConceptEmbedder` in tests. */
export interface Embedder {
  readonly modelId: string;
  embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]>;
  embedQuery(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/** The callable feature-extraction pipeline (transformers.js). */
export type ExtractionPipeline = (
  texts: readonly string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Iterable<number> }>;

interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<ExtractionPipeline>;
  /** transformers.js global config; we point the model cache under the world-model home. */
  env: { cacheDir: string };
}

export type TransformersImporter = () => Promise<TransformersModule>;

async function importTransformers(): Promise<TransformersModule> {
  const mod: unknown = await import("@xenova/transformers");
  const transformers = mod as TransformersModule;
  // Co-locate the downloaded model with the world model (survives a node_modules wipe, stays local).
  transformers.env.cacheDir = stateHomePaths().modelCache;
  return transformers;
}

/**
 * Resolve the embed batch size from a raw env value, clamped to `[1, MAX_EMBED_BATCH_SIZE]`.
 *
 * @param raw the raw env string, or undefined
 * @returns the batch size
 */
export function resolveEmbedBatchSize({ raw }: { raw: string | undefined }): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_EMBED_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_EMBED_BATCH_SIZE);
}

/**
 * Slice a flat `count * EMBEDDING_DIM` tensor into `count` per-text vectors. Throws on a length mismatch.
 *
 * @param data the flat tensor data
 * @param count the number of texts
 * @returns one vector per text
 */
export function splitBatchVectors({ data, count }: { data: Iterable<number>; count: number }): readonly Float32Array[] {
  const flat = Float32Array.from(data);
  if (count <= 0 || flat.length % count !== 0) {
    throw new Error(`embedding tensor length ${String(flat.length)} not divisible by ${String(count)}`);
  }
  const dim = flat.length / count;
  return Array.from({ length: count }, (_, i) => flat.slice(i * dim, (i + 1) * dim));
}

/**
 * Embed texts in batches through an injected pipeline `run`. The testable core of the embedder.
 *
 * @param texts the texts to embed
 * @param run the pipeline callable
 * @param batchSize the batch size
 * @param prefix the task prefix to prepend to each text
 * @returns one vector per text
 */
export async function embedInBatches({
  texts,
  run,
  batchSize,
  prefix,
}: {
  texts: readonly string[];
  run: ExtractionPipeline;
  batchSize: number;
  prefix: string;
}): Promise<readonly Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((text) => `${prefix}${text.slice(0, MAX_EMBED_CHARS)}`);
    const result = await run(batch, { normalize: true, pooling: "mean" });
    vectors.push(...splitBatchVectors({ count: batch.length, data: result.data }));
  }
  return vectors;
}

let pipelinePromise: Promise<Result<ExtractionPipeline>> | undefined;

/**
 * Load (once, memoised) the feature-extraction pipeline. A failed load returns a typed error and does
 * NOT poison the memo, so a later call can retry.
 *
 * @param importer the transformers importer (injectable for tests)
 * @returns the pipeline, or an error describing why the embedder is unavailable
 */
export async function loadPipeline({
  importer = importTransformers,
}: {
  importer?: TransformersImporter;
} = {}): Promise<Result<ExtractionPipeline>> {
  if (pipelinePromise !== undefined) {
    return pipelinePromise;
  }
  const attempt = (async (): Promise<Result<ExtractionPipeline>> => {
    try {
      const mod = await importer();
      const run = await mod.pipeline("feature-extraction", EMBEDDING_MODEL);
      return ok(run);
    } catch (error: unknown) {
      pipelinePromise = undefined; // don't poison the memo — allow a retry
      return err([`embedder unavailable: ${error instanceof Error ? error.message : "unknown error"}`]);
    }
  })();
  pipelinePromise = attempt;
  return attempt;
}

async function embedWith({
  texts,
  prefix,
}: {
  texts: readonly string[];
  prefix: string;
}): Promise<readonly Float32Array[]> {
  const pipeline = await loadPipeline();
  if (pipeline.ok === false) {
    throw new Error(pipeline.errors.join("; "));
  }
  return embedInBatches({
    batchSize: resolveEmbedBatchSize({ raw: process.env["SLOPWEAVER_EMBED_BATCH"] }),
    prefix,
    run: pipeline.value,
    texts,
  });
}

/** The production on-device embedder. `embedDocuments`/`embedQuery` throw if the embedder is unavailable. */
export const defaultEmbedder: Embedder = {
  embedDocuments: (texts) => embedWith({ prefix: DOCUMENT_PREFIX, texts }),
  embedQuery: (texts) => embedWith({ prefix: QUERY_PREFIX, texts }),
  modelId: EMBEDDING_MODEL,
};
