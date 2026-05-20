/**
 * Pure-function tests for the hash-bag embedder + cosine similarity.
 */

import { describe, expect, it } from 'vitest';
import { cosineSimilarity, createHashBagEmbedder } from './embedder.ts';

describe('createHashBagEmbedder', () => {
  const embedder = createHashBagEmbedder();

  it('produces a normalized vector of the configured dimensions', () => {
    const v = embedder.embed('hello world');
    expect(v.length).toBe(256);
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('is deterministic — same input → identical vector', () => {
    const a = embedder.embed('foo bar baz');
    const b = embedder.embed('foo bar baz');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns a zero vector for input with only stopwords + 1-char tokens', () => {
    const v = embedder.embed('a the of an and');
    let nonzero = 0;
    for (const x of v) if (x !== 0) nonzero += 1;
    expect(nonzero).toBe(0);
  });

  it('is case-insensitive', () => {
    const a = embedder.embed('Hello World');
    const b = embedder.embed('hello world');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('exposes a stable name + dimensions', () => {
    expect(embedder.name).toBe('hash-bag-256');
    expect(embedder.dimensions).toBe(256);
  });
});

describe('cosineSimilarity', () => {
  const embedder = createHashBagEmbedder();

  it('returns 1.0 for identical inputs', () => {
    const v = embedder.embed('alpha beta gamma');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns ~0 for inputs with no shared tokens', () => {
    const a = embedder.embed('alpha beta gamma');
    const b = embedder.embed('completely different lexicon entirely');
    expect(cosineSimilarity(a, b)).toBeLessThan(0.2);
  });

  it('returns a value in [0, 1] for partial overlap', () => {
    const a = embedder.embed('alpha beta gamma');
    const b = embedder.embed('alpha delta epsilon');
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 for mismatched dimensions', () => {
    const a = createHashBagEmbedder({ dimensions: 128 }).embed('test');
    const b = createHashBagEmbedder({ dimensions: 256 }).embed('test');
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
