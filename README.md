# SlopWeaver

> Help Claude Code answer "what should I work on next?" by searching across your work tools.
>
> Open-source local-first MCP server. BYOK.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![GitHub Stars](https://img.shields.io/github/stars/slopweaver/slopweaver?style=social)](https://github.com/slopweaver/slopweaver/stargazers)

**Status**: pre-alpha. v1.0.0 ships in the coming weeks. Built solo by [@lachiejames](https://github.com/lachiejames). Roadmap: [tracking issue #2](https://github.com/slopweaver/slopweaver/issues/2).

---

## What it does

You sit down to work. You ask Claude Code:

> "What should I work on next?"

SlopWeaver searches everything — your open PRs, Slack mentions, Linear tickets, threads waiting on your reply, recent activity in repos you care about. Claude synthesizes a priority order and tells you what's worth doing now, what can wait, and what isn't worth your time at all.

You get oriented in 60 seconds instead of 20 minutes of tab-flipping.

**Pull-based. Never acts without you. Cognitive partner, not automation tool.**

(Demo video lands with v1.0.0.)

---

## Install (coming with v1.0.0)

SlopWeaver runs as a local subprocess of your MCP client over **stdio** — no HTTP server, no token paste, no auth dance.

**Claude Code:**

```bash
claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
```

**Cursor** — add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "slopweaver": {
      "command": "npx",
      "args": ["-y", "@slopweaver/mcp-local"]
    }
  }
}
```

**Cline** — add to `~/.cline/data/settings/cline_mcp_settings.json` (or `$CLINE_DIR/data/settings/cline_mcp_settings.json` if you've set `CLINE_DIR`):

```json
{
  "mcpServers": {
    "slopweaver": {
      "command": "npx",
      "args": ["-y", "@slopweaver/mcp-local"]
    }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.slopweaver]
command = "npx"
args = ["-y", "@slopweaver/mcp-local"]
```

Then ask your client: *"What should I work on next?"* If anything fails, [open an issue](https://github.com/slopweaver/slopweaver/issues/new) — a `doctor` subcommand ships with v1.0.0.

> **Note:** Connecting SlopWeaver to GitHub (so it can poll your PRs and mentions) uses GitHub's own OAuth or a personal access token — that's separate from the MCP transport between your client and SlopWeaver. The MCP layer itself has no auth in v1; stdio inherits the user's trust context.

---

## Why local-first

- **Your work data stays on your machine.** No SaaS, no cloud round-trip, no signup.
- **BYOK.** Bring your own Anthropic / OpenAI key (only needed for AI features; deterministic context tools work without).
- **One binary. SQLite.** No Docker, no Postgres, no setup theatre.

---

## Cloud tier (year 2 — coming)

Some things require a server: real-time webhooks instead of polling, mobile push notifications, cross-device sync, always-on observation. The optional [SlopWeaver Cloud](https://slopweaver.ai) (launching year 2) adds these. Same code; hosted deployment.

---

## Integrations

**v1.0**: GitHub + Slack.

**v1.1+ (planned)**: Linear, Gmail, Google Calendar.

[Request an integration](https://github.com/slopweaver/slopweaver/issues/new) once issue templates land.

---

## License

[MIT](LICENSE).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.
