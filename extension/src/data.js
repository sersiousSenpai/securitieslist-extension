// Feed access. The only two requests the extension ever makes:
//   1. the whole flagged index (no parameters), polled every minute
//   2. event detail for one ticker, when the popup shows it
// Neither carries a page URL or anything about the user's browsing.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

const LIVE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    // apikey alone works for both legacy anon JWTs and new sb_publishable_ keys.
    headers: { apikey: SUPABASE_ANON_KEY },
  });
  if (!res.ok) throw new Error(`feed ${res.status}: ${path}`);
  return res.json();
}

// PostgREST caps each response (1000 rows by default), so page until a short page.
async function restAll(path, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await rest(`${path}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function bundled(file) {
  const res = await fetch(chrome.runtime.getURL(`data/${file}`));
  return res.json();
}

export async function fetchIndex() {
  if (!LIVE) return { ...(await bundled("seed-index.json")), source: "seed" };
  const [tickers, firms] = await Promise.all([restAll("flagged_index?select=*&order=ticker"), rest("firms?select=name")]);
  return { demo: false, firms: firms.map((f) => f.name), tickers, source: "live" };
}

export async function fetchEvents(ticker) {
  if (!LIVE) return (await bundled("seed-events.json")).filter((e) => e.ticker === ticker);
  return rest(`events_by_ticker?ticker=eq.${encodeURIComponent(ticker)}&order=event_date.desc`);
}

// Cached index in chrome.storage.local, refreshed by the background alarm.
export async function getIndex() {
  const { index } = await chrome.storage.local.get("index");
  if (index) return index;
  return refreshIndex();
}

export async function refreshIndex() {
  const data = await fetchIndex();
  const index = { ...data, fetchedAt: Date.now() };
  await chrome.storage.local.set({ index });
  return index;
}
