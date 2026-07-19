# Architecture

How Slopweaver turns a repo's history into a queryable, on-device world model. Everything runs locally;
the only things that leave your machine are the GitHub reads you authorise and the Claude calls you
already make in Claude Code.

## Shape

A single-package Claude Code plugin — no MCP server, no monorepo. A bundled CLI (the verb framework
under `src/cli/`) does the work; markdown slash-commands shell that CLI. State lives in a medallion
corpus under `$SLOPWEAVER_HOME`.

```
GitHub  ──refresh──▶  bronze  ──derive──▶  silver  ──distil──▶  gold
 (REST + GraphQL)     (records)   (free)   (graph/opps)  (LLM)   (markdown)
                                     │                              │
                                     └──────────  ask / facts  ◀────┘
                                        (hybrid retrieval + grounded answer)
```

## The atom

Everything hangs off one source-agnostic record — `CorpusRecord` (`src/corpus/types.ts`): `source`,
`sourceId`, `url`, `tsIso`, `kind`, `container`, `text`, `refs`, optional `author`/`title`. Connectors
project their data into this shape; every downstream stage consumes it, so adding a source never
touches the pipeline. Bronze is fed by direct-SDK connectors for **GitHub, Slack, Linear, and Notion**
(no MCP — single-package API clients) plus a synthetic `gold` source.

## Stages

- **refresh → bronze** (`src/corpus/`): per-source direct-SDK connectors, each an effectful fetch edge
  (behind an injected seam) + a pure projection into `CorpusRecord` — GitHub (REST search + GraphQL
  activity), Slack (all accessible channels: messages/threads/reactions + ref-only file/image
  attachments), Linear (issues/projects/comments/status via `@linear/sdk`), Notion (pages + databases,
  recursive blocks chunked). All flow through the one redact → fingerprint-dedup → JSONL writer with a
  per-source watermark for incremental resume. `refresh --source <id>` / `--all-sources` select sources;
  bare `refresh` stays GitHub-only. Tokens resolve from env / `$SLOPWEAVER_HOME/secrets/*` (GitHub is
  gh-first); no data leaves the machine.
- **derive → silver** (`src/silver/`): free, deterministic synthesis — a people/container directory, a
  cross-ref graph (shared-token cliques), a **cross-source identity map** (the same human across
  GitHub/Slack/Linear/Notion resolved into one canonical person, data-first with a confidence +
  provenance on every link), and opportunity detection (cross-cutting / blocker / duplication). A full
  re-scan each run. The identity roster (`$SLOPWEAVER_HOME/identity.json`, off-repo) is the human
  override/seed that always wins; low-confidence name-only links are held (surfaced, not applied). The
  `identity` verb (`show`/`resolve`) reads it back.
- **distil → gold** (`src/gold/`): an LLM map-reduce — batches → grounded per-container digests →
  per-source silver digests → gold markdown (overview / by-source / where-to-look). A content-hash
  batch cache re-calls the model only for batches whose bronze changed.
- **ask / facts** (`src/retrieval/`): hybrid retrieval (BM25 ⊕ on-device cosine, recency-weighted,
  fail-soft to BM25) over bronze + gold, then a grounded, cited answer (`ask`) or the raw ranked slice
  (`facts`).

## Zero-key transports

- **LLM**: the keyless `claude` CLI on your existing Claude Code session (`src/llm/`) — no API key, no
  SDK. There are no model/token knobs; the CLI uses your session model.
- **Embeddings**: on-device via `@xenova/transformers` (`nomic-embed-text-v1.5`, 768-dim). Inference
  runs on WASM (`onnxruntime-web`) — no native build, so it works on any OS/arch; the model downloads
  once and caches. If the embedder is unavailable, retrieval fails soft to BM25.

## Packaging

Distributed as a Claude Code plugin. `bin/` is on the Bash PATH; slash-commands shell
`"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver"`. Node dependencies are NOT committed — a `SessionStart` hook
installs them into the persistent `${CLAUDE_PLUGIN_DATA}` on first run (or when `package.json` changes),
and the launcher runs the TypeScript source via `tsx`. No native build (WASM inference).

## Trust

A shipped hygiene gate (`src/hygiene/`) scans every tracked file for generic leak classes and runs in
CI + a local pre-push hook. See [security.md](security.md).

## Layout

```
bin/slopweaver          # launcher (resolves config + deps, runs the CLI via tsx)
src/cli/                # verb framework + dispatch spine + the verbs
src/corpus/             # CorpusRecord atom, GitHub connector, bronze writer/reader
src/silver/  src/gold/  # derive + distil
src/retrieval/          # embeddings, vector cache, hybrid search, answer engine
src/llm/                # keyless claude-CLI transport (test seam)
src/hygiene/            # public leak-class gate
commands/               # markdown slash-commands (shell the CLI)
hooks/                  # SessionStart dep-install hook
docs/                   # this doc + the security model
```
