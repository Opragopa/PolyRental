/* Layout and booking continuity for «Кадр», using synthetic fixtures only. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture, base} = require('./completion-ui.cjs');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  const output = `artifacts/frame-style/${engine.name()}`;
  fs.mkdirSync(output, {recursive:true});
  try {
    for (const [width, theme] of [[320,'light'], [390,'light'], [390,'dark'], [1440,'light']]) {
      const {page, errors} = await fixture(browser, {width, order:base('pending'), isMobile:width < 700});
      await page.emulateMedia({reducedMotion:'reduce'});
      const categories = ['camera','optics','light','sound','support','battery'].map((code, i) => ({code, name:['Камеры','Оптика','Свет','Звук','Штативы и опоры','Питание'][i]}));
      const items = [
        {id:1, name:'Камера Sony FX3', category:'camera', description:'Компактная кинокамера', capacity:3, available_quantity:3},
        {id:2, name:'Камера с очень длинным названием для проверки переноса текста', category:'camera', description:'Тестовая модель', capacity:2, available_quantity:2}
      ];
      await page.route('**/api/miniapp/catalog/categories', r => r.fulfill({json:{items:categories}}));
      await page.route('**/api/miniapp/catalog?*', r => r.fulfill({json:{items, selected_items:items, page:0, page_size:20, total:items.length}}));
      await page.route('**/api/miniapp/availability?*', r => r.fulfill({json:{items, all_items:items, selected_items:items, unavailable_count:0}}));
      let cart = {start:'', end:'', lines:[], version:0};
      await page.route('**/api/miniapp/cart', r => {
        if (r.request().method() === 'PUT') cart = {...r.request().postDataJSON(), version:cart.version + 1};
        return r.fulfill({json:cart});
      });
      await page.locator('#profile-header > summary').click();
      await page.locator('label:has([name="visual-style"][value="frame"])').click();
      await page.locator(`label:has([name="theme"][value="${theme}"])`).click();
      await page.reload();
      await page.waitForFunction(() => !document.documentElement.classList.contains('role-pending'));
      assert.equal(await page.locator('html').getAttribute('data-style'), 'frame', 'choice survives a new launch');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const check = async name => {
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} page fits ${width}`);
        const overflowing = await page.locator('#booking-flow button:visible, #booking-flow input:visible').evaluateAll(nodes => nodes.filter(n => {
          const r = n.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1;
        }).map(n => n.id || n.className));
        assert.deepEqual(overflowing, [], `${name} controls fit`);
        await page.screenshot({path:`${output}/${width}-${theme}-${name}.png`, fullPage:true});
        if (width === 390 && name === 'categories') await page.screenshot({path:`${output}/catalog-${theme}.png`});
      };
      await page.locator('[data-category-code="camera"]').waitFor();
      await check('categories');
      await page.locator('[data-category-code="camera"]').click();
      await page.locator('.item-card').first().waitFor();
      await check('equipment');
      await page.locator('#client-product-layout').getByRole('button', {name:'Плитка'}).click();
      await check('tiles');
      await page.locator('#client-product-layout').getByRole('button', {name:'Список'}).click();
      const plus = page.locator('.item-card .plus').first();
      const target = await plus.boundingBox();
      assert.ok(target.width >= 43.9 && target.height >= 43.9, 'quantity control is touch sized');
      await plus.click(); await page.locator('#main-button').click();
      assert.equal(await page.locator('#frame-progress [aria-current]').innerText(), '2\nПодборка');


      await check('cart');
      await page.locator('#main-button').click();
      await page.locator('[data-date="2026-11-03"]').click(); await page.locator('[data-date="2026-11-04"]').click();
      await page.locator('#start-time').fill('10:00'); await page.locator('#end-time').fill('18:00');
      await check('calendar');
      await page.locator('#main-button').click(); await page.locator('#step-review').waitFor();
      assert.equal(await page.locator('#frame-progress [aria-current]').innerText(), '4\nПроверка');
      await check('review');
      assert.equal(await page.locator('#main-button').isEnabled(), true);
      await page.locator('#tab-orders').click();
      assert.equal(await page.locator('#frame-progress').isVisible(), false);
      await page.locator('#profile-header > summary').click();
      await page.locator('label:has([name="visual-style"][value="classic"])').click();
      await page.locator('#tab-new').click();
      assert.equal(await page.locator('#frame-progress').isVisible(), true, 'booking progress is shared by all styles');
      assert.deepEqual(errors, []); await page.close();
    }
    console.log(`Frame style (${engine.name()}): persistent choice, 4 viewport/theme cases, categories, long titles, cart, calendar, review and classic restoration passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
