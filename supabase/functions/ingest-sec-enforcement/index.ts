// SEC enforcement ingestor: litigation releases and administrative
// proceedings. Most name individuals or private advisers; Claude reads each
// new release and reports whether it concerns a listed company or one of its
// officers. The ticker must then exist in SEC's own ticker list and match the
// company name, or the release is skipped.
//
// Triggered hourly by pg_cron (migrations/0003_lifecycle.sql).

import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { companyByTicker, db } from "../_shared/db.ts";
import { extractEnforcementFacts } from "../_shared/extract.ts";
import { parseSecRss, stripTags } from "../_shared/feeds.js";
import { urlHash } from "../_shared/canonical.js";

const UA = Deno.env.get("SEC_USER_AGENT");
const SOURCE = "sec-enforcement";
const FEEDS = [
  "https://www.sec.gov/enforcement-litigation/litigation-releases/rss",
  "https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss",
];
const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const MAX_NEW_PER_RUN = 8;

let lastRequest = 0;
async function secFetch(url: string) {
  const wait = lastRequest + 200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA!, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`SEC ${res.status} ${url}`);
  return res;
}

const STOP = new Set(["inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "holdings", "group", "the", "sa", "nv", "ag", "llc", "lp"]);
const nameTokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
const sameCompany = (a: string, b: string) => {
  const [ta, tb] = [nameTokens(a), nameTokens(b)];
  return ta.length > 0 && tb.length > 0 && ta[0] === tb[0];
};

async function releaseSource(link: string) {
  const res = await secFetch(link);
  if (link.toLowerCase().endsWith(".pdf") || res.headers.get("content-type")?.includes("pdf")) {
    return { pdfBase64: encodeBase64(new Uint8Array(await res.arrayBuffer())) };
  }
  const text = stripTags(await res.text());
  const start = text.search(/Litigation Release No|Administrative Proceeding/i);
  return { text: text.slice(Math.max(0, start), Math.max(0, start) + 15000) };
}

const VERB = { charged: "brought charges", settled: "announced a settled action", judgment: "obtained a judgment", other: "announced an enforcement action" };

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  if (!UA) return new Response("SEC_USER_AGENT secret is not set", { status: 500 });

  const items = [];
  for (const feed of FEEDS) items.push(...parseSecRss(await (await secFetch(feed)).text()));
  const ids = items.map((i) => i.id).filter(Boolean);
  const { data: seen } = await db.from("raw_items").select("source_id").eq("source", SOURCE).in("source_id", ids);
  const seenIds = new Set((seen ?? []).map((r) => r.source_id));
  const fresh = items.filter((i) => i.id && i.link && !seenIds.has(i.id)).slice(0, MAX_NEW_PER_RUN);
  if (!fresh.length) return Response.json({ processed: 0 });

  const { fields, data } = await (await secFetch(TICKERS_URL)).json();
  const [iName, iTicker, iExchange] = [fields.indexOf("name"), fields.indexOf("ticker"), fields.indexOf("exchange")];
  const byTicker = new Map<string, { name: string; exchange: string | null }>();
  for (const row of data) byTicker.set(String(row[iTicker]).toUpperCase(), { name: row[iName], exchange: row[iExchange] });

  const results = [];
  for (const item of fresh) {
    const { data: raw } = await db
      .from("raw_items")
      .insert({ source: SOURCE, source_id: item.id, url: item.link, payload: item })
      .select("id")
      .single();
    const done = (patch: Record<string, unknown>) =>
      db.from("raw_items").update({ processed_at: new Date().toISOString(), ...patch }).eq("id", raw!.id);
    try {
      const facts = await extractEnforcementFacts(item.title, await releaseSource(item.link));
      const listed = facts?.ticker ? byTicker.get(facts.ticker.toUpperCase()) : undefined;
      if (!facts?.involves_listed_company || !facts.company_name || !listed || !sameCompany(listed.name, facts.company_name)) {
        await done({ error: "no verified listed company" });
        results.push({ id: item.id, skipped: "no verified listed company" });
        continue;
      }
      const ticker = facts.ticker!.toUpperCase();
      const company = await companyByTicker(ticker, listed.exchange?.toUpperCase() ?? null, facts.company_name);
      const who = facts.named_party === "company" ? company.name : `a current or former officer or director of ${company.name}`;
      const { data: ev, error } = await db
        .from("events")
        .upsert(
          {
            company_id: company.id,
            category: "enforcement",
            status: "open",
            event_date: new Date(item.published ?? Date.now()).toISOString().slice(0, 10),
            severity: facts.named_party === "company" ? "high" : "medium",
            title: `SEC ${item.id?.startsWith("LR-") ? "litigation release" : "administrative proceeding"} naming ${facts.named_party === "company" ? company.name : `${company.name} officer`}`,
            summary: `The SEC ${VERB[facts.resolution]} involving ${who}${facts.alleged_conduct ? `, alleging ${facts.alleged_conduct}` : ""}, according to the SEC release.`,
            alleged_conduct: facts.alleged_conduct,
            source_urls: [item.link],
            source_url_hashes: [await urlHash(item.link)],
            dedupe_key: `sec:${item.id}`,
          },
          { onConflict: "dedupe_key" },
        )
        .select("id")
        .single();
      if (error) throw error;
      await done({ event_id: ev.id });
      results.push({ id: item.id, ticker, event: ev.id });
    } catch (err) {
      await db.from("raw_items").update({ error: String(err) }).eq("id", raw!.id);
      results.push({ id: item.id, error: String(err) });
    }
  }
  return Response.json({ processed: results.length, results });
});
