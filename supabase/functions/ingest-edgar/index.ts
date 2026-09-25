// EDGAR red-flag ingestor. Polls the market-wide latest-filings Atom feeds
// (the per-company submissions API can't see new filings across all issuers).
// The feed summary already lists each 8-K's item numbers, so one request
// covers up to 100 filings with no per-filing fetch.
//
// Backfill mode (POST {"mode":"backfill","query":"4.02"|"4.01"|"nt","from":0})
// pages through EDGAR full-text search, 100 filings per call, over the last year.
//
// SEC fair-access rules: a declared User-Agent with contact info, and under
// 10 requests/second. Requests are spaced 200 ms apart.

import { companyByTicker, db } from "../_shared/db.ts";
import { parseEdgarAtom, parseEftsHits, RED_FLAG_ITEMS } from "../_shared/feeds.js";
import { urlHash } from "../_shared/canonical.js";

const UA = Deno.env.get("SEC_USER_AGENT"); // e.g. "SecuritiesList you@example.com"
const SOURCE = "edgar";
const FEED = (type: string, count: number) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=0&count=${count}&output=atom`;
const FEEDS = [FEED("8-K", 100), FEED("NT 10-K", 40), FEED("NT 10-Q", 40)];
const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const EFTS = (params: string, from: number) => {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  return `https://efts.sec.gov/LATEST/search-index?${params}&dateRange=custom&startdt=${start}&enddt=${end}&from=${from}`;
};
const BACKFILL_QUERIES: Record<string, string> = {
  "4.02": "q=%22Item%204.02%22&forms=8-K",
  "4.01": "q=%22Item%204.01%22&forms=8-K",
  nt: "forms=NT%2010-K,NT%2010-Q",
};

const NT_FORMS: Record<string, string> = { "NT 10-K": "annual report (10-K)", "NT 10-Q": "quarterly report (10-Q)" };

let lastRequest = 0;
async function secFetch(url: string) {
  const wait = lastRequest + 200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA!, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`SEC ${res.status} ${url}`);
  return res;
}

type Entry = Pick<ReturnType<typeof parseEdgarAtom>[number], "accession" | "form" | "company" | "cik" | "link" | "filed" | "items"> & {
  ticker?: string | null;
};
type Flag = { entry: Entry; key: string; title: string; summary: string; severity: string };

function redFlags(entry: Entry): Flag[] {
  const base = entry.form?.replace(/\/A$/, "") ?? "";
  if (base === "8-K") {
    return entry.items
      .filter((i) => i in RED_FLAG_ITEMS)
      .map((i) => {
        const { label, severity } = RED_FLAG_ITEMS[i as keyof typeof RED_FLAG_ITEMS];
        return {
          entry,
          key: `${entry.accession}:${i}`,
          title: `8-K Item ${i}: ${label}`,
          summary: `${entry.company} reported Item ${i} (${label.toLowerCase()}) in an 8-K filed ${entry.filed}, according to the SEC filing.`,
          severity,
        };
      });
  }
  if (base in NT_FORMS) {
    return [
      {
        entry,
        key: `${entry.accession}:${base}`,
        title: `${base}: late filing notice`,
        summary: `${entry.company} notified the SEC on ${entry.filed} that its ${NT_FORMS[base]} will be filed late, according to SEC records.`,
        severity: "medium",
      },
    ];
  }
  return [];
}

async function tickerMap() {
  // CIK -> ticker/exchange. Issuers with no listed ticker (private funds, ABS trusts) are skipped.
  const { fields, data } = await (await secFetch(TICKERS_URL)).json();
  const [iCik, iTicker, iExchange] = [fields.indexOf("cik"), fields.indexOf("ticker"), fields.indexOf("exchange")];
  const byCik = new Map<number, { ticker: string; exchange: string | null }>();
  for (const row of data) if (!byCik.has(row[iCik])) byCik.set(row[iCik], { ticker: row[iTicker], exchange: row[iExchange] });
  return byCik;
}

async function save(flags: Flag[]) {
  if (!flags.length) return [];
  const { data: seen } = await db.from("raw_items").select("source_id").eq("source", SOURCE).in("source_id", flags.map((f) => f.key));
  const seenKeys = new Set((seen ?? []).map((r) => r.source_id));
  const fresh = flags.filter((f) => !seenKeys.has(f.key));
  if (!fresh.length) return [];

  const byCik = await tickerMap();
  const results = [];
  for (const f of fresh) {
    const listed =
      byCik.get(Number(f.entry.cik)) ?? (f.entry.ticker ? { ticker: f.entry.ticker, exchange: null } : undefined);
    const { data: raw } = await db
      .from("raw_items")
      .insert({ source: SOURCE, source_id: f.key, url: f.entry.link, payload: f.entry })
      .select("id")
      .single();
    if (!listed || !f.entry.link) {
      await db.from("raw_items").update({ processed_at: new Date().toISOString(), error: "no listed ticker" }).eq("id", raw!.id);
      results.push({ key: f.key, skipped: "no listed ticker" });
      continue;
    }
    try {
      const company = await companyByTicker(listed.ticker, listed.exchange?.toUpperCase() ?? null, f.entry.company);
      const { data: ev, error } = await db
        .from("events")
        .upsert(
          {
            company_id: company.id,
            category: "filing",
            status: "open",
            event_date: f.entry.filed,
            severity: f.severity,
            title: f.title,
            summary: f.summary,
            source_urls: [f.entry.link],
            source_url_hashes: [await urlHash(f.entry.link)],
            dedupe_key: `edgar:${f.key}`,
          },
          { onConflict: "dedupe_key" },
        )
        .select("id")
        .single();
      if (error) throw error;
      await db.from("raw_items").update({ processed_at: new Date().toISOString(), event_id: ev.id }).eq("id", raw!.id);
      results.push({ key: f.key, ticker: listed.ticker, event: ev.id });
    } catch (err) {
      await db.from("raw_items").update({ error: String(err) }).eq("id", raw!.id);
      results.push({ key: f.key, error: String(err) });
    }
  }
  return results;
}

async function live() {
  const flags: Flag[] = [];
  for (const url of FEEDS) {
    // Filer and subject-company rows repeat an accession; keep the filer.
    const entries = parseEdgarAtom(await (await secFetch(url)).text()).filter((e) => e.role === "Filer");
    for (const e of entries) flags.push(...redFlags(e));
  }
  const results = await save(flags);
  return { processed: results.length, results };
}

async function backfill(query: string, from: number) {
  const params = BACKFILL_QUERIES[query];
  if (!params) throw new Error(`unknown backfill query ${query}`);
  const json = await (await secFetch(EFTS(params, from))).json();
  const hits: Entry[] = parseEftsHits(json);
  // Only hits carrying a listed ticker; redFlags keeps just the red-flag items.
  const flags = hits.filter((h) => h.ticker).flatMap((h) => redFlags(h));
  const results = await save(flags);
  const total = json.hits?.total?.value ?? 0;
  const next = from + hits.length;
  return { query, from, hits: hits.length, total, done: !hits.length || next >= Math.min(total, 10000), next_from: next, created: results.filter((r) => "event" in r).length, results };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  if (!UA) return new Response("SEC_USER_AGENT secret is not set", { status: 500 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.mode === "backfill") return Response.json(await backfill(body.query ?? "4.02", body.from ?? 0));
    return Response.json(await live());
  } catch (err) {
    console.error(err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
});
