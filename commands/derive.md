---
description: Derive deterministic silver (directory + cross-ref graph + opportunities) from the corpus
argument-hint: "[--top N]"
---
Run `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" derive $ARGUMENTS` and report the directory / graph / opportunity summary. This is free and deterministic (no LLM). If it says there's no corpus, tell the user to run `/slopweaver:refresh` first.
