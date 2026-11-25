/* Booking purpose cards and administrator control; all data is synthetic. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const purpose = '<img src=x onerror="window.purposeInjected=true"> Съёмка\nинтервью';
    for (const admin of [false, true]) {
      const {page, errors} = await fixture(browser, {admin, role:'admin', order:{...base('pending'), rental_purpose:purpose}, width:320});
      const section = page.locator('.rental-purpose-summary');
      await page.clock.runFor(400);
      assert.equal(await section.locator('p').textContent(), purpose);
      assert.equal(await section.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.purposeInjected), undefined);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (admin) {
        let enabled = true;
        const changes = [];
        await page.route('**/api/miniapp/admin/booking-settings', route => {
          if (route.request().method() === 'PUT') {
            enabled = route.request().postDataJSON().rental_purpose_enabled; changes.push(enabled);
          }
          return route.fulfill({json:{rental_purpose_enabled:enabled}});
        });
        await page.locator('#admin-settings-open').click();
        await page.locator('#settings-tab-booking').click();
        const checkbox = page.locator('#booking-settings-form input');
        await page.locator('#booking-settings-form button:enabled').waitFor();
        assert.equal(await checkbox.isChecked(), true);
        await checkbox.uncheck();
        await page.locator('#booking-settings-form button').click();
        await page.locator('#booking-settings-status').getByText('Настройки оформления сохранены').waitFor();
        assert.deepEqual(changes, [false]);
        await checkbox.check();
        await page.locator('#booking-settings-form button').click();
        await page.waitForFunction(() => !document.querySelector('#booking-settings-form button').disabled);
        assert.deepEqual(changes, [false, true]);
      }
      assert.deepEqual(errors, []); await page.close();
    }
    const {page, errors} = await fixture(browser, {admin:true, role:'manager'});
    await page.locator('#admin-settings-open').click();
    assert.equal(await page.locator('#settings-tab-booking').isVisible(), false);
    assert.deepEqual(errors, []); await page.close();
    console.log('Rental purpose: safe customer/staff cards, mobile layout and admin-only toggle passed');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
