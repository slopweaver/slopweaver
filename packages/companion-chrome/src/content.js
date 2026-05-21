// SlopWeaver companion — content script.
//
// Injects a small "📌 File in SlopWeaver" button on supported pages
// (GitHub PR / issue view + Slack web client). Click → asks the
// extension service worker to POST the current URL to the local
// SlopWeaver HTTP server at http://127.0.0.1:60701.
//
// Why the round-trip through the background worker: content scripts
// run in the page's origin (github.com / slack.com), so a direct
// `fetch('http://127.0.0.1:60701/...')` is a cross-origin request and
// the SlopWeaver server (correctly) 403s it on Origin. Extension
// service workers have their own privileged fetch context that the
// local server explicitly allow-lists. See
// `packages/companion-chrome/README.md` for the contract.
//
// First-cut implementation. Intentionally tiny — no framework, no
// build step. Runs as-is when loaded unpacked. Future polish (badge
// for tracked anchors, hover preview) is a v1.2 follow-up.

(() => {
  function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '📌 SlopWeaver';
    btn.className = 'slopweaver-companion-button';
    btn.title = 'File this thread in your SlopWeaver work console';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ filing…';
      try {
        const reply = await chrome.runtime.sendMessage({
          type: 'FILE_TAB',
          url: location.href,
          title: document.title.slice(0, 200),
        });
        if (reply && reply.ok === true) {
          btn.textContent = '✓ filed';
        } else {
          const detail = reply && typeof reply.error === 'string' ? reply.error : 'failed';
          btn.textContent = `✗ ${detail}`;
        }
      } catch (err) {
        btn.textContent = `✗ ${err && err.message ? err.message : 'failed'}`;
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = '📌 SlopWeaver';
        }, 3000);
      }
    });
    return btn;
  }

  function ensureMounted() {
    if (document.querySelector('.slopweaver-companion-button')) return;
    const host = document.body;
    if (host == null) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'slopweaver-companion-host';
    wrapper.appendChild(makeButton());
    host.appendChild(wrapper);
  }

  ensureMounted();
  // GitHub + Slack are SPAs — rerun on history nav.
  const observer = new MutationObserver(() => ensureMounted());
  observer.observe(document.body, { childList: true, subtree: true });
})();
