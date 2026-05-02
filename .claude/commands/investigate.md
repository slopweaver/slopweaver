You are an AI agent investigating a topic in the SlopWeaver public repo.

The user invoked you with `/investigate <topic>`. The argument describes what to investigate. Examples:

- "should we use Drizzle or Kysely for the db layer?"
- "how does Cal.com structure its app-store integrations?"
- "what does the MCP SDK provide for OAuth 2.1 server-side?"

## What this command is for

**Research only**. No code changes. Output is either a comment on a GitHub issue or a doc in `docs/`. The deliverable is **information that helps a future decision or implementation**, not a fix.

If the user wants a fix, they should use `/fix-issue` instead.

## Read first

1. **`.claude/rules/workflow.md`** — context on how decisions live in issues
2. **`CLAUDE.md`** — repo state and dev principles
3. **The relevant files in the repo** if the topic is about existing code

## Workflow

### 1. Scope the investigation

Restate the topic in your own words. If unclear, ask the user before proceeding.

Decide what counts as "done":

- A recommendation with rationale
- A list of options with tradeoffs
- A code sketch (in markdown, not committed code)
- A summary of how a comparable project handles the same thing

State the scope upfront so you don't sprawl.

### 2. Investigate

Use whatever tools are useful:

- Read existing repo files (`Read`, `Grep`, `Glob`)
- Web searches for current best practice (`WebSearch`, `WebFetch`)
- Check `npm view <pkg>` / `gh api` for ecosystem facts
- Read MCP SDK source if the topic is MCP-related (it's at `node_modules/@modelcontextprotocol/sdk/`)

If web research is involved, **cite sources** (URLs) so the founder can verify.

If the topic touches strategy that lives in `slopweaver-private`, **don't reference private content in any output**. Investigate from public sources only.

### 3. Output

**Default: comment on a `decision-record` issue.**

If the topic maps to an existing decision-record issue, post the investigation findings as a comment on that issue:

```bash
gh issue comment <number> --repo slopweaver/slopweaver --body "$(cat <<'EOF'
## Investigation

[your findings here]

## Sources

- <url 1>
- <url 2>

## Recommendation

[your recommendation, if applicable]
EOF
)"
```

If no decision-record issue exists for this topic, **open one** (with the `decision_record.yml` template), then post the findings as the first comment.

**Alternative: a doc in `docs/`** if the investigation produces reference material that's broadly useful (e.g. "comparison of Drizzle vs Kysely") rather than tied to a specific decision. Open a small PR with the doc; use `/fix-issue` style workflow for that.

### 4. Don't decide for the founder

Investigations end with a **recommendation**, not a decision. The founder decides. They might agree with you and close the issue with the resolution, or push back and ask for more research, or pick a different option.

Be opinionated in the recommendation (don't waffle), but be clear it's a recommendation.

## When you're done

Reply briefly with:

- Link to the issue comment / new issue / doc PR you produced
- 1-line summary of your recommendation (or "no clear answer; documented options X, Y, Z")
