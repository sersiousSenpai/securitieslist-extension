// Page-text scanner. A classic script (not a module) because it is injected
// two ways: as a manifest content script on wire sites, and by the popup via
// chrome.scripting.executeScript on any page (activeTab). Both run in the
// extension's isolated world, so the page cannot see or call it.
//
// It only extracts candidates; match.js decides what they mean. The name and
// firm lists passed in stay in the isolated world, out of the page's reach.

globalThis.SLScan = function SLScan(opts) {
  const names = (opts && opts.names) || []; // [{ ticker, name }]
  const firms = (opts && opts.firms) || [];
  const MAX_CHARS = 300000;

  const text = (document.body ? document.body.innerText : "").slice(0, MAX_CHARS);
  const title = document.title || "";
  const all = title + "\n" + text;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "(NASDAQ: XYZ)", "NYSE:XYZ", "(NYSE American: XYZ)", "OTC: XYZ", "Nasdaq GS: XYZ"
  const exchangeRe =
    /\b(NASDAQ(?:\s?(?:GS|GM|CM))?|Nasdaq(?:\s?(?:GS|GM|CM))?|NYSE(?:\s?American|\s?Arca|\s?MKT)?|OTC(?:QX|QB|\s?Markets)?|Cboe)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
  const exchangeTickers = new Set();
  for (const m of all.matchAll(exchangeRe)) exchangeTickers.add(m[2]);

  // $XYZ cashtags; skip currency amounts like $5 or $5M.
  const cashtags = new Set();
  for (const m of all.matchAll(/(?:^|[\s(])\$([A-Z]{1,5})\b/g)) cashtags.add(m[1]);

  // Exact, case-sensitive company names, only on pages with finance context.
  const financeContext = /\b(stock|shares|shareholders|investors|securities|NASDAQ|NYSE)\b/i.test(all);
  const nameHits = new Set();
  if (financeContext) {
    for (const { ticker, name } of names) {
      if (name.length < 4) continue;
      if (new RegExp(`(^|[^\\w])${esc(name)}(?=[^\\w]|$)`).test(all)) nameHits.add(ticker);
    }
  }

  const firmHits = firms.filter((f) => all.includes(f));

  const canonical = document.querySelector('link[rel="canonical"]');

  return {
    url: location.href,
    canonicalHref: canonical ? canonical.href : null,
    title: title.slice(0, 200),
    exchangeTickers: [...exchangeTickers],
    cashtags: [...cashtags],
    nameHits: [...nameHits],
    firmHits,
  };
};
