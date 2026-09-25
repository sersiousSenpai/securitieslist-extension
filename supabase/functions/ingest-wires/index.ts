// Wire-service ingestor: plaintiff-firm releases from GlobeNewswire, clustered
// into one event per company investigation or filed suit.
//
// Live mode (pg_cron, every 3 min): the keyword RSS feeds, newest 20 each.
// Backfill mode (POST {"mode":"backfill","keyword":"class action","page":N}):
// one page of GlobeNewswire search results, 50 releases, in chunks.
//
// Claude is called only for a release that starts a new event. A release that
// joins an existing investigation or suit is appended without a model call.
//
// Business Wire and Accesswire block feed access (403), and PR Newswire has no
// class-action feed, so GlobeNewswire is the only live wire source for now.

import { db, companyByTicker, findCompany } from "../_shared/db.ts";
import { extractReleaseFacts } from "../_shared/extract.ts";
import {
  exchangeTicker,
  exchangeTickers,
  gnwReleaseDate,
  gnwReleaseId,
  kindHint,
  matchFirm,
  parseGlobeNewswire,
  parseGnwRelease,
  parseGnwSearchPage,
  releaseText,
} from "../_shared/feeds.js";
import { urlHash } from "../_shared/canonical.js";

const FEEDS = [
  "https://www.globenewswire.com/RssFeed/keyword/class%20action",
  "https://www.globenewswire.com/RssFeed/keyword/securities%20fraud",
];
const SEARCH = (keyword: string, page: number) =>
  `https://www.globenewswire.com/search/keyword/${encodeURIComponent(keyword)}?page=${page}&pageSize=50`;
const SOURCE = "globenewswire";
const MAX_NEW_PER_RUN = 10; // keeps a run well inside the edge-function time limit
const INVESTIGATION_WINDOW_DAYS = 120;
const LAWSUIT_WINDOW_DAYS = 365;
const UA = Deno.env.get("SEC_USER_AGENT") ?? "SecuritiesList contact@securitieslist.com";

type Item = ReturnType<typeof parseGlobeNewswire>[number];

// Severity rubric: a filed suit is high. An investigation is medium, and
// becomes high once 5 or more firms are announcing it.
const investigationSeverity = (firmCount: number) => (firmCount >= 5 ? "high" : "medium");

const isoDate = (d: string | null) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function unseen<T extends { id: string | null }>(items: T[]): Promise<T[]> {
  const ids = items.map((i) => i.id).filter((id): id is string => Boolean(id));
  if (!ids.length) return [];
  const { data: seen } = await db.from("raw_items").select("source_id").eq("source", SOURCE).in("source_id", ids);
  const seenIds = new Set((seen ?? []).map((r) => r.source_id));
  return items.filter((it) => it.id && !seenIds.has(it.id));
}

