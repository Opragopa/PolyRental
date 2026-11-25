/* Loading placeholders, failures and retries for customer history. */
const {chromium,webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture,base} = require('./completion-ui.cjs');
const fs = require('node:fs');
const path = require('node:path');

async function startupFixture(browser, {delay, failRole = false} = {}) {
  const assets = path.resolve(__dirname, '../app/miniapp_static');
  const page = await browser.newPage({viewport: {width: 320, height: 640}, colorScheme: 'dark', reducedMotion: 'reduce'});
  const startedAt = new Date('2026-11-23T10:00:00Z');
  await page.clock.install({time: startedAt});
  await page.clock.pauseAt(new Date(startedAt.getTime() + 100));
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let roleRequests = 0;
  let site = false;
  await page.route('**/*', async route => {
    const {hostname, pathname} = new URL(route.request().url());
    if (hostname === 'telegram.org') {
      if (delay === 'sdk') await blocked;
      if (site) return route.fulfill({contentType: 'text/javascript', body: ''});
      return route.fulfill({contentType: 'text/javascript', body: 'window.readyCalls = 0; window.Telegram = {WebApp: {initData: "signed-test", ready() { window.readyCalls++; }}};'});
    }
    if (pathname.startsWith('/miniapp/static/')) {
      const name = path.basename(pathname);
      if (name === 'app.js' && delay === 'app') await blocked;
      return route.fulfill({body: fs.readFileSync(path.join(assets, name)), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript'});
    }
    if (pathname === '/api/miniapp/me') {
      roleRequests++;
      if (delay === 'role') await blocked;
      if (failRole && roleRequests === 1) return route.fulfill({status: 503, json: {detail: 'Временно недоступно'}});
      return route.fulfill({json: {id: 42, admin: false}});
    }
    if (pathname === '/api/site/session') return route.fulfill({json: {id: 42}});
    if (pathname.startsWith('/api/')) return route.fulfill({json: {items: []}});
    site = pathname === '/site';
    return route.fulfill({
      body: fs.readFileSync(path.join(assets, 'index.html')), contentType: 'text/html',
      headers: {'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'"},
    });
  });
  return {page, unblock};
}

async function verifyStartup(browser) {
  const url = 'https://polyrental.test/miniapp?booking=7#tgWebAppVersion=8.0';
  for (const delay of ['sdk', 'app', 'role']) {
    const {page, unblock} = await startupFixture(browser, {delay});
    try {
      await page.goto(url, {waitUntil: 'commit'});
      const startup = page.locator('#miniapp-startup');
      await startup.waitFor({state: 'attached'});
      assert.ok(await startup.isHidden(), 'short waits do not show the startup screen');
      await page.clock.runFor(300);
      await startup.waitFor({state: 'visible'});
      assert.match(await startup.innerText(), /Открываем ПолиРентал/);
      assert.ok(await page.locator('.shell').isHidden());
      assert.equal(await startup.locator('.startup-spinner').evaluate(node => getComputedStyle(node).animationName), 'none');
      const ring = await startup.locator('.startup-spinner').boundingBox();
      const status = await startup.locator('#startup-status').boundingBox();
      assert(ring.x+ring.width<=status.x && Math.abs(ring.y+ring.height/2-status.y-status.height/2)<1);
      await page.clock.fastForward(4700);
      assert.match(await startup.innerText(), /Загрузка занимает больше времени/);
      if (delay === 'app') {
        await page.clock.fastForward(20000);
        await startup.getByRole('button', {name: 'Повторить'}).waitFor();
        assert.match(await startup.innerText(), /Приложение не успело загрузиться/);
      }
      unblock();
      await page.waitForFunction(() => window.readyCalls === 1);
      if (delay === 'app') {
        await page.waitForLoadState('domcontentloaded');
        assert.ok(await startup.getByRole('button', {name: 'Повторить'}).isVisible());
        assert.ok(await page.locator('.shell').isHidden());
      } else {
        await startup.waitFor({state: 'hidden'});
        await page.locator('#orders-panel').waitFor();
      }
    } finally {
      unblock();
      await page.close();
    }
  }
  const {page} = await startupFixture(browser, {failRole: true});
  try {
    await page.goto(url);
    const startup = page.locator('#miniapp-startup');
    const retry = startup.getByRole('button', {name: 'Повторить'});
    await retry.waitFor();
    assert.match(await startup.innerText(), /Не удалось открыть приложение/);
    await retry.evaluate(button => button.click());
    await page.locator('#orders-panel').waitFor();
    assert.equal(page.url(), url, 'retry preserves the deep link');
    await page.clock.fastForward(5000);
    assert.ok(await startup.isHidden(), 'quick successful retry leaves the startup screen hidden');
    assert.equal(await page.evaluate(() => window.readyCalls), 1);
    await page.goto('https://polyrental.test/site');
    assert.ok(await startup.isHidden(), 'site has no Telegram startup screen');
    await page.goto('https://polyrental.test/miniapp?preview=1');
    assert.ok(await startup.isHidden(), 'preview has no Telegram startup screen');
  } finally { await page.close(); }
  console.log('Mini App startup: slow SDK, script and role, timeout, retry and fast entry passed');
}

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    await verifyStartup(browser);
    const {page,errors}=await fixture(browser,{order:base('pending')});
    let release; const wait=new Promise(resolve=>{release=resolve}); let calls=0;
    await page.route('**/api/miniapp/profile/history?*', async route => {
      calls++;
      if (calls===1) { await wait; return route.fulfill({status:503,json:{detail:'Временно недоступно'}}); }
      return route.fulfill({json:{items:[],total:0,page:0,page_size:10}});
    });
    await page.locator('#tab-new').click();
    await page.locator('#tab-orders').click();
    await page.locator('#orders-content .customer-order-toggle').first().waitFor();
    assert.equal(calls,0,'returning to profile uses the fresh result');
    await page.locator('#tab-new').click();
    await page.clock.fastForward(5100);
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
    let reads = 0;
    admin.page.on('request', request => { if (request.url().includes('/api/miniapp/admin/bookings?')) reads++; });
    await admin.page.locator('.request-card').first().evaluate(el => { window.savedRequestCard = el; });
    await admin.page.locator('#tab-new').click();
    await admin.page.locator('#tab-admin').click();
    await admin.page.waitForTimeout(100);
    assert.equal(reads,0,'returning to orders reuses the fresh fetch');
    assert.equal(await admin.page.locator('.request-card').first().evaluate(el => el === window.savedRequestCard),true,'unchanged management data retains its card after a tab switch');
    await admin.page.locator('#tab-new').click(); adminOrder.status = 'confirmed';
    await admin.page.clock.fastForward(5100);
    const changed = admin.page.waitForResponse(response => response.url().includes('/api/miniapp/admin/bookings?'));
    await admin.page.locator('#tab-admin').click(); await changed;
    await admin.page.locator('.request-card .status-pill').getByText('Подтверждена').waitFor();
    assert.equal(await admin.page.locator('.request-card').first().evaluate(el => el === window.savedRequestCard),false,'changed management data must be rendered');
    assert.deepEqual(admin.errors,[]); await admin.page.close();
    for (const surface of ['site','miniapp']) {
      const {page,errors}=await fixture(browser,{surface,order:base(),receipt:{body:'%PDF-1.4\n'}});
      await page.emulateMedia({reducedMotion:'reduce'});
      let release;
      const waiting = new Promise(resolve=>{release=resolve;});
      await page.route('**/api/miniapp/bookings/7/receipt',async route=>{
        await waiting;
        return route.fulfill({status:503,json:{detail:'Скачивание временно недоступно'}});
      });
      try {
        await page.locator('.customer-actions > summary').click();
        const button = page.getByRole('button',{name:'Скачать расписку',exact:true});
        await button.click();
        assert.equal(await button.isDisabled(),true,'the download action waits for the request');
        release();
        await page.getByText('Скачивание временно недоступно',{exact:true}).waitFor();
        assert.equal(await button.isEnabled(),true);
        assert.equal(await page.locator('.receipt-preview-dialog').count(),0);
        assert.deepEqual(errors,[]);
      } finally {
        release();
        await page.close();
      }
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
