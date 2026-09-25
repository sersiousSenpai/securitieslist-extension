// Robinhood positions page (/account/investing). Injected on all of
// robinhood.com because the app routes client-side, but reports only while
// the positions page is showing. Reads ticker symbols only, from the links each
// holdings row points at (/stocks/<TICKER>). Never reads quantities, prices,
// balances or cost basis. All Robinhood-specific selectors live here.

const HOLDINGS_LINK = 'a[href^="/stocks/"]';
const TICKER_FROM_HREF = /^\/stocks\/([A-Za-z.]{1,6})\/?$/;

function readTickers() {
  const tickers = new Set();
  for (const a of document.querySelectorAll(HOLDINGS_LINK)) {
    const m = a.getAttribute("href").match(TICKER_FROM_HREF);
    if (m) tickers.add(m[1].toUpperCase());
  }
  return [...tickers];
}

let last = "";
const POSITIONS_PATH = /^\/account\/investing/;

function report() {
  if (!POSITIONS_PATH.test(location.pathname)) return;
  const tickers = readTickers();
  const key = tickers.join(",");
  if (!tickers.length || key === last) return;
  last = key;
  chrome.runtime.sendMessage({ type: "portfolio", tickers });
}

// Robinhood is a single-page app and rows load lazily.
let timer;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(report, 500);
}).observe(document.body, { childList: true, subtree: true });
report();
