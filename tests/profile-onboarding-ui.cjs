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
      const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, colorScheme:admin?'dark':'light'});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let seen = false, completed = 0, switches = 0, reminders = true, historySearch = '', identityRequests = 0;
      let identityDelay = null;
      let identity = {phone:'+79990000000',full_name:'Тестовый Клиент', birth_date:'2000-01-01', passport_series:'0000', passport_number:'123456', passport_issued_at:'2020-01-01', passport_issuer:'Тестовый отдел', passport_division_code:'123-456', registration_address:'Тестовая улица', residential_address:'Тестовый адрес', student_id_number:'', student_institution:''};
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'telegram.org') return route.fulfill({contentType:'text/javascript', body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
        if (url.pathname.startsWith('/miniapp/static/')) { const file = path.join(assets, path.basename(url.pathname)); return route.fulfill({body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript'}); }
        if (url.pathname === '/api/miniapp/me') return route.fulfill({json:{id:admin ? 100 : 42, admin, pii_admin:false}});
        if (url.pathname === '/api/miniapp/profile') return route.fulfill({json:{display_name:'QA', member_since:'2026-01-01T00:00:00Z', onboarding_seen:seen, reminders_enabled:reminders, start_screen:admin ? 'management' : 'booking'}});
        if (url.pathname === '/api/miniapp/profile/identity') { if (route.request().method() === 'PUT') identity = route.request().postDataJSON(); else { identityRequests++; if(identityDelay) await identityDelay; } return route.fulfill({json:{fields:identity}}); }
        if (url.pathname === '/api/miniapp/profile/reminders') { reminders = route.request().postDataJSON().enabled; return route.fulfill({json:{enabled:reminders}}); }
        if (url.pathname === '/api/miniapp/onboarding/show') { const first = !seen; seen = true; return route.fulfill({json:{first_show:first}}); }
        if (url.pathname === '/api/miniapp/onboarding/complete') { completed++; return route.fulfill({json:{status:'ok'}}); }
        if (url.pathname === '/api/miniapp/operator/client-mode') { switches++; return route.fulfill({json:{status:'ok'}}); }
        if (url.pathname === '/api/miniapp/admin/catalog') return route.fulfill({json:{articles:[],dependencies:[]}});
        if (url.pathname === '/api/miniapp/profile/history') { historySearch = url.searchParams.get('number'); return route.fulfill({json:{items:[],total:historySearch ? 0 : 30}}); }
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
      assert.equal(await dialog.locator('h2').innerText(),'Каталог и подборка');
      await dialog.getByRole('button',{name:'Далее'}).click();
      assert.equal(await dialog.locator('h2').innerText(),'Выбор дат');
      await dialog.getByRole('button',{name:'Пропустить'}).click();
      await dialog.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.querySelector('#onboarding-dialog').hidden);
      if (admin) {
        await page.locator('#tab-admin').click();
        await page.getByText('Показано моделей: 0 из 0').waitFor();
        assert.equal(switches, 1);
      }
      await page.locator('#tab-orders').click();
      await page.locator('#profile-pagination').waitFor({state:'visible'});
      assert.equal(identityRequests, 0);
      assert.equal(await page.locator('#profile-avatar-fallback').innerText(), 'Q');
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({width, height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Profile overflows at ${width}px`);
        assert.equal(await page.locator('#profile-disclosure').evaluate(node=>node.open),false);
        assert.equal(await page.locator('.profile-private').isVisible(),false);
        const spacing=await page.locator('#profile-pagination').evaluate(row=>{
          const below=document.querySelector('.profile-preferences').getBoundingClientRect();
          const back=row.querySelector('#profile-prev').getBoundingClientRect();
          return {gap:parseFloat(getComputedStyle(row).gap),below:below.top-back.bottom};
        });
        assert(spacing.gap>=12 && spacing.below>=12, `Profile navigation touches adjacent blocks at ${width}px: ${JSON.stringify(spacing)}`);
      }
      await page.setViewportSize({width:390, height:844});
      await page.locator('#profile-disclosure > summary').click();
      await page.locator('.profile-identity-row').first().waitFor();
      assert.equal(identityRequests,1,'opening loads the actual form beneath the blur');
      assert.equal(await page.locator('.profile-fields-masked .profile-identity-value').count(),Object.values(identity).filter(Boolean).length);
      assert.match(await page.locator('.profile-fields-masked .profile-identity-value').first().evaluate(node=>getComputedStyle(node).filter),/blur/);
      assert.match(await page.locator('#profile-identity-fields').innerText(),/123456/);
      await page.waitForFunction(() => document.querySelector('#profile-disclosure').style.overflow !== 'hidden');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const fieldGeometry = () => page.locator('#profile-identity-fields').evaluate(fields => {
        const origin=fields.getBoundingClientRect().top;
        return [...fields.querySelectorAll('.profile-identity-row')].map(row => {
          const bounds=row.getBoundingClientRect();
          return {top:bounds.top-origin,height:bounds.height,text:row.textContent};
        });
      });
      const geometry=await fieldGeometry();
      await page.evaluate(()=>window.profileValueNodes=[...document.querySelectorAll('.profile-identity-value')]);
      if(process.env.QA_SCREENSHOTS){fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});await page.waitForTimeout(300);await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`profile-masked-${admin}.png`),fullPage:true});}
      await page.locator('.profile-fields-masked .profile-identity-row').nth(1).click();
      assert.equal(identityRequests, 1);
      const revealed=await fieldGeometry();
      assert.deepEqual(revealed.map(row=>row.text),geometry.map(row=>row.text));
      assert(revealed.every((row,index)=>Math.abs(row.top-geometry[index].top)<=1 && Math.abs(row.height-geometry[index].height)<=1),
        `blur toggle keeps field alignment: ${JSON.stringify({geometry, revealed})}`);
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.profile-identity-value')].every((node,index)=>node===window.profileValueNodes[index])),true,'reveal keeps the same text nodes');
      if(process.env.QA_SCREENSHOTS){fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`profile-revealed-${admin}.png`),fullPage:true});}
      await page.locator('#profile-identity-fields').getByText('Номер паспорта:', {exact:false}).waitFor();
      assert.match(await page.locator('#profile-identity-fields').innerText(), /123456/);
      await page.getByRole('button',{name:'Редактировать',exact:true}).click();
      const edit = page.locator('.workflow-dialog');
      await edit.locator('[name="residential_address"]').fill('Новый тестовый адрес');
      await edit.getByRole('button',{name:'Сохранить',exact:true}).click();
      await edit.waitFor({state:'detached'});
      await page.locator('#profile-identity-fields').getByText('Новый тестовый адрес').waitFor();
      assert.equal(identity.residential_address, 'Новый тестовый адрес');
      await page.getByRole('button',{name:'Скрыть данные'}).click();
      assert.match(await page.locator('#profile-identity-fields').innerText(),/Новый тестовый адрес/);
      assert.equal(await page.locator('.profile-fields-masked .profile-identity-value').count(),Object.values(identity).filter(Boolean).length);
      await page.locator('#profile-disclosure > summary').click();
      await page.waitForFunction(()=>!document.querySelector('#profile-disclosure').open);
      await page.locator('#profile-disclosure > summary').click();
      await page.locator('.profile-fields-masked .profile-identity-row').first().focus(); await page.keyboard.press('Enter');
      await page.locator('#profile-identity-fields').getByText('Новый тестовый адрес').waitFor();
      await page.locator('#tab-new').click();
      assert.doesNotMatch(await page.locator('#profile-identity-fields').innerText(),/123456|Новый тестовый адрес/);
      await page.locator('#tab-orders').click();
      assert.equal(await page.locator('#profile-disclosure').evaluate(node=>node.open),false);
      let releaseIdentity; identityDelay=new Promise(resolve=>releaseIdentity=resolve);
      const lateRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/miniapp/profile/identity');
      const lateResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/miniapp/profile/identity');
      await page.locator('#profile-disclosure > summary').click(); await lateRequest;
      await page.locator('#profile-disclosure > summary').click();
      await page.waitForFunction(()=>!document.querySelector('#profile-disclosure').open);
      releaseIdentity(); await lateResponse; identityDelay=null;
      assert.doesNotMatch(await page.locator('#profile-identity-fields').innerText(),/123456|Новый тестовый адрес/,'late response must not reveal a closed profile');
      await page.locator('#profile-number').fill('ТС260001');
      await page.waitForFunction(() => document.querySelector('#orders-content').textContent.includes('В этой категории заявок пока нет'));
      await page.waitForTimeout(500);
      assert.equal(historySearch, 'ТС260001');
      assert.equal(await page.getByRole('button',{name:'Найти',exact:true}).count(), 0);
      await page.locator('#profile-header > summary').click();
      await page.locator('#reminders-enabled').uncheck();
      assert.equal(reminders, false);
      await page.getByRole('button',{name:'Как пользоваться'}).click();
      assert.equal(await dialog.locator('h2').innerText(),'Каталог и подборка');
      await dialog.getByRole('button',{name:'Пропустить'}).click();
      await page.waitForTimeout(50);
      assert.equal(completed, 2);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Client and operator onboarding checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
