/* Browser acceptance for server-directed start screens and onboarding. */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');

(async () => {
  const engineName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
  const engine = engineName === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless: true, ...(engineName === 'chromium' && process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const admin of [false, true]) {
      const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let seen = false, completed = 0, switches = 0, reminders = true, historySearch = '', identityRequests = 0;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'telegram.org') return route.fulfill({contentType:'text/javascript', body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
        if (url.pathname.startsWith('/miniapp/static/')) { const file = path.join(assets, path.basename(url.pathname)); return route.fulfill({body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript'}); }
        if (url.pathname === '/api/miniapp/me') return route.fulfill({json:{id:admin ? 100 : 42, admin, pii_admin:false}});
        if (url.pathname === '/api/miniapp/profile') return route.fulfill({json:{display_name:'QA', member_since:'2026-01-01T00:00:00Z', onboarding_seen:seen, reminders_enabled:reminders, start_screen:admin ? 'management' : 'booking'}});
        if (url.pathname === '/api/miniapp/profile/identity') { identityRequests++; return route.fulfill({json:{fields:{passport_number:'123456'}}}); }
        if (url.pathname === '/api/miniapp/profile/reminders') { reminders = route.request().postDataJSON().enabled; return route.fulfill({json:{enabled:reminders}}); }
        if (url.pathname === '/api/miniapp/onboarding/show') { const first = !seen; seen = true; return route.fulfill({json:{first_show:first}}); }
        if (url.pathname === '/api/miniapp/onboarding/complete') { completed++; return route.fulfill({json:{status:'ok'}}); }
        if (url.pathname === '/api/miniapp/operator/client-mode') { switches++; return route.fulfill({json:{status:'ok'}}); }
        if (url.pathname === '/api/miniapp/admin/catalog') return route.fulfill({json:{articles:[],dependencies:[]}});
        if (url.pathname === '/api/miniapp/profile/history') { historySearch = url.searchParams.get('number'); return route.fulfill({json:{items:[],total:0}}); }
        if (url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[],total:0}});
        return route.fulfill({body:html,contentType:'text/html'});
      });
      await page.goto('http://polyrental.test/miniapp');
      if (admin) {
        await page.locator('#admin-panel').waitFor({state:'visible'});
        assert.equal(await page.locator('#onboarding-dialog').isHidden(), true);
        await page.getByRole('button',{name:'Каталог',exact:true}).click();
        await page.locator('#tab-new').click();
      }
      const dialog = page.locator('#onboarding-dialog');
      await dialog.waitFor({state:'visible'});
      assert.equal(await dialog.locator('h2').innerText(),'Выбор дат');
      await dialog.getByRole('button',{name:'Далее'}).click();
      assert.equal(await dialog.locator('h2').innerText(),'Каталог и подборка');
      await dialog.getByRole('button',{name:'Пропустить'}).click();
      await dialog.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.querySelector('#onboarding-dialog').hidden);
      if (admin) {
        await page.locator('#tab-admin').click();
        await page.getByText('Показано моделей: 0 из 0').waitFor();
        assert.equal(switches, 1);
      }
      await page.locator('#tab-orders').click();
      assert.equal(identityRequests, 0);
      assert.equal(await page.locator('#profile-avatar-fallback').innerText(), 'Q');
      await page.getByRole('button',{name:'Показать данные'}).click();
      assert.equal(identityRequests, 1);
      await page.locator('#profile-identity-fields').getByText('Номер паспорта:', {exact:false}).waitFor();
      assert.match(await page.locator('#profile-identity-fields').innerText(), /123456/);
      await page.getByRole('button',{name:'Скрыть данные'}).click();
      assert.equal(await page.locator('#profile-identity-fields').innerText(), '');
      await page.locator('#profile-number').fill('ТС260001');
      await page.waitForFunction(() => document.querySelector('#orders-content').textContent.includes('В этой категории заявок пока нет'));
      await page.waitForTimeout(500);
      assert.equal(historySearch, 'ТС260001');
      assert.equal(await page.getByRole('button',{name:'Найти',exact:true}).count(), 0);
      await page.locator('#profile-header > summary').click();
      await page.locator('#reminders-enabled').uncheck();
      assert.equal(reminders, false);
      await page.getByRole('button',{name:'Как пользоваться'}).click();
      assert.equal(await dialog.locator('h2').innerText(),'Выбор дат');
      await dialog.getByRole('button',{name:'Пропустить'}).click();
      await page.waitForTimeout(50);
      assert.equal(completed, 2);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Client and operator onboarding checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
