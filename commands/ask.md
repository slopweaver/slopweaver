---
description: Ask a grounded, cited question of your local world model
argument-hint: "<question>"
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/slopweaver" ask $ARGUMENTS` and present the answer (tldr, any details) and the citations exactly as returned — do not add commentary or invent citations. The FIRST ask may take a minute (one-time embedding-model download + corpus embed); later asks are fast. If it reports no corpus, tell the user to run `/slopweaver:onboard`.

Question: $ARGUMENTS
