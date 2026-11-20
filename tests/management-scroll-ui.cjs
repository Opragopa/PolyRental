/* Synthetic management requests; no production API calls. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium ? {channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'} : {})});
  let cases = 0;
  try {
    for (const width of [390, 1440]) for (const status of ['pending','ready','issued','return_inspection']) {
      const {page, errors} = await fixture(browser, {admin:true, order:base(status), width, isMobile:width === 390});
      await page.clock.resume();
      const accordion = page.locator('.request-accordion');
      const toggle = accordion.locator(':scope > summary');
      await toggle.click();
      await toggle.click();
      assert(await accordion.evaluate(node => node.open));
      assert.equal(await accordion.evaluate(node => node.style.overflow), '', 'management card must never trap scrolling in an animated overflow:hidden container');
      assert.equal(await accordion.evaluate(node => node.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.height))), false);
      await page.waitForTimeout(350);
      await page.evaluate(() => { document.documentElement.style.scrollBehavior='auto'; scrollTo(0,100); });
      if (width === 1440) {
        await page.mouse.move(180,450); await page.mouse.wheel(0,180);
        await page.waitForFunction(() => scrollY > 150);
      } else if (engine === chromium) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:180,y:550}]});
        for (const y of [510,460,410,350]) {
          await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:180,y}]});
          await page.waitForTimeout(25);
        }
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await page.waitForFunction(() => scrollY > 150);
      } else {
        await page.evaluate(() => scrollBy(0,180));
        assert(await page.evaluate(() => scrollY > 150));
      }
      await page.waitForTimeout(350);
      assert(await page.evaluate(() => scrollY > 150), 'disclosure completion must not snap back over user scrolling');
      assert.deepEqual(errors, []);
      await page.close(); cases++;
    }
    console.log(`${engine.name()}: ${cases} management scroll cases passed`);
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
