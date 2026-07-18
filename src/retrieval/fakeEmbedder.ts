/**
 * A deterministic, IO-free "concept embedder" for tests. A handful of concept axes (keyword sets) map
 * text onto a small unit vector: synonyms land on the same axis, so lexically-disjoint text about the
 * same concept embeds close — enough to exercise the hybrid ranker without downloading a model.
 * Symmetric (documents and queries embed identically).
 */
import type { Embedder } from "./embeddings.js";

const CONCEPTS: readonly (readonly string[])[] = [
  ["auth", "login", "token", "session", "oauth", "credential"],
  ["deploy", "release", "build", "pipeline", "ship", "connector"],
  ["bug", "error", "fail", "crash", "fix", "blocked"],
  ["corpus", "record", "ingest", "store", "bronze", "gold", "retrieval"],
];

/** Embed one text onto the concept axes, L2-normalised. */
function embedOne({ text }: { text: string }): Float32Array {
  const lower = text.toLowerCase();
  const axes = CONCEPTS.map((keywords) =>
    keywords.reduce((weight, keyword) => weight + (lower.includes(keyword) ? 1 : 0), 0),
  );
  const norm = Math.sqrt(axes.reduce((sum, a) => sum + a * a, 0)) || 1;
  return Float32Array.from(axes.map((a) => a / norm));
}

/** A deterministic in-memory embedder for tests — no model download, no IO. */
export const fakeConceptEmbedder: Embedder = {
  embedDocuments: async (texts) => texts.map((text) => embedOne({ text })),
  embedQuery: async (texts) => texts.map((text) => embedOne({ text })),
  modelId: "fake-concept-embedder-v1",
};
