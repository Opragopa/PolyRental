/* Staff queue controls send filters to the server before pagination. */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const { fixture, base } = require('./completion-ui.cjs');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const {page, errors} = await fixture(browser, {admin:true, role:'operator', order:base('pending')});
    let last;
    await page.route('**/api/miniapp/admin/bookings?*', async route => {
      const query = new URL(route.request().url()).searchParams;
      last = Object.fromEntries(query);
      const order = {...base(query.get('status') === 'ready' ? 'ready' : 'pending'), id:query.get('page') === '1' ? 8 : 7};
      return route.fulfill({json:{items:[order], total:25, page_size:20, queues:{review:8,handover:5,return:2}}});
    });
    await page.locator('#admin-sort').selectOption('status');
    await page.getByRole('button',{name:'Нужна проверка · 8'}).waitFor();
    assert.equal(last.sort,'status');
    await page.getByRole('button',{name:'Нужна проверка · 8'}).click();
    await page.waitForFunction(() => document.querySelector('#admin-queues [aria-pressed="true"]')?.textContent.includes('Нужна проверка'));
    assert.equal(last.queue,'review');
    await page.locator('#admin-status').selectOption('ready');
    await page.waitForFunction(() => document.querySelector('#admin-status').value === 'ready');
    await page.waitForTimeout(100);
    assert.equal(last.status,'ready');
    assert.equal(last.queue,'all');
    await page.locator('#admin-next').click();
    await page.locator('.request-card[data-booking-id="8"]').waitFor();
    assert.equal(last.page,'1');
    for (const width of [320,390,440,1440]) {
      await page.setViewportSize({width,height:900});
      await page.clock.runFor(300);
      const before=await page.locator('#admin-queues').boundingBox();
      const button=page.locator('#admin-queues [data-queue="review"]');
      await button.evaluate(el=>{window.__queueButton=el;el.focus();});
      const response=page.waitForResponse(r=>r.url().includes('/api/miniapp/admin/bookings?'));
      await button.click();await response;await page.clock.runFor(300);
      const after=await page.locator('#admin-queues').boundingBox();
      assert.ok(Math.abs(before.height-after.height)<1,`${width}: filter height changed`);
      assert.equal(await button.evaluate(el=>el===window.__queueButton),true,'filter DOM must survive refresh');
      assert.equal(await button.evaluate(el=>document.activeElement===el),true,'filter focus must survive refresh');
      assert.equal(await button.evaluate(el=>getComputedStyle(el).transform),'none');
      assert.equal(await button.evaluate(el=>el.style.getPropertyValue('--button-fit')),'');
      const columns=await page.locator('#admin-queues').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.equal(columns,width<=600?2:4);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    await page.addStyleTag({content:'#admin-queues > .button {font-size:20px !important}'});
    await page.setViewportSize({width:320,height:900});await page.clock.runFor(300);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors, []);
    console.log('Staff queue filter and pagination: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
