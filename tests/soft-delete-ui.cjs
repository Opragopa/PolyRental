/* Verify undo and ordered commits without Telegram or real data. */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
(async () => {
  const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch({headless:true, ...(name === 'chromium' && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(() => {
      window.__layoutShifts = [];
      if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) {
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShifts.push(entry.value); }).observe({type:'layout-shift', buffered:true});
      }
    });
    const deleted = [];
    const orders = [1,2].map(id => ({id, human_number:`ТС26000${id}`, status:'pending', identity_status:'not_required', starts_at:'2026-11-02T10:00:00+03:00', ends_at:'2026-11-02T18:00:00+03:00', customer_name:'QA', customer_contact:'@qa', items:[{name:'Камера',quantity:1}], lines:[{id:id*10,article_id:1,name:'Камера',quantity:1}], assets:[],inspections:[]}));
    orders.push({...orders[0], id:3, human_number:'ТС260003', status:'preparing', identity_status:'verified', assets:[{id:30, name:'Камера', serial:'TEST', article_id:1}], lines:[{id:30, article_id:1, name:'Камера', quantity:1}]});
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:100}}}}'});
      if (url.pathname.startsWith('/miniapp/static/')) { const file = path.join(assets,path.basename(url.pathname)); return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'}); }
      if (url.pathname === '/api/miniapp/me') return route.fulfill({json:{id:100,admin:true,pii_admin:false}});
      if (url.pathname === '/api/miniapp/profile') return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'management',reminders_enabled:true}});
      if (url.pathname === '/api/miniapp/admin/bookings' && route.request().method() === 'GET') return route.fulfill({json:{items:orders,undo_seconds:2}});
      if (url.pathname.includes('/api/miniapp/admin/bookings/') && route.request().method() === 'DELETE') { deleted.push(url.pathname); return route.fulfill({json:{status:'deleted'}}); }
      if (url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[]}});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://polyrental.test/miniapp');
    const first = page.locator('.request-card[data-booking-id="1"]');
    const second = page.locator('.request-card[data-booking-id="2"]');
    await first.locator('.request-toggle').click();
    await first.locator('.request-history-body').getByText('Записей пока нет.').waitFor({state:'attached'});
    assert.equal(await first.locator('details.request-history').evaluate(node=>node.open),false);
    await first.getByRole('button',{name:'Удалить позицию Камера'}).evaluate(element => element.scrollIntoView({block:'center'}));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.addEventListener('click', () => { window.__scrollAtClick = window.scrollY; }, {capture:true,once:true}));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const targetBefore = await first.getByRole('button',{name:'Удалить позицию Камера'}).boundingBox();
    await page.evaluate(() => { window.__layoutShifts = []; });
    await first.getByRole('button',{name:'Удалить позицию Камера'}).click();
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, `scroll at click: ${await page.evaluate(() => window.__scrollAtClick)} target: ${JSON.stringify(targetBefore)}`);
    await page.locator('#delete-snackbar').waitFor({state:'visible'});
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__layoutShifts.reduce((sum, value) => sum + value, 0)), 0);
    await page.getByRole('button',{name:'Отменить',exact:true}).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2200);
    assert.deepEqual(deleted, []);
    assert.equal(await first.getByRole('button',{name:'Удалить позицию Камера'}).isVisible(), true);
    await first.getByRole('button',{name:'Удалить позицию Камера'}).click();
    await second.locator('.request-toggle').click();
    await second.getByRole('button',{name:'Удалить позицию Камера'}).click();
    await page.waitForTimeout(150);
    assert.deepEqual(deleted, ['/api/miniapp/admin/bookings/1/lines/10']);
    await page.getByRole('button',{name:'Отменить',exact:true}).click();
    await page.waitForTimeout(2200);
    assert.equal(deleted.length, 1);
    const third = page.locator('.request-card[data-booking-id="3"]');
    await third.locator('.request-toggle').click();
    await third.getByRole('button',{name:'Удалить экземпляр Камера'}).click();
    await page.getByRole('button',{name:'Отменить',exact:true}).click();
    assert.equal(await third.getByRole('button',{name:'Удалить экземпляр Камера'}).isVisible(), true);
    console.log('Soft delete undo checks passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
