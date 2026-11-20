/* Synthetic delayed writes: no real Telegram calls or customer data. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture, base} = require('./completion-ui.cjs');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

async function prepare(browser, {conflict = false, purposeEnabled = true} = {}) {
  const f = await fixture(browser, {order:base('pending'), width:320});
  const {page} = f, cartGate = gate(), cartReceived = gate(), bookingGate = gate(), bookingReceived = gate();
  const item = {id:1, name:'Камера Sony', title:'Камера Sony', category:'generic', capacity:3, available_quantity:3};
  let cart = {start:'', end:'', lines:[], version:0};
  const attempts = [];
  const question = {rental_purpose_enabled:purposeEnabled};
  await page.route('**/api/miniapp/booking-settings', route => route.fulfill({json:question}));
  await page.route('**/api/miniapp/catalog?*', route => route.fulfill({json:{items:[item], selected_items:[item], page:0, page_size:20, total:1}}));
  await page.route('**/api/miniapp/availability?*', route => route.fulfill({json:{items:[item], all_items:[item], selected_items:[item], unavailable_count:0}}));
  await page.route('**/api/miniapp/cart', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:cart});
    const payload = route.request().postDataJSON();
    if (cart.version === 0) {
      cartReceived.resolve(); await cartGate.promise;
      if (conflict) {
        cart = {start:'', end:'', lines:[], version:1};
        return route.fulfill({status:409, json:{detail:'Подборка изменена на другом устройстве'}});
      }
    }
    cart = {...payload, version:cart.version + 1};
    return route.fulfill({json:cart});
  });
  await page.route('**/api/miniapp/bookings', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({json:{items:[]}});
    attempts.push(route.request().postDataJSON());
    bookingReceived.resolve();
    if (attempts.length === 1) { await bookingGate.promise; return route.abort('failed'); }
    return route.fulfill({status:201, json:{id:9, human_number:'ТС000009'}});
  });
  await page.locator('#tab-new').click();
  await page.locator('#client-categories .category-card').filter({hasText:'Оборудование'}).click();
  await page.locator('.item-card .plus').first().click({timeout:10000}).catch(async error => {console.error({errors:f.errors,body:await page.locator('#booking-flow').innerText()});throw error;});
  await page.locator('#main-button').click();
  assert.equal(await page.locator('#customer-name, #customer-contact').count(),0);
  await page.locator('#main-button').click();
  await page.locator('[data-date="2026-11-03"]').click();
  await page.locator('[data-date="2026-11-04"]').click();
  await page.locator('#start-time').fill('10:00');
  await page.locator('#end-time').fill('18:00');
  await page.locator('#main-button').click();
  await page.locator('#step-review').waitFor();
  await page.clock.runFor(350); await cartReceived.promise;
  return {...f, cartGate, bookingGate, bookingReceived, attempts, question};
}

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    {
      const {page, errors, cartGate, bookingGate, bookingReceived, attempts} = await prepare(browser);
      const purpose = 'Съёмка <интервью> & мероприятия';
      await page.getByLabel('Для чего вам оборудование?').fill(purpose);
      assert.equal(await page.getByRole('button', {name:'Изменить контакт',exact:true}).count(),0);
      await page.getByRole('button', {name:'Изменить срок аренды', exact:true}).click();
      assert.equal(await page.locator('#start-time').inputValue(), '10:00');
      await page.locator('#main-button').click(); await page.locator('#step-review').waitFor();
      assert.equal(await page.locator('#rental-purpose').inputValue(), purpose, 'back navigation keeps purpose');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      fs.mkdirSync('artifacts/booking-submit', {recursive:true});
      await page.evaluate(() => document.fonts.ready);
      await page.clock.runFor(400);
      await page.screenshot({path:'artifacts/booking-submit/review-320.png', fullPage:true});
      for (const style of ['classic', 'studio']) {
        for (const theme of ['light', 'dark']) {
          await page.evaluate(({style, theme}) => { document.documentElement.dataset.style = style; document.documentElement.dataset.theme = theme; }, {style, theme});
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({path:`artifacts/booking-submit/review-${style}-${theme}-320.png`, fullPage:true});
        }
      }
      await page.locator('#main-button').click();
      assert.equal(await page.locator('#main-button').isDisabled(), true, 'busy before awaiting cart');
      assert.equal(await page.locator('#booking-flow').evaluate(el => el.inert), true);
      assert.equal(await page.locator('#top-back-button').isDisabled(), true);
      assert.equal(await page.locator('#tab-orders').isDisabled(), true);
      assert.equal(attempts.length, 0, 'booking waits for all cart writes');
      // A rapid second activation cannot start another request.
      await page.locator('#main-button').evaluate(el => el.click());
      cartGate.resolve();
      await bookingReceived.promise;
      assert.equal(attempts.length, 1);
      assert.equal('contact' in attempts[0],false);
      assert.equal('name' in attempts[0],false);
      assert.deepEqual(attempts[0].lines, [{article_id:1, quantity:1}]);
      assert.equal(attempts[0].rental_purpose, purpose);
      bookingGate.resolve();
      await page.locator('#global-error').getByText(/Проверьте интернет/).waitFor();
      assert.equal(await page.locator('#booking-flow').evaluate(el => el.inert), false);
      assert.equal(await page.locator('#main-button').isEnabled(), true);
      assert.equal(await page.locator('#rental-purpose').inputValue(), purpose, 'failed send keeps purpose');
      await page.locator('#main-button').click();
      await page.locator('#step-done').waitFor();
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1].request_id, attempts[0].request_id, 'retry uses the same idempotency key');
      assert.equal(attempts[1].rental_purpose, purpose);
      assert.equal(await page.locator('#rental-purpose').inputValue(), '', 'success clears purpose');
      assert.equal(await page.locator('#selected-count').innerText(), '0', 'success clears local selection');
      await page.locator('#tab-new').click();
      assert.equal(await page.locator('#start').inputValue(), '');
      assert.equal(await page.locator('#selected-count').innerText(), '0');
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors, cartGate, attempts, question} = await prepare(browser, {conflict:true, purposeEnabled:false});
      assert.equal(await page.locator('#rental-purpose-field').isVisible(), false);
      question.rental_purpose_enabled = true;
      await page.getByRole('button', {name:'Изменить срок аренды', exact:true}).click();
      await page.locator('#main-button').click(); await page.locator('#step-review').waitFor();
      assert.equal(await page.locator('#rental-purpose-field').isVisible(), true, 'question settings refresh on entry');
      await page.locator('#main-button').click(); cartGate.resolve();
      await page.locator('#cart-sync-notice').waitFor();
      assert.equal(attempts.length, 0, 'cart conflict must never submit the replaced snapshot');
      assert.equal(await page.locator('#booking-flow').evaluate(el => el.inert), true);
      await page.getByRole('button', {name:'Использовать серверную подборку'}).click();
      await page.locator('#cart-sync-notice').waitFor({state:'hidden'});
      assert.equal(await page.locator('#booking-flow').evaluate(el => el.inert), false);
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors, cartGate, bookingGate, attempts, bookingReceived} = await prepare(browser, {purposeEnabled:false});
      await page.locator('#main-button').click(); cartGate.resolve(); await bookingReceived.promise;
      assert.equal(attempts[0].rental_purpose, '', 'disabled optional question permits an empty answer');
      bookingGate.resolve(); await page.locator('#global-error').getByText(/Проверьте интернет/).waitFor();
      await page.locator('#main-button').click(); await page.locator('#step-done').waitFor();
      assert.deepEqual(errors, []); await page.close();
    }
    console.log('Booking submit: delayed cart, navigation lock, network retry, idempotency, conflict, review corrections and empty new cart passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
