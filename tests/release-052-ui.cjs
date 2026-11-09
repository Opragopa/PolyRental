const {chromium,webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {fixture,base} = require('./completion-ui.cjs');
const assets = path.resolve(__dirname,'../app/miniapp_static');
const html = fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','0.5.2');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#416b66"/><circle cx="60" cy="60" r="35" fill="#bce1c7"/></svg>';
(async()=>{
 const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
 const browser = await engine.launch({headless:true,...(engine===chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
 try {
  fs.mkdirSync('artifacts/release-052',{recursive:true});
  for (const width of [320,390]) {
   const page = await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true});
   const errors=[]; page.on('pageerror',error=>errors.push(error.message));
   let color='all', calendarCalls=0, avatarRoute;
   let cart={start:'',end:'',lines:[],version:0};
   const item={id:1,name:'Камера Sony',category:'camera',sku:'CAM',capacity:3,composition:'Камера\nКрышка\nКабель',image_url:'https://images.test/camera.svg'};
   await page.route('**/*', async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42,photo_url:"https://images.test/avatar.svg"}}}}'});
    if(url.pathname==='/avatar.svg'){avatarRoute=route;return;}
    if(url.hostname==='images.test')return route.fulfill({contentType:'image/svg+xml',body:svg});
    if(url.pathname.startsWith('/miniapp/static/')){const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream'});}
    if(url.pathname==='/api/miniapp/me')return route.fulfill({json:{id:42,admin:false}});
    if(url.pathname==='/api/miniapp/profile')return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking'}});
    if(url.pathname==='/api/miniapp/cart'){if(route.request().method()==='PUT')cart={...route.request().postDataJSON(),version:cart.version+1};return route.fulfill({json:cart});}
    if(url.pathname==='/api/miniapp/catalog')return route.fulfill({json:{items:[item],selected_items:[item],total:1,page:0,page_size:20}});
    if(url.pathname==='/api/miniapp/availability/calendar'){
     calendarCalls++;const request=route.request().postDataJSON(),first=new Date(request.first_day+'T12:00:00Z');
     const daily=Object.fromEntries(Array.from({length:42},(_,i)=>{const date=new Date(first);date.setUTCDate(date.getUTCDate()+i);const day=date.toISOString().slice(0,10);return [day,day==='2026-10-30'?color:day==='2026-11-02'?'all':['all','partial','none'][i%3]];}));
     return route.fulfill({json:{selected:color,days:daily,daily}});
    }
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[]}});
    return route.fulfill({contentType:'text/html',body:html});
   });
   await page.clock.install({time:new Date('2026-10-29T10:00:00Z')});
   await page.goto('http://polyrental.test/miniapp',{waitUntil:'domcontentloaded'});
   await page.locator('.item-card').waitFor();
   assert.equal(await page.locator('#tab-avatar').evaluate(el=>el.classList.contains('avatar-loading')),true);
   assert.equal(await page.locator('#tab-avatar').evaluate(el=>getComputedStyle(el,'::after').animationName),'avatar-light-sweep');
   if (width===320) await avatarRoute.fulfill({contentType:'image/svg+xml',body:svg}); else await avatarRoute.abort();
   await page.waitForFunction(()=>!document.querySelector('#tab-avatar').classList.contains('avatar-loading'));
   assert.equal(await page.locator('#tab-avatar img').count(),width===320 ? 1 : 0);
   await page.locator('.client-item-details summary').click();
   assert.match(await page.locator('.composition-text').innerText(),/Камера\nКрышка\nКабель/);
   const clear=await page.locator('#clear-cart').boundingBox(),main=await page.locator('#main-button').boundingBox();
   assert.ok(Math.abs(clear.width/main.width-.5)<.02); // One third of the available action width.
   await page.locator('.item-card .plus').click();await page.locator('#main-button').click();
   await page.locator('#cart-items img').waitFor();
   assert.equal(await page.locator('#cart-items img').evaluate(img=>img.complete && img.naturalWidth>0),true);
   await page.locator('#cart-items .plus').click();assert.equal(await page.locator('#cart-items .quantity-control strong').innerText(),'2');
   await page.locator('#cart-items .minus').click();assert.equal(await page.locator('#cart-items .quantity-control strong').innerText(),'1');
   await page.locator('#customer-name').fill('Анна');await page.locator('#customer-contact').fill('@anna_user');await page.locator('#main-button').click();
   await page.clock.runFor(300);
   await page.locator('#range-calendar [data-availability]').first().waitFor();
   assert.equal(await page.locator('#start-date').inputValue(),'','daily colors are available before choosing dates');
   await page.locator('[data-date="2026-10-30"]').click();await page.locator('[data-date="2026-11-02"]').click();
   assert.equal(await page.locator('#start-time').inputValue(),'');assert.equal(await page.locator('#end-time').inputValue(),'');
   await page.locator('#main-button').click();assert.equal(await page.locator('#start-time').getAttribute('aria-invalid'),'true');
   await page.clock.runFor(300);await page.locator('[data-date="2026-10-30"][data-availability="all"]').waitFor();
   assert.ok(calendarCalls>0);assert.ok(await page.locator('.calendar-availability-partial').count());assert.ok(await page.locator('.calendar-availability-none').count());
   color='partial';await page.locator('#start-time').fill('10:00');await page.clock.runFor(300);await page.locator('[data-date="2026-10-30"][data-availability="partial"]').waitFor();
   color='none';await page.locator('#end-time').fill('18:00');await page.clock.runFor(300);await page.locator('[data-date="2026-10-30"][data-availability="none"]').waitFor();
   assert.equal(await page.locator('[data-date="2026-10-30"]').evaluate(el=>getComputedStyle(el,'::before').backgroundColor),'rgb(251, 220, 222)');
   assert.equal(await page.locator('[data-date="2026-11-02"]').getAttribute('data-availability'),'all','a red selected interval must not recolor individually free days');
   const delays=await page.locator('#range-calendar .calendar-day').evaluateAll(nodes=>Object.fromEntries(nodes.filter(el=>el.dataset.availability).map(el=>[el.dataset.date,parseFloat(el.style.getPropertyValue('--availability-reveal-delay'))])));
   assert.ok(delays['2026-10-31']>delays['2026-10-30'] && delays['2026-11-06']>delays['2026-10-30'],'daily colors reveal diagonally from top left');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:`artifacts/release-052/calendar-${width}.png`,fullPage:true});
   await page.locator('#top-back-button').click();await page.locator('#top-back-button').click();
   page.once('dialog',dialog=>dialog.dismiss());await page.locator('#clear-cart').click();assert.equal(await page.locator('#selected-count').innerText(),'1');
   page.once('dialog',dialog=>dialog.accept());await page.locator('#clear-cart').click();assert.equal(await page.locator('#selected-count').innerText(),'0');
   await page.clock.runFor(400);await page.waitForFunction(()=>document.querySelector('#clear-cart').disabled);assert.deepEqual(cart.lines,[]);
   assert.deepEqual(errors,[]);await page.close();

   const staff=await fixture(browser,{admin:true,role:'admin',order:base('pending'),width});
   let savedOwner, savedFeature;
   const asset={id:21,serial:'SN-052',asset_code:'CAM-1',inventory_code:'INV-052',condition:'available',owner:'Владелец QA',features:[{id:1,description:'Царапина',source:'catalog'}],external_blocks:[{start:'2026-10-28T10:00:00+03:00',end:'2026-11-03T10:00:00+03:00',reason:'Внешняя работа'}]};
   await staff.page.route('**/api/miniapp/admin/catalog?*',route=>route.fulfill({json:{articles:[{id:1,name:'Камера Sony',category:'camera',sku:'CAM',active:true,equipment:[asset]}],categories:[],dependencies:[],page:0,page_size:20,total:1}}));
   await staff.page.route('**/api/miniapp/admin/catalog/equipment/21/features',route=>{
    if(route.request().method()==='POST'){savedFeature=route.request().postDataJSON();asset.features.push({id:2,description:savedFeature.description,source:'catalog'});return route.fulfill({json:{id:2}});}
    return route.fulfill({json:{features:asset.features}});
   });
   await staff.page.route('**/api/miniapp/admin/catalog/equipment/21/owner',route=>{savedOwner=route.request().postDataJSON();return route.fulfill({json:{ok:true}});});
   await staff.page.locator('[data-mode="catalog"]').click();
   assert.equal(await staff.page.locator('.article-toggle').getAttribute('aria-expanded'),'false');
   assert.equal(await staff.page.getByRole('button',{name:/Изменить экземпляр:/}).count(),0);
   await staff.page.locator('.article-toggle').click();await staff.page.getByText('Занят вне сервиса',{exact:true}).waitFor();
   assert.equal(await staff.page.locator('.equipment-details').getAttribute('open'),null);
   await staff.page.locator('.equipment-details summary').click();await staff.page.getByText('INV-052',{exact:true}).waitFor();
   await staff.page.clock.runFor(500);
   assert.equal(await staff.page.locator('.article-collapse-inner').evaluate(el=>el.scrollTop),0);
   assert.equal(await staff.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await staff.page.screenshot({path:`artifacts/release-052/catalog-${width}.png`,fullPage:true});
   const pencil=await staff.page.getByRole('button',{name:/Изменить экземпляр:/}).boundingBox(),cross=await staff.page.getByRole('button',{name:/Удалить экземпляр:/}).boundingBox();assert.ok(cross.x>pencil.x);
   staff.page.once('dialog',dialog=>dialog.dismiss());await staff.page.getByRole('button',{name:/Удалить экземпляр:/}).click();
   await staff.page.getByRole('button',{name:/Изменить экземпляр:/}).click();
   await staff.page.getByRole('button',{name:'Добавить особенность'}).waitFor();
   assert.equal(await staff.page.locator('.equipment-owner-form [name="name"]').inputValue(),'Владелец QA');
   assert.equal(await staff.page.getByRole('button',{name:'Указать или изменить занятость'}).isVisible(),true);
   await staff.page.locator('.equipment-owner-form [name="name"]').fill('Новый владелец');
   staff.page.once('dialog',dialog=>dialog.dismiss());await staff.page.locator('#top-back-button').click();assert.equal(await staff.page.locator('.equipment-owner-form').isVisible(),true);
   await staff.page.getByRole('button',{name:'Сохранить владельца'}).click();await staff.page.getByText('Владелец сохранён',{exact:true}).waitFor();assert.equal(savedOwner.name,'Новый владелец');
   await staff.page.locator('.feature-add textarea').fill('Новая особенность');await staff.page.getByRole('button',{name:'Добавить особенность'}).click();
   await staff.page.locator('.feature-edit textarea').filter({hasText:'Новая особенность'}).waitFor();assert.equal(savedFeature.description,'Новая особенность');
   assert.deepEqual(staff.errors,[]);await staff.page.close();
  }
  console.log('0.5.2 mobile acceptance: photos, quantities, clear cart, empty times, calendar colors, avatar, collapsed inventory and editor passed');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
