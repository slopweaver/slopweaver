# SlopWeaver

> Give Claude Code the GitHub + Slack context behind any PR.
>
> Open-source local-first MCP server. BYOK.

**Status**: pre-alpha. v1 ships in the coming weeks. Watch this repo for releases.

The strategy and design docs live in [`docs/strategy/`](docs/strategy/) (landing soon).

The npm package `slopweaver` will be the local binary; `@slopweaver/*` packages will be importable libraries.

## Coming soon

- `npx -y slopweaver@latest init` — install + first-run setup
- `slopweaver connect github` — connect your GitHub
- `slopweaver doctor` — diagnose any issues
- Add MCP token to `~/.claude.json` and ask Claude Code: "What's the context behind PR #1234?"

## License

[MIT](LICENSE).
