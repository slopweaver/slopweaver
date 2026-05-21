// SlopWeaver companion — background service worker.
//
// Receives `FILE_TAB` messages from the content script and POSTs them
// to the local SlopWeaver HTTP server at http://127.0.0.1:60701.
//
// Why this lives here and not in content.js: a content script's fetch
// inherits the page's origin (github.com / slack.com), so the local
// server rejects it on the same-origin Origin guard. The service
// worker runs in the extension's own privileged context — the local
// server's companion endpoint explicitly allow-lists that and skips
// Origin validation for it.

const ENDPOINT = 'http://127.0.0.1:60701/api/companion/file';

chrome.runtime.onInstalled.addListener(() => {
  // No-op for v1.1. Reserved for future install-time setup (welcome
  // page, options seeding, etc).
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg == null || typeof msg !== 'object' || msg.type !== 'FILE_TAB') {
    sendResponse({ ok: false, error: 'unknown message type' });
    return false;
  }
  fileTab({ url: msg.url, title: msg.title })
    .then((reply) => sendResponse(reply))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  // Return true to keep the message channel open for the async response.
  return true;
});

async function fileTab({ url, title }) {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'url required' };
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, title: typeof title === 'string' ? title : '' }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.text();
      if (body.length > 0) detail = `${res.status} ${body.slice(0, 200)}`;
    } catch {
      // Ignore body read failure — the status code alone is enough signal.
    }
    return { ok: false, error: detail };
  }
  return { ok: true };
}
