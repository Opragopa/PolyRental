const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture}=require('./completion-ui.cjs');
const items=[
 {id:'d:1',kind:'booking',title:'Заявка ТС260007',summary:'Оборудование готово к выдаче',message:'Заявка ТС260007\nГотово к выдаче\nАвтор: Оператор\nОткрыть заявку',created_at:'2026-10-29T09:55:00Z'},
 {id:'s:2',kind:'support',title:'Поддержка',summary:'Новое сообщение от оператора',created_at:'2026-10-29T09:00:00Z'},
 {id:'d:3',kind:'booking',title:'Заявка ТС260006',summary:'Возврат завершён',created_at:'2026-10-28T10:00:00Z'}
];
(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true});
 try {
  for(const width of [320,390,1440]) for(const theme of ['light','dark']) {
   const {page,errors}=await fixture(browser,{width,isMobile:width<700});let read=[];
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.style='frame';},theme);
   await page.route('**/api/miniapp/notifications/inbox?*',r=>r.fulfill({json:{items,unread:read.length===0,has_more:false}}));
   await page.route('**/api/miniapp/notifications/inbox/read',r=>{read.push(...r.request().postDataJSON().ids);return r.fulfill({json:{ok:true}});});
   await page.locator('#tab-new').click();
   const bell=page.locator('.catalog-search > .notification-bell');await bell.click();
   await page.locator('#notification-items .notification-item').nth(2).waitFor();
   const dialog=page.locator('#notification-dialog'),copy=await dialog.innerText();
   assert(!copy.includes('Автор:'));assert(!copy.includes('Открыть заявку'));
   assert.match(copy,/5 минут назад/);assert.equal(await dialog.getByRole('button',{name:'Закрыть',exact:true}).count(),0);
   assert.equal(await page.locator('#notification-more').isVisible(),false);
   const card=await dialog.locator('.dialog-card').boundingBox();
   assert(card.x>=0&&card.x+card.width<=width+1);
   const center=await page.locator('#notification-close').evaluate(el=>{
    const a=el.getBoundingClientRect(),b=el.querySelector('svg').getBoundingClientRect();
    return {x:Math.abs(a.x+a.width/2-b.x-b.width/2),y:Math.abs(a.y+a.height/2-b.y-b.height/2)};
   });assert(center.x<1&&center.y<1);
   await page.waitForFunction(()=>document.querySelector('#notification-items').getAttribute('aria-busy')==='false');
   assert.equal(read.length,3);
   fs.mkdirSync('artifacts/notification-panel',{recursive:true});
   if(width===390||width===1440)await page.screenshot({path:`artifacts/notification-panel/${engine.name()}-${width}-${theme}.png`});
   await page.locator('#notification-items').evaluate(el=>{for(let i=0;i<30;i++)el.append(el.firstElementChild.cloneNode(true));});
   assert(await page.locator('#notification-items').evaluate(el=>el.scrollHeight>el.clientHeight));
   const close=await page.locator('#notification-close').boundingBox();assert(close.y>=0&&close.y+close.height<=844);
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   assert(await bell.evaluate(el=>el===document.activeElement));
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser);let mode='error',offsets=[];
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.route('**/api/miniapp/notifications/inbox?*',r=>{
    const offset=Number(new URL(r.request().url()).searchParams.get('offset'));offsets.push(offset);
    if(mode==='error')return r.fulfill({status:503,json:{detail:'Unavailable'}});
    return r.fulfill({json:{items:mode==='empty'?[]:offset?items.slice(1):items.slice(0,1),unread:false,has_more:mode==='pages'&&!offset}});
   });
   await page.route('**/api/miniapp/notifications/inbox/read',r=>r.fulfill({json:{ok:true}}));
   await page.locator('#tab-new').click();await page.locator('.catalog-search > .notification-bell').click();
   await page.locator('#notification-retry').waitFor();
   mode='empty';await page.locator('#notification-retry').click();
   await page.getByText('Пока нет уведомлений',{exact:true}).waitFor();
   assert.equal(await page.locator('#notification-retry').isVisible(),false);
   await page.locator('#notification-close').click();mode='pages';
   await page.locator('.catalog-search > .notification-bell').click();
   await page.locator('#notification-more').waitFor();
   await page.waitForFunction(()=>!document.querySelector('#notification-more').disabled);
   await page.locator('#notification-more').click();
   await page.waitForFunction(()=>document.querySelectorAll('.notification-item').length===3);
   assert(offsets.includes(1));assert.equal(await page.locator('#notification-more').isVisible(),false);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser);
   const late={id:'d:4',kind:'booking',booking_id:7,staff:false,title:'Заявка ТС260007: возврат просрочен',
    summary:'Срок сдачи прошёл.',created_at:'2026-10-29T09:55:00Z'};
   await page.route('**/api/miniapp/notifications/inbox?*',r=>r.fulfill({json:{items:[late],unread:false,has_more:false}}));
   await page.route('**/api/miniapp/notifications/inbox/read',r=>r.fulfill({json:{ok:true}}));
   await page.locator('#tab-new').click();
   await page.locator('.catalog-search > .notification-bell').click();
   const dialog=page.locator('#notification-dialog');
   await dialog.getByRole('button',{name:'Связаться с оператором'}).waitFor();
   const history=page.waitForRequest(req=>new URL(req.url()).searchParams.get('booking_id')==='7');
   await dialog.getByRole('button',{name:'Открыть заявку'}).click();
   await history;
   await dialog.waitFor({state:'hidden'});
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log(`Compact notification panel (${engine.name()}): passed`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
