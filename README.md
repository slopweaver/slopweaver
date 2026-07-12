# Slopweaver

**A local-first, zero-key org world model — the own-your-data alternative to hosted enterprise search.**

Point Slopweaver at a GitHub repo and it builds a queryable world model of your team's work, entirely on
your machine: it ingests the history, runs a tiered **bronze → silver → gold** synthesis, and lets you
**ask grounded, cited questions** of it. No API keys, no data leaving your machine, no accounts.

```
/slopweaver:onboard your-org/your-repo
/slopweaver:ask "what has the team shipped recently, and what's blocked?"
```

## Why

- **Zero-key.** Nothing to configure. Language-model calls run on your **existing Claude Code session**
  (via the `claude` CLI — no API key, no SDK). Embeddings run **on-device**. The only optional
  credential is a GitHub token for private repos, and it defaults to your `gh` CLI login.
- **Local-first.** Your world model lives under `$SLOPWEAVER_HOME` on your machine. The only things that
  leave it are the GitHub reads you authorise and the Claude calls you already make. See
  [docs/security.md](docs/security.md).
- **Runs anywhere.** No native build step — inference is pure WASM. The same plugin works on macOS,
  Linux, and Windows, on any CPU architecture.
- **Grounded, not hallucinated.** Every answer cites the exact records it's built from; a citation the
  model can't back is stripped, not shown.

## Install (as a Claude Code plugin)

```
/plugin marketplace add /path/to/slopweaver
/plugin install slopweaver@slopweaver-dev
```

On first session the plugin installs its own dependencies into its plugin-data dir (one-time, ~a
minute) — you don't run `npm install`. Requires Node + Corepack/Yarn and the `claude` CLI (you already
have it). Then run `/slopweaver:onboard` to build your first world model.

## The pipeline

| Command | Stage | What it does |
|---|---|---|
| `/slopweaver:refresh` | **bronze** | Ingest recent GitHub activity (PRs, issues, reviews, comments) into a local corpus. Incremental — resumes from a watermark. |
| `/slopweaver:derive` | **silver** | Free, deterministic synthesis: a people/container directory, a cross-ref graph, and opportunity detection. |
| `/slopweaver:distil` | **gold** | LLM map-reduce into grounded markdown digests (via your Claude session; caches per batch, so re-runs are cheap). |
| `/slopweaver:ask` | **query** | A grounded, cited answer over hybrid retrieval (on-device semantic ⊕ keyword, fail-soft to keyword). |
| `/slopweaver:facts` | **query** | The raw ranked record slice, no LLM — for feeding a subagent or eyeballing the corpus. |

To update: re-run `refresh → derive → distil`. `refresh` pulls only new activity; `distil` only
re-synthesises batches whose content changed.

## Trust

The biggest objection to any tool that ingests company data is "where does it go?" — here, nowhere you
don't already send it. A shipped **hygiene gate** scans every tracked file for leak classes (secrets,
absolute paths, raw workspace IDs) and runs in CI + a local pre-push hook, so neither you nor a fork
can commit your org's secrets. Full threat model + data-flow: [docs/security.md](docs/security.md).

## Development

Requires [Node](https://nodejs.org) (see `.nvmrc`) and [Yarn 4](https://yarnpkg.com) (via Corepack —
`corepack enable` once).

```bash
yarn install
yarn slopweaver doctor  # smoke-test the CLI
yarn typecheck          # tsc --noEmit
yarn test:unit          # vitest
yarn hygiene            # public leak-class gate
```

Architecture: [docs/architecture.md](docs/architecture.md).

## License

MIT — see [LICENSE](LICENSE).
