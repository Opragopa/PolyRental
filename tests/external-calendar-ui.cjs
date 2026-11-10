const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture,base} = require('./completion-ui.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  for(const width of [320,390]) {
   const {page,errors}=await fixture(browser,{admin:true,role:'manager',order:base('pending'),width});
   await page.evaluate(()=>{window.__externalImpacts=[];window.Telegram.WebApp.HapticFeedback={impactOccurred:style=>window.__externalImpacts.push(style)};});
   const busy={id:4,kind:'booking',start:'2026-10-30T10:00:00+03:00',end:'2026-10-30T13:00:00+03:00',label:'Заявка ТС260004',reason:'Экземпляр назначен на заявку'};
   const writes=[]; let failSchedule=false;
   await page.route(/\/api\/miniapp\/admin\/catalog(?:\?|$)/,route=>route.fulfill({json:{categories:[{code:'camera',name:'Камера'}],articles:[{id:1,name:'Камера Sony',sku:'CAM',category:'camera',active:true,equipment:[{id:21,asset_code:'CAM-1',condition:'available',location:'A1'}]}],dependencies:[],total:1,page:0,page_size:20}}));
   await page.route('**/api/miniapp/admin/catalog/equipment/*/blocks',route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{items:[{id:8,start:busy.start,end:busy.end,reason:'Съёмка'}]}});
    writes.push(route.request().postDataJSON());return route.fulfill({json:{id:9,warnings:[busy]}});
   });
   await page.route('**/api/miniapp/admin/catalog/equipment/*/schedule',route=>route.fulfill(failSchedule?{status:503,json:{detail:'offline'}}:{json:{items:[busy]}}));
   await page.route('**/api/miniapp/admin/catalog/blocks/8',route=>{writes.push({released:8});return route.fulfill({json:{status:'released'}});});
   await page.locator('[data-mode="catalog"]').click();await page.getByRole('button',{name:'Камера',exact:true}).click();
   const openExternal = async () => {
    const toggle = page.locator('.article-toggle').first();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.getByRole('button',{name:/Изменить экземпляр:/}).first().click();
    await page.getByRole('button',{name:'Указать или изменить занятость'}).click();
   };
   await openExternal();
   let dialog=page.getByRole('dialog',{name:'Занятость вне сервиса'});
   await dialog.locator('[data-date="2026-10-30"].calendar-day-busy').waitFor();
   assert.equal(await dialog.locator('[type="datetime-local"]').count(),0);
   assert.equal(await dialog.locator('[data-date="2026-10-30"]').isDisabled(),false);
   await dialog.locator('[data-date="2026-10-30"]').click();await dialog.locator('[data-date="2026-10-30"]').click();
   assert.deepEqual(await page.evaluate(()=>window.__externalImpacts),['light','light'],'external calendar triggers one impact per date');
   await dialog.locator('.external-start-time').fill('11:00');await dialog.locator('.external-end-time').fill('12:00');
   await dialog.locator('.external-warning.has-overlap').waitFor();
   await dialog.locator('[name="reason"]').fill('Работа вне сервиса');
   assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.clock.runFor(800);await dialog.locator('.dialog-card').evaluate(el=>el.scrollTop=0);
   fs.mkdirSync('artifacts/external-calendar',{recursive:true});await dialog.screenshot({path:`artifacts/external-calendar/${width}.png`});
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await dialog.waitFor({state:'detached'});
   assert.deepEqual(writes[0],{start:'2026-10-30T11:00:00+03:00',end:'2026-10-30T12:00:00+03:00',reason:'Работа вне сервиса'});
   await page.locator('.stage-toast').getByText('Занятость сохранена. Есть пересечения: 1.').waitFor();
   // Releasing a note does not require dates or a reason.
   await openExternal();dialog=page.getByRole('dialog',{name:'Занятость вне сервиса'});
   await dialog.locator('[name="operation"]').selectOption('8');assert.equal(await dialog.locator('.external-period').isHidden(),true);
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(writes[1].released,8);
   // Schedule transport failure is visible and does not block recording a fact.
   failSchedule=true;await openExternal();dialog=page.getByRole('dialog',{name:'Занятость вне сервиса'});
   await dialog.getByText('Не удалось загрузить занятость. Отметку можно сохранить.').waitFor();
   await dialog.locator('[name="reason"]').fill('Офлайн предупреждение');
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(writes.length,3);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('External occupancy: shared calendar, selectable busy days, warnings without blocking, timezone, release, network failure and mobile width passed');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
