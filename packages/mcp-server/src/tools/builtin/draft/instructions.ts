/**
 * Instructional body returned by `start_draft`. The model receives
 * this as the tool's structured output and follows it inline to
 * produce a reply matching the user's voice rules.
 *
 * No personal identifiers anywhere. The instructions reference the
 * user's own writing patterns abstractly; the actual stakeholder
 * history is pulled at runtime from the user's connected MCP servers.
 */

export const DRAFT_INSTRUCTIONS = `# Draft a reply

You're drafting a reply on the user's behalf. The output goes to a
file on disk under \`.claude/personal/drafts/\` — it does not send.
The user reviews, edits if needed, then triggers \`send_via_source\`
(PR #59) to actually deliver.

## Inputs

- **\`thread_ref\`** (supplied by the caller): the permalink to the
  thread / PR / ticket / email being replied to.
- **\`intent\`** (optional): a one-line statement of what the user
  wants to convey. Treat as a strong hint, not a script.
- **\`stakeholder\`** (optional): an identifier for the recipient
  (Slack user_id, GitHub username, email, etc.). Used to pull
  stakeholder history if \`recall\` is available.

## Steps

1. **Pull context.** Fetch the source thread via the appropriate MCP
   server (Slack \`slack_read_thread\`, GitHub \`gh pr view\` or PR
   API, Gmail \`get_thread\`, Linear ticket fetch, etc.). Capture the
   full conversation, not just the last message — the user's reply
   needs to address the actual ask.

   **Failure mode — missing source MCP.** If the MCP server hosting
   the thread is not connected (no Slack MCP for a \`slack:\` ref, no
   GitHub MCP / \`gh\` CLI for a \`github:\` ref, no Gmail MCP for a
   \`gmail:\` ref), **fail closed**. Stop and return an error to chat:
   "Cannot draft: source thread MCP for <platform> is not connected.
   Install/authenticate the relevant MCP server, then retry." Do not
   guess at the thread contents from the ref alone.

2. **Pull stakeholder history.** If \`recall\` is available (PR #57)
   and \`stakeholder\` is supplied, call:

   \`\`\`
   recall({
     query: "<stakeholder identifier> <key topic words from the thread>",
     limit: 15,
     filters: { integration: "slack" | "github" | ... }
   })
   \`\`\`

   The hits surface the user's last 10–15 interactions with this
   stakeholder. Use them to calibrate tone — formal vs casual, prior
   in-jokes, recurring topics, response cadence.

   **Failure mode — \`recall\` not available.** If PR #57 hasn't
   merged yet (or the \`recall\` tool isn't registered for any other
   reason), **continue without it**. Add a note to the chat output:
   "Historical stakeholder context unavailable (recall tool not
   registered); calibrating tone from the thread alone." Do not block
   the draft on this.

3. **Pull voice rules.** Read \`.claude/personal/rules/communication-style.md\`
   via \`read_console_file\` (PR #54) — or, if the work-console tools
   aren't present, ask the caller to supply the rules markdown.

4. **Draft.** Compose the reply in the user's voice. One concrete
   call-out per paragraph. Keep it tight — most great replies are
   2–4 sentences, not paragraphs. Don't editorialise; just answer
   what was asked.

5. **Lint with voice rules.** Call \`apply_voice_rules({ draft,
   rules_markdown })\` (PR #56) on your output. If the edit log
   reports rewrites, surface them in the chat output ("rewrote 2
   phrases per voice rules"). Use the rewritten string as the final
   draft.

   **Failure mode — \`apply_voice_rules\` not available.** If PR #68
   hasn't merged yet (or the tool isn't registered), **continue
   without the lint pass**. Add a warning to the chat output: "Voice
   lint skipped (apply_voice_rules tool not registered); review the
   draft manually for tone." Do not block the draft on this.

6. **Save.** Use \`write_console_file\` (PR #54) to drop the draft at
   the \`suggested_path\` returned by this tool. Include frontmatter:

   \`\`\`yaml
   ---
   draft_id: <id>
   thread_ref: <ref>
   target: <see "Supported target shapes" below>
   status: pending
   ---
   \`\`\`

   The \`target:\` field is what \`send_via_source\` (PR #59) parses
   later to route the send. Build it from the \`thread_ref\`.

   **Failure mode — \`write_console_file\` not available.** If the
   work-console tools aren't registered, **do not block the draft**.
   Instead, return the full draft body (frontmatter + content) inline
   in the chat output, and tell the user: "Could not write to
   \`<suggested_path>\` (write_console_file not registered); the full
   draft is above — copy it into your console manually."

7. **Surface.** Print the draft to chat. End with one line:
   \`Draft saved to <path>. Reply with \\\`send\\\` to deliver via <platform>, or edit + re-save.\`

## Supported \`target:\` shapes

The \`target:\` field in the frontmatter is what \`send_via_source\`
(PR #59) parses. Use exactly one of these forms — \`parse-target.ts\`
will reject anything else:

- \`slack:<channel_id>/thread:<thread_ts>\` (e.g.
  \`slack:C1234567/thread:1700000000.123456\`)
- \`gmail:<thread_id>\` (e.g. \`gmail:18f3c2a9b1e4d5f6\`)
- \`github:<owner>/<repo>/pull/<number>\` (e.g.
  \`github:slopweaver/slopweaver/pull/71\`) — note: \`pull\`, not
  \`pulls\`.
- \`github:<owner>/<repo>/issue/<number>\` (e.g.
  \`github:slopweaver/slopweaver/issue/42\`) — note: \`issue\`, not
  \`issues\`.

## Hard rules

- **Never send.** This tool drafts; \`send_via_source\` sends. The
  user is the final gate.
- **Apply voice rules when available.** Pass through
  \`apply_voice_rules\` before saving when the tool is registered;
  surface a warning in chat when it isn't (see step 5).
- **One draft per call.** If the user wants alternatives, they can
  call \`/draft\` again with a different \`intent\`. The
  \`suggested_path\` includes the \`draft_id\`, so repeat calls don't
  overwrite earlier drafts.
- **No personal data hardcoded in the output.** Pull all
  identifiers from the source thread + stakeholder lookup — never
  guess names or contexts.
`;
