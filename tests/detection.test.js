import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tickerFromUrl, isWirePage } from "../extension/src/sites.js";
import { canonicalUrl, urlHash } from "../extension/src/canonical.js";
import { matchScan } from "../extension/src/match.js";

const index = JSON.parse(await readFile(new URL("../extension/data/seed-index.json", import.meta.url), "utf8"));
const scan = (over) => ({ url: "https://example.com/a", canonicalHref: null, exchangeTickers: [], cashtags: [], nameHits: [], firmHits: [], ...over });

test("tickerFromUrl reads Tier-1 finance URLs", () => {
  assert.equal(tickerFromUrl("https://robinhood.com/stocks/NVLX"), "NVLX");
  assert.equal(tickerFromUrl("https://robinhood.com/us/en/stocks/aapl/"), "AAPL");
  assert.equal(tickerFromUrl("https://finance.yahoo.com/quote/NVLX/"), "NVLX");
  assert.equal(tickerFromUrl("https://finance.yahoo.com/quote/BRK-B/news"), "BRK.B");
  assert.equal(tickerFromUrl("https://www.google.com/finance/quote/NVLX:NASDAQ"), "NVLX");
  assert.equal(tickerFromUrl("https://seekingalpha.com/symbol/QRBT/analysis"), "QRBT");
  assert.equal(tickerFromUrl("https://www.marketwatch.com/investing/stock/nvlx"), "NVLX");
  assert.equal(tickerFromUrl("https://www.nasdaq.com/market-activity/stocks/nvlx"), "NVLX");
  assert.equal(tickerFromUrl("https://www.cnbc.com/quotes/HLPY"), "HLPY");
  assert.equal(tickerFromUrl("https://stocktwits.com/symbol/NVLX"), "NVLX");
});

test("tickerFromUrl reads news, data and brokerage quote URLs", () => {
  const cases = {
    "https://www.bloomberg.com/quote/AAPL:US": "AAPL",
    "https://www.reuters.com/markets/companies/AAPL.O/": "AAPL",
    "https://www.reuters.com/markets/companies/F.N": "F",
    "https://www.wsj.com/market-data/quotes/AAPL": "AAPL",
    "https://www.barrons.com/market-data/stocks/aapl?mod=searchresults": "AAPL",
    "https://www.morningstar.com/stocks/xnas/aapl/quote": "AAPL",
    "https://www.tradingview.com/symbols/NASDAQ-AAPL/": "AAPL",
    "https://www.tradingview.com/symbols/NYSE-BRK.B/": "BRK.B",
    "https://www.fool.com/quote/nasdaq/aapl/": "AAPL",
    "https://www.zacks.com/stock/quote/AAPL": "AAPL",
    "https://www.benzinga.com/quote/AAPL": "AAPL",
    "https://www.barchart.com/stocks/quotes/AAPL/overview": "AAPL",
    "https://www.marketbeat.com/stocks/NASDAQ/AAPL/": "AAPL",
    "https://stockanalysis.com/stocks/aapl/": "AAPL",
    "https://www.tipranks.com/stocks/aapl": "AAPL",
    "https://simplywall.st/stocks/us/tech/nasdaq-aapl/apple": "AAPL",
    "https://www.wallstreetzen.com/stocks/us/nasdaq/aapl": "AAPL",
    "https://finviz.com/quote.ashx?t=AAPL": "AAPL",
    "https://finviz.com/stock?t=AAPL&p=d": "AAPL",
    "https://markets.ft.com/data/equities/tearsheet/summary?s=AAPL:NSQ": "AAPL",
    "https://www.webull.com/quote/nasdaq-aapl": "AAPL",
    "https://public.com/stocks/aapl": "AAPL",
    "https://www.moomoo.com/stock/AAPL-US": "AAPL",
    "https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=AAPL": "AAPL",
    "https://us.etrade.com/etx/mkt/quotes?symbol=AAPL": "AAPL",
    "https://client.schwab.com/app/research/#/stocks/AAPL/summary": "AAPL",
  };
  for (const [url, ticker] of Object.entries(cases)) assert.equal(tickerFromUrl(url), ticker, url);
});

