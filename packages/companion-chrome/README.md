# @slopweaver/companion-chrome

Chrome extension companion for the local SlopWeaver work console.

## What it does

Drops a "📌 SlopWeaver" button on supported pages (GitHub PR / issue
view, Slack web client). Clicking it hands the current URL + page
title to the extension's background service worker, which POSTs the
entry to the local SlopWeaver HTTP server. The server appends a JSONL
line to `<cwd>/.claude/personal/state/companion-inbox.jsonl`.

Bidirectional badges on tracked anchors (so a thread you've already
filed shows a "tracked since YYYY-MM-DD" indicator) are a v1.2
follow-up.

## Install (unpacked)

1. `chrome://extensions/`
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select `packages/companion-chrome/`.
4. Ensure SlopWeaver is running locally (`slopweaver` or
   `npx -y slopweaver`). The companion talks to
   `http://127.0.0.1:60701`.

## Files

```
packages/companion-chrome/
├── manifest.json       # Manifest v3, supported sites + permissions
├── src/
│   ├── background.js   # Service worker — receives FILE_TAB and POSTs to localhost
│   ├── content.js      # Page-side injector + click handler (sends FILE_TAB)
│   ├── content.css     # Pill-style button styling
│   └── popup.html      # Default popup when the toolbar icon is clicked
└── README.md           # You are here
```

## Why the round-trip through the background worker

A content script's `fetch()` inherits the host page's origin
(`github.com`, `*.slack.com`). The local SlopWeaver server enforces a
same-origin allow-list on its `/api/*` routes for baseline
DNS-rebinding protection, so a direct content-script POST is
correctly 403'd on `Origin`.

The extension's background service worker has its own privileged
fetch context: every cross-origin request it makes sets `Origin:
chrome-extension://<id>`. The local server's companion endpoint runs
its own authentication-by-origin guard tuned for that: it accepts
*only* requests whose `Origin` header starts with
`chrome-extension://`, and echoes that specific origin back in
`Access-Control-Allow-Origin` (never `*`).

## Authentication model

The `/api/companion/file` endpoint is the only route on the local
SlopWeaver server that accepts writes from outside the Diagnostics
UI. Its trust model is:

- **Allowed**: `Origin: chrome-extension://<id>` — the extension's
  background service worker. The exact origin is echoed back in
  `Access-Control-Allow-Origin`.
- **Rejected (403)**: every other `Origin` value, including
  `https://evil.example`, `https://github.com`, and
  `http://localhost:60701` (the Diagnostics UI itself). Web pages
  cannot forge `Origin: chrome-extension://…` — the browser stamps
  it from the request initiator's actual origin.
- **Rejected (403)**: requests with *no* `Origin` header. The Chrome
  service worker always sets one for cross-origin fetches to
  `127.0.0.1`, so a missing Origin is not the companion.

The server is loopback-bound (`127.0.0.1`), so a same-machine attacker
who can run arbitrary code is already inside the trust boundary —
that's not the threat model here. The threat model *is* "any
malicious website the user visits should not be able to write to the
local inbox," and the `chrome-extension://` Origin check defends
exactly that.

## Message contract (content → background)

```js
chrome.runtime.sendMessage({ type: 'FILE_TAB', url, title })
  → { ok: true }
  | { ok: false, error: string }
```

## Local HTTP contract (background → server)

```
POST http://127.0.0.1:60701/api/companion/file
content-type: application/json

{ "url": "<page url>", "title": "<page title>" }
```

The server validates: payload is an object, `url` is a non-empty
`http://` or `https://` URL ≤2048 chars, `title` is a string
≤512 chars. Other schemes (`javascript:`, `data:`, `file:`,
`chrome:`, …) are rejected with 400.

Response: `200 OK` with a JSON body
`{ "filed": true, "path": "<.claude/personal/state/companion-inbox.jsonl>", "line_number": N }`
on success; 400 with `{ "filed": false, "error": "<reason>" }`
otherwise.

The server also handles the CORS preflight (`OPTIONS`).

## Status

v1.1 first cut. No build step — load unpacked as-is. Future:
- v1.2: badge for tracked anchors, hover preview.
- v1.3: Firefox + Safari ports, Slack action manifest.
- v1.4: mobile / native share-extension on iOS.

## Permissions

The manifest declares only what's needed:

- `host_permissions`: `http://127.0.0.1:60701/*` — the background
  worker's fetch target. No `https://github.com/*` or
  `https://*.slack.com/*` here; the content scripts use narrower
  `matches` patterns instead (PR / issue / Slack archive URLs only).
- No `activeTab`, `scripting`, `tabs`, or other broad permissions.
- No analytics, no telemetry, no remote endpoints.
