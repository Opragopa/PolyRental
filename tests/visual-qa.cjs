/* Reproducible visual smoke test for the Telegram Mini App. Run with NODE_PATH
 * pointing at tools/browser-qa/node_modules; QA_SCREENSHOTS is optional. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assets = path.join(root, "app", "miniapp_static");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8").replaceAll("__APP_VERSION__", version);
const cases = [[320, 640, false], [360, 640, true], [390, 844, false], [430, 844, true]];

function serve(route) {
  const url = new URL(route.request().url());
  if (url.hostname === "telegram.org") return route.fulfill({ body: "", contentType: "text/javascript" });
  if (url.pathname.startsWith("/miniapp/static/")) {
    const file = path.join(assets, path.basename(url.pathname));
    return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
  }
  return route.fulfill({ body: html, contentType: "text/html" });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    for (const [width, height, dark] of cases) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.route("**/*", serve);
      await page.clock.install({ time: new Date("2026-10-26T10:00:00Z") });
      await page.goto("http://polyrental.test/miniapp?preview=1");

      const tabIcons = await page.locator(".tabs .tab-icon use").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
      assert.deepEqual(tabIcons, ["#icon-settings", "#icon-calendar", "#icon-user"], "navigation uses SVG icons");
      assert.equal(await page.locator(".icon-sprite symbol").count() >= 12, true, "SVG sprite is present");
      assert.notEqual(await page.locator(".icon-sprite").evaluate(node => getComputedStyle(node).display), "none", "SVG sprite stays renderable for embedded WebViews");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`);
      assert.equal(await page.locator(".tabs .tab:visible").evaluateAll(buttons => buttons.every(button => {
        const box = button.getBoundingClientRect();
        return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth;
      })), true, `navigation targets at ${width}px`);

      await page.locator('[data-date="2026-10-30"]').tap();
      await page.locator('[data-date="2026-11-02"]').tap();
      await page.locator("#start-time").fill("10:00");
      await page.locator("#end-time").fill("16:00");
      const bottomLayout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { action: rect("#action-bar"), tabs: rect(".tabs") };
      });
      assert.ok(bottomLayout.action.bottom <= bottomLayout.tabs.top, JSON.stringify({ width, bottomLayout }));
      assert.equal(await page.locator("#main-button").isEnabled(), true);

      if (process.env.QA_SCREENSHOTS) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, `visual-${width}-${dark ? "dark" : "light"}.png`) });
      }
      await page.locator("#main-button").tap();
      await page.locator(".item-card").first().waitFor();
      assert.equal(await page.locator(".item-placeholder .placeholder-icon use").count() > 0, true, "catalog fallback uses SVG icon");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `catalog overflow at ${width}px`);
      assert.deepEqual(errors, [], `browser errors at ${width}px: ${errors.join(" | ")}`);
      await page.close();
    }
    console.log("Visual QA: 4 mobile viewport/theme cases passed");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
