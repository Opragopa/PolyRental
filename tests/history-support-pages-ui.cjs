/* Activity and support lists load additional pages from their APIs. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const {page,errors}=await fixture(browser,{admin:true,role:'operator',order:base('pending')});let historyPage=-1,supportPage=-1,customerPage=-1;
 await page.route('**/api/miniapp/admin/bookings/*/history?*',route=>{const q=new URL(route.request().url()).searchParams;historyPage=Number(q.get('page'));return route.fulfill({json:{items:[{id:`audit:${historyPage+1}`,action:'confirmed',actor_id:100,created_at:'2026-10-29T10:00:00Z'}],total:21,page:historyPage,page_size:20}})});
 await page.route('**/api/miniapp/admin/support?*',route=>{const q=new URL(route.request().url()).searchParams;supportPage=Number(q.get('page'));return route.fulfill({json:{items:[{id:supportPage+1,status:'new',owner_id:null,screen:'profile',request_number:'',created_at:'2026-10-29T10:00:00Z'}],total:21,page:supportPage,page_size:20,eligible_owners:[]}})});
 await page.route('**/api/miniapp/support/threads?*',route=>{const q=new URL(route.request().url()).searchParams;customerPage=Number(q.get('page'));return route.fulfill({json:{items:[{id:customerPage+1,request_number:`QA-${customerPage+1}`,status:'Обращение получено'}],total:21,page:customerPage,page_size:20}})});
 if (await page.locator('.request-accordion').first().evaluate(node=>node.open)) await page.locator('.request-toggle').first().click();
 await page.locator('.request-toggle').first().click();
 const history=page.locator('.request-history');await history.locator('summary').click();
 await history.getByText('1 / 2').waitFor();assert.equal(historyPage,0);
 await history.getByRole('button',{name:'Далее'}).click();await history.getByText('2 / 2').waitFor();assert.equal(historyPage,1);
 await page.locator('[data-mode="support"]').click();await page.getByText('Обращение №1').waitFor();
 await page.locator('#admin-content').getByRole('button',{name:'Далее'}).click();await page.getByText('Обращение №2').waitFor();assert.equal(supportPage,1);
 await page.locator('#tab-orders').click();await page.locator('#profile-header > summary').click();
 await page.getByText('QA-1: Обращение получено').waitFor();await page.getByRole('button',{name:'Показать ещё обращения'}).click();await page.getByText('QA-2: Обращение получено').waitFor();assert.equal(customerPage,1);
 assert.deepEqual(errors,[]);console.log('History and support pagination: passed');await page.close();
 }finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
