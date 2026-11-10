/* Loading placeholders, failures and retries for customer history. */
const {chromium,webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture,base} = require('./completion-ui.cjs');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const {page,errors}=await fixture(browser,{order:base('pending')});
    let release; const wait=new Promise(resolve=>{release=resolve}); let calls=0;
    await page.route('**/api/miniapp/profile/history?*', async route => {
      calls++;
      if (calls===1) { await wait; return route.fulfill({status:503,json:{detail:'Временно недоступно'}}); }
      return route.fulfill({json:{items:[],total:0,page:0,page_size:10}});
    });
    await page.locator('#tab-orders').click();
    await page.locator('#orders-content .customer-order-toggle').first().waitFor();
    assert.equal(await page.locator('#orders-content .loading-skeleton').count(), 0, 'previous data remains visible during refresh');
    release();
    await page.locator('#orders-content').getByRole('button',{name:'Повторить'}).click();
    await page.getByText('В этой категории заявок пока нет.').waitFor();
    assert.equal(calls,2); assert.deepEqual(errors,[]);
    console.log('Loading, error and retry states: passed');
    await page.close();
    const adminOrder = base('pending');
    const admin = await fixture(browser,{admin:true,order:adminOrder});
    await admin.page.locator('.request-card').first().evaluate(el => { window.savedRequestCard = el; });
    await admin.page.locator('#tab-new').click();
    const refreshed = admin.page.waitForResponse(response => response.url().includes('/api/miniapp/admin/bookings?'));
    await admin.page.locator('#tab-admin').click(); await refreshed;
    await admin.page.waitForTimeout(100);
    assert.equal(await admin.page.locator('.request-card').first().evaluate(el => el === window.savedRequestCard),true,'unchanged management data retains its card after a tab switch');
    await admin.page.locator('#tab-new').click(); adminOrder.status = 'confirmed';
    const changed = admin.page.waitForResponse(response => response.url().includes('/api/miniapp/admin/bookings?'));
    await admin.page.locator('#tab-admin').click(); await changed;
    await admin.page.locator('.request-card .status-pill').getByText('Подтверждена').waitFor();
    assert.equal(await admin.page.locator('.request-card').first().evaluate(el => el === window.savedRequestCard),false,'changed management data must be rendered');
    assert.deepEqual(admin.errors,[]); await admin.page.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
