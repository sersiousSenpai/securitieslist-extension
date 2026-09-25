// Feed parsing for the ingestors. Plain JS with no dependencies so the Deno
// edge functions and the Node tests (tests/feeds.test.js) share it.
// The feeds are machine-generated with a stable shape, so a small tag reader
// is enough; no general XML parser needed.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function unwrap(s) {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
}

function tagAll(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => unwrap(m[1]).trim());
}
const tag = (xml, t) => tagAll(xml, t)[0] ?? null;

export function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// ---------- GlobeNewswire RSS

export function parseGlobeNewswire(xml) {
  return tagAll(xml, "item").map((item) => ({
    id: tag(item, "dc:identifier"),
    link: tag(item, "link"),
    title: tag(item, "title") ?? "",
    description: stripTags(tag(item, "description") ?? ""),
    contributor: tag(item, "dc:contributor"),
    keywords: tagAll(item, "dc:keyword"),
    subjects: tagAll(item, "dc:subject"),
    published: tag(item, "pubDate"),
  }));
}

// ---------- Tickers and firms in release text

const EXCHANGE_RE =
  /\b(NASDAQ|Nasdaq|NYSE American|NYSE Arca|NYSE|OTC(?:QX|QB)?|Cboe)(?:\s?(?:GS|GM|CM))?\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/;

export function exchangeTicker(...texts) {
  for (const t of texts) {
    const m = t && t.match(EXCHANGE_RE);
    if (m) return { exchange: m[1].toUpperCase().startsWith("NASDAQ") ? "NASDAQ" : m[1].toUpperCase(), ticker: m[2] };
  }
  return null;
}

// Every distinct listed ticker in the text, in order of first mention. More
// than one usually means a roundup release covering several companies.
export function exchangeTickers(text) {
  const seen = new Map();
  for (const m of (text ?? "").matchAll(new RegExp(EXCHANGE_RE.source, "g"))) {
    if (!seen.has(m[2])) seen.set(m[2], { exchange: m[1].toUpperCase().startsWith("NASDAQ") ? "NASDAQ" : m[1].toUpperCase(), ticker: m[2] });
  }
  return [...seen.values()];
}

// Known firm names are short forms ("Rosen Law Firm"); releases and the
// contributor field use longer ones ("The Rosen Law Firm PA"). Substring match.
export function matchFirm(firms, ...texts) {
  const hay = texts.filter(Boolean).join("\n");
  return firms.find((f) => hay.includes(f)) ?? null;
}

// Main text of a GlobeNewswire release page, from the dateline on.
export function releaseText(html, maxChars = 8000) {
  const text = stripTags(html);
  const start = text.search(/\((GLOBE NEWSWIRE|PR NEWSWIRE|BUSINESS WIRE|ACCESSWIRE)\)/i);
  return text.slice(Math.max(0, start - 120), Math.max(0, start - 120) + maxChars);
}

// ---------- EDGAR latest-filings Atom

export const RED_FLAG_ITEMS = {
  "4.01": { label: "Change in certifying accountant", severity: "medium" },
  "4.02": { label: "Prior financial statements should no longer be relied upon", severity: "high" },
};

export function parseEdgarAtom(xml) {
  return tagAll(xml, "entry").map((entry) => {
    const title = tag(entry, "title") ?? "";
    const summary = stripTags(tag(entry, "summary") ?? "");
    const tm = title.match(/^(\S+)\s+-\s+(.*?)\s+\((\d{10})\)\s+\((\w+)\)$/);
    return {
      accession: (tag(entry, "id") ?? "").replace(/^.*accession-number=/, ""),
      form: tm ? tm[1] : null,
      company: tm ? tm[2] : null,
      cik: tm ? tm[3] : null,
      role: tm ? tm[4] : null,
      link: (entry.match(/<link[^>]*href="([^"]+)"/) ?? [])[1] ?? null,
      filed: (summary.match(/Filed:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null,
      items: [...summary.matchAll(/Item (\d+\.\d+)/g)].map((m) => m[1]),
      updated: tag(entry, "updated"),
    };
  });
}

// ---------- GlobeNewswire search pages and release pages (backfill)

// Search results: one { link, title, contributor } per release, newest first.
export function parseGnwSearchPage(html, base = "https://www.globenewswire.com") {
  const out = [];
  const re = /class="sourceLink">([^<]*)<\/a>[\s\S]*?<div class="mainLink">\s*<a href="(\/news-release\/[^"]+)">([^<]*)<\/a>/g;
  for (const m of html.matchAll(re)) {
    out.push({ contributor: decodeEntities(m[1]).trim(), link: base + m[2], title: decodeEntities(m[3]).trim() });
  }
  return out;
}

const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`));
  return m ? decodeEntities(m[1]).trim() : null;
};

// Release id and publication date are both in the URL path:
// /news-release/2026/09/25/3368832/673/en/...
const GNW_PATH = /\/news-release\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)\//;
export const gnwReleaseId = (link) => (link.match(GNW_PATH) ?? [])[4] ?? null;
export function gnwReleaseDate(link) {
  const m = link.match(GNW_PATH);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// A release page, in the same shape parseGlobeNewswire gives RSS items.
export function parseGnwRelease(html, link) {
  const id = gnwReleaseId(link);
  const published = (html.match(/"datePublished":"([^"]+)"/) ?? [])[1] ?? null;
  return {
    id,
    link,
    title: meta(html, "og:title") ?? "",
    description: meta(html, "description") ?? "",
    contributor: meta(html, "author"),
    keywords: (meta(html, "keywords") ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    subjects: [],
    published,
  };
}

// Cheap pre-classification, used only to decide whether a release can join
// an existing event without a Claude call. Claude decides for new events.
export function kindHint(text) {
  if (/class action (lawsuit )?(has been |was )?filed|filed an? (securities )?class action|lead plaintiff deadline|deadline to (seek|move for) (appointment as )?lead plaintiff/i.test(text)) {
    return "lawsuit_filed";
  }
  if (/investigat/i.test(text)) return "investigation";
  return null;
}

// ---------- SEC enforcement RSS (litigation releases, administrative proceedings)

export function parseSecRss(xml) {
  return tagAll(xml, "item").map((item) => ({
    id: tag(item, "dc:creator") ?? tag(item, "guid"),
    link: (tag(item, "link") ?? "").trim(),
    title: tag(item, "title") ?? "",
    published: tag(item, "pubDate"),
  }));
}

// ---------- EDGAR full-text search hits (backfill)

// display_names look like "Netcapital Inc.  (NCPL, NCPLW)  (CIK 0001414767)".
export function parseEftsHits(json) {
  return (json.hits?.hits ?? []).map(({ _source: s }) => {
    const name = s.display_names?.[0] ?? "";
    const m = name.match(/^(.*?)\s+\(([^)]*)\)\s+\(CIK (\d{10})\)$/);
    const tickers = m && !m[2].startsWith("CIK") ? m[2].split(",").map((t) => t.trim()) : [];
    const cik = m ? m[3] : (s.ciks?.[0] ?? null);
    return {
      accession: s.adsh,
      form: s.form,
      company: m ? m[1].trim() : name,
      cik,
      ticker: tickers[0] ?? null,
      filed: s.file_date,
      items: s.items ?? [],
      link: cik ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${s.adsh.replaceAll("-", "")}/${s.adsh}-index.htm` : null,
    };
  });
}
