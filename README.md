# Slopweaver

Build a local-first, zero-key org world model from your GitHub history: point it at a repo, it
ingests the history, runs a tiered (bronze → silver → gold) synthesis on your machine, and lets you
ask questions of it. The free, own-your-data alternative to a hosted enterprise search.

> 🚧 **v0.1 in progress.** The scaffold, CLI verb framework, and the public hygiene gate are in
> place. The ingest, tiering, and ask pipeline land in the following releases.

## Why

- **Zero-key.** Nothing to configure. The language-model calls use your existing Claude Code session;
  embeddings run on-device. The only optional credential is a GitHub token for private repos, and it
  falls back to `gh auth token`.
- **Local-first.** Your world model lives under `$SLOPWEAVER_HOME` on your machine. Nothing leaves it
  except the Claude calls you already make in Claude Code.
- **Trust is first-class.** A shipped hygiene gate scans every tracked file for leak classes (secrets,
  absolute paths, raw workspace IDs) so you never commit your own org's secrets. See
  [docs/security.md](docs/security.md).

## Try it

```bash
slopweaver doctor
```

Prints the plugin version and your resolved `SLOPWEAVER_HOME`.

## Development

Requires [Node](https://nodejs.org) (see `.nvmrc`) and [Yarn 4](https://yarnpkg.com) (resolved
automatically from the `packageManager` field via Corepack — run `corepack enable` once).

```bash
yarn install
yarn slopweaver doctor  # smoke-test the CLI end-to-end
yarn build              # tsc → dist/
yarn typecheck          # tsc --noEmit
yarn test:unit          # vitest
yarn hygiene            # public leak-class gate
```

### Try it as a Claude Code plugin (local)

This repo ships a local dev marketplace (`.claude-plugin/marketplace.json`), so you can install the
plugin from your own checkout before it's published:

```
/plugin marketplace add /path/to/slopweaver
/plugin install slopweaver
```

> In this release the plugin registers only its scaffold — the user-facing slash-commands
> (`onboard`, `refresh`, `ask`) land in the following PRs. Today the testable surface is the CLI
> above (`yarn slopweaver doctor`).

## License

MIT — see [LICENSE](LICENSE).
