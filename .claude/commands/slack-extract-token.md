---
description: Extract the user's xoxc Slack token from a logged-in browser session via Playwright MCP, then pipe the dump through `slopweaver slack-extract-xoxc` to print the token (or an `export SLACK_XOXC=...` line). No cookie reading, no credential stores.
argument-hint: [--format=token|export]
---

This skill resolves the `SLACK_XOXC` credential the `slack-image-draft` skill needs to send. xoxc tokens cycle on the order of 60-90 seconds on enterprise grid, so this needs to run immediately before each send. The skill never reads cookies or files; it asks the user's already-logged-in browser to read its own localStorage.

## Prereqs

- Playwright MCP (`mcp__playwright__*`) attached to Claude Code, with a Chrome profile that's currently logged in to Slack.
- `slopweaver` on the PATH.

## Steps

### 1. Make sure a Slack tab is open and logged in

If the Playwright browser doesn't already have a Slack tab open, navigate to `https://app.slack.com/client/`. SSO usually completes in the background; pause briefly if there's a login challenge.

### 2. Read localStorage from the Slack tab

Run `browser_evaluate` against the Slack tab with this script. It returns the full localStorage as a JSON-serialisable object so the SlopWeaver-side regex helper can do the matching, not the browser:

```js
() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) out[k] = localStorage.getItem(k);
  }
  return out;
}
```

### 3. Pipe the dump through the extractor

The extractor is a pure regex consumer. Pipe the JSON-stringified result into `slopweaver slack-extract-xoxc`:

```bash
echo '<json from step 2>' | slopweaver slack-extract-xoxc --format export
```

The `--format export` flag prints `export SLACK_XOXC=xoxc-...` so the user can `eval` it in their shell. `--format token` (default) prints the bare token, useful when piping into a downstream command.

Exit codes:

- `0` — token found, written to stdout.
- `1` — no xoxc token in the input. The user is probably not logged in to Slack on the Playwright browser profile, or the workspace is using a non-standard token shape.
- `2` — stdin read failed.

### 4. Use the token

For the `/slack-image-draft` flow, the cleanest sequence is:

```bash
eval "$(echo '<dump>' | slopweaver slack-extract-xoxc --format export)"
# SLACK_XOXC is now set in this shell.
slopweaver slack-send-image --channel "$CHANNEL" --text "$TEXT" --image "$IMG"
```

Or print the bare token and pass via `--xoxc`:

```bash
TOKEN=$(echo '<dump>' | slopweaver slack-extract-xoxc)
slopweaver slack-send-image --xoxc "$TOKEN" --channel "$CHANNEL" --text "$TEXT" --image "$IMG"
```

## Why this shape

- The browser drive lives in the skill body (Playwright MCP). The SlopWeaver binary doesn't bundle Playwright as a Node dependency, so the published package stays small.
- The regex + parser lives in TypeScript with unit tests so the token-recognition contract is locked down.
- The token never touches any persistent SlopWeaver state. It flows from the browser through Playwright through the extractor through the calling shell, then out to Slack. No file, no keychain, no env-export-to-disk.

## Notes

- Tokens cycle every ~60-90 seconds on enterprise grid. Re-extract immediately before any send.
- A standard (non-enterprise) workspace returns the same token shape under `localConfig_v2`; the regex handles both.
- If `slack-extract-xoxc` returns exit 1, the user may be logged in to a different Slack workspace than the one the send is targeting. Open the right workspace tab and retry.
