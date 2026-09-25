// Service worker. Tier-1 detection from tab URLs, badge updates, the one-
// minute index poll, and new-event notifications for held tickers.
// Tier-2 (any page) scans run from the popup, not here: with a popup set,
// chrome.action.onClicked never fires.

import { tickerFromUrl } from "./sites.js";
import { getIndex, refreshIndex } from "./data.js";
import { indexByTicker, matchScan } from "./match.js";

const SEVERITY_COLOR = { high: "#D93025", medium: "#E37400", low: "#80868B" };
const POLL_MINUTES = 10; // the full index is ~250 KB; event detail is always fetched live

const stateKey = (tabId) => `tab:${tabId}`;

async function setTabState(tabId, state) {
  if (state) await chrome.storage.session.set({ [stateKey(tabId)]: state });
  else await chrome.storage.session.remove(stateKey(tabId));
}

async function setBadge(tabId, entry) {
  await chrome.action.setBadgeText({ tabId, text: entry ? String(entry.count) : "" });
  if (entry) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: SEVERITY_COLOR[entry.max_severity] });
    await chrome.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" });
  }
}

async function maybeAutoOpen(tab) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (settings.autoOpen === false || !tab.active) return;
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch {
    // Window not focused, or openPopup unavailable. The badge still shows.
  }
}

async function evaluateUrl(tab) {
  const ticker = tab.url && tickerFromUrl(tab.url);
  const index = await getIndex();
  const entry = ticker && indexByTicker(index).get(ticker);
  if (!entry) {
    await setTabState(tab.id, null);
    await setBadge(tab.id, null);
    return;
  }
  await setTabState(tab.id, { url: tab.url, tier: 1, ticker, method: "url", matches: [{ ticker, method: "url" }] });
  await setBadge(tab.id, entry);
  await maybeAutoOpen(tab);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) evaluateUrl(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => setTabState(tabId, null));

async function handleWireScan(tabId, scan) {
  const result = await matchScan(scan, await getIndex());
  if (!result) return;
  const entry = indexByTicker(await getIndex()).get(result.primary.ticker);
  await setTabState(tabId, { url: scan.url, tier: 1, ticker: result.primary.ticker, ...result });
  await setBadge(tabId, entry);
}

async function handlePortfolio(tickers) {
  const { portfolio = { robinhood: [], manual: [] } } = await chrome.storage.local.get("portfolio");
  portfolio.robinhood = [...new Set(tickers)].sort();
  portfolio.robinhoodUpdatedAt = Date.now();
  await chrome.storage.local.set({ portfolio });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "wire-scan" && sender.tab) handleWireScan(sender.tab.id, msg.scan);
  if (msg?.type === "portfolio" && Array.isArray(msg.tickers)) handlePortfolio(msg.tickers);
});

// Notify only when a held ticker gains a signal or first becomes flagged.
async function notifyHeldChanges(index) {
  const { portfolio = {}, seen } = await chrome.storage.local.get(["portfolio", "seen"]);
  const held = new Set([...(portfolio.robinhood ?? []), ...(portfolio.manual ?? [])]);
  const current = Object.fromEntries(index.tickers.map((t) => [t.ticker, t.count]));
  if (seen) {
    for (const t of index.tickers) {
      if (!held.has(t.ticker) || (seen[t.ticker] ?? 0) >= t.count) continue;
      chrome.notifications.create(`sl:${t.ticker}:${t.updated_at}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: `New risk signal: ${t.ticker} (in your portfolio)`,
        message: `${t.company} now has ${t.count} active signal${t.count === 1 ? "" : "s"}.`,
      });
    }
  }
  await chrome.storage.local.set({ seen: current });
}

async function poll() {
  try {
    await notifyHeldChanges(await refreshIndex());
  } catch (err) {
    console.warn("[SecuritiesList] index refresh failed", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: POLL_MINUTES });
  poll();
});
chrome.runtime.onStartup.addListener(poll);
chrome.alarms.onAlarm.addListener((a) => a.name === "poll" && poll());

chrome.notifications.onClicked.addListener(() => chrome.action.openPopup().catch(() => {}));
