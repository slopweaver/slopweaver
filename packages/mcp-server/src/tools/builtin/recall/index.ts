/**
 * Recall barrel. The tool itself plus the embedder interface and the
 * default hash-bag implementation, so future PRs swapping in a real
 * local model can import the interface without touching the tool body.
 */

export { createRecallTool } from './recall.ts';
export type { CreateRecallToolArgs } from './recall.ts';
export { createHashBagEmbedder, cosineSimilarity } from './embedder.ts';
export type { Embedder } from './embedder.ts';
