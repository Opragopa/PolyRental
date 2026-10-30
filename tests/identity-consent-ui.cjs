/* Browser regression: entering the identity form must not wait for old photos. */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
  assert.ok(['chromium', 'webkit'].includes(engine), 'Unsupported browser engine');
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({headless: true, ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    const errors = [];
    let reusableDocumentRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'telegram.org') return route.fulfill({contentType: 'text/javascript', body: 'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42,first_name:"QA"}},ready(){}}}'});
      if (url.pathname.startsWith('/miniapp/static/')) {
        const file = path.join(assets, path.basename(url.pathname));
        return route.fulfill({body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript'});
      }
      if (url.pathname === '/api/miniapp/me') return route.fulfill({json: {id: 42, admin: false, pii_admin: false}});
      if (url.pathname === '/api/miniapp/profile') return route.fulfill({json: {display_name: 'QA', onboarding_seen: true, reminders_enabled: true, start_screen: 'booking'}});
      if (url.pathname === '/api/miniapp/cart') return route.fulfill({json: {version: 0, start: '', end: '', lines: []}});
      if (url.pathname === '/api/miniapp/schedule') return route.fulfill({json: {enforced: false}});
      if (url.pathname === '/api/miniapp/support/threads') return route.fulfill({json: {items: []}});
      if (url.pathname.startsWith('/api/miniapp/profile/history')) return route.fulfill({json: {items: [{id: 10, human_number: 'ТС0010', status: 'confirmed', identity_status: 'required', starts_at: '2026-11-10T10:00:00+03:00', ends_at: '2026-11-10T12:00:00+03:00', items: [{id: 1, name: 'Камера', quantity: 1}]}], total: 1}});
      if (url.pathname === '/api/miniapp/bookings/10/identity') return route.fulfill({json: {status: 'required', fields: {}, documents: []}});
      if (url.pathname === '/api/miniapp/bookings/10/identity/reusable-profile') return route.fulfill({json: {reusable: true, fields: {full_name: 'Анна Иванова'}, documents: ['passport_main', 'passport_registration', 'student_front']}});
      if (url.pathname === '/api/miniapp/privacy-consent') return route.fulfill({json: {text: 'Тестовое согласие', version: 'qa', text_hash: 'hash'}});
      if (url.pathname.startsWith('/api/miniapp/bookings/10/identity/reusable-profile/documents/')) {
        reusableDocumentRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 350));
        return route.fulfill({contentType: 'image/jpeg', body: Buffer.from('photo')});
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({json: {items: []}});
      return route.fulfill({body: html, contentType: 'text/html'});
    });

    await page.goto('http://polyrental.test/miniapp?startapp=my_bookings');
    await page.locator('#orders-content .customer-order-toggle').waitFor();
    if (process.env.QA_SCREENSHOTS) {
      fs.mkdirSync(process.env.QA_SCREENSHOTS, {recursive: true});
      await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, 'profile.png')});
    }
    await page.locator('#orders-content .customer-order-toggle').click();
    await page.getByRole('button', {name: 'Заполнить документы'}).click();
    await page.getByText('Тестовое согласие').waitFor();
    await page.locator('#consent-check').check();
    await page.getByRole('button', {name: 'Подтвердить согласие и перейти к анкете'}).click();

    await page.locator('#identity-form').waitFor({state: 'visible'});
    assert.equal(await page.locator('#consent-step').isHidden(), true);
    assert.equal(await page.locator('#identity-submit').isDisabled(), true);
    assert.deepEqual(await page.locator('#identity-form .identity-section h3').allTextContents(), ['Личные данные', 'Паспорт', 'Адрес и студенческий', 'Фотографии документов']);
    const passport = await page.locator('.document-photo-group').first().boundingBox();
    const student = await page.locator('.document-photo-group').last().boundingBox();
    assert.ok(student.x > passport.x, 'passport and student photo groups should be side by side');
    assert.equal(await page.locator('.photo-placeholder').count(), 3);
    assert.equal(await page.locator('#identity-form input[type=file]').count(), 3);
    await page.waitForTimeout(75);
    assert.equal(reusableDocumentRequests, 3, 'old photos should start restoring concurrently in the background');
    await page.locator('#identity-submit').waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.querySelector('#identity-submit').disabled);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.QA_SCREENSHOTS) {
      fs.mkdirSync(process.env.QA_SCREENSHOTS, {recursive: true});
      await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, 'identity.png'), fullPage: true});
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
