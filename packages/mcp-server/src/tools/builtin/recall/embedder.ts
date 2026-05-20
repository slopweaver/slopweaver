/**
 * Deterministic hash-bag-of-words embedder. Tokenizes input, hashes
 * each token into a fixed-dimensional vector slot, accumulates counts,
 * L2-normalizes the result. Pure function, zero deps.
 *
 * Not as semantically rich as a real local model (bge-small etc.) but:
 *
 * 1. Deterministic — tests are stable; same input always gives the
 *    same vector.
 * 2. Fast — no model download, no warm-up, no GC pressure on a
 *    bge-small-class WASM runtime.
 * 3. Zero deps — node:crypto is in the standard library.
 * 4. Drop-in swappable — the embedder interface stays the same, so a
 *    follow-up PR can substitute a real model without touching the
 *    `recall` tool.
 *
 * The 256-dimensional fingerprint gives reasonable substring-overlap
 * similarity at low cost. Cosine similarity of two embeddings is what
 * `recall` ranks on.
 */

import { createHash } from 'node:crypto';

export type Embedder = {
  readonly name: string;
  readonly dimensions: number;
  readonly embed: (text: string) => Float32Array;
};

const DEFAULT_DIMENSIONS = 256;

/** Tokenize: lowercase, split on non-word, strip 1-char tokens + stopwords. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function hashToBucket(token: string, dimensions: number): number {
  // sha1 → first 4 bytes → 32-bit unsigned int → modulo dimensions.
  const digest = createHash('sha1').update(token).digest();
  const first = digest.readUInt32BE(0);
  return first % dimensions;
}

export function createHashBagEmbedder(args: { dimensions?: number } = {}): Embedder {
  const dimensions = args.dimensions ?? DEFAULT_DIMENSIONS;
  return {
    name: `hash-bag-${dimensions}`,
    dimensions,
    embed: (text) => {
      const vec = new Float32Array(dimensions);
      const tokens = tokenize(text);
      for (const token of tokens) {
        const bucket = hashToBucket(token, dimensions);
        vec[bucket] = (vec[bucket] ?? 0) + 1;
      }
      // L2-normalize so cosine similarity = dot product.
      let norm = 0;
      for (let i = 0; i < dimensions; i += 1) {
        const v = vec[i] ?? 0;
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dimensions; i += 1) {
          vec[i] = (vec[i] ?? 0) / norm;
        }
      }
      return vec;
    },
  };
}

/**
 * Cosine similarity of two L2-normalized embedding vectors. Since both
 * inputs are unit vectors, this is just the dot product. Returns a
 * value in [0, 1] — the clamp catches floating-point overshoot.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  if (dot < 0) return 0;
  if (dot > 1) return 1;
  return dot;
}
