// Background service worker. v1.1 first cut is a no-op shell — every
// interaction goes through the content script's fetch to localhost.
// The service worker exists because manifest v3 requires it for the
// extension's lifecycle; future versions (browser-action popup,
// badge counts, alarm-driven sync) will hook here.
chrome.runtime.onInstalled.addListener(() => {
  // No-op for v1.1. Reserved for future install-time setup (welcome
  // page, options seeding, etc).
});
