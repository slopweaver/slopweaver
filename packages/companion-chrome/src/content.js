// SlopWeaver companion — content script
//
// Injects a small "📌 File in SlopWeaver" button on supported pages
// (GitHub PR view + Slack thread view). Click → POSTs the current URL
// to the local SlopWeaver HTTP server at http://127.0.0.1:60701.
//
// First-cut implementation. Intentionally tiny — no framework, no
// build step. Runs as-is when loaded unpacked. Future polish (badge
// for tracked anchors, hover preview) is a v1.2 follow-up.

(() => {
  const ENDPOINT = 'http://127.0.0.1:60701/api/companion/file';

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
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: location.href, title: document.title.slice(0, 200) }),
        });
        btn.textContent = res.ok ? '✓ filed' : `✗ ${res.status}`;
      } catch (err) {
        btn.textContent = `✗ ${err.message ?? 'failed'}`;
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
