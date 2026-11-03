const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
(async () => {
  const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch({headless:true, ...(name === 'chromium' && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}}), errors=[];
    page.on('pageerror', error => errors.push(error.message));
    let nearestPayload=null;
    let cart={start:'2026-11-01T10:00',end:'2026-11-02T10:00',lines:[],version:0};
    const item={id:1,name:'Камера Sony',title:'Камера Sony',description:'',sku:'CAM',available:true,available_quantity:3};
    await page.route('**/*', async route => {
      const url=new URL(route.request().url());
      if (url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
      if (url.pathname.startsWith('/miniapp/static/')) {const file=path.join(assets,path.basename(url.pathname)); return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
      if (url.pathname==='/api/miniapp/me') return route.fulfill({json:{id:42,admin:false,pii_admin:false}});
      if (url.pathname==='/api/miniapp/profile') return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking',reminders_enabled:true}});
      if (url.pathname==='/api/miniapp/cart' && route.request().method()==='GET') return route.fulfill({json:cart});
      if (url.pathname==='/api/miniapp/cart' && route.request().method()==='PUT') {const next=route.request().postDataJSON(); if (next.version!==cart.version) return route.fulfill({status:409,json:{detail:'conflict'}}); cart={...next,version:cart.version+1}; return route.fulfill({json:cart});}
      if (url.pathname==='/api/miniapp/profile/history') return route.fulfill({json:{total:1,items:[{id:7,human_number:'ТС260007',status:'returned',identity_status:'verified',receipt_available:true,starts_at:'2026-10-01T10:00:00+03:00',ends_at:'2026-10-02T10:00:00+03:00',items:[{id:2,name:'Старый штатив',quantity:1}]}]}});
      if (url.pathname==='/api/miniapp/bookings/7/receipt') return route.fulfill({contentType:'application/pdf',headers:{'Content-Disposition':'attachment; filename="receipt-TS260007.pdf"'},body:'%PDF-synthetic'});
      if (url.pathname==='/api/miniapp/availability/nearest') { nearestPayload=route.request().postDataJSON(); return route.fulfill({json:{period:{start:'2026-11-09T10:00:00+03:00',end:'2026-11-10T10:00:00+03:00'},horizon_days:90}}); }
      if (url.pathname==='/api/miniapp/availability') { const available = url.searchParams.get('start')?.startsWith('2026-11-09') ? {...item,id:2,name:'Старый штатив',title:'Старый штатив',available_quantity:1} : item; const unavailable = {...item,id:3,name:'Недоступный свет',title:'Недоступный свет',available:false,available_quantity:0}; return route.fulfill({json:{items:[available],all_items:[available,unavailable],unavailable_count:1,unavailable:[]}}); }
      if (url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[]}});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.clock.install({time:new Date('2026-10-26T10:00:00Z')});
    await page.goto('http://polyrental.test/miniapp');
    await page.waitForFunction(() => !document.documentElement.classList.contains('role-pending'));
    await page.locator('#main-button').click();
    await page.getByRole('button',{name:'Увеличить количество: Камера Sony'}).click();
    await page.locator('#main-button').click();
    await page.locator('#cart-items').getByRole('button',{name:'Увеличить количество'}).click();
    assert.match(await page.locator('#cart-total').innerText(), /2 шт/);
    await page.locator('#customer-name').fill('Анна');
    await page.locator('#customer-contact').fill('@anna_user');
    await page.locator('#main-button').click();
    await page.locator('#review-content .review-plus').click();
    assert.match(await page.locator('#review-content').innerText(), /3 шт\. в заявке/);
    await page.locator('#review-content .review-minus').click();
    assert.match(await page.locator('#review-content').innerText(), /2 шт\. в заявке/);
    await page.locator('#top-back-button').click();
    await page.clock.runFor(400);
    await page.waitForFunction(() => !document.querySelector('#mode-banner').textContent.includes('Не удалось синхронизировать'));
    assert.equal(cart.lines[0].quantity,2);
    await page.locator('#top-back-button').click();
    await page.getByRole('button',{name:'Изменить даты'}).click();
    await page.locator('[data-date="2026-11-03"]').click();
    await page.locator('[data-date="2026-11-04"]').click();
    await page.locator('#main-button').click();
    await page.waitForFunction(() => document.querySelector('#selected-count').textContent === '2');
    assert.match(await page.locator('#selected-count').innerText(),/2/);
    await page.locator('#tab-orders').click();
    await page.locator('#orders-content .customer-order-toggle').first().click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button',{name:'Скачать расписку',exact:true}).click();
    assert.match((await downloadPromise).suggestedFilename(), /\.pdf$/);
    await page.getByRole('button',{name:'Повторить заявку'}).click();
    assert.equal(await page.locator('#start-date').inputValue(), '');
    await page.locator('[data-date="2026-11-05"]').click();
    await page.locator('[data-date="2026-11-06"]').click();
    await page.locator('#main-button').click();
    await page.getByText('Старый штатив', {exact:true}).first().waitFor();
    assert.match(await page.locator('.item-card').filter({hasText:'Старый штатив'}).innerText(), /Нет в наличии/);
    await page.clock.runFor(400);
    await page.waitForFunction(() => !document.querySelector('#mode-banner').textContent.includes('Не удалось синхронизировать'));
    assert.deepEqual(cart.lines, [{article_id:2, quantity:1}]);
    await page.getByRole('button',{name:'Найти ближайшие сроки для подборки'}).click();
    await page.getByRole('button',{name:'Выбрать эти сроки'}).waitFor();
    assert.deepEqual(nearestPayload.lines, [{article_id:2, quantity:1}]);
    await page.getByRole('button',{name:'Выбрать эти сроки'}).click();
    await page.getByText('Новые сроки выбраны, доступность проверена.').waitFor();
    assert.equal(await page.locator('#start-date').inputValue(), '2026-11-09');
    assert.equal(await page.locator('#end-date').inputValue(), '2026-11-10');
    await page.getByRole('button',{name:'Добавить для поиска сроков: Недоступный свет'}).click();
    await page.getByRole('button',{name:'Найти ближайшие сроки для подборки'}).waitFor();
    assert.equal(await page.locator('#selected-count').innerText(), '2');
    assert.deepEqual(errors, []);
    console.log('Versioned cart and date change checks passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
