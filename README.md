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

```bash
npx -y slopweaver@latest init
slopweaver connect github
slopweaver token create
```

Then add the printed MCP token to `~/.claude.json` and ask Claude Code about your work.

If anything fails, run `slopweaver doctor`.

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

**v1.0**: GitHub, Slack (preview).

**v1.1+ (planned)**: Linear, Gmail, Google Calendar.

[Request an integration](https://github.com/slopweaver/slopweaver/issues/new) once issue templates land.

---

## License

[MIT](LICENSE).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.
