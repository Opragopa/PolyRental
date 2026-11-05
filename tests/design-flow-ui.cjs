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
      await page.locator(".item-card").first().waitFor();
      assert.equal(await page.locator(".item-card summary").count(), await page.locator(".item-card").count());
      assert.equal(await page.locator("#items-status").isHidden(), true);
      await page.locator(".item-card .plus").first().tap();
      assert.equal(await page.locator("#selected-count").innerText(), "1");
      const dimensions = await page.locator(".item-card .quantity-control .button").first().evaluate(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height }));
      // WebKit can report 44 CSS px as 43.999969 after a transform.
      const layoutEpsilon = 0.001;
      assert.ok(dimensions.width >= 44 - layoutEpsilon && dimensions.height >= 44 - layoutEpsilon, JSON.stringify(dimensions));
      await page.locator("#main-button").tap();
      await page.locator("#customer-name").fill("Анна");
      await page.locator("#customer-contact").fill("@anna_example");
      await page.locator("#main-button").tap();
      await page.locator('[data-date="2026-10-30"]').tap();
      await page.locator('[data-date="2026-11-02"]').tap();
      await page.locator("#start-time").fill("10:00");
      await page.locator("#end-time").fill("16:00");
      await page.locator("#main-button").tap();
      await page.locator("#step-review").waitFor();
      assert.match(await page.locator("#review-content").innerText(), /Анна/);
      assert.match(await page.locator("#review-content").innerText(), /@anna_example/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`Design flow (${engine}): 4 mobile viewport/theme cases passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
