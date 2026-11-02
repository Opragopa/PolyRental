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
    await page.locator('#orders-content .loading-skeleton').waitFor();
    assert.equal(await page.locator('#orders-content .loading-skeleton').getAttribute('aria-hidden'),'true');
    release();
    await page.locator('#orders-content').getByRole('button',{name:'Повторить'}).click();
    await page.getByText('В этой категории заявок пока нет.').waitFor();
    assert.equal(calls,2); assert.deepEqual(errors,[]);
    console.log('Loading, error and retry states: passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
