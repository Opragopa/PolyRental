const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,base}=require('./completion-ui.cjs');
const settle=page=>page.waitForFunction(()=>!document.querySelector('#admin-panel').getAnimations({subtree:true}).some(a=>a.playState==='running'));
async function centeredIcons(page,label) {
 const offsets=await page.evaluate(()=>[...document.querySelectorAll('.catalog-search-back, .notification-bell, .icon-action, .catalog-layout-icon, .category-card-icon, .catalog-manage-categories, .category-edit, .category-delete')].flatMap(el=>{
  const svg=el.querySelector(':scope > svg'),a=el.getBoundingClientRect(),b=svg?.getBoundingClientRect();
  return b&&a.width&&a.height&&b.width?[{id:el.id||el.className,x:Math.abs(a.x+a.width/2-b.x-b.width/2),y:Math.abs(a.y+a.height/2-b.y-b.height/2)}]:[];
 }));
 assert(offsets.length>0);
 assert.deepEqual(offsets.filter(row=>row.x>1||row.y>1),[],`${label}: icons are centered`);
}

(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  {
   const page=await browser.newPage();
   await page.setContent('<div id="host"><div id="content" style="height:100px"></div></div>');
   await page.addScriptTag({content:fs.readFileSync('app/miniapp_static/motion.js','utf8')});
   await page.evaluate(()=>PolyRentalMotion.surface(document.querySelector('#host'),()=>document.querySelector('#content').style.height='300px'));
   await page.waitForFunction(()=>{const h=document.querySelector('#host').getBoundingClientRect().height;return h>110&&h<290;});
   const reversal=await page.evaluate(()=>{
    const host=document.querySelector('#host'),before=host.getBoundingClientRect().height;
    PolyRentalMotion.surface(host,()=>document.querySelector('#content').style.height='160px');
    return {before,after:host.getBoundingClientRect().height};
   });
   assert(Math.abs(reversal.before-reversal.after)<1,'rapid changes start at the visible height');
   await page.evaluate(()=>document.querySelector('#content').style.height='420px');
   await page.waitForFunction(()=>document.querySelector('#host').getAnimations().length===0);
   assert.equal(await page.locator('#host').evaluate(el=>el.getBoundingClientRect().height),420,'late content determines the final height');
   await page.evaluate(()=>{PolyRentalMotion.surface(document.querySelector('#host'),()=>document.querySelector('#content').style.height='100px');PolyRentalMotion.cancelTransient();});
   assert.equal(await page.locator('#host').evaluate(el=>el.getAnimations().length),0);
   assert.equal(await page.locator('#host').evaluate(el=>el.style.overflow),'');
   await page.close();
  }
  for(const reducedMotion of ['no-preference','reduce']) {
   const {page,errors}=await fixture(browser,{admin:true,role:'admin',order:base('issued')});
   await page.emulateMedia({reducedMotion});
   await page.route('**/api/miniapp/admin/handover-settings',r=>r.fulfill({json:{pickup_location:'Тестовый склад',pickup_instructions:'По времени заявки'}}));
   await page.route('**/api/miniapp/admin/booking-settings',r=>r.fulfill({json:{rental_purpose_enabled:true}}));
   await page.locator('#admin-settings-open').click();
   await page.locator('#settings-tab-handover').click();
   await page.locator('#settings-tab-calendar').click();
   await page.locator('#settings-tab-booking').click();
   await page.locator('#settings-tab-notifications').click();
   const details=page.locator('#operator-notification-settings');
   await details.locator('summary').click();
   await page.waitForFunction(()=>!document.querySelector('#operator-notification-settings').open);
   assert.equal(await details.evaluate(el=>el.open),false);
   await details.locator('summary').focus();await page.keyboard.press('Enter');
   await settle(page);
   assert.equal(await details.evaluate(el=>el.open),true);
   assert.equal(await page.locator('#admin-settings [role=tabpanel]:not([hidden])').count(),1);
   assert.equal(await page.locator('#admin-panel').evaluate(el=>el.style.overflow),'');
   await page.locator('#settings-tab-notifications').focus();
   await page.keyboard.press('ArrowRight');
   assert.equal(await page.locator('#settings-tab-calendar').getAttribute('aria-selected'),'true');
   await settle(page);
   assert.equal(await page.locator('#admin-settings').evaluate(el=>el.getAnimations().length),0);
   await page.locator('#admin-back-button').click();
   await settle(page);
   assert.equal(await page.locator('#admin-settings').isVisible(),false);
   assert.equal(await page.locator('#admin-settings-open').evaluate(el=>el===document.activeElement),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  for(const width of [320,1440]) for(const style of ['classic','studio','frame']) for(const theme of ['light','dark']) {
   const {page,errors}=await fixture(browser,{admin:true,role:'admin',order:base('issued'),width,isMobile:width<700});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(({style,theme})=>{document.documentElement.dataset.style=style;document.documentElement.dataset.theme=theme;},{style,theme});
   await centeredIcons(page,`${width}/${style}/${theme}/operator`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(width===320&&style==='frame'&&theme==='light') {
    fs.mkdirSync('artifacts/settings-return',{recursive:true});
    await page.screenshot({path:`artifacts/settings-return/${engine.name()}-operator.png`,fullPage:true});
   }
   await page.locator('#tab-new').click();
   await page.locator('#client-categories .category-card').first().waitFor();
   await centeredIcons(page,`${width}/${style}/${theme}/customer`);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const order=base('issued'),{page,errors}=await fixture(browser,{admin:true,order});let calls=0;
   await page.route('**/return-without-customer',r=>{calls++;order.status='return_inspection';order.handover.operator_return={actor_id:100,at:new Date().toISOString()};return r.fulfill({json:order});});
   await page.getByRole('button',{name:'Подтвердить получение оборудования',exact:true}).click();
   assert.equal(calls,0);
   const dialog=page.locator('.workflow-dialog');
   assert.match(await dialog.innerText(),/оборудование уже у вас/);
   await dialog.getByRole('button',{name:'Подтвердить получение',exact:true}).click();
   await page.getByRole('button',{name:'Завершить заявку',exact:true}).waitFor();
   assert.equal(calls,1);assert.equal(order.handover.returning_at,undefined);
   assert.match(await page.locator('.handover-progress').innerText(),/Сотрудник подтвердил фактический возврат/);
   assert.equal(await page.getByRole('button',{name:'Завершить заявку',exact:true}).isDisabled(),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log(`Settings, centered icons and operator return (${engine.name()}): passed`);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
