---
description: Ingest recent GitHub activity into your local bronze corpus
argument-hint: "[--repo owner/repo] [--since YYYY-MM-DD] [--until YYYY-MM-DD]"
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" refresh $ARGUMENTS` and report what was written (new records, deduped, source). If it reports no GitHub auth, tell the user to run `gh auth login` — no personal access token is needed. Remind them to run `/slopweaver:derive` then `/slopweaver:distil` to fold the new activity into silver/gold.
