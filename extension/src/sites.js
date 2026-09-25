// Tier-1 detection: a ticker read from the URL alone, on known finance sites.
// Each site's `pattern` runs against the URL path and captures the ticker in
// group 1. Sites that carry the ticker elsewhere say so instead:
//   param: the query-string key holding the ticker (the pattern then only gates
//          the path, and `value` matches the parameter, default the bare ticker)
//   hash:  the pattern runs against the #fragment (single-page apps)
// Keep hosts in sync with host_permissions in manifest.json.

const T = "([A-Za-z]{1,5}(?:[.-][A-Za-z])?)"; // BRK.B, BF-B
const END = "(?:/|$)";
const re = (src, flags = "i") => new RegExp(src, flags);

export const SITES = [
  { host: "robinhood.com", pattern: new RegExp(`^/(?:us/en/)?stocks/${T}/?$`), portfolio: true },
  { host: "finance.yahoo.com", pattern: new RegExp(`^/quote/${T}(?:/|$)`) },
  { host: "www.google.com", pattern: new RegExp(`^/finance/quote/${T}:[A-Z]+`) },
  { host: "seekingalpha.com", pattern: new RegExp(`^/symbol/${T}(?:/|$)`) },
  { host: "www.marketwatch.com", pattern: new RegExp(`^/investing/stock/${T}(?:/|$)`, "i") },
  { host: "www.cnbc.com", pattern: new RegExp(`^/quotes/${T}(?:/|$)`) },
  { host: "www.nasdaq.com", pattern: new RegExp(`^/market-activity/stocks/${T}(?:/|$)`, "i") },
  { host: "stocktwits.com", pattern: new RegExp(`^/symbol/${T}(?:/|$)`) },

  // News and data
  { host: "bloomberg.com", pattern: re(`^/quote/${T}:US${END}`) }, // AAPL:US
  { host: "reuters.com", pattern: re(`^/markets/companies/${T}\\.[A-Z]{1,2}${END}`) }, // AAPL.O
  { host: "wsj.com", pattern: re(`^/market-data/quotes/${T}${END}`) },
  { host: "barrons.com", pattern: re(`^/market-data/stocks/${T}${END}`) },
  { host: "morningstar.com", pattern: re(`^/stocks/[a-z]{4}/${T}${END}`) }, // xnas/aapl
  { host: "tradingview.com", pattern: re(`^/symbols/(?:NASDAQ|NYSE|AMEX|NYSEARCA|CBOE|OTC)-${T}${END}`) },
  { host: "fool.com", pattern: re(`^/quote/(?:nasdaq|nyse|nysemkt|otc)/${T}${END}`) },
  { host: "zacks.com", pattern: re(`^/stock/quote/${T}${END}`) },
  { host: "benzinga.com", pattern: re(`^/quote/${T}${END}`) },
  { host: "barchart.com", pattern: re(`^/stocks/quotes/${T}${END}`) },
  { host: "marketbeat.com", pattern: re(`^/stocks/(?:NASDAQ|NYSE|NYSEAMERICAN|OTCMKTS)/${T}${END}`) },
  { host: "stockanalysis.com", pattern: re(`^/stocks/${T}${END}`) },
  { host: "tipranks.com", pattern: re(`^/stocks/${T}${END}`) },
  { host: "simplywall.st", pattern: re(`^/stocks/us/[^/]+/(?:nasdaq|nyse|nysemkt|otc|otcpk)-${T}${END}`) },
  { host: "wallstreetzen.com", pattern: re(`^/stocks/us/[a-z]+/${T}${END}`) },
  { host: "finviz.com", pattern: re(`^/(?:quote\\.ashx|stock)$`), param: "t" }, // quote.ashx redirects to /stock
  {
    host: "markets.ft.com",
    pattern: re(`^/data/equities/tearsheet/`),
    param: "s",
    value: re(`^${T}:(?:NSQ|NYQ|ASQ|PCQ|PNK)$`), // AAPL:NSQ, US listings only
  },

  // Brokerages
  { host: "webull.com", pattern: re(`^/quote/(?:nasdaq|nyse|amex|otc|nysearca)-${T}${END}`) },
  { host: "public.com", pattern: re(`^/stocks/${T}${END}`) },
  { host: "moomoo.com", pattern: re(`^/stock/${T}-US${END}`) },
  { host: "digital.fidelity.com", pattern: re(`^/prgw/digital/research/quote/`), param: "symbol" },
  { host: "etrade.com", pattern: re(`^/etx/mkt/quotes`), param: "symbol" },
  { host: "client.schwab.com", pattern: re(`^#/stocks/${T}${END}`), hash: true },
];

// Wire sites have no ticker in the URL; the wire content script text-scans them.
export const WIRE_HOSTS = [
  "globenewswire.com",
  "prnewswire.com",
  "businesswire.com",
  "accesswire.com",
  "newsfilecorp.com",
  "einpresswire.com",
];

// Other pages worth scanning automatically, with the same content script:
// quote pages keyed by company name, the class-action clearinghouse, and
// short sellers' report sites.
export const SCAN_HOSTS = [
  "investing.com",
  "securities.stanford.edu",
  "muddywatersresearch.com",
  "sprucepointcap.com",
  "culperresearch.com",
  "grizzlyreports.com",
  "kerrisdalecap.com",
  "fuzzypandaresearch.com",
  "wolfpackresearch.com",
  "blueorcacapital.com",
  "iceberg-research.com",
];

function hostMatches(actual, expected) {
  return actual === expected || actual.endsWith("." + expected.replace(/^www\./, ""));
}

const BARE = new RegExp(`^${T}$`);

function siteTicker(site, u) {
  if (site.hash) return u.hash.match(site.pattern)?.[1] ?? null;
  if (!site.param) return u.pathname.match(site.pattern)?.[1] ?? null;
  if (!site.pattern.test(u.pathname)) return null;
  return (u.searchParams.get(site.param) ?? "").match(site.value ?? BARE)?.[1] ?? null;
}

export function tickerFromUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  for (const site of SITES) {
    if (!hostMatches(u.hostname, site.host)) continue;
    const m = siteTicker(site, u);
    if (m) return m.toUpperCase().replace("-", ".");
  }
  return null;
}

export function isWirePage(raw) {
  try {
    const { hostname } = new URL(raw);
    return WIRE_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

export function isRobinhood(raw) {
  try {
    return hostMatches(new URL(raw).hostname, "robinhood.com");
  } catch {
    return false;
  }
}
