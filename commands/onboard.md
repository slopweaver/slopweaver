---
description: One guided cold-start — connect GitHub/Slack/Linear/Notion (create the Slack app, capture keys safely), pick the backfill, build the whole corpus, land a first grounded answer
argument-hint: "[owner/repo]"
---

Guide the user through **one** cold-start setup of their local world model: pick the tools, connect each
(including creating the Slack app), capture every key **safely**, choose the backfill depth, then pull
GitHub + Slack + Linear + Notion, build silver + gold, and land on a first grounded answer.

**The chat is the wizard — you drive it.** All interactivity lives here, never in a CLI verb: no Slopweaver
command ever blocks the terminal waiting on input. The ONE sanctioned interactive read is the no-echo secret
capture — `secrets set <name>` prompts for the token with terminal echo OFF and stores it locally.

**Never let a token touch this chat.** Do not ask the user to paste a token into the conversation, and never
echo one. Tokens are captured no-echo in their terminal and written `0600` under `$SLOPWEAVER_HOME/secrets/`
— they never reach the transcript, an argv, or the repo.

The bundled CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver"` (also on PATH as `slopweaver`). This flow is
**idempotent + resumable**: re-running skips whatever is already done (a scaffolded home, an already-valid
token, activity already pulled) and resumes the crawl from its watermarks. Safe to re-run any time.

## 1 — Scaffold + inspect the home

1. Run `slopweaver init` — scaffolds `$SLOPWEAVER_HOME` (idempotent; creates the `secrets/` dir at `0700`).
2. Run `slopweaver doctor --json` — read `initialised` and the path/status map. This is your resume signal:
   anything already present is skipped below.

## 2 — Resolve the repo + org

- If `$ARGUMENTS` names an `owner/repo`, use it; otherwise use the current directory's `origin` git remote.
- The **GitHub org** defaults to the repo owner (override later with `--github-org` if they differ).
- Confirm the repo + org with the user before proceeding.

## 3 — Access level: default READ-ONLY, offer full

Each source can be connected **read-only** (ingest only — least privilege, and all this onboarding flow
needs) or **full** (read + write — what the assistant uses at parity). **Default to read-only**: it's the
smaller, safer grant and everything here works on it. Offer **full** as an opt-up for anyone who wants the
assistant's write features now (they can choose per source), with the explicit trade-off that a read-only
setup will need a re-auth later when those features land. Ask the user which they want.

## 4 — Create the Slack app (from the bundled manifest)

Slack is the only source that needs an app. Guide the user to create one from the bundled manifest — do NOT
try to auto-create it. If they **already run a Slack app** with these scopes, they can skip creation and
reuse its existing **User OAuth Token** instead.

1. Point them to <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pick their
   workspace → paste the contents of the manifest matching their step-3 choice (read-only is the default):
   - read-only: `"${CLAUDE_PLUGIN_ROOT}/templates/slack-app-manifest.readonly.json"` (just the user-token
     read scopes ingest needs — the least-privilege default)
   - full: `"${CLAUDE_PLUGIN_ROOT}/templates/slack-app-manifest.full.json"` (read + write user & bot scopes,
     a bot user, socket mode + events — provisions the whole assistant, install once)
     Both include `users:read.email`, which member hydration depends on for cross-source linking.
2. Install the app to the workspace, then copy the **User OAuth Token** (`xoxp-…`). Prefer the user token
   (full read breadth); a bot token (`xoxb-…`) works but only sees invited channels — `connect slack --check`
   will warn about that.

## 5 — Capture each token (no-echo prompt, never in chat)

