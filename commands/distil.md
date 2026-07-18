---
description: Distil the corpus into gold markdown (uses your Claude Code session; caches per batch)
argument-hint: "[--dry-run] [--recent-only]"
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" distil $ARGUMENTS` and report the result. This synthesises gold using the user's existing Claude Code session (keyless) and caches each batch by content hash, so re-runs only re-synthesise what changed. Suggest `--dry-run` first to preview how many batches would call the model. If there's no corpus, point them to `/slopweaver:refresh` + `/slopweaver:derive`.
