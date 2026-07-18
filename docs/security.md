# Security & trust

Slopweaver is built local-first on purpose: the biggest objection to any tool that ingests company
data is "where does my data go". The answer here is: nowhere you don't already send it.

## Data flow

All processing is local. Your world model — bronze, silver, gold, and the embedding cache — is written
under `$SLOPWEAVER_HOME` on your machine and is never uploaded. Exactly three things touch the network,
and **none of them is your world-model data leaving**:

1. **GitHub reads you authorise** — `refresh` calls the GitHub API (REST + GraphQL) to read the repo
   history you point it at, using your `gh` login / token. This is a read, over your own credential.
2. **Claude calls you already make** — `distil` and `ask` run the model through your existing Claude
   Code session (the `claude` CLI). Same calls, same account, same data boundary you already accept by
   using Claude Code. No separate API key.
3. **A one-time model download** — the first semantic query downloads the open embedding model
   (`nomic-embed-text-v1.5`) from Hugging Face and caches it under `$SLOPWEAVER_HOME`. This fetches
   model _weights_; it sends none of your data. After that, embeddings run fully offline, on-device.

There is no telemetry, no account, and no Slopweaver server — there is no Slopweaver server to send
anything to.

## Runs anywhere, no native build

Embedding inference runs on WebAssembly (`onnxruntime-web`); there is no native compilation step and no
platform-specific binary, so the same plugin behaves identically on macOS, Linux, and Windows across
CPU architectures. If the embedder is ever unavailable, retrieval fails soft to keyword (BM25) search
rather than breaking.

## Credentials

- **No keys required.** The language-model transport is your existing Claude Code session.
- The only optional credential is a GitHub token, used to read repo history for private repos. It
  falls back to `gh auth token`, and is marked sensitive in the plugin config so it is never printed.

## The hygiene gate (a shipped feature)

`scripts/check-hygiene.sh` (backed by `src/hygiene/scan.ts`) scans every git-tracked file for generic
leak classes — absolute home paths, token shapes, and raw workspace-ID patterns — and fails the build
listing every hit. It names no organisation: you scope your own private literals through an optional
denylist at `$SLOPWEAVER_HOME/hygiene-denylist.txt` (one case-insensitive substring per line). This
protects any user, or any fork, from committing their own secrets.

## Reporting

Found something? Open a private security advisory on the repository.
