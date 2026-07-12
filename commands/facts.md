---
description: Retrieve the ranked record slice for a question (no LLM)
argument-hint: "<question>"
---
Run `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" facts $ARGUMENTS` and show the ranked records (source, cite token, url, title, snippet) exactly as returned. This is retrieve-only — no LLM answer — useful for feeding a subagent or eyeballing what the corpus holds. If it reports no corpus, point to `/slopweaver:onboard`.

Question: $ARGUMENTS
