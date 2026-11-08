/* Synthetic regression: identity navigation, async ownership and draft restoration. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const order = id => ({id, human_number:`ТС26000${id}`, status:'confirmed', identity_status:'required', starts_at:'2026-11-15T10:00:00+03:00', ends_at:'2026-11-16T10:00:00+03:00', items:[{id:1, name:'Тестовая камера', quantity:1}], handover:{}});

async function fixture(browser) {
  const page = await browser.newPage({viewport:{width:1024, height:900}});
  const errors = [], identityRequests = [];
  const responses = {identity:async id => ({status:'required', fields:{full_name:`Клиент ${id}`}, documents:[]}), reusable:async () => ({reusable:false}), consent:async () => ({text:'Тестовое согласие', version:'qa', text_hash:'hash'})};
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'telegram.org') return route.fulfill({contentType:'text/javascript', body:'window.Telegram={WebApp:{initData:"synthetic",initDataUnsafe:{user:{id:42}}}}'});
    if (url.pathname.startsWith('/miniapp/static/')) {
      const file = path.resolve(assets, url.pathname.slice('/miniapp/static/'.length));
      assert.ok(file.startsWith(assets + path.sep));
      return route.fulfill({body:fs.readFileSync(file), contentType:file.endsWith('.css')?'text/css':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream'});
    }
    if (url.pathname === '/api/miniapp/me') return route.fulfill({json:{id:42, admin:false, pii_admin:false}});
    if (url.pathname === '/api/miniapp/profile') return route.fulfill({json:{display_name:'QA', onboarding_seen:true, client_allowed:true, start_screen:'booking'}});
    if (url.pathname === '/api/miniapp/cart') return route.fulfill({json:{version:0, start:'', end:'', lines:[]}});
    if (url.pathname === '/api/miniapp/profile/history') return route.fulfill({json:{items:[order(7), order(8)], total:2}});
    const identity = /^\/api\/miniapp\/bookings\/(\d+)\/identity$/.exec(url.pathname);
    if (identity) { const id = Number(identity[1]); identityRequests.push(id); return route.fulfill({json:await responses.identity(id, route.request().method())}); }
    if (/\/identity\/reusable-profile$/.test(url.pathname)) return route.fulfill({json:await responses.reusable()});
    if (url.pathname === '/api/miniapp/privacy-consent') return route.fulfill({json:await responses.consent()});
    if (url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[], total:0}});
    return route.fulfill({body:html, contentType:'text/html'});
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://polyrental.test/miniapp');
  await page.waitForFunction(() => !document.documentElement.classList.contains('role-pending'));
  async function open(id = 7, ready = true) {
    await page.locator('#tab-orders').click();
    const card = page.locator(`.customer-order-card[data-booking-id="${id}"]`);
    if (!await card.locator('details').evaluate(node => node.open)) await card.locator('summary').click();
    await card.getByRole('button', {name:'Заполнить документы', exact:true}).click();
    if (ready) await page.getByText('Тестовое согласие', {exact:true}).waitFor();
  }
  async function reveal() { await page.locator('#consent-check').check(); await page.locator('#consent-next').click(); await page.locator('#identity-form').waitFor({state:'visible'}); }
  return {page, errors, responses, identityRequests, open, reveal};
}

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  let passed = 0;
  try {
    {
      const {page, errors, open, reveal} = await fixture(browser);
      await open(); await reveal();
      await page.locator('[name="full_name"]').fill('Несохранённый Клиент');
      let prompts = 0;
      const dismiss = async dialog => { prompts++; assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); };
      page.on('dialog', dismiss);
      for (const selector of ['#identity-close', '#tab-orders', '#tab-new', '#top-back-button']) {
        await page.locator(selector).click();
        assert.equal(await page.locator('#identity-panel').isVisible(), true);
        assert.equal(await page.locator('[name="full_name"]').inputValue(), 'Несохранённый Клиент');
      }
      assert.equal(prompts, 4, 'every navigation path must allow keeping the unsaved form');
      assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(event); return event.defaultPrevented; }), true);
      const storage = await page.evaluate(() => Object.values(localStorage).join(' '));
      assert.ok(!storage.includes('Несохранённый Клиент'), 'identity text stays out of localStorage');
      page.off('dialog', dismiss); page.once('dialog', dialog => dialog.accept());
      await page.locator('#identity-close').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('polyrental-identity-booking')), null);
      await page.reload(); await page.waitForFunction(() => !document.documentElement.classList.contains('role-pending'));
      assert.equal(await page.locator('#identity-panel').isHidden(), true, 'explicitly closed form must not reopen');
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    {
      const {page, errors, identityRequests} = await fixture(browser);
      for (const query of ['startapp=booking_8', 'booking=8', 'startapp=my_bookings', 'startapp=booking']) {
        await page.evaluate(() => localStorage.setItem('polyrental-identity-booking', '7'));
        await page.goto(`http://polyrental.test/miniapp?${query}`);
        await page.waitForFunction(() => !document.documentElement.classList.contains('role-pending'));
        assert.equal(await page.locator('#identity-panel').isHidden(), true);
        assert.equal(await page.evaluate(() => localStorage.getItem('polyrental-identity-booking')), null);
        assert.equal(await page.locator(query === 'startapp=booking' ? '#booking-flow' : '#orders-panel').isVisible(), true);
      }
      assert.deepEqual(identityRequests, [], 'explicit destinations take precedence over old form restoration');
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    for (const stage of ['identity', 'reusable', 'consent']) {
      for (const nextId of [7, 8]) {
        const {page, errors, responses, open} = await fixture(browser);
        const started = deferred(), late = deferred();
        if (stage === 'reusable') responses.identity = async () => ({status:'required', fields:{}, documents:[]});
        const initial = responses[stage]; let calls = 0;
        responses[stage] = async (...args) => { if (++calls === 1) { started.resolve(); return late.promise; } return initial(...args); };
        await open(7, false); await started.promise;
        await page.locator('#identity-close').click();
        await open(nextId);
        const name = await page.locator('[name="full_name"]').inputValue();
        const response = stage === 'identity' ? {status:'needs_changes', fields:{full_name:'УСТАРЕВШИЙ ОТВЕТ'}, documents:[], review_fields:['full_name']}
          : stage === 'reusable' ? {reusable:true, fields:{full_name:'УСТАРЕВШИЙ ОТВЕТ'}, documents:['passport_main']}
          : {text:'УСТАРЕВШЕЕ СОГЛАСИЕ', version:'old', text_hash:'old'};
        const settled = page.waitForResponse(response => stage === 'identity' ? /\/bookings\/7\/identity$/.test(response.url()) : stage === 'reusable' ? response.url().endsWith('/identity/reusable-profile') : response.url().endsWith('/privacy-consent'));
        late.resolve(response); await settled;
        await page.waitForTimeout(100);
        assert.equal(await page.locator('[name="full_name"]').inputValue(), name, `${stage}: stale response must not rewrite another form generation`);
        assert.equal(await page.locator('#consent-text').innerText(), 'Тестовое согласие');
        assert.equal(await page.locator('#identity-form').isHidden(), true);
        assert.equal(await page.locator('#identity-feedback').isHidden(), true);
        assert.deepEqual(errors, []); await page.close(); passed++;
      }
    }
    {
      const {page, errors, responses, open} = await fixture(browser);
      const started = deferred(), late = deferred();
      const fields = {full_name:'Тестовый Клиент', birth_date:'2000-01-01', passport_series:'1234', passport_number:'123456', passport_issued_at:'2020-01-01', passport_division_code:'123-456', passport_issuer:'Тестовый отдел', registration_address:'Тестовая улица', residential_address:'Тестовая улица'};
      responses.identity = async (id, method) => {
        if (method === 'POST') { assert.equal(id, 7); started.resolve(); return late.promise; }
        return {status:'needs_changes', fields, documents:[], review_fields:['full_name']};
      };
      await open(7, false); await page.locator('#identity-form').waitFor({state:'visible'});
      await page.locator('[name="full_name"]').fill('Исправленный Клиент');
      await page.locator('#identity-submit').click(); await started.promise;
      await page.locator('#tab-new').click();
      assert.equal(await page.locator('#identity-panel').isVisible(), true, 'navigation must not change the target while submission is pending');
      assert.match(await page.locator('#global-error').innerText(), /Дождитесь завершения/);
      assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(event); return event.defaultPrevented; }), true);
      let prompts = 0; page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
      late.resolve({status:'submitted'});
      await page.locator('#orders-panel').waitFor({state:'visible'});
      assert.equal(prompts, 0, 'successful save must leave without an unsaved-changes prompt');
      assert.equal(await page.evaluate(() => localStorage.getItem('polyrental-identity-booking')), null);
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    {
      const {page, errors, responses, open, reveal} = await fixture(browser);
      responses.identity = async () => ({status:'required', fields:{}, documents:[]});
      responses.reusable = async () => ({reusable:true, fields:{full_name:'Клиент Новый'}, documents:['passport_main']});
      const started = deferred(), late = deferred();
      await page.route('**/identity/reusable-profile/documents/passport_main', async route => { started.resolve(); await late.promise; await route.fulfill({status:500, json:{detail:'Late failure'}}); });
      await open(); await reveal(); await started.promise;
      await page.locator('#identity-close').click();
      responses.reusable = async () => ({reusable:false});
      await open(); await reveal();
      const settled = page.waitForResponse(response => response.url().endsWith('/identity/reusable-profile/documents/passport_main'));
      late.resolve(); await settled; await page.waitForTimeout(100);
      assert.equal(await page.locator('[name="passport_main"]').locator('..').locator('.file-draft-status').innerText(), '');
      assert.equal(await page.locator('#identity-submit').isEnabled(), true);
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    console.log(`Identity lifecycle: ${passed} scenarios passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
