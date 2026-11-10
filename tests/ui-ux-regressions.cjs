/* Delayed responses, pending modal focus, nested scroll locks and support drafts. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  {
   const {page,errors}=await fixture(browser,{order:base('pending')});
   const item={id:1,name:'Камера Sony',title:'Камера Sony',sku:'CAM',category:'generic',available:true,available_quantity:3};
   const availability=gate();
   await page.route('**/api/miniapp/catalog?*',route=>route.fulfill({json:{items:[item],selected_items:[item],page:0,page_size:20,total:1}}));
   await page.route('**/api/miniapp/cart',route=>route.fulfill({json:{...route.request().postDataJSON(),version:1}}));
   await page.route('**/api/miniapp/availability?*',async route=>{await availability.promise;await route.fulfill({json:{items:[item],all_items:[item],selected_items:[item],unavailable_count:0,unavailable:[]}});});
   await page.locator('#tab-new').click();
   await page.locator('#client-categories .category-card').filter({hasText:'Оборудование'}).click();
   await page.locator('.item-card .plus').first().click();await page.locator('#main-button').click();
   await page.locator('#customer-name').fill('Анна');await page.locator('#customer-contact').fill('@anna_qa');
   await page.locator('#main-button').click();
   await page.locator('[data-date="2026-11-03"]').click();await page.locator('[data-date="2026-11-04"]').click();
   await page.locator('#start-time').fill('10:00');await page.locator('#end-time').fill('18:00');
   const started=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/miniapp/availability');
   await page.locator('#main-button').click();await started;
   await page.locator('#top-back-button').click();
   await page.locator('#customer-name').fill('Исправленное имя');
   // Returning to dates before the old response arrives must not revive its navigation.
   await page.locator('#main-button').click();
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/miniapp/availability');
   availability.resolve();await response;await page.waitForTimeout(300);
   assert.equal(await page.locator('#step-dates').isVisible(),true,'old response must not advance a re-entered step');
   assert.equal(await page.locator('#main-button').isEnabled(),true,'abandoned check releases busy state');
   await page.locator('#main-button').click();await page.locator('#step-review').waitFor();
   assert.match(await page.locator('#review-content').innerText(),/Исправленное имя/);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const order=base('issued');order.handover.received_at='2026-10-29T10:00:00Z';
   const {page,errors}=await fixture(browser,{order});
   const response=gate();let calls=0;
   await page.route('**/api/miniapp/bookings/7/attest',async route=>{calls++;await response.promise;await route.fulfill({status:503,json:{detail:'Тестовая ошибка отправки'}});});
   await page.getByRole('button',{name:'Сдаю оборудование',exact:true}).click();
   const dialog=page.locator('.workflow-dialog');
   await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();
   for(const key of ['Tab','Tab','Shift+Tab','Tab']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.workflow-dialog')),true,'pending dialog owns focus');
   }
   assert.equal(await page.locator('#tab-new').evaluate(el=>!!el.closest('[inert]')),true,'background navigation is inert');
   response.resolve();await dialog.locator('.workflow-error').waitFor();
   assert.equal(await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).isEnabled(),true);
   assert.equal(calls,1);await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
   await dialog.waitFor({state:'detached'});
   await page.waitForFunction(()=>document.activeElement.textContent==='Сдаю оборудование',{},{timeout:3000});
   assert.equal(await page.evaluate(()=>document.activeElement.textContent==='Сдаю оборудование'),true);
   assert.equal(await page.locator('#tab-new').evaluate(el=>!!el.closest('[inert]')),false);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser,{order:base('pending'),isMobile:false});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
   await page.locator('#profile-header > summary').click();
   const open=page.locator('#profile-support');await open.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
   const before=await open.evaluate(el=>({y:el.getBoundingClientRect().y,scroll:scrollY}));
   await open.click();const dialog=page.locator('#support-dialog');await dialog.waitFor();
   await dialog.locator('#support-question').fill('Неотправленный вопрос');
   await page.mouse.move(2,100);await page.mouse.wheel(0,-1000);await page.waitForTimeout(100);
   const locked=await open.evaluate(el=>el.getBoundingClientRect().y);
   // A second modal temporarily owns focus; closing it must keep the first lock.
   await page.evaluate(()=>{const el=document.createElement('section');el.id='nested-test';el.className='dialog-backdrop workflow-dialog';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.innerHTML='<div class="dialog-card"><button>Закрыть вложенное</button></div>';document.body.append(el);});
   await page.waitForFunction(()=>!!document.querySelector('#support-dialog').closest('[inert]'));
   await page.evaluate(()=>document.querySelector('#nested-test').remove());
   await page.waitForFunction(()=>!document.querySelector('#support-dialog').closest('[inert]'));
   assert.equal(await page.evaluate(()=>document.body.style.position),'fixed','nested close preserves scroll lock');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   const after=await page.evaluate(()=>scrollY);
   assert.ok(Math.abs(after-before.scroll)<=3,`close restores scroll position: ${JSON.stringify({before,after,locked})}`);
   assert.ok(Math.abs(locked-before.y)<=3,'backdrop wheel does not move background');
   await open.click();assert.equal(await dialog.locator('#support-question').inputValue(),'Неотправленный вопрос');
   await dialog.getByRole('button',{name:'Отправить вопрос'}).click();await dialog.locator('#support-result.success').waitFor();
   await dialog.locator('#support-close').click();await dialog.waitFor({state:'hidden'});
   // Per-booking drafts and the profile draft must not share text.
   await page.locator('#orders-content .customer-actions > summary').click();
   await page.locator('#orders-content .customer-order-body').getByRole('button',{name:'Поддержка',exact:true}).click();
   assert.equal(await dialog.locator('#support-question').inputValue(),'');
   await dialog.locator('#support-question').fill('Вопрос по заявке');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await open.click();assert.equal(await dialog.locator('#support-question').inputValue(),'','successful send clears profile draft');
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('UI/UX regressions: delayed navigation, pending focus, nested scroll lock and context drafts passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