test("tickerFromUrl ignores non-quote pages on the new hosts", () => {
  for (const url of [
    "https://www.bloomberg.com/news/articles/2026-09-24/some-story",
    "https://www.bloomberg.com/quote/VOD:LN", // non-US listing
    "https://markets.ft.com/data/equities/tearsheet/summary?s=VOD:LSE",
    "https://www.reuters.com/markets/us/",
    "https://www.wsj.com/finance",
    "https://finviz.com/screener.ashx?t=AAPL",
    "https://finviz.com/quote.ashx",
    "https://www.fool.com/investing/2026/09/24/story/",
    "https://www.tradingview.com/symbols/LSE-VOD/",
    "https://www.moomoo.com/stock/00700-HK",
    "https://us.etrade.com/etx/mkt/quotes?symbol=",
    "https://client.schwab.com/app/accounts/positions/#/",
  ])
    assert.equal(tickerFromUrl(url), null, url);
});

test("tickerFromUrl ignores non-quote pages and other hosts", () => {
  assert.equal(tickerFromUrl("https://robinhood.com/account/investing"), null);
  assert.equal(tickerFromUrl("https://finance.yahoo.com/news/some-story"), null);
  assert.equal(tickerFromUrl("https://evil-robinhood.com/stocks/NVLX"), null);
  assert.equal(tickerFromUrl("not a url"), null);
});

test("isWirePage", () => {
  assert.ok(isWirePage("https://www.globenewswire.com/news-release/2026/09/19/1/0/en/x.html"));
  assert.ok(!isWirePage("https://www.benzinga.com/pressreleases/x"));
  assert.ok(isWirePage("https://www.newsfilecorp.com/release/123/x"));
  assert.ok(isWirePage("https://www.einpresswire.com/article/123/x"));
});

test("canonicalUrl drops tracking params, www, trailing slash and case", () => {
  assert.equal(
    canonicalUrl("https://WWW.GlobeNewswire.com/News/X/?utm_source=t&b=2&a=1#frag"),
    "globenewswire.com/news/x?a=1&b=2",
  );
});

test("release match by URL hash", async () => {
  const r = await matchScan(scan({ url: "http://localhost:8000/demo/wire/nvlx-rosen-law-firm.html?utm_source=x" }), index);
  assert.equal(r.primary.ticker, "NVLX");
  assert.equal(r.primary.method, "release");
  assert.equal(r.primary.release.via, "url");
  assert.equal(r.primary.release.release_count, 37);
});

test("release match by text catches syndicated copies", async () => {
  const r = await matchScan(scan({ exchangeTickers: ["NVLX"], firmHits: ["Rosen Law Firm"] }), index);
  assert.equal(r.primary.method, "release");
  assert.equal(r.primary.release.via, "text");
});

test("exchange ticker without a firm is a plain match, not a release", async () => {
  const r = await matchScan(scan({ exchangeTickers: ["NVLX", "AAPL"], nameHits: ["QRBT"] }), index);
  assert.deepEqual(r.matches.map((m) => [m.ticker, m.method]), [["NVLX", "exchange"], ["QRBT", "name"]]);
});

test("unflagged tickers produce no match", async () => {
  assert.equal(await matchScan(scan({ exchangeTickers: ["AAPL"], cashtags: ["TSLA"] }), index), null);
});

test("seed hashes equal what the extension computes", async () => {
  const inv = index.tickers.find((t) => t.ticker === "NVLX").investigations[0];
  assert.equal(inv.release_hashes[0], await urlHash("http://localhost:8000/demo/wire/nvlx-rosen-law-firm.html"));
});

test("edge functions use an identical copy of canonical.js", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  assert.equal(await read("../supabase/functions/_shared/canonical.js"), await read("../extension/src/canonical.js"));
});
