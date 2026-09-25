// Popup. Works out which flagged stock the current tab is about, then shows
// the compact alert, the expanded signal view and the My Portfolio tab.
//
// Detection order: Tier-1 URL pattern, then a wire-page scan the service
// worker already stored, then a Tier-2 scan of the page. Opening the popup by
// clicking the icon grants activeTab, which is what lets that scan run.

import { tickerFromUrl } from "../src/sites.js";
import { getIndex, fetchEvents } from "../src/data.js";
import { indexByTicker, matchScan, nameList } from "../src/match.js";

const CATEGORIES = [
  ["enforcement", "SEC enforcement"],
  ["filing", "SEC filings (red flags)"],
  ["short_report", "Short reports"],
  ["investigation", "Securities lawsuit investigations"],
  ["lawsuit", "Securities lawsuits filed"],
  ["news", "News"],
];
const METHOD_LABEL = {
  url: "Detected from this page's address",
  release: "This page is a law-firm release about this investigation",
  exchange: "Found an exchange ticker on this page",
  cashtag: "Found a cashtag on this page",
  name: "Found the company name on this page",
};
const CLOSED = new Set(["dismissed", "settled", "closed"]);

const app = document.getElementById("app");

// ---------- DOM helper (textContent only; feed data is never parsed as HTML)

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDate = (d) =>
  d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
function daysUntil(d) {
  const ms = new Date(d + "T00:00:00") - new Date(new Date().toDateString());
  return Math.round(ms / 86400000);
}
function agoText(ts) {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

// ---------- Detection

async function scanTab(tab, index) {
  if (!/^(https?|file):/.test(tab.url ?? "")) return { unscannable: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/scanner.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => globalThis.SLScan(opts),
      args: [{ names: nameList(index), firms: index.firms }],
    });
    return { match: await matchScan(result, index) };
  } catch {
    return { unscannable: true };
  }
}

async function detect(tab, index) {
  const urlTicker = tab.url && tickerFromUrl(tab.url);
  if (urlTicker) {
    const flagged = indexByTicker(index).has(urlTicker);
    return flagged
      ? { primary: { ticker: urlTicker, method: "url" }, matches: [{ ticker: urlTicker, method: "url" }] }
      : { cleanTicker: urlTicker };
  }
  const key = `tab:${tab.id}`;
  const stored = (await chrome.storage.session.get(key))[key];
  if (stored && stored.url === tab.url && stored.primary) return stored;
  const { match, unscannable } = await scanTab(tab, index);
  if (match) return match;
  return { unscannable };
}

// ---------- State

const state = {
  index: null,
  tab: null,
  detection: null,
  ticker: null, // ticker currently displayed
  expanded: false,
  view: "signals",
  events: new Map(),
};

async function eventsFor(ticker) {
  if (!state.events.has(ticker)) state.events.set(ticker, await fetchEvents(ticker));
  return state.events.get(ticker);
}

function matchFor(ticker) {
  return state.detection?.matches?.find((m) => m.ticker === ticker) ?? null;
}

// ---------- Rendering

const STATUS_LABEL = {
  lawsuit: "Class action",
  investigation: "Investigation",
  enforcement: "SEC action",
  short_report: "Short report",
  filing: "Filing flag",
  news: "In the news",
};

// Small inline chevron, the one icon the popup uses.
function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 4.5 6 8l3.5-3.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

// Header pill label: the most serious open category, in CATEGORIES order.
function statusLabel(entry, events) {
  const open = events.filter((e) => !CLOSED.has(e.status));
  for (const cat of ["lawsuit", "investigation", "enforcement", "short_report", "filing", "news"]) {
    if (open.some((e) => e.category === cat)) return STATUS_LABEL[cat];
  }
  return entry.investigations?.length ? STATUS_LABEL.investigation : `${entry.count} signal${entry.count === 1 ? "" : "s"}`;
}

async function render() {
  const entry = state.ticker && indexByTicker(state.index).get(state.ticker);
  const events = entry ? await eventsFor(entry.ticker) : [];
  const parts = [header(entry, events)];

  if (entry && !state.expanded) {
    parts.push(h("div", { class: "scroll" }, compactAlert(entry)));
  } else {
    parts.push(tabs());
    const body = h("div", { class: "scroll" });
    if (state.view === "portfolio") body.append(await portfolioView());
    else if (entry) body.append(signalsView(entry, events));
    else body.append(emptyView());
    parts.push(body);
  }
  parts.push(await footer());
  app.replaceChildren(...parts);
}

