/* Visual-design regression through the real preview flow; all requests are local fixtures. */
const { chromium, webkit } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const assets = path.join(root, "app", "miniapp_static");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8").replaceAll("__APP_VERSION__", version);

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
  assert.ok(["chromium", "webkit"].includes(engine), "Unsupported browser engine");
  const browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true, ...(engine === "chromium" && process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    for (const [width, dark] of [[320, false], [390, false], [390, true], [430, false]]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname === "telegram.org") return route.fulfill({ body: "", contentType: "text/javascript" });
        if (url.pathname.startsWith("/miniapp/static/")) {
          const file = path.join(assets, path.basename(url.pathname));
          return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
        }
        return route.fulfill({ body: html, contentType: "text/html" });
      });
      await page.clock.install({ time: new Date("2026-10-26T10:00:00Z") });
      await page.goto("http://polyrental.test/miniapp?preview=1");
      await page.locator('[data-date="2026-10-30"]').tap();
      await page.locator('[data-date="2026-11-02"]').tap();
      await page.locator("#start-time").fill("10:00");
      await page.locator("#end-time").fill("16:00");
      if (process.env.QA_SCREENSHOTS && width === 390 && !dark) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, "dates.png") });
      }
      await page.locator("#main-button").tap();
      await page.locator(".item-card").first().waitFor();
      assert.equal(await page.locator(".item-card summary").count(), 0, "catalog cards do not add a details control absent from the design");
      assert.equal(await page.locator("#items-status").isHidden(), true, "successful availability does not add a redundant banner");
      assert.equal(await page.locator("#change-dates").isVisible(), true);
      assert.ok(await page.locator("#change-dates").evaluate(n => n.getBoundingClientRect().height >= 44));
      await page.locator("#change-dates").tap();
      assert.equal(await page.locator("#start-date").inputValue(), "2026-10-30");
      await page.locator("#main-button").tap();
      await page.locator(".item-card .plus").first().tap();
      assert.equal(await page.locator("#selected-count").innerText(), "1");
      const dimensions = await page.locator(".item-card .quantity-control .button").first().evaluate(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height }));
      assert.ok(dimensions.width >= 44 && dimensions.height >= 44, JSON.stringify(dimensions));
      if (process.env.QA_SCREENSHOTS && width === 390 && !dark) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, "catalog.png"), fullPage: true });
      }
      await page.locator("#main-button").tap();
      await page.locator("#customer-name").fill("Анна");
      await page.locator("#customer-contact").fill("@anna_example");
      assert.equal(await page.locator(".contact-card #customer-name").count(), 1);
      if (process.env.QA_SCREENSHOTS && width === 390 && !dark) await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, "contact.png"), fullPage: true });
      await page.locator("#main-button").tap();
      assert.match(await page.locator("#review-content").innerText(), /Анна/);
      assert.match(await page.locator("#review-content").innerText(), /@anna_example/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`Design flow (${engine}): 4 mobile viewport/theme cases passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
