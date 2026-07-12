---
description: Set up your local world model — ingest a repo, build silver/gold, ask a question
argument-hint: "[owner/repo]"
---
Guide the user through first-time Slopweaver setup, step by step, showing each command's output. The bundled CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver"` (also on PATH as `slopweaver`).

1. Run `slopweaver doctor` — show the version + resolved `SLOPWEAVER_HOME` (defaults to `~/.slopweaver` if unset).
2. Pick the repo: if `$ARGUMENTS` names one (`owner/repo`), use it; otherwise use the current directory's `origin` git remote. Confirm with the user before proceeding.
3. **Bronze** — `slopweaver refresh --repo <owner/repo>`. Report the record count. If it warns about GitHub auth, tell them to run `gh auth login` (no PAT needed).
4. **Silver** — `slopweaver derive`. Report the directory / graph / opportunity counts.
5. **Gold** — `slopweaver distil`. Explain this synthesises gold using their existing Claude Code session (keyless) and caches per batch, so re-runs are cheap. Report the result.
6. **Ask** — `slopweaver ask "what has the team shipped recently?"`. Warn that the FIRST ask downloads the on-device embedding model (one-time) and embeds the corpus, so it may take a minute; later questions are fast. Show the grounded answer + citations.
7. Tell them the everyday commands: `/slopweaver:ask <question>`, `/slopweaver:facts <question>`, and `/slopweaver:refresh` (then `derive` + `distil`) to pull new activity. Everything stays on their machine.

Optional target repo: $ARGUMENTS
