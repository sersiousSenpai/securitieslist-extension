// End-to-end check of the extension in Chromium, on the local demo pages.
// Setup once: npm i && npx playwright install chromium. Run: npm run e2e
// Screenshots land in tests/.shots/.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${REPO}extension`;
const OUT = fileURLToPath(new URL("./.shots/", import.meta.url));
await mkdir(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", "8000", "--bind", "127.0.0.1"], { cwd: REPO, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const errors = [];
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  sw.on("console", (m) => m.type() === "error" && errors.push("sw: " + m.text()));
  const id = new URL(sw.url()).host;
  console.log("extension id", id);
  await new Promise((r) => setTimeout(r, 1000)); // first index poll

  const badgeFor = (page) =>
    sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return { tabId: t.id, text: await chrome.action.getBadgeText({ tabId: t.id }) };
    }, page.url());

  async function popupFor(page, name, expand) {
    const { tabId } = await badgeFor(page);
    const pop = await ctx.newPage();
    pop.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
    pop.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await pop.setViewportSize({ width: 392, height: 600 });
    await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tabId}`);
    await pop.waitForFunction(() => !document.body.innerText.includes("Checking this page"));
    await pop.screenshot({ path: `${OUT}${name}-compact.png` });
    const compact = await pop.innerText("main");
    let expanded = null;
    if (expand && (await pop.$("text=View risk signals"))) {
      await pop.click("text=View risk signals");
      await pop.waitForTimeout(200);
      await pop.screenshot({ path: `${OUT}${name}-expanded.png`, fullPage: true });
      expanded = await pop.innerText("main");
    }
    await pop.close();
    return { compact, expanded };
  }

  // 1. Wire release: badge set automatically by the content script, "1 of 37" by URL.
  const wire = await ctx.newPage();
  await wire.goto("http://localhost:8000/demo/wire/nvlx-rosen-law-firm.html");
  await wire.waitForTimeout(800);
  console.log("wire badge", await badgeFor(wire));
  const w = await popupFor(wire, "wire", true);
  console.log("--- wire compact\n" + w.compact);
  console.log("--- wire expanded\n" + w.expanded);

  // 2. Syndicated copy: no auto badge (not a wire host), "1 of 37" by text on popup scan.
  const synd = await ctx.newPage();
  await synd.goto("http://localhost:8000/demo/syndicated/nvlx-benzinga-copy.html");
  await synd.waitForTimeout(500);
  console.log("syndicated badge", await badgeFor(synd));
  console.log("--- syndicated compact\n" + (await popupFor(synd, "syndicated", false)).compact);

  // 3. News article: exchange ticker + a company-name match for a second ticker.
  const art = await ctx.newPage();
  await art.goto("http://localhost:8000/demo/article.html");
  const a = await popupFor(art, "article", true);
  console.log("--- article compact\n" + a.compact);
  console.log("--- article expanded (first 400)\n" + a.expanded.slice(0, 400));

  // 4. Tier-1 URL: Yahoo quote page (URL only; page content irrelevant).
  await ctx.route("https://finance.yahoo.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>QRBT quote</title><h1>stub</h1>" }));
  const yahoo = await ctx.newPage();
  await yahoo.goto("https://finance.yahoo.com/quote/QRBT/");
  await yahoo.waitForTimeout(800);
  console.log("yahoo badge", await badgeFor(yahoo));

  // 5. Unflagged page.
  const clean = await ctx.newPage();
  await clean.goto("http://localhost:8000/demo/short-report-qrbt.html");
  console.log("--- clean\n" + (await popupFor(clean, "clean", false)).compact);

  // 6. Portfolio: manual add, then render the tab.
  await sw.evaluate(() => chrome.storage.local.set({ portfolio: { robinhood: ["AAPL", "QRBT"], manual: ["NVLX"], robinhoodUpdatedAt: Date.now() - 300000 } }));
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 392, height: 600 });
  const { tabId } = await badgeFor(clean);
  await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tabId}`);
  await pop.click("text=My Portfolio");
  await pop.waitForTimeout(200);
  await pop.screenshot({ path: `${OUT}portfolio.png` });
  console.log("--- portfolio\n" + (await pop.innerText("main")));

  // 7. Dark mode render of the wire popup.
  const dark = await ctx.newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.setViewportSize({ width: 392, height: 600 });
  const wt = (await badgeFor(wire)).tabId;
  await dark.goto(`chrome-extension://${id}/popup/popup.html?tabId=${wt}`);
  await dark.click("text=View risk signals");
  await dark.waitForTimeout(200);
  await dark.screenshot({ path: `${OUT}wire-expanded-dark.png` });

  console.log("errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
} finally {
  await ctx.close();
  server.kill();
}
