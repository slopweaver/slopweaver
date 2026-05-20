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

Then connect your work tools (one-time setup). The fastest path is the guided wizard:

```bash
npx -y @slopweaver/mcp-local init   # detects MCP clients, walks through GitHub + Slack, verifies tokens
```

Prefer to do it manually?

```bash
npx -y @slopweaver/mcp-local connect github   # paste a fine-grained PAT (input is hidden)
npx -y @slopweaver/mcp-local connect slack    # paste a Slack user token (xoxp-)
```

(If you'd rather have `slopweaver` on your PATH directly, `npm install -g @slopweaver/mcp-local` first, then run `slopweaver init`.)

Then ask your client: *"What should I work on next?"* If anything fails, [open an issue](https://github.com/slopweaver/slopweaver/issues/new) — a `doctor` subcommand ships with v1.0.0.

> **Note:** Connecting SlopWeaver to GitHub (so it can poll your PRs and mentions) uses GitHub's own OAuth or a personal access token — that's separate from the MCP transport between your client and SlopWeaver. The MCP layer itself has no auth in v1; stdio inherits the user's trust context.

---

## The AI work console (slash commands)

SlopWeaver ships an opinionated workflow as a set of MCP prompts. The moment you finish `claude mcp add slopweaver`, these commands appear in Claude Code's slash-command menu as `/mcp__slopweaver__*` (and as bare `/session-start`-style names if you let `slopweaver init` drop short-name shims into `.claude/commands/`).

| Command | What it does |
| --- | --- |
| `/session-start` | Switches to the `ai-work-console` git branch, fans out across every MCP server you've connected (Slack, Linear, Gmail, Calendar, GitHub, Notion, etc.), refreshes stale deltas, reconciles open items in your work files, prints a ranked snapshot ending in "what are we working on this session?" |
| `/fan-out-audit` | First-run deep backfill. Builds `.claude/personal/{contexts,work,state,rules,daily,drafts,handoffs}` from scratch by querying every connected MCP server. Identity resolution, team directory, voice extraction, ranked priorities, work files per programme — the lot. |
| `/lock-in` | Push-style execution walker. Steps through the ranked queue one item at a time, proposes a concrete next action, waits for `do | agent | handoff | defer | skip | note | open-question`. Every resolution feeds a calibration log. |
| `/reconcile` | Cross-references work-file open items against the latest deltas. Buckets into `propose-close / propose-update / state-mismatch / new-attention / inbox`, then ranks for the walk. |
| `/style-rule` | Capture a voice / workflow rule the user just stated. Verbatim. Appends to `rules/communication-style.md` (or the matching rules file). |
| `/style-edit` | Amend or remove an existing rule. |
| `/correct` | A correction the user just pushed back with. One-line acknowledgement, classify, update the right rules / context file, log a calibration breadcrumb. No apology essays. |

The work console always lives on a dedicated git branch (default name: `ai-work-console`). Every slash command calls the `ensure_work_console_branch` MCP tool first so context/draft writes never leak into a PR branch. `slopweaver init` writes a `.claude/SLOPWEAVER-MEMORY.md` memory file and adds an `@.claude/SLOPWEAVER-MEMORY.md` import to your `CLAUDE.md`, so future Claude Code sessions automatically know to stay on the branch.

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for the full operating model.

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

Integration tokens (GitHub PAT, Slack user token) are stored in the macOS Keychain under the entry `slopweaver / <integration>` — the local SQLite database holds only presence metadata (slug, account label, timestamps). Audit a stored token with `security find-generic-password -a github -s slopweaver -w`. On first write the v1 binary is unsigned, so macOS shows a "Keychain Access wants to use the slopweaver entry" prompt; clicking "Always Allow" trusts the binary's path. macOS is the only OS that's QA'd for v1 — Linux Secret Service and Windows Credential Manager work under the hood but are best-effort untested. For vulnerability disclosure see [SECURITY.md](SECURITY.md).
