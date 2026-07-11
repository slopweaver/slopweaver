# Architecture

How Slopweaver is put together. This is a stub for v0.1; it grows as the pipeline lands.

## Intent

A single-package Claude Code plugin that turns a repo's history into a queryable, on-device world
model. No MCP server, no monorepo: a bundled CLI (the verb framework under `src/cli/`) plus markdown
slash-commands, and a warehouse of tiered artifacts under `$SLOPWEAVER_HOME`.

## Shape (target)

- **CLI verb framework** (`src/cli/`) — a lazy-loaded `<noun> <verb>` dispatcher. Verbs register in a
  manifest barrel; each verb's module loads only when it is dispatched.
- **Corpus** — one source-agnostic record atom is the seam every connector rebuilds behind.
- **Tiering** — bronze (raw ingest) → silver (deterministic derivation) → gold (synthesised markdown).
- **Retrieval** — on-device embeddings plus lexical search, answering from the smallest grounded slice.

## Layout

```
bin/slopweaver          # launcher
src/cli/                # verb framework + dispatch spine
src/hygiene/            # public leak-class gate (a shipped feature)
scripts/                # CI-wired shell gates
docs/                   # this doc + the security model
```
