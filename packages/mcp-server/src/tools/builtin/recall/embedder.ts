/**
 * Deterministic signed-feature-hashing embedder. Tokenizes input,
 * hashes each token into a fixed-dimensional vector slot AND a sign
 * bit, accumulates signed counts, L2-normalizes the result. Pure
 * function, zero deps.
 *
 * Not as semantically rich as a real local model (bge-small etc.) but:
 *
 * 1. Deterministic — tests are stable; same input always gives the
 *    same vector.
 * 2. Fast — no model download, no warm-up, no GC pressure on a
 *    bge-small-class WASM runtime.
 * 3. Zero deps — node:crypto is in the standard library.
 * 4. Drop-in swappable — the embedder interface is async, so a
 *    follow-up PR can substitute a real model without touching the
 *    `recall` tool.
 *
 * **Why signed hashing.** A naive unsigned bag-of-buckets collides
 * unrelated tokens additively: if `theta` and `tau` happen to map to
 * the same bucket they both increment it, scoring 1.0 on cosine
 * despite sharing no vocabulary. The signed variant assigns each
 * token an independent +/-1 sign from a separate hash bit; collisions
 * still happen but contribute zero in expectation, so unrelated
 * corpora score near zero rather than near one. Reference: Weinberger
 * et al., "Feature Hashing for Large Scale Multitask Learning" (2009).
 *
 * The 256-dimensional fingerprint gives reasonable substring-overlap
 * similarity at low cost. Cosine similarity of two embeddings is what
 * `recall` ranks on. Vectors are L2-normalized inside `embed`, so the
 * similarity helper is a plain dot product in [-1, 1].
 */

import { createHash } from 'node:crypto';

/**
 * Embedder interface — async by design so a real local model
 * (bge-small via @xenova/transformers, candle, etc.) is drop-in
 * swappable. Implementations MUST return an L2-normalized
 * `Float32Array` of length `dimensions`; `cosineSimilarity` assumes
 * unit vectors and skips re-normalizing.
 */
export type Embedder = {
  readonly name: string;
  readonly dimensions: number;
  readonly embed: (text: string) => Promise<Float32Array>;
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

/**
 * Hash a token to (bucket, sign). Both come from the same sha1
 * digest but use independent byte ranges so they're statistically
 * uncorrelated:
 *  - bucket: first 4 bytes → uint32 → modulo dimensions
 *  - sign:   byte 4, low bit → -1 or +1
 */
function hashTokenSigned({ token, dimensions }: { token: string; dimensions: number }): {
  bucket: number;
  sign: 1 | -1;
} {
  const digest = createHash('sha1').update(token).digest();
  const first = digest.readUInt32BE(0);
  const bucket = first % dimensions;
  const signByte = digest[4] ?? 0;
  const sign: 1 | -1 = (signByte & 1) === 0 ? 1 : -1;
  return { bucket, sign };
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
        const { bucket, sign } = hashTokenSigned({ token, dimensions });
        vec[bucket] = (vec[bucket] ?? 0) + sign;
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
      return Promise.resolve(vec);
    },
  };
}

/**
 * Cosine similarity of two L2-normalized embedding vectors. Since
 * both inputs are unit vectors, this is just the dot product, which
 * lives in `[-1, 1]`. The clamp catches floating-point overshoot at
 * the bounds; we do NOT remap to `[0, 1]` — callers that want a
 * non-negative score should filter or shift downstream. Returns `0`
 * for mismatched dimensions (defensive; ranks the row out).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  if (dot < -1) return -1;
  if (dot > 1) return 1;
  return dot;
}