async function appendRelease(eventId: string, url: string, hash: string, firm: string, published: string) {
  const { data: ev } = await db
    .from("events")
    .select("source_urls, source_url_hashes, firms, category, event_date, latest_source_date")
    .eq("id", eventId)
    .single();
  if (!ev || ev.source_url_hashes.includes(hash)) return;
  const firms = [...ev.firms, firm];
  await db
    .from("events")
    .update({
      source_urls: [...ev.source_urls, url],
      source_url_hashes: [...ev.source_url_hashes, hash],
      firms,
      // Backfill arrives newest-first; the event dates from its earliest release.
      event_date: published < ev.event_date ? published : ev.event_date,
      latest_source_date: !ev.latest_source_date || published > ev.latest_source_date ? published : ev.latest_source_date,
      ...(ev.category === "investigation" ? { severity: investigationSeverity(new Set(firms).size) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);
}

async function openEvent(companyId: string, kind: "investigation" | "lawsuit_filed") {
  const investigation = kind === "investigation";
  const { data } = await db
    .from("events")
    .select("id")
    .eq("company_id", companyId)
    .eq("category", investigation ? "investigation" : "lawsuit")
    .eq("status", investigation ? "investigation" : "filed")
    .gte("event_date", daysAgo(investigation ? INVESTIGATION_WINDOW_DAYS : LAWSUIT_WINDOW_DAYS))
    .order("event_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function processItem(item: Item, knownFirms: string[], html?: string) {
  const firm = matchFirm(knownFirms, item.contributor, item.title, item.description);
  if (!firm) return { skipped: "no known firm" };

  // The ticker is often only in the body: page metadata can be truncated before it.
  const body = releaseText(html ?? (await fetchText(item.link!)));
  // If the metadata names exactly one ticker, that is the subject even when the
  // body mentions others (an acquirer, a peer); only then is it not a roundup.
  const inMeta = exchangeTickers(`${item.keywords.join(" ")}\n${item.title}`);
  const tickers =
    inMeta.length === 1 ? inMeta : exchangeTickers(`${item.keywords.join(" ")}\n${item.title}\n${item.description}\n${body}`);
  if (!tickers.length) return { skipped: "no exchange ticker" };
  const url = item.link!;
  const hash = (await urlHash(url))!;
  const published = isoDate(item.published);
  const hint = kindHint(`${item.title}\n${item.description}\n${body.slice(0, 2000)}`);

  // Roundups ("DEADLINE ALERT for FCEL, BBNX, DKS...") remind investors of
  // several existing cases. They join those events but never create one.
  if (tickers.length > 1) {
    const joined: string[] = [];
    for (const t of tickers) {
      const company = hint && (await findCompany(t.ticker));
      const existing = company && (await openEvent(company.id, hint!));
      if (existing) {
        await appendRelease(existing.id, url, hash, firm, published);
        joined.push(existing.id);
      }
    }
    return joined.length ? { event: joined[0], appended: true, roundup: joined.length } : { skipped: "roundup, no existing events" };
  }
  const listed = tickers[0];

  // Fast path: join an existing event without calling Claude.
  const known = await findCompany(listed.ticker);
  if (hint && known) {
    const existing = await openEvent(known.id, hint);
    if (existing) {
      await appendRelease(existing.id, url, hash, firm, published);
      return { event: existing.id, appended: true };
    }
  }

  const facts = await extractReleaseFacts(item.title, body || item.description);
  if (!facts || facts.kind === "other") return { skipped: `kind=${facts?.kind ?? "refused"}` };
  const company = await companyByTicker(listed.ticker, listed.exchange, facts.company_name);

  if (facts.kind === "investigation") {
    const open = await openEvent(company.id, "investigation");
    if (open) {
      await appendRelease(open.id, url, hash, firm, published);
      return { event: open.id, appended: true };
    }
    const { data: created, error } = await db
      .from("events")
      .insert({
        company_id: company.id,
        category: "investigation",
        status: "investigation",
        event_date: published,
        latest_source_date: published,
        severity: investigationSeverity(1),
        title: `Plaintiff firms investigate ${company.name}`,
        summary: `Law firms announced investigations of possible securities claims against ${company.name}${facts.alleged_conduct ? `, citing ${facts.alleged_conduct}` : ""}, according to their press releases.`,
        alleged_conduct: facts.alleged_conduct,
        source_urls: [url],
        source_url_hashes: [hash],
        firms: [firm],
        dedupe_key: `investigation:${listed.ticker}:${published}`,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { event: created.id, created: true };
  }

  // lawsuit_filed: one event per class period.
  const dedupe = `lawsuit:${listed.ticker}:${facts.class_period_start ?? "?"}:${facts.class_period_end ?? "?"}`;
  const { data: existing } = await db.from("events").select("id, lead_plaintiff_deadline").eq("dedupe_key", dedupe).maybeSingle();
  if (existing) {
    await appendRelease(existing.id, url, hash, firm, published);
    if (!existing.lead_plaintiff_deadline && facts.lead_plaintiff_deadline) {
      await db.from("events").update({ lead_plaintiff_deadline: facts.lead_plaintiff_deadline }).eq("id", existing.id);
    }
    return { event: existing.id, appended: true };
  }
  const period =
    facts.class_period_start && facts.class_period_end ? ` for investors who bought between ${facts.class_period_start} and ${facts.class_period_end}` : "";
  const { data: created, error } = await db
    .from("events")
    .insert({
      company_id: company.id,
      category: "lawsuit",
      status: "filed",
      event_date: published,
      latest_source_date: published,
      severity: "high",
      title: `Securities class action filed against ${company.name}`,
      summary: `Firm press releases report a securities class action filed${facts.court ? ` in ${facts.court}` : ""}${period}.`,
      alleged_conduct: facts.alleged_conduct,
      source_urls: [url],
      source_url_hashes: [hash],
      firms: [firm],
      class_period_start: facts.class_period_start,
      class_period_end: facts.class_period_end,
      lead_plaintiff_deadline: facts.lead_plaintiff_deadline,
      court: facts.court,
      dedupe_key: dedupe,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { event: created.id, created: true };
}

async function record(item: Item, knownFirms: string[], html?: string) {
  const { data: raw } = await db
    .from("raw_items")
    .insert({ source: SOURCE, source_id: item.id, url: item.link, payload: item })
    .select("id")
    .single();
  try {
    const r = await processItem(item, knownFirms, html);
    await db
      .from("raw_items")
      .update({ processed_at: new Date().toISOString(), event_id: r.event ?? null, error: r.skipped ?? null })
      .eq("id", raw!.id);
    return { id: item.id, ...r };
  } catch (err) {
    // processed_at stays null: the error is kept on the row for manual reprocessing.
    await db.from("raw_items").update({ error: String(err) }).eq("id", raw!.id);
    return { id: item.id, error: String(err) };
  }
}

async function live(knownFirms: string[]) {
  const all = new Map<string, Item>();
  for (const feed of FEEDS) {
    for (const item of parseGlobeNewswire(await fetchText(feed))) if (item.id) all.set(item.id, item);
  }
  const results = [];
  for (const item of (await unseen([...all.values()])).slice(0, MAX_NEW_PER_RUN)) results.push(await record(item, knownFirms));
  return { processed: results.length, results };
}

// One chunk of one search page. The caller advances offset until done.
async function backfill(knownFirms: string[], keyword: string, page: number, offset: number, limit: number) {
  const listing = parseGnwSearchPage(await fetchText(SEARCH(keyword, page)));
  const chunk = listing.slice(offset, offset + limit);
  const results = [];
  for (const entry of chunk) {
    if (!matchFirm(knownFirms, entry.contributor, entry.title)) {
      results.push({ link: entry.link, skipped: "no known firm" });
      continue;
    }
    const id = gnwReleaseId(entry.link);
    if (!(await unseen([{ id }])).length) {
      results.push({ id, skipped: "already ingested" });
      continue;
    }
    // Fast path: the title names the exchange ticker and the release joins an
    // open event, so append it from the listing without fetching the page.
    const listed = exchangeTicker(entry.title);
    const hint = kindHint(entry.title);
    const known = listed && hint ? await findCompany(listed.ticker) : null;
    const existing = known && hint ? await openEvent(known.id, hint) : null;
    if (existing) {
      const firm = matchFirm(knownFirms, entry.contributor, entry.title)!;
      await db.from("raw_items").insert({
        source: SOURCE,
        source_id: id,
        url: entry.link,
        payload: entry,
        processed_at: new Date().toISOString(),
        event_id: existing.id,
      });
      await appendRelease(existing.id, entry.link, (await urlHash(entry.link))!, firm, gnwReleaseDate(entry.link)!);
      results.push({ id, event: existing.id, appended: true, fast: true });
      continue;
    }
    const html = await fetchText(entry.link);
    results.push(await record(parseGnwRelease(html, entry.link), knownFirms, html));
  }
  const next = offset + limit;
  return { keyword, page, offset, listed: listing.length, done: next >= listing.length, next_offset: next, results };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const { data: firmRows } = await db.from("firms").select("name");
  const knownFirms = (firmRows ?? []).map((f) => f.name);

  if (body.mode === "backfill") {
    const { keyword = "class action", page = 1, offset = 0, limit = 25 } = body;
    return Response.json(await backfill(knownFirms, keyword, page, offset, limit));
  }
  return Response.json(await live(knownFirms));
});
