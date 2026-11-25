const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,base}=require('./completion-ui.cjs');
const guide=order=>({booking_id:order.id,human_number:order.human_number,status:order.status,identity_status:order.identity_status,
  title:order.status==='issued'?'Оборудование у вас':'Всё готово к выдаче',description:'Получение в согласованное время · МСК',
  action:order.status==='issued'?'return':'open',label:order.status==='issued'?'Сдать оборудование':'Открыть заявку',pickup_location:'Тестовый склад',pickup_instructions:'Приходите в своё время'});
(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  {
   const order=base('issued'),{page,errors,writes}=await fixture(browser,{order,width:320});
   assert.match(await page.locator('.equipment-features').innerText(),/царапина/);
   assert.match(await page.locator('.equipment-features').innerText(),/Частичная выдача/);
   await page.emulateMedia({reducedMotion:'reduce'});await page.clock.runFor(400);
   fs.mkdirSync('artifacts/release-0511',{recursive:true});await page.screenshot({path:`artifacts/release-0511/${engine.name()}-features.png`,fullPage:true});
   await page.route('**/api/miniapp/customer/next-actions',r=>r.fulfill({json:{items:[guide(order)]}}));
   await page.clock.runFor(15100);await page.locator('#tab-new').click();
   await page.locator('#customer-next').waitFor();assert.equal(await page.getByRole('button',{name:'Получил',exact:true}).count(),0);
   await page.locator('#customer-next').getByRole('button',{name:'Сдать оборудование'}).click();
   const dialog=page.locator('.workflow-dialog');assert.match(await dialog.innerText(),/уже передаёте/);
   assert.match(await dialog.innerText(),/царапина/);assert.equal(writes.length,0);
   await dialog.getByRole('button',{name:'Да, передаю сотруднику'}).click();
   await dialog.waitFor({state:'detached'});assert.equal(order.status,'return_inspection');
   assert.equal(writes.filter(row=>row.body?.action==='returning').length,1);
   await page.getByRole('button',{name:'Сдать оборудование',exact:true}).waitFor({state:'hidden'});
   assert.equal(await page.getByRole('button',{name:'Сдать оборудование',exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const order=base('ready'),{page,errors}=await fixture(browser,{order});let ack=0;
   await page.route('**/api/miniapp/customer/next-actions',r=>r.fulfill({json:{items:[guide(order)]}}));
   await page.route('**/api/miniapp/notifications/pending',r=>r.fulfill({json:{items:ack?[]:[{event_id:'ready1',...guide(order)}]}}));
   await page.route('**/api/miniapp/notifications/ready1/ack',r=>{ack++;return r.fulfill({json:{status:'acknowledged'}});});
   await page.clock.runFor(15100);await page.locator('.ready-invitation').waitFor();
   assert.equal(ack,0,'a fetched or displayed invitation is not acknowledged before dismissal');
   await page.locator('.ready-invitation').getByRole('button',{name:'Понятно'}).click();
   await page.locator('.ready-invitation').waitFor({state:'detached'});
   await page.waitForFunction(()=>!document.querySelector('.ready-invitation'));
   await page.clock.runFor(15100);assert.equal(ack,1);assert.equal(await page.locator('.ready-invitation').count(),0);
   await page.locator('#tab-new').click();assert.match(await page.locator('#customer-next').innerText(),/Тестовый склад/);
   fs.mkdirSync('artifacts/release-0511',{recursive:true});await page.screenshot({path:`artifacts/release-0511/${engine.name()}-home.png`,fullPage:true});
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const order=base('ready'),{page,errors}=await fixture(browser,{order});let release;
   const delayed=new Promise(resolve=>{release=resolve;});
   await page.route('**/api/miniapp/customer/next-actions',r=>r.fulfill({json:{items:[guide(order)]}}));
   await page.route('**/api/miniapp/notifications/pending',r=>r.fulfill({json:{items:[{event_id:'deferred-ready',...guide(order)}]}}));
   await page.route('**/api/miniapp/bookings/7',async r=>{await delayed;await r.fulfill({json:order});});
   const started=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/miniapp/bookings/7');
   await page.clock.runFor(15100);await started;
   await page.locator('#profile-header > summary').click();await page.locator('#profile-support').click();
   await page.locator('#support-question').fill('Несохранённый вопрос');
   const loaded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/miniapp/bookings/7');release();await loaded;
   await page.waitForTimeout(100);assert.equal(await page.locator('.ready-invitation').count(),0,'delayed invitation must not interrupt an opened form');
   assert.equal(await page.locator('#support-question').inputValue(),'Несохранённый вопрос');
   await page.locator('#support-close').click();await page.clock.runFor(15100);await page.locator('.ready-invitation').waitFor();
   await page.locator('.ready-invitation').getByRole('button',{name:'Понятно'}).click();
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser,{admin:true,role:'manager'});
   await page.locator('[data-mode="catalog"]').click();
   const camera=page.locator('.article-card').filter({has:page.locator('[aria-controls="catalog-article-1-assets"]')});
   await camera.locator('.article-toggle').click();
   await camera.getByRole('button',{name:'Загрузить фото модели',exact:true}).click();const dialog=page.locator('.catalog-photo-dialog');
   await dialog.locator('.file-drop-zone').waitFor();
   const drop=async count=>dialog.locator('.file-drop-zone').evaluate((zone,count)=>{
    const canvas=document.createElement('canvas');canvas.width=10;canvas.height=10;
    return new Promise(resolve=>canvas.toBlob(blob=>{const data=new DataTransfer();for(let i=0;i<count;i++)data.items.add(new File([blob],`camera${i}.png`,{type:'image/png'}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));resolve();},'image/png'));
   },count);
   await drop(2);assert.match(await dialog.locator('.drop-status').innerText(),/только одно/);
   assert.equal(await dialog.locator('input[type=file]').evaluate(el=>el.files.length),0);
   await drop(1);assert.equal(await dialog.locator('input[type=file]').evaluate(el=>el.files.length),1);
   await dialog.locator('.catalog-upload-preview').waitFor();await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
   await dialog.waitFor({state:'detached'});await page.getByText('Фото сохранено.',{exact:true}).waitFor();
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser,{admin:true,role:'admin'});let saved=null;
   await page.route('**/api/miniapp/admin/handover-settings',r=>{if(r.request().method()==='PUT')saved=r.request().postDataJSON();return r.fulfill({json:saved||{pickup_location:'Прежний склад',pickup_instructions:''}});});
   await page.locator('#admin-settings-open').click();await page.locator('#settings-tab-handover').click();
   await page.waitForFunction(()=>document.querySelector('#handover-settings-form [name=pickup_location]').value==='Прежний склад');
   await page.locator('#handover-settings-form [name=pickup_location]').fill('Тестовый склад');
   await page.locator('#handover-settings-form [name=pickup_instructions]').fill('Приходите по времени заявки');
   await page.locator('#handover-settings-form button').click();await page.getByText('Настройки выдачи сохранены').waitFor();
   assert.equal(saved.pickup_location,'Тестовый склад');assert.deepEqual(errors,[]);await page.close();
  }
  console.log(`0.5.11 (${engine.name()}): prominent return, no receipt confirmation, ready dismissal/ack, persistent home card, photo drop and admin pickup settings passed`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
