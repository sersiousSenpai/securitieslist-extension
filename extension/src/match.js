// On-device matching of a page scan against the flagged index. Nothing here
// touches the network: the page URL is hashed locally and compared to the
// release hashes that ship inside the index.

import { urlHash } from "./canonical.js";

const METHOD_ORDER = ["release", "url", "exchange", "cashtag", "name"];

export function indexByTicker(index) {
  return new Map(index.tickers.map((t) => [t.ticker, t]));
}

export function nameList(index) {
  return index.tickers.flatMap((t) => t.names.map((name) => ({ ticker: t.ticker, name })));
}

// Returns { matches: [{ ticker, method, release? }], primary } or null.
// release = { event_id, release_count, via: "url" | "text" } when the page is
// one of an investigation's firm releases (or a syndicated copy of one).
export async function matchScan(scan, index) {
  const byTicker = indexByTicker(index);
  const pageHashes = new Set(
    (await Promise.all([scan.url, scan.canonicalHref].filter(Boolean).map(urlHash))).filter(Boolean),
  );
  const exchange = new Set(scan.exchangeTickers);
  const found = new Map();
  const add = (ticker, method, release) => {
    const prev = found.get(ticker);
    if (!prev || METHOD_ORDER.indexOf(method) < METHOD_ORDER.indexOf(prev.method)) {
      found.set(ticker, { ticker, method, ...(release ? { release } : {}) });
    }
  };

  for (const entry of byTicker.values()) {
    for (const inv of entry.investigations ?? []) {
      const byUrl = inv.release_hashes.some((h) => pageHashes.has(h));
      const byText = exchange.has(entry.ticker) && scan.firmHits.length > 0;
      if (byUrl || byText) {
        add(entry.ticker, "release", {
          event_id: inv.event_id,
          release_count: inv.release_count,
          via: byUrl ? "url" : "text",
          firms_on_page: scan.firmHits,
        });
      }
    }
  }
  for (const t of scan.exchangeTickers) if (byTicker.has(t)) add(t, "exchange");
  for (const t of scan.cashtags) if (byTicker.has(t)) add(t, "cashtag");
  for (const t of scan.nameHits) if (byTicker.has(t)) add(t, "name");

  if (!found.size) return null;
  const matches = [...found.values()].sort(
    (a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return { matches, primary: matches[0] };
}