function header(entry, events) {
  if (!entry) {
    return h(
      "div",
      { class: "head" },
      h("span", { class: `dot ${state.detection?.cleanTicker ? "clear" : "none"}`, "aria-hidden": "true" }),
      h("div", { class: "brand" }, "Securities List"),
    );
  }
  const toggle = () => {
    state.expanded = !state.expanded;
    render();
  };
  return h(
    "div",
    { class: "head toggle", onclick: toggle },
    h("span", { class: `dot ${entry.max_severity}`, "aria-hidden": "true" }),
    h("div", { class: "ticker" }, entry.ticker),
    h("div", { class: "company" }, entry.company),
    h("span", { class: `status ${entry.max_severity}` }, statusLabel(entry, events)),
    h(
      "button",
      {
        class: "chev",
        "aria-expanded": String(state.expanded),
        "aria-label": state.expanded ? "Collapse" : "Expand",
        onclick: (ev) => {
          ev.stopPropagation();
          toggle();
        },
      },
      chevron(),
    ),
  );
}

function lede(eyebrow, headline, sub, hot) {
  return h(
    "div",
    { class: "lede" },
    eyebrow ? h("div", { class: `eyebrow${hot ? " hot" : ""}` }, eyebrow) : null,
    h("div", { class: "headline" }, headline),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

function compactAlert(entry) {
  const m = matchFor(entry.ticker);
  const release = m?.release;
  return h(
    "div",
    { class: "stack" },
    release
      ? lede("This page", `This is 1 of ${release.release_count} releases about this investigation`, METHOD_LABEL[m.method], true)
      : lede(null, `${entry.count} risk signal${entry.count === 1 ? "" : "s"} on this stock`, METHOD_LABEL[m?.method] ?? ""),
    h(
      "button",
      {
        class: "btn",
        onclick: () => {
          state.expanded = true;
          render();
        },
      },
      "View risk signals",
    ),
  );
}

function tabs() {
  const tab = (id, label) =>
    h(
      "button",
      {
        class: "tab",
        role: "tab",
        "aria-selected": String(state.view === id),
        onclick: () => {
          state.view = id;
          render();
        },
      },
      label,
    );
  return h(
    "div",
    { class: "seg-wrap" },
    h("div", { class: "seg", role: "tablist", "data-view": state.view }, tab("signals", "Signals"), tab("portfolio", "My Portfolio")),
  );
}

function emptyView() {
  const d = state.detection ?? {};
  let msg = "No flagged stock found on this page.";
  if (d.cleanTicker) msg = `No risk signals on ${d.cleanTicker}.`;
  else if (d.unscannable) msg = "This page can't be scanned.";
  return h(
    "div",
    { class: "stack" },
    lede(
      null,
      msg,
      "Securities List checks finance sites automatically. On other pages it looks for exchange tickers like (NASDAQ: XYZ), cashtags and flagged company names, only when you click the icon.",
    ),
  );
}

function signalsView(entry, events) {
  const out = [];

  const others = (state.detection?.matches ?? []).filter((m) => m.ticker !== entry.ticker);
  if (others.length) {
    out.push(
      h(
        "div",
        { class: "others" },
        h("span", { class: "muted small" }, "Also on this page"),
        others.map((m) =>
          h(
            "button",
            {
              class: "chip",
              onclick: () => {
                state.ticker = m.ticker;
                render();
              },
            },
            m.ticker,
          ),
        ),
      ),
    );
  }

  const investigations = events.filter((e) => e.category === "investigation" && !CLOSED.has(e.status));
  const lawsuit = events.find((e) => e.category === "lawsuit" && !CLOSED.has(e.status));
  for (const inv of investigations) out.push(...floodBlock(entry, inv, lawsuit));
  if (!investigations.length) {
    const m = matchFor(entry.ticker);
    out.push(lede(null, `${entry.count} risk signal${entry.count === 1 ? "" : "s"} on this stock`, METHOD_LABEL[m?.method] ?? ""));
  }

  const carded = new Set(investigations.map((e) => e.id));
  for (const [cat, label] of CATEGORIES) {
    const items = events.filter((e) => e.category === cat && !carded.has(e.id));
    if (!items.length) continue;
    out.push(h("div", { class: "eyebrow section-title" }, label), ...items.map(eventItem));
  }
  return h("div", { class: "stack" }, out);
}

// The consolidated view of an investigation's press-release flood.
function floodBlock(entry, inv, lawsuit) {
  const m = matchFor(entry.ticker);
  const onThisPage = m?.release?.event_id === inv.id;
  const n = inv.source_urls.length;
  const firms = inv.firms.length || n;

  const status = lawsuit
    ? `A class action has been filed${lawsuit.court ? ` in ${lawsuit.court.replace(/\.$/, "")}` : ""}.`
    : "No lawsuit has been filed. This is an announced investigation only.";
  const out = [
    lede(
      onThisPage ? "This page" : `${n} releases · one investigation`,
      onThisPage ? `This is 1 of ${n} releases about this investigation` : inv.title,
      `${status} ${firms} firm${firms === 1 ? " has" : "s have"} published near-identical announcements. Here is what they say, once.`,
      onThisPage,
    ),
    h(
      "div",
      { class: "card stats" },
      stat("Releases", n),
      stat("Firms", firms),
      stat("Suit filed", lawsuit ? "Yes" : "No", true),
    ),
  ];

  if (inv.alleged_conduct) {
    out.push(
      h("div", { class: "card pad-card" }, h("div", { class: "label" }, "Alleged"), h("div", { class: "body-text" }, inv.alleged_conduct)),
    );
  }

  const steps = [{ title: "Investigation announced", date: fmtDate(inv.event_date), done: true }];
  if (lawsuit) {
    const where = [lawsuit.court, lawsuit.case_number].filter(Boolean).join(" · ");
    const period = lawsuit.class_period_start
      ? `Class period ${fmtDate(lawsuit.class_period_start)} – ${fmtDate(lawsuit.class_period_end)}`
      : null;
    steps.push({ title: "Class action filed", date: fmtDate(lawsuit.event_date), done: true, note: [where, period] });
    if (lawsuit.lead_plaintiff_deadline) {
      const days = daysUntil(lawsuit.lead_plaintiff_deadline);
      steps.push({
        title: "Lead-plaintiff deadline",
        date: fmtDate(lawsuit.lead_plaintiff_deadline),
        done: days < 0,
        urgent: days >= 0,
        note: days >= 0 ? `${days} day${days === 1 ? "" : "s"} left` : "Passed",
      });
    }
  } else {
    steps.push({ title: "Class action filed", date: "Pending", done: false });
  }
  out.push(h("div", { class: "card timeline" }, steps.map(step)));

  out.push(
    h(
      "details",
      { class: "card" },
      h("summary", null, h("span", null, "All releases ", h("span", { class: "n" }, `· ${n}`)), chevron()),
      h(
        "ul",
        { class: "release-list" },
        inv.source_urls.map((u, i) => h("li", null, link(u, inv.firms[i] ?? hostOf(u)), h("span", { class: "host" }, hostOf(u)))),
      ),
    ),
  );
  return out;
}

function stat(label, value, word) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: `v${word ? " word" : ""}` }, value));
}

