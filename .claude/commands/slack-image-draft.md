---
description: Draft a Slack message in the user's voice with an inline image, then (after human ack) send via the same 4-call web-API sequence the Slack web client uses. Requires the user's own xoxc token. No bot token, no MCP for the upload itself.
argument-hint: <channel-id-or-channel/thread_ts> | <message-text> | <image-path>
---

This skill exists to make "1 link + 1 image" Slack messages fast while keeping a human-review gate before send. It splits into two phases so the user reviews the text before any image lands publicly.

## Why this exists

Slack's API has no draft-with-attachment path. The web UI uploads first, then `files.share` sends the message + file in one shot. Bot tokens (`xoxb-`) can't run `files.getUploadURL` for personal sends. The user-scoped xoxc token from a logged-in browser tab can.

This skill is the SlopWeaver-friendly version of that flow: voice-linted text via `apply_voice_rules`, draft via the Slack MCP for human ack, then a single `slopweaver slack-send-image` CLI call that runs the actual 4-call sequence.

## Prereqs

- The Slack MCP attached to Claude Code (provides `slack_send_message_draft`).
- The user's xoxc token, exported as `SLACK_XOXC` (or passed via `--xoxc`).
- The workspace API base URL, exported as `SLOPWEAVER_SLACK_WORKSPACE_URL` (`https://<workspace>.slack.com`, or `https://<workspace>.enterprise.slack.com` for enterprise grid).
- On enterprise grid: `SLOPWEAVER_SLACK_ROUTE` set to `<enterprise_id>:<team_id>`. Standard workspaces leave this unset.

Extract the xoxc token by opening Slack in a logged-in browser, then in DevTools console:

```js
for (const k of Object.keys(localStorage)) {
  const v = localStorage.getItem(k);
  if (v) {
    const m = v.match(/xoxc-[0-9A-Za-z-]+/);
    if (m) { console.log(m[0]); break; }
  }
}
```

These tokens cycle on the order of 60-90 seconds on enterprise grid. Re-extract immediately before sending. Do not cache them across sessions.

## Inputs

`$ARGUMENTS` parsed as `<channel-or-channel/thread_ts> | <message-text> | <image-path>`.

- **`<channel>`**: a Slack channel id (`C…`) or DM id (`D…`). For thread replies, append `/<thread_ts>`.
- **`<message-text>`**: the message body. Will be voice-linted before drafting.
- **`<image-path>`**: absolute or repo-relative. PNG or JPEG.

## Steps

### 1. Voice-lint the text

Call `apply_voice_rules` (the SlopWeaver MCP tool) with the message text and the user's `rules/communication-style.md`. Use the rewritten text for the draft.

If `apply_voice_rules` is not registered in this server build, continue with the original text and surface a one-line note that voice lint was skipped.

### 2. Draft for human review (Phase A)

Call `slack_send_message_draft` (the Slack MCP tool) with the channel, thread_ts (if any), and the rewritten text. The draft appears in the user's Slack draft box for review. Report the draft URL plus the image path that's queued for the send call. Pause.

### 3. Send when the user acks (Phase B)

Once the user says "send" or otherwise acks the draft, run:

```bash
slopweaver slack-send-image \
  --channel "<channel>" \
  --text "<rewritten-text>" \
  --image "<image-path>" \
  [--thread "<thread_ts>"]
```

The binary reads `SLACK_XOXC`, `SLOPWEAVER_SLACK_WORKSPACE_URL`, and `SLOPWEAVER_SLACK_ROUTE` from the environment. Override any of them with `--xoxc`, `--workspace-url`, `--slack-route`.

On success the binary prints:

```
slack-send-image: ok file=<file_id> ts=<file_msg_ts> where=<channel>[/<thread_ts>]
```

The earlier text draft becomes irrelevant once the send lands (`files.share` carries its own text). The unsent draft stays in the user's draft box until they delete it.

### 4. Verify

Optionally call the Slack MCP `slack_read_channel` on the target channel. The newest message should be the rewritten text plus the file.

## Failure modes

- `SLACK_IMAGE_INVALID_TOKEN`: the token did not start with `xoxc-`. Re-extract.
- `SLACK_IMAGE_UPLOAD_URL_FAILED` with `slack: invalid_auth`: token expired or the workspace URL is wrong. Re-extract; verify `SLOPWEAVER_SLACK_WORKSPACE_URL` matches the workspace.
- `SLACK_IMAGE_SHARE_FAILED` with `slack: channel_not_found`: the user is not a member of the channel (xoxc only sends as the user themselves). Pick a different channel.
- `SLACK_IMAGE_BYTES_UPLOAD_FAILED`: the `files.slack.com` upload endpoint rejected the bytes. Often transient; retry once.

## Notes

- The 4-call sequence (`files.getUploadURL` -> binary POST -> `files.completeUpload` -> `files.share`) is the same path the official Slack web client uses. Nothing here exploits an undocumented API. `xoxc` tokens are workspace user tokens; the user is acting as themselves.
- The skill never reads cookies, localStorage, or any other credential store. The user supplies the token. SlopWeaver consumes it.
- For privacy: the inbox payloads land on the user's machine only. The send itself is observable in Slack (as any user-authored message would be).
