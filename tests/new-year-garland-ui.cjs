const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const { fixture } = require("./completion-ui.cjs");

const start = Date.parse("2026-12-01T00:00:00+03:00");
const end = Date.parse("2027-01-09T00:00:00+03:00");

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === "webkit" ? webkit : chromium;
  const browser = await engine.launch();
  try {
    for (const surface of ["site", "miniapp"]) {
      for (const width of [320, 1440]) {
        const { page, errors } = await fixture(browser, { surface, width, height: 810, isMobile: width === 320, openOrder: false });
        const garland = page.locator(".new-year-garland");
        await page.clock.pauseAt(start - 500);
        await page.reload();
        assert.equal(await garland.isVisible(), false);
        await page.clock.runFor(500);
        await garland.waitFor({state: "visible"});
        assert.equal(await garland.getAttribute("aria-hidden"), "true");
        const geometry = await garland.evaluate(element => {
          const span = element.getBoundingClientRect();
          const top = element.parentElement.querySelector(".topbar").getBoundingClientRect().top;
          return {
            pointerEvents: getComputedStyle(element).pointerEvents,
            overflow: document.documentElement.scrollWidth > innerWidth,
            aboveHeader: span.bottom <= top,
            lights: [...element.querySelectorAll(".new-year-lamp")].filter(lamp => lamp.getClientRects().length).length,
          };
        });
        assert.deepEqual(geometry, {
          pointerEvents: "none", overflow: false, aboveHeader: true, lights: width === 320 ? 8 : 16,
        });
        await page.clock.setSystemTime(end - 500);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
        assert.equal(await garland.isVisible(), true);
        await page.clock.runFor(500);
        await garland.waitFor({state: "hidden"});
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    console.log(`New Year garland (${engine.name()}): both entry points and Moscow date boundaries passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