function step({ title, date, done, urgent, note }) {
  return h(
    "div",
    { class: "step" },
    h("div", { class: "rail" }, h("span", { class: `node${urgent ? " high" : done ? "" : " todo"}` }), h("span", { class: "stem" })),
    h(
      "div",
      { class: "what" },
      h(
        "div",
        { class: "row1" },
        h("span", { class: `t${done || urgent ? "" : " todo-t"}` }, title),
        h("span", { class: `d${done || urgent ? "" : " pending"}` }, date),
      ),
      [note].flat().filter(Boolean).map((n) => h("div", { class: "note" }, n)),
    ),
  );
}

function eventItem(e) {
  return h(
    "div",
    { class: "card signal" },
    h(
      "div",
      { class: "meta" },
      h("span", { class: "date" }, fmtDate(e.event_date)),
      h("span", { class: `tag ${e.severity}` }, e.severity),
      CLOSED.has(e.status) ? h("span", { class: "tag closed" }, e.status) : null,
    ),
    h("div", { class: "title" }, e.title),
    h("p", null, e.summary),
    e.category === "lawsuit" && e.lead_plaintiff_deadline
      ? h("p", { class: "small muted" }, `Lead-plaintiff deadline: ${fmtDate(e.lead_plaintiff_deadline)}`)
      : null,
    h(
      "div",
      { class: "links" },
      e.source_urls.slice(0, e.category === "investigation" ? 1 : 3).map((u, i) => [i ? " · " : "", link(u, hostOf(u))]),
    ),
  );
}

