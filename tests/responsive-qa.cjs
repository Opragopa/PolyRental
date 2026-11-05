/* Offline browser QA against real app markup and preview interactions.
 * NODE_PATH=tools/browser-qa/node_modules PLAYWRIGHT_CHANNEL=msedge node tests/responsive-qa.cjs */
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const assets = path.resolve(__dirname, "../app/miniapp_static");
const cases = [[240, 320], [280, 480], [320, 568], [360, 640], [390, 844], [568, 320], [768, 1024], [1024, 768], [1440, 900]];

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge"});
  try {
    for (const [width, height] of cases) {
      const page = await browser.newPage({viewport: {width, height}, colorScheme: width % 80 ? "dark" : "light"});
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "polyrental.test") return route.fulfill({body: "", contentType: "text/javascript"});
        const file = path.join(assets, url.pathname.startsWith("/miniapp/static/") ? path.basename(url.pathname) : "index.html");
        const type = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2"}[path.extname(file)];
        const body = path.extname(file) === ".html" ? fs.readFileSync(file, "utf8").replaceAll("__APP_VERSION__", "QA") : fs.readFileSync(file);
        return route.fulfill({body, contentType: type || "application/octet-stream"});
      });
      await page.goto("http://polyrental.test/miniapp?preview=1");
      async function check(stage) {
        await page.waitForTimeout(300);
        const result = await page.evaluate(() => {
          const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
          const overflow = [...document.querySelectorAll("button, input, select, .item-card, .calendar-day, .dialog-card")].filter(visible).filter(el => {
            const box = el.getBoundingClientRect();
            return box.left < -1 || box.right > innerWidth + 1;
          }).map(el => el.id || el.className);
          const tabs = document.querySelector(".tabs").getBoundingClientRect();
          document.querySelectorAll(".tabs .tab").forEach(tab => {
            if (visible(tab) && tab.scrollWidth > tab.clientWidth + 1) overflow.push(`tab-label:${tab.id}`);
          });
          const footer = document.querySelector(".action-bar");
          return {overflow, pageOverflow: document.documentElement.scrollWidth > innerWidth, barsOverlap: visible(footer) && footer.getBoundingClientRect().bottom > tabs.top + 1};
        });
        assert.deepEqual(result, {overflow: [], pageOverflow: false, barsOverlap: false}, `${width}x${height} ${stage}: ${JSON.stringify(result)}`);
        if (process.env.QA_SCREENSHOTS && [240, 390, 1440].includes(width)) {
          fs.mkdirSync(process.env.QA_SCREENSHOTS, {recursive: true});
          await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, `responsive-${width}-${stage}.png`)});
        }
      }
      if (await page.locator("#onboarding-skip").isVisible()) await page.locator("#onboarding-skip").click();
      await check("categories");
      if (await page.locator("#client-categories .category-card").count()) await page.locator("#client-categories .category-card").first().click();
      await page.locator(".item-card").first().waitFor();
      await check("list");
      await page.locator("#catalog-grid").click();
      await check("tiles");
      await page.locator(".item-card .plus").first().click();
      await page.locator("#main-button").click();
      await page.locator("#step-contact").waitFor({state: "visible"});
      await check("cart");
      await page.locator("#customer-name").fill("Анна");
      await page.locator("#customer-contact").fill("@anna_test");
      await page.locator("#main-button").click();
      await page.locator("#step-dates").waitFor({state: "visible"});
      await check("calendar");
      assert.equal(await page.locator(".calendar-day").count(), 42);
      const available = page.locator(".calendar-day:not(:disabled):not(.outside-month)");
      await available.nth(2).click();
      await available.nth(4).click();
      await page.locator("#start-time").fill("10:00");
      await page.locator("#end-time").fill("16:00");
      await page.locator("#main-button").click();
      await page.locator("#step-review").waitFor({state: "visible"});
      await check("review");
      if (width === 240) {
        await page.locator("#main-button").evaluate(el => { el.textContent = "Подтвердить бронирование выбранного оборудования"; });
        await check("long-action");
        assert.ok(await page.locator("#main-button").evaluate(el => Number(el.style.getPropertyValue("--button-fit")) < 1), "long control scales down");
      }
      await page.locator("#tab-orders").click();
      await check("profile");
      await page.locator("#profile-header > summary").click();
      await page.locator("#onboarding-reopen").click();
      await page.locator("#onboarding-dialog").waitFor({state: "visible"});
      await check("dialog");
      await page.locator("#onboarding-skip").click();
      // Static staff controls use the same stylesheet; no real staff API needed.
      await page.evaluate(() => {
        document.querySelector("#orders-panel").hidden = true;
        document.querySelector("#admin-panel").hidden = false;
        document.querySelector("#tab-admin").hidden = false;
      });
      await check("staff-controls");
      await page.emulateMedia({reducedMotion: "reduce"});
      assert.equal(await page.locator(".tab").first().evaluate(el => getComputedStyle(el).transitionDuration), "0s");
      assert.deepEqual(errors, [], `${width}px browser errors`);
      if (process.env.QA_SCREENSHOTS) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, {recursive: true});
        await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, `responsive-${width}x${height}.png`)});
      }
      await page.close();
      console.log(`PASS ${width}x${height}: catalog, cart, calendar, review, profile, dialog, staff controls, reduced motion`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
