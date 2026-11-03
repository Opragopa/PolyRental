const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('app/miniapp_static/app.js', 'utf8');
const motion = source.slice(source.indexOf('  // Animate the element'), source.indexOf('  const tg ='));
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({reducedMotion});
      await page.setContent('<details><summary>Развернуть</summary><div style="height:180px">Содержимое</div></details><p id="after">Ниже</p>');
      await page.addScriptTag({content: motion});
      const after = page.locator('#after');
      const before = (await after.boundingBox()).y;
      await page.locator('summary').click();
      if (reducedMotion === 'no-preference') {
        await page.waitForTimeout(90);
        const during = (await after.boundingBox()).y;
        assert(during > before && during < before + 180, `content should move gradually: ${during-before}`);
      }
      await page.waitForTimeout(350);
      assert((await after.boundingBox()).y >= before + 179);
      await page.locator('summary').click();
      await page.waitForTimeout(350);
      assert(Math.abs((await after.boundingBox()).y - before) < 1);
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      assert(await page.locator('details').evaluate(el => el.open));
      await page.close();
    }
    console.log('Disclosure motion, layout, keyboard and reduced motion: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
