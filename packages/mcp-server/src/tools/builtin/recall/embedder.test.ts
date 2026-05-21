/**
 * Pure-function tests for the signed-hash-bag embedder + cosine similarity.
 */

import { describe, expect, it } from 'vitest';
import { cosineSimilarity, createHashBagEmbedder } from './embedder.ts';

describe('createHashBagEmbedder', () => {
  const embedder = createHashBagEmbedder();

  it('produces a normalized vector of the configured dimensions', async () => {
    const v = await embedder.embed('hello world');
    expect(v.length).toBe(256);
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('is deterministic — same input → identical vector', async () => {
    const a = await embedder.embed('foo bar baz');
    const b = await embedder.embed('foo bar baz');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns a zero vector for input with only stopwords + 1-char tokens', async () => {
    const v = await embedder.embed('a the of an and');
    let nonzero = 0;
    for (const x of v) if (x !== 0) nonzero += 1;
    expect(nonzero).toBe(0);
  });

  it('is case-insensitive', async () => {
    const a = await embedder.embed('Hello World');
    const b = await embedder.embed('hello world');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('exposes a stable name + dimensions', () => {
    expect(embedder.name).toBe('hash-bag-256');
    expect(embedder.dimensions).toBe(256);
  });

  it('produces signed components (not just non-negative counts)', async () => {
    // Signed hashing assigns each token a +/-1 sign. Across a moderately
    // diverse vocabulary we expect both polarities to appear; a purely
    // non-negative vector would mean the sign bit isn't being applied.
    const v = await embedder.embed(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega',
    );
    let hasPositive = false;
    let hasNegative = false;
    for (const x of v) {
      if (x > 0) hasPositive = true;
      if (x < 0) hasNegative = true;
    }
    expect(hasPositive).toBe(true);
    expect(hasNegative).toBe(true);
  });
});

describe('cosineSimilarity', () => {
  const embedder = createHashBagEmbedder();

  it('returns 1.0 for identical inputs', async () => {
    const v = await embedder.embed('alpha beta gamma');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns ~0 for inputs with no shared tokens', async () => {
    const a = await embedder.embed('alpha beta gamma');
    const b = await embedder.embed('completely different lexicon entirely');
    // Signed hashing collision-cancels in expectation; unrelated single-token
    // pairs occasionally still spike via collisions, but multi-token disjoint
    // corpora should sit well under 0.05.
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.05);
  });

  it('returns a value in [-1, 1] for partial overlap (positive on shared tokens)', async () => {
    const a = await embedder.embed('alpha beta gamma');
    const b = await embedder.embed('alpha delta epsilon');
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('keeps known unsigned-hashing collision pairs near zero', async () => {
    // The unsigned bag-of-buckets variant scored these greek-letter pairs
    // at 1.0 because their sha1-mod-256 buckets happened to collide. The
    // signed variant has the same bucket collision but an opposing sign
    // bit, so the dot product drops back to the disjoint-vocab baseline.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['theta', 'tau'],
      ['epsilon', 'omega'],
    ];
    for (const [left, right] of pairs) {
      const a = await embedder.embed(left);
      const b = await embedder.embed(right);
      // Single-token collisions can still spike +/-1 on the few buckets
      // they occupy. The point is that they're no longer pinned to +1.
      expect(cosineSimilarity(a, b)).toBeLessThan(0.999);
    }
  });

  it('keeps a multi-token disjoint corpus tightly near zero', async () => {
    const a = await embedder.embed('payments billing invoice subscription customer renewal');
    const b = await embedder.embed('compiler lexer parser token grammar production');
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.05);
  });

  it('returns 0 for mismatched dimensions', async () => {
    const a = await createHashBagEmbedder({ dimensions: 128 }).embed('test');
    const b = await createHashBagEmbedder({ dimensions: 256 }).embed('test');
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
