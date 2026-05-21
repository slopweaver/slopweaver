/**
 * Pure-function tests for the signed-hash-bag embedder + cosine similarity.
 */

import { describe, expect, it } from 'vitest';
import { cosineSimilarity, createHashBagEmbedder } from './embedder.ts';

describe('createHashBagEmbedder', () => {
  const embedder = createHashBagEmbedder();

  it('produces a normalized vector of the configured dimensions', async () => {
    const v = await embedder.embed('hello world');
    expect(v.length).toBe(4096);
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
    expect(embedder.name).toBe('hash-bag-4096');
    expect(embedder.dimensions).toBe(4096);
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
    // single-hash signed variant fixed bucket-only collisions but still
    // pinned to +1.0 when the sign bit also matched (e.g. `epsilon`/`chi`).
    // Multi-hash sketching (k=3, 4096 buckets) drops the all-buckets-
    // collide probability to ~1e-12; single-bucket collisions can still
    // contribute 1/k = ~0.333 to cosine when the sign matches, so the
    // threshold is set to 0.5 for the worst-case single-token regime.
    // Multi-token corpora cancel collisions in expectation — see the
    // multi-token disjoint-corpus test below for the tighter bound.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['theta', 'tau'],
      ['epsilon', 'omega'],
    ];
    for (const [left, right] of pairs) {
      const a = await embedder.embed(left);
      const b = await embedder.embed(right);
      expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.5);
    }
  });

  it('keeps disjoint single-token pairs from collapsing to +1.0 (multi-hash regression)', async () => {
    // Iter-2 of PR #70 found that signed feature hashing with a single
    // (bucket, sign) pair per token still produced false +1.0 scores
    // when two unrelated tokens collided on BOTH bucket AND sign — e.g.
    // `epsilon`/`chi` and `xi`/`phi` under the 256-bucket variant. The
    // fix is multi-hash sketching (k=3 independent bucket+sign pairs
    // per token), which drops all-pairs-collide probability to ~1e-12
    // at 4096 buckets. This test sweeps a broad set of disjoint Greek
    // and Latin token pairs and asserts NONE score above 0.3 (loose
    // upper bound — actual scores cluster near zero, often exactly 0
    // when no bucket overlap occurs at all).
    const pairs: ReadonlyArray<readonly [string, string]> = [
      // Pairs observed to false-positive in iter-2:
      ['epsilon', 'chi'],
      ['xi', 'phi'],
      // Other Greek letters paired arbitrarily:
      ['alpha', 'beta'],
      ['gamma', 'delta'],
      ['zeta', 'eta'],
      ['theta', 'iota'],
      ['kappa', 'lambda'],
      ['mu', 'nu'],
      ['omicron', 'rho'],
      ['sigma', 'upsilon'],
      ['psi', 'omega'],
      // Latin/English pairs across unrelated domains:
      ['payment', 'compiler'],
      ['invoice', 'lexer'],
      ['customer', 'parser'],
      ['subscription', 'grammar'],
      ['renewal', 'token'],
      ['billing', 'production'],
      ['refund', 'syntax'],
      ['dashboard', 'inference'],
      ['analytics', 'gradient'],
      ['warehouse', 'neuron'],
      ['router', 'embedding'],
    ];
    for (const [left, right] of pairs) {
      const a = await embedder.embed(left);
      const b = await embedder.embed(right);
      const score = cosineSimilarity(a, b);
      expect(Math.abs(score)).toBeLessThan(0.3);
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
