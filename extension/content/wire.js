// Runs on wire-service sites, the SCAN_HOSTS in src/sites.js (and the local
// demo wire pages). Scans the page text with SLScan (src/scanner.js, loaded first) and hands the
// candidates to the service worker, which matches them on the device.

(async () => {
  const { index } = await chrome.storage.local.get("index");
  const names = index ? index.tickers.flatMap((t) => t.names.map((name) => ({ ticker: t.ticker, name }))) : [];
  const scan = globalThis.SLScan({ names, firms: index ? index.firms : [] });
  chrome.runtime.sendMessage({ type: "wire-scan", scan });
})();
