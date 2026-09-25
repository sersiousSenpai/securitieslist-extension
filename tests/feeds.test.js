import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseGlobeNewswire, parseEdgarAtom, exchangeTicker, matchFirm, releaseText } from "../supabase/functions/_shared/feeds.js";

const fixture = (f) => readFile(new URL(`fixtures/${f}`, import.meta.url), "utf8");
const seed = JSON.parse(await readFile(new URL("../seed/seed.json", import.meta.url), "utf8"));

test("parses GlobeNewswire items with id, link, contributor and keywords", async () => {
  const items = parseGlobeNewswire(await fixture("gnw-class-action.xml"));
  assert.equal(items.length, 20);
  for (const it of items) {
    assert.match(it.id, /^\d+$/);
    assert.match(it.link, /^https:\/\/www\.globenewswire\.com\/news-release\//);
    assert.ok(it.title.length > 10);
  }
  const withTicker = items.filter((it) => exchangeTicker(it.keywords.join(" "), it.title, it.description));
  assert.ok(withTicker.length >= 10, `only ${withTicker.length} items had an exchange ticker`);
  const withFirm = items.filter((it) => matchFirm(seed.firms, it.contributor, it.title, it.description));
  assert.ok(withFirm.length >= 10, `only ${withFirm.length} items matched a known firm`);
});

test("exchangeTicker normalizes exchange names", () => {
  assert.deepEqual(exchangeTicker("shareholders of Fluence Energy, Inc. (NASDAQ: FLNC) resulting"), { exchange: "NASDAQ", ticker: "FLNC" });
  assert.deepEqual(exchangeTicker("(NYSE:HON)"), { exchange: "NYSE", ticker: "HON" });
  assert.deepEqual(exchangeTicker("(Nasdaq GS: ABCD)"), { exchange: "NASDAQ", ticker: "ABCD" });
  assert.equal(exchangeTicker("no ticker here"), null);
});

test("releaseText starts at the dateline", async () => {
  const text = releaseText(await fixture("gnw-release.html"));
  assert.match(text, /GLOBE NEWSWIRE/);
  assert.ok(!/<[a-z]/i.test(text), "no markup left");
  assert.ok(text.length > 500);
});

test("parses EDGAR latest-filings entries with items", async () => {
  const entries = parseEdgarAtom(await fixture("edgar-8k.xml"));
  assert.ok(entries.length >= 40);
  for (const e of entries) {
    assert.match(e.accession, /^\d{10}-\d{2}-\d{6}$/);
    assert.match(e.cik, /^\d{10}$/);
    assert.ok(e.form.startsWith("8-K"));
    assert.ok(e.items.length >= 1);
  }
  assert.ok(entries.some((e) => e.items.includes("4.01") || e.items.includes("4.02")));
});

import { parseGnwSearchPage, parseGnwRelease, kindHint, parseSecRss, parseEftsHits } from "../supabase/functions/_shared/feeds.js";

test("parses GlobeNewswire search pages for backfill", async () => {
  const rows = parseGnwSearchPage(await fixture("gnw-search.html"));
  assert.equal(rows.length, 50);
  for (const r of rows) {
    assert.match(r.link, /^https:\/\/www\.globenewswire\.com\/news-release\/\d{4}\//);
    assert.ok(r.contributor && r.title);
  }
});

test("a release page parses into the RSS item shape", async () => {
  const link = "https://www.globenewswire.com/news-release/2026/09/25/3368832/673/en/x.html";
  const item = parseGnwRelease(await fixture("gnw-release.html"), link);
  assert.equal(item.id, "3368832");
  assert.equal(item.contributor, "The Rosen Law Firm PA");
  assert.ok(item.keywords.includes("NASDAQ: FLNC"));
  assert.equal(item.published, "2026-09-25T01:45:00Z");
});

test("kindHint separates filed suits from investigations", () => {
  assert.equal(kindHint("Class Action Filed Alleging Investor Harm"), "lawsuit_filed");
  assert.equal(kindHint("the lead plaintiff deadline is November 3, 2026"), "lawsuit_filed");
  assert.equal(kindHint("announces an investigation of potential securities claims"), "investigation");
  assert.equal(kindHint("Quarterly dividend declared"), null);
});

test("parses SEC enforcement RSS", async () => {
  for (const f of ["sec-lit.xml", "sec-admin.xml"]) {
    const items = parseSecRss(await fixture(f));
    assert.equal(items.length, 25);
    for (const it of items) assert.ok(it.id && it.link.startsWith("https://www.sec.gov/"));
  }
});

test("parses EDGAR full-text search hits with ticker and items", async () => {
  const hits = parseEftsHits(JSON.parse(await fixture("efts-402.json")));
  assert.equal(hits.length, 100);
  const withTicker = hits.filter((h) => h.ticker);
  assert.ok(withTicker.length >= 90);
  for (const h of withTicker) {
    assert.match(h.ticker, /^[A-Z.]{1,6}$/);
    assert.match(h.link, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.htm$/);
  }
});

import { exchangeTickers } from "../supabase/functions/_shared/feeds.js";

test("exchangeTickers finds every listed company in a roundup, once each", () => {
  const text = "FuelCell Energy (NASDAQ: FCEL) ... Beta Bionics (NASDAQ: BBNX) ... DICK'S (NYSE: DKS) ... again (NASDAQ: FCEL)";
  assert.deepEqual(exchangeTickers(text).map((t) => t.ticker), ["FCEL", "BBNX", "DKS"]);
  assert.deepEqual(exchangeTickers("no tickers"), []);
});
