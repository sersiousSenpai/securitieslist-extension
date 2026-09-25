# Securities List

A Chrome/Edge extension that adds a legal and regulatory risk layer to stock research. It surfaces securities class actions, plaintiff-firm investigations, SEC red-flag filings, enforcement actions, short reports and news for the stock you're reading about. It works on brokerages, quote pages, news articles and law-firm press releases.

When you land on one of the dozens of near-identical firm releases that follow a stock drop, it tells you **"This is 1 of 37 releases about this investigation."** It then shows the facts once: alleged conduct, whether a suit is actually filed, the class period and the lead-plaintiff deadline.

## How detection works

| Where | How | When |
|---|---|---|
| Finance sites: Robinhood, Yahoo Finance, Google Finance, Seeking Alpha, MarketWatch, CNBC, Nasdaq.com, StockTwits, Bloomberg, Reuters, WSJ, Barron's, FT, Morningstar, TradingView, Motley Fool, Zacks, Benzinga, Barchart, MarketBeat, Stock Analysis, TipRanks, Simply Wall St, WallStreetZen, Finviz, Webull, Public, moomoo, Fidelity, E\*TRADE, Schwab | Ticker read from the URL (path, query string or `#` fragment) | Automatically: badge, plus the popup auto-opens on every visit (dismiss it or turn it off in the popup footer) |
| Wire services (GlobeNewswire, PR Newswire, Business Wire, Accesswire, Newsfile, EIN Presswire), Investing.com, the Stanford Securities Class Action Clearinghouse, and short-seller report sites (Muddy Waters, Spruce Point, Culper, Grizzly, Kerrisdale, Fuzzy Panda, Wolfpack, Blue Orca, Iceberg) | Page text scanned for `(NASDAQ: XYZ)`, cashtags, company names and plaintiff-firm names | Automatically: badge only |
| Any other page (news, syndicated releases, blogs) | Same text scan, plus `$XYZ` cashtags and exact company names | Only when you click the icon (`activeTab`) |

Everything is matched **on your device** against a downloaded index of flagged companies (a few hundred). The "1 of N" match compares a hash of the page URL, and the ticker-plus-firm text, against release fingerprints in that index. The extension makes only two kinds of requests: the whole index (no parameters), and event detail for one ticker. Neither carries a page URL.

## Quick start (offline demo, about 2 minutes)

The extension ships with **fictional demo data** (NVLX, QRBT, HLPY) and runs without a backend.

1. Run `python3 -m http.server 8000` from the repo root. It serves `demo/` at `http://localhost:8000/demo/`.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose `extension/`. Pin the icon.
3. Open `http://localhost:8000/demo/` and follow the pages:
   1. **Wire release** → the badge lights. Click it: "1 of 37 releases" plus the consolidated card.
   2. **Syndicated copy** (not a wire host) → click the icon: the same card, matched by text.
   3. **News article** → click the icon: NVLX by exchange ticker, and QRBT by company name.
   4. `https://finance.yahoo.com/quote/NVLX/` → the popup auto-opens from the URL alone.
   5. **My Portfolio** → open `robinhood.com/account/investing` to import tickers, or add them by hand.
4. Close on privacy: open DevTools → Network on the popup. No request contains a page URL.

> **Pre-record the full demo** as a backup. The Robinhood step needs a logged-in account with holdings, and venue wifi fails.

## Going live (Supabase)

1. Create a Supabase project. Apply the migrations and the seed:
   ```bash
   supabase link --project-ref <ref>
   supabase db push                        # 0001_schema.sql, 0002_cron.sql
   psql "$DB_URL" -f supabase/seed.sql     # optional: demo rows (flagged is_demo)
   ```
   `0002_cron.sql` reads two Vault secrets. Create them first, in the SQL editor:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<random string>', 'cron_secret');
   ```
2. Set the function secrets and deploy:
   ```bash
   supabase secrets set CRON_SECRET=<same random string> \
     ANTHROPIC_API_KEY=sk-ant-... \
     SEC_USER_AGENT="SecuritiesList you@yourdomain.com"
   supabase functions deploy ingest-wires
   supabase functions deploy ingest-edgar
   ```
3. Put the project URL and **anon** key in `extension/config.js`, then reload the extension. Never put the service-role key there.

### Ingestors

- **`ingest-wires`** (every 3 min) reads GlobeNewswire's `class action` and `securities fraud` keyword feeds.
  - The firm comes from `dc:contributor` and the ticker from `dc:keyword`, both deterministic.
  - Claude (`claude-opus-5`, low effort, structured output) extracts only the facts the release states: kind, alleged conduct, class period, deadline, court.
  - User-facing summaries are templated and attributed in code. The model never writes the characterization.
  - Releases cluster into one investigation per company per 120 days, or one lawsuit per class period.
- **`ingest-edgar`** (every 5 min) reads EDGAR's market-wide latest-filings Atom feeds.
  - It covers 8-K Items 4.01 and 4.02, NT 10-K and NT 10-Q.
  - The feed lists item numbers, so there are no per-filing fetches. A run makes at most 4 SEC requests, spaced 200 ms apart, with a declared User-Agent.
  - SEC's `company_tickers_exchange.json` maps CIK to ticker.

Business Wire and Accesswire returned 403 to feed requests, and PR Newswire has no class-action feed. Those sources stay seeded for now, along with enforcement, short reports, filed suits and news.

## Layout

```
extension/            MV3 extension (load this folder)
  src/sites.js          Tier-1 URL patterns
  src/scanner.js        page-text scanner (content script + activeTab injection)
  src/match.js          on-device matching and "1 of N"
  src/canonical.js      URL canonicalization + hashing (copied to edge functions)
  src/background.js     service worker: badge, auto-open, 1-min poll, notifications
  content/              wire-page and Robinhood-portfolio content scripts
  popup/                compact alert, expanded view, My Portfolio
  data/                 generated demo seed
seed/seed.json        demo data source of truth
scripts/              build-seed.mjs (seed + SQL + canonical copy), build-icons.mjs
supabase/             schema, cron, edge functions
demo/                 fictional pages for local testing
tests/                unit tests (npm test) and Chromium e2e (npm run e2e)
```

## Development

```bash
npm test                  # detection, matching, feed parsing (Node 22+)
npm i && npx playwright install chromium && npm run e2e
node scripts/build-seed.mjs   # after editing seed/seed.json
```

Before a Web Store submission, remove `http://localhost:8000/*` from `manifest.json` (host permissions and the wire content-script match) and publish a privacy policy.

Informational only; not investment or legal advice. Every signal is attributed to, and links to, its source.