For each source the user wants, have them run — in **their terminal** (prefix with `!`) — simply:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" secrets set slack-user-token
```

`secrets set` prompts for the value with **echo off** (nothing shows on screen), then stores it `0600` under
`$SLOPWEAVER_HOME/secrets/`. The value never touches the chat, an argv, or the repo. (For scripted use it also
accepts a piped value with `--stdin`.) Repeat with the right secret name per source (only the tools they use):

- `slack-user-token` (or `slack-bot-token` for the limited bot fallback)
- `linear-token` — a Linear personal API key (Linear → Settings → API → Personal API keys). If the user
  already runs an assistant, reuse its existing key.
- `notion-token` — a Notion internal integration secret; the integration must have the
  **read user information (including email)** capability (and **update/insert** too for full access), and the
  pages/databases must be **shared** with it.
- `github-token` — usually unnecessary: GitHub uses your `gh auth login`. Only capture one if
  `connect github --check` reports GitHub auth missing.

## 6 — Preflight each source (the gate)

Run a `connect --check --json` per chosen source and branch on the JSON:

```bash
slopweaver connect github --check --json --repo <owner/repo>
slopweaver connect slack  --check --json
slopweaver connect linear --check --json
slopweaver connect notion --check --json
```

For each report: `ok:true` → ready. A capability with `status:"missing"` is a **hard gap** — STOP and show
the user the exact capability + its `detail` (e.g. Slack `users:read.email`, Notion read-user-email, GitHub
`read:org`), and loop back to steps 4–5 to fix it. A `status:"warning"` (e.g. a bot token's reduced breadth,
or no GitHub SAML) is fine to **proceed on with the user's ok** — it just means reduced breadth. Only move on
once every chosen source is `ok`, or the user accepts its warnings.

## 7 — Choose the backfill depth

Ask the user how far back to pull. Offer: **90 days** (recommended, ~3 months), **30**, **180**, or **all**
(full history — slower). Also accept an explicit `YYYY-MM-DD` start date.

## 8 — Pull every source IN PARALLEL (watch them stream)

Refresh **per source**, and run them **concurrently** — each source is a different API with its own rate
limit and its own resume file, so there's nothing to gain from doing them one at a time. Only run the
sources the user actually connected in steps 3–6.

> **Launch each refresh in the BACKGROUND, ALL AT ONCE — do NOT block, do NOT serialise.** A source crawl
> takes many minutes; running them foreground (or one-after-another) means the user waits N× as long and
> sees nothing but a spinner. Instead start **every** chosen source **backgrounded at the same time** (in
> Claude Code: one Bash tool call per source with `run_in_background: true`), then **poll their outputs every
> ~20–30s and relay the newest heartbeat/preview line from each** until all exit. Total time ≈ the slowest
> single source, not the sum. Each streams to its own background task, so the user can click between them
> (GitHub tab, Slack tab, …) and watch each independently.

```bash
# start all of these at once, each backgrounded — they run in parallel
slopweaver refresh --source github --all-repos --repo <owner/repo> --github-org <owner> --lookback-days 90
slopweaver refresh --source slack  --lookback-days 90
slopweaver refresh --source linear --lookback-days 90
slopweaver refresh --source notion --lookback-days 90
```

Parallel is SAFE: each source writes only its own bronze files, its own per-source watermark
(`corpus/watermarks/<source>.json`), and (Slack/GitHub) its own thread/repo cursors — so two sources
finishing at the same moment can never clobber each other's resume state. If one source fails, the others
keep the progress they already committed. (Prefer this over `refresh --all-sources`, which runs the sources
sequentially in one process.)

Each run **streams human progress lines to stderr** as it works — relay the latest from each to the user each poll:

- a per-source **heartbeat** — `refresh slack · Reading channel · #<channel> · 63% · ETA 14m · 12,420 messages`
  (monotonic %, EMA-based ETA once there's real data, running counts);
- a **content preview** — a redacted taste of what's being read right now (`↳ #<channel> · "<snippet>"`);
- a `(stalled)` note if a source goes quiet for 60s (a wedged API call, not a crash);
- and, during distil (step 9), **learnings as they arrive** (`↳ learned decision/high · <fact> [cite]`).

Only the clean human lines stream by default; the machine-readable `slopweaver.progress` JSON lane is **off
unless** `SLOPWEAVER_PROGRESS_JSON=1` is set (for a programmatic consumer) — either way **stdout stays clean
for `--json`**. Every source resumes from its own (and per-repo) watermark, so a re-run only pulls what's new,
and because sources run independently, if one fails the others keep the progress they already committed.

For a day count use `--lookback-days N` (default 90, ~3 months); for full history use `--all`; for an explicit
start use `--since YYYY-MM-DD`. (A quick first run — e.g. `--lookback-days 7` — is a fine way to watch it work
before the full backfill.)

## 9 — Build silver + gold

1. `slopweaver derive` — deterministic silver (identity/person graph, directory, structure, opportunities).
   Report the counts.
2. `slopweaver distil` — gold (LLM map-reduce using the user's existing Claude Code session, keyless; caches
   per batch so re-runs are cheap). Report the result.

## 10 — First grounded answer

Run `slopweaver ask "what has the team shipped recently?"`. Warn that the FIRST ask downloads the on-device
embedding model (one-time) and embeds the corpus, so it may take a minute; later questions are fast. Show the
grounded answer + citations.

## 11 — Wrap up

Summarise: which sources connected, the refresh written/deduped counts, the derive + distil results, and the
first answer. Then tell them the everyday commands: `/slopweaver:ask <question>`, `/slopweaver:facts
<question>`, and re-running `/slopweaver:onboard` (or `slopweaver refresh` → `derive` → `distil`) to pull new
activity. Everything stays on their machine.

Optional target repo: $ARGUMENTS
