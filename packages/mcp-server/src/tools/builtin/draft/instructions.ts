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

6. **Save.** Use \`write_console_file\` (PR #54) to drop the draft at
   the \`suggested_path\` returned by this tool. Include frontmatter:

   \`\`\`yaml
   ---
   draft_id: <id>
   thread_ref: <ref>
   target: <slack:C123/thread:1234.5678 | github:owner/repo/pulls/456 | ...>
   status: pending
   ---
   \`\`\`

   The \`target:\` field is what \`send_via_source\` (PR #59) parses
   later to route the send. Build it from the \`thread_ref\`.

7. **Surface.** Print the draft to chat. End with one line:
   \`Draft saved to <path>. Reply with \\\`send\\\` to deliver via <platform>, or edit + re-save.\`

## Hard rules

- **Never send.** This tool drafts; \`send_via_source\` sends. The
  user is the final gate.
- **Apply voice rules.** Always pass through \`apply_voice_rules\`
  before saving. The post-processor is the last-mile safety net.
- **One draft per call.** If the user wants alternatives, they can
  call \`/draft\` again with a different \`intent\`.
- **No personal data hardcoded in the output.** Pull all
  identifiers from the source thread + stakeholder lookup — never
  guess names or contexts.
`;
