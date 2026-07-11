# Security & trust

Slopweaver is built local-first on purpose: the biggest objection to any tool that ingests company
data is "where does my data go". The answer here is: nowhere you don't already send it.

## Data flow

All processing is local. Your world model is written under `$SLOPWEAVER_HOME` on your machine and is
never uploaded. Nothing leaves your machine except the Claude calls you already make in Claude Code.
Embeddings run on-device.

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
