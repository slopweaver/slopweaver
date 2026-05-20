# @slopweaver/companion-chrome

Chrome extension companion for the local SlopWeaver work console.

## What it does

Drops a "📌 SlopWeaver" button on supported pages (GitHub PR view,
Slack thread view in the web client). Clicking it POSTs the current
URL + page title to the local SlopWeaver HTTP server, which routes
the entry into the appropriate work file.

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
│   ├── background.js   # Service worker (no-op shell for v1.1)
│   ├── content.js      # Page-side injector + click handler
│   ├── content.css     # Pill-style button styling
│   └── popup.html      # Default popup when the toolbar icon is clicked
└── README.md           # You are here
```

## Local HTTP contract

```
POST http://127.0.0.1:60701/api/companion/file
content-type: application/json

{ "url": "<page url>", "title": "<page title>" }
```

Response: `200 OK` with a JSON body
`{ "filed": true, "path": "<.claude/personal/state/companion-inbox.jsonl>" }`
on success; non-2xx otherwise.

## Status

v1.1 first cut. No build step — load unpacked as-is. Future:
- v1.2: badge for tracked anchors, hover preview.
- v1.3: Firefox + Safari ports, Slack action manifest.
- v1.4: mobile / native share-extension on iOS.

## Permissions

`activeTab`, `scripting`, plus `host_permissions` for
`github.com`, `*.slack.com`, and `127.0.0.1:60701`. No analytics,
no telemetry, no remote endpoints.