async function portfolioView() {
  const { portfolio = { robinhood: [], manual: [] } } = await chrome.storage.local.get("portfolio");
  const manual = new Set(portfolio.manual ?? []);
  const held = [...new Set([...(portfolio.robinhood ?? []), ...manual])];
  const byTicker = indexByTicker(state.index);
  const rank = { high: 3, medium: 2, low: 1 };
  held.sort((a, b) => (rank[byTicker.get(b)?.max_severity] ?? 0) - (rank[byTicker.get(a)?.max_severity] ?? 0) || a.localeCompare(b));

  const wrap = h("div", { class: "stack" });
  if (!held.length) {
    wrap.append(
      lede(
        null,
        "No holdings yet",
        "Open your Robinhood positions page (robinhood.com/account/investing) to import tickers, or add them below. Only ticker symbols are stored, on this device.",
      ),
    );
  }
  for (const t of held) {
    const entry = byTicker.get(t);
    const open = () => {
      state.ticker = t;
      state.view = "signals";
      state.expanded = true;
      render();
    };
    const source = manual.has(t) ? "Added by you" : "Robinhood";
    wrap.append(
      h(
        "div",
        entry
          ? {
              class: "card holding flagged",
              role: "button",
              tabindex: "0",
              "aria-label": `${t}: ${entry.count} signal${entry.count === 1 ? "" : "s"}`,
              onclick: open,
              onkeydown: (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), open()),
            }
          : { class: "card holding" },
        h("span", { class: `dot ${entry?.max_severity ?? "clear"}`, "aria-hidden": "true" }),
        h(
          "div",
          { class: "who" },
          h("div", { class: "tk" }, t),
          h("div", { class: "nm" }, entry ? entry.company : source),
        ),
        h("div", { class: "st" }, entry ? `${entry.count} signal${entry.count === 1 ? "" : "s"}` : "No signals"),
        manual.has(t)
          ? h(
              "button",
              {
                class: "x",
                title: `Remove ${t}`,
                "aria-label": `Remove ${t}`,
                onclick: (ev) => {
                  ev.stopPropagation();
                  editManual(t, false);
                },
              },
              "×",
            )
          : null,
      ),
    );
  }
  if (portfolio.robinhoodUpdatedAt) {
    wrap.append(h("p", { class: "src", style: "padding:0 4px" }, `Robinhood holdings read ${agoText(portfolio.robinhoodUpdatedAt)}.`));
  }
  const input = h("input", { name: "t", placeholder: "Add ticker, e.g. NVLX", maxlength: "6", autocomplete: "off", "aria-label": "Ticker" });
  wrap.append(
    h(
      "form",
      {
        class: "add",
        onsubmit: (ev) => {
          ev.preventDefault();
          const t = input.value.trim().toUpperCase();
          if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) editManual(t, true);
        },
      },
      input,
      h("button", { class: "btn ghost", type: "submit" }, "Add"),
    ),
  );
  return wrap;
}

async function editManual(ticker, add) {
  const { portfolio = { robinhood: [], manual: [] } } = await chrome.storage.local.get("portfolio");
  const manual = new Set(portfolio.manual ?? []);
  add ? manual.add(ticker) : manual.delete(ticker);
  portfolio.manual = [...manual].sort();
  await chrome.storage.local.set({ portfolio });
  render();
}

async function footer() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const auto = h("input", {
    type: "checkbox",
    checked: settings.autoOpen !== false,
    onchange: async (ev) => {
      await chrome.storage.local.set({ settings: { ...settings, autoOpen: ev.target.checked } });
    },
  });
  return h(
    "footer",
    null,
    h(
      "div",
      { class: "line" },
      h("span", null, `Updated ${agoText(state.index.fetchedAt)}`),
      state.index.demo ? h("span", { class: "demo", title: "Fictional demo data" }, "DEMO DATA") : null,
    ),
    h(
      "div",
      { class: "line" },
      h("label", { class: "switch-row" }, auto, h("span", { class: "switch", "aria-hidden": "true" }), "Auto-open on finance sites"),
      h("span", { class: "fine" }, "Not investment advice"),
    ),
  );
}

// ---------- Boot

(async () => {
  try {
    // ?tabId= lets automated tests open popup.html as a page aimed at a given tab.
    const testTab = new URLSearchParams(location.search).get("tabId");
    const [tab] = testTab
      ? [await chrome.tabs.get(Number(testTab))]
      : await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab;
    state.index = await getIndex();
    state.detection = await detect(tab, state.index);
    state.ticker = state.detection?.primary?.ticker ?? null;
    await render();
  } catch (err) {
    console.error("[SecuritiesList]", err);
    app.replaceChildren(h("p", { class: "pad" }, "Something went wrong loading risk signals. Try again in a minute."));
  }
})();
