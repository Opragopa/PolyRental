/* Synthetic browser acceptance for the new receipt and request-change flows. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
const base = (status='ready') => ({id:7,human_number:'ТС260007',status,identity_status:'verified',
  starts_at:'2026-11-03T10:00:00+03:00',ends_at:'2026-11-04T10:00:00+03:00',
  customer_name:'QA',customer_contact:'@synthetic',partial_issue:true,receipt_available:true,
  items:[{id:1,name:'Камера Sony',title:'Камера Sony',quantity:2}],lines:[{id:11,article_id:1,name:'Камера Sony',quantity:2}],
  assets:[{id:21,article_id:1,name:'Камера Sony',serial:'QA-21',location:'A1',inspection_profile:'generic'}],
  inspections:[],archived_documents:['receipt_pdf'],
  handover:{snapshot:[{id:21,name:'Камера Sony',features:[{description:'Небольшая царапина'}]}],
    exceptions:[{line_id:11,name:'Камера Sony',reason:'missing',note:'Нет на складе'}]}});

async function fixture(browser,{admin=false,role='operator',trusted=false,order=base(),change=null,width=390,failWriteOnce=false,notices=[],deferInspectionRefresh=false,receipt=null}={}) {
  const page=await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true});
  const errors=[],writes=[];let catalogPreview='';
  let releaseInspectionRefresh;
  const inspectionRefresh=new Promise(resolve=>{releaseInspectionRefresh=resolve;});
  const categories=[{code:'generic',name:'Оборудование'},{code:'camera',name:'Камера'}];
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date('2026-10-29T10:00:00Z')});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();
    if (url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"synthetic",initDataUnsafe:{user:{id:42}}}}'});
    if (url.pathname.startsWith('/miniapp/static/')) {
      const file=path.resolve(assets,url.pathname.slice('/miniapp/static/'.length));
      assert.ok(file.startsWith(assets+path.sep));
      return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream'});
    }
    if (url.pathname.endsWith('/receipt') && receipt) return route.fulfill({status:receipt.status || 200,body:receipt.body,contentType:receipt.type || 'application/pdf'});
    if (url.pathname==='/api/miniapp/notifications/claim') return route.fulfill({json:{items:notices.splice(0)}});
    if (url.pathname==='/api/miniapp/catalog/categories') return route.fulfill({json:{items:categories}});
    if (url.pathname==='/api/miniapp/admin/catalog/categories') {
      const category={code:'custom_sound',name:route.request().postDataJSON().name};categories.push(category);
      return route.fulfill({json:category});
    }
    if (url.pathname==='/api/miniapp/me') return route.fulfill({json:{id:admin?100:42,admin,pii_admin:false,...(admin?{staff_role:role,trusted_signer:trusted}:{})}});
    if (url.pathname==='/api/miniapp/profile') return route.fulfill({json:{display_name:'QA',onboarding_seen:true,client_allowed:true,system_admin:role==='admin',start_screen:admin?'management':'booking'}});
    if (url.pathname==='/api/miniapp/operator/last-section') return route.fulfill({json:{section:'orders'}});
    if (url.pathname==='/api/miniapp/cart') return route.fulfill({json:{version:0,start:'',end:'',lines:[]}});
    if (url.pathname==='/api/miniapp/profile/history'||url.pathname==='/api/miniapp/admin/bookings') {
      if (url.pathname==='/api/miniapp/admin/bookings'&&deferInspectionRefresh&&order.inspections.length) await inspectionRefresh;
      return route.fulfill({json:{items:[order],total:1,undo_seconds:5}});
    }
    if (url.pathname.endsWith('/history')) return route.fulfill({json:{items:[]}});
    if (url.pathname==='/api/miniapp/admin/catalog') return route.fulfill({json:{articles:[{id:1,name:'Камера Sony',title:'Камера Sony',sku:'CAM',category:'camera',image_data:catalogPreview,composition:'Корпус\nКабель',equipment:Array.from({length:15},(_,index)=>({id:21+index,asset_code:`CAM-${index+1}`,condition:'available',location:'A1'}))}],dependencies:[]}});
    if (url.pathname==='/api/miniapp/admin/staff') return route.fulfill({json:{items:[{telegram_id:100,role:'admin',full_name:'QA Admin',trusted:true},{telegram_id:200,role:'operator',full_name:'QA Staff',trusted:false}]}});
    if (url.pathname==='/api/miniapp/admin/assignees') return route.fulfill({json:{items:[{id:100,name:'QA Admin'},{id:200,name:'QA Staff'}]}});
    if (url.pathname.endsWith('/changes')&&method==='GET') return route.fulfill({json:change});
    if(url.pathname.endsWith('/photo')&&['PUT','DELETE'].includes(method)){
      writes.push({path:url.pathname,method});
      catalogPreview=method==='PUT'?'data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA':'';
      return route.fulfill({json:{ok:true}});
    }
    if (['POST','PUT','DELETE'].includes(method)) {
      const body=route.request().postDataJSON(); writes.push({path:url.pathname,body});
      if(failWriteOnce){failWriteOnce=false;return route.fulfill({status:409,json:{detail:'Синтетический конфликт: повторите'}});}
      if (url.pathname.endsWith('/attest')) { if (body.action==='returning') { order.handover.returning_at='2026-10-29T10:00:00Z'; order.status='return_inspection'; } else order.handover.received_at='2026-10-29T10:00:00Z'; }
      if (url.pathname.endsWith('/paper-signature')) order.handover[`${body.point}_signature`]={actor_id:100,full_name:'QA Admin'};
      if (url.pathname.endsWith('/transition')) order.status=body.action;
      if (url.pathname.endsWith('/assignee')) { order.assignee_id=body.assignee_id; order.assignee_name='QA Staff'; }
      if (url.pathname.endsWith('/changes')) order.status='needs_changes';
      if (url.pathname.endsWith('/respond')) order.status='pending';
      return route.fulfill({json:order});
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[]}});
    return route.fulfill({body:html,contentType:'text/html'});
  });
  await page.goto('http://polyrental.test/miniapp');
  await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
  if (admin) {await page.locator('.request-toggle').waitFor();await page.locator('.request-toggle').click();}
  else {await page.locator('#tab-orders').click();await page.locator('#orders-content .customer-order-toggle').first().click();}
  return {page,errors,writes,releaseInspectionRefresh};
}

async function noOverflow(page) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page must fit the viewport');
  const dialog=page.locator('.workflow-dialog .dialog-card');
  if (await dialog.count()) assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog must fit the viewport');
}

module.exports={fixture,base};
if(require.main===module)(async()=>{
  const engine=process.env.PLAYWRIGHT_BROWSER||'chromium';
  const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  let passed=0;
  try {
    {
      const {page,errors}=await fixture(browser,{order:base('returned'),notices:[{id:'event-1',booking_id:7,status:'returned',message:'Заявка завершена'}]});
      await page.locator('.stage-toast').waitFor();
      assert.equal(await page.locator('.stage-toast').count(),1);
      await page.reload();
      await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
      assert.equal(await page.locator('.stage-toast').count(),0);
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const {page,errors}=await fixture(browser,{admin:true,role:'operator',order:base('pending')});
      assert.ok(await page.getByRole('button',{name:'Подтвердить заявку',exact:true}).isVisible());
      await page.locator('[data-mode="catalog"]').click();
      await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
      const form=page.locator('.catalog-form');
      await form.locator('[name="name"]').fill('Полное имя Sony FX3');
      await form.getByRole('button',{name:'Создать категорию',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.locator('[name="name"]').fill('Звук');
      await dialog.getByRole('button',{name:'Создать',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.equal(await form.locator('[name="category"]').inputValue(),'custom_sound');
      assert.equal(await form.locator('[name="name"]').inputValue(),'Полное имя Sony FX3');
      await noOverflow(page);
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    for (const width of [320,390]) {
      const {page,errors,writes}=await fixture(browser,{width,order:base("issued")});
      await page.getByRole('button',{name:'Получил',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();
      assert.equal(writes.length,0,'partial receipt requires acknowledgement');
      await dialog.getByLabel('С перечнем ознакомлен').check(); await noOverflow(page);
      await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.deepEqual(writes[0].body,{action:'received',acknowledged:true});
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const {page, errors, writes} = await fixture(browser, {admin:true, role:'manager', order:base('pending')});
      assert.equal(await page.getByRole('button', {name:'Назначить ответственного', exact:true}).count(), 1);
      assert.equal(await page.getByRole('button', {name:'Выбрать ответственного', exact:true}).count(), 0);
      await page.getByRole('button', {name:'Назначить ответственного', exact:true}).click();
      const dialog = page.locator('.workflow-dialog');
      await dialog.getByLabel('Сотрудник').selectOption('200');
      await dialog.getByRole('button', {name:'Подтвердить', exact:true}).click();
      await page.waitForFunction(() => !document.querySelector('.workflow-dialog'));
      assert.deepEqual(writes[0].body, {assignee_id:200});
      await page.getByText('Ответственный: QA Staff', {exact:true}).waitFor();
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    {
      const {page, errors, writes} = await fixture(browser, {admin:true, role:'admin'});
      await page.locator('#admin-settings > summary').click();
      await page.getByRole('button', {name:'Сотрудники', exact:true}).click();
      const dialog = page.locator('.workflow-dialog');
      try { await dialog.waitFor({state:'visible', timeout:3000}); } catch (error) { throw new Error(`Staff dialog: ${await page.locator('#global-error').innerText()}`, {cause:error}); }
      await dialog.locator('[name="staff"]').selectOption('200');
      await dialog.locator('[name="role"]').selectOption('manager');
      assert.equal(await dialog.getByText('Доверенный подписант').count(), 0);
      await dialog.getByRole('button', {name:'Сохранить', exact:true}).click();
      await page.waitForFunction(() => !document.querySelector('.workflow-dialog'));
      assert.equal(writes.length, 1);
      assert.match(writes[0].path, /\/staff\/200\/role$/);
      assert.deepEqual(writes[0].body, {role:'manager'});
      assert.deepEqual(errors, []); await page.close(); passed++;
    }
    {
      const order=base(); order.partial_issue=false; order.handover.exceptions=[]; order.assignee_id=200;
      const client=await fixture(browser,{order});
      const operator=await fixture(browser,{admin:true,role:"manager",order,deferInspectionRefresh:true});
      assert.ok(await operator.page.getByRole('button',{name:'Выдать оборудование',exact:true}).isEnabled());
      assert.equal(await client.page.getByRole('button',{name:'Получил',exact:true}).count(),0);
      await operator.page.getByRole('button',{name:'Выдать оборудование',exact:true}).click();
      assert.ok(operator.writes.some(row=>row.body.action==='issued'));
      assert.ok(!operator.writes.some(row=>row.path.endsWith('/paper-signature')));
      await client.page.clock.runFor(5100);
      await client.page.getByRole('button',{name:'Получил',exact:true}).click();
      await client.page.locator('.workflow-dialog').getByRole('button',{name:'Подтверждаю',exact:true}).click();
      await client.page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.ok(client.writes.some(row=>row.body.action==='received'));
      await client.page.getByRole('button',{name:'Сдаю оборудование',exact:true}).waitFor();
      await client.page.getByRole('button',{name:'Сдаю оборудование',exact:true}).waitFor();
      await client.page.getByRole('button',{name:'Сдаю оборудование',exact:true}).click();
      await client.page.locator('.workflow-dialog').getByRole('button',{name:'Подтверждаю',exact:true}).click();
      await operator.page.clock.runFor(5100);
      await operator.page.getByText('Клиент отметил сдачу оборудования — готово',{exact:false}).waitFor();
      assert.ok(await operator.page.getByRole('button',{name:'Завершить заявку',exact:true}).isDisabled());
      assert.ok(await operator.page.getByRole('button',{name:'Все исправны',exact:true}).isEnabled());
      order.inspections=[{equipment_id:21,stage:'check_in',result:'pass'}];
      const inspectionPoll=operator.page.waitForRequest(request=>new URL(request.url()).pathname==='/api/miniapp/admin/bookings');
      await operator.page.clock.runFor(5100);
      await inspectionPoll;
      assert.ok(await operator.page.getByRole('button',{name:'Завершить заявку',exact:true}).isDisabled(),'completion remains blocked until the server returns inspections');
      operator.releaseInspectionRefresh();
      await operator.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Завершить заявку'&&!button.disabled));
      assert.ok(await operator.page.getByRole('button',{name:'Завершить заявку',exact:true}).isEnabled());
      await operator.page.getByRole('button',{name:'Завершить заявку',exact:true}).click();
      await operator.page.locator('.workflow-dialog').getByRole('button',{name:'Подтвердить',exact:true}).click();
      await operator.page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.ok(operator.writes.some(row=>row.body.action==='returned'));
      assert.deepEqual(client.errors,[]); assert.deepEqual(operator.errors,[]);
      await client.page.close(); await operator.page.close(); passed++;
    }
    {
      const {page,errors,writes}=await fixture(browser,{admin:true,role:'manager',order:base('pending')});
      await page.getByRole('button',{name:'Изменить заявку',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.locator('[name="start"]').fill('2026-11-05T10:00');
      await dialog.locator('[name="end"]').fill('2026-11-06T10:00');
      await dialog.locator('[name="comment"]').fill('QA: изменены даты');await noOverflow(page);
      await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
      assert.equal(writes[0].body.change_type,'manager_edit');
      assert.equal(writes[0].body.proposed.start,'2026-11-05T10:00:00+03:00');
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const order=base('needs_changes');order.change_status='pending';
      const before={start:order.starts_at,end:order.ends_at,lines:[{article_id:1,quantity:2}]};
      const change={id:9,change_type:'manager_edit',status:'pending',comment:'QA private comment',before,after:{...before,lines:[{article_id:1,quantity:1}]},deadline:'2026-10-30T10:00:00Z'};
      const {page,errors,writes}=await fixture(browser,{order,change});
      await page.getByRole('button',{name:'Посмотреть изменения',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      assert.match(await dialog.innerText(),/2 → 1/);
      await dialog.locator('[name="decision"]').selectOption('dispute');
      await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();assert.equal(writes.length,0);
      await dialog.locator('[name="comment"]').fill('Оспариваю количество');
      await dialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();
      assert.deepEqual(writes[0].body,{change_id:9,accept:false,comment:'Оспариваю количество'});
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const {page,errors,writes}=await fixture(browser,{admin:true,role:'admin',order:base('preparing')});
      await page.getByRole('button',{name:'Заменить экземпляры',exact:true}).click();
      const editor=page.locator('.assignment-editor');
      await editor.locator('.assignment-slot').first().getByText('Выбрать замену',{exact:true}).click();
      assert.equal(await editor.locator('.assignment-slot').first().locator('.replacement-list .button').count(),10);
      await editor.locator('.assignment-slot').first().getByRole('searchbox').fill('CAM-15');
      await editor.locator('.assignment-slot').first().getByRole('button',{name:'Камера Sony #CAM-15',exact:true}).click();
      await editor.locator('[name="line-11"]').nth(1).selectOption('missing');
      await editor.locator('.assignment-slot').first().locator('.component-state').nth(1).selectOption('faulty');
      await editor.getByRole('button',{name:'Сохранить замену',exact:true}).click();
      assert.equal(writes[0].body.exceptions.length,3);
      assert.ok(writes[0].body.exceptions.some(row=>row.component==='Кабель'&&row.reason==='faulty'));
      assert.ok(writes[0].body.exceptions.some(row=>row.reason==='replacement'&&row.replacement_id===35));
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const {page,errors,writes}=await fixture(browser,{admin:true,role:'manager',order:base('pending'),failWriteOnce:true});
      await page.getByRole('button',{name:'Отклонить',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.locator('[name="comment"]').fill('Причина должна сохраниться при ошибке');
      await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(await dialog.locator('[name="comment"]').inputValue(),'Причина должна сохраниться при ошибке');
      await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    {
      const {page,errors,writes}=await fixture(browser,{admin:true,role:'admin'});
      await page.locator('[data-mode="catalog"]').click();
      await page.getByRole('button',{name:'Загрузить фото модели',exact:true}).click();
      let dialog=page.locator('.workflow-dialog');
      await dialog.locator('[name="photo"]').setInputFiles({name:'synthetic.webp',mimeType:'image/webp',buffer:Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA','base64')});
      await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
      await page.getByRole('button',{name:'Заменить фото модели',exact:true}).waitFor();
      assert.match(await page.locator('.article-card-head img').getAttribute('src'),/^data:image\/webp;base64,/);
      await noOverflow(page);
      await page.getByRole('button',{name:'Удалить фото модели',exact:true}).click();
      dialog=page.locator('.workflow-dialog');
      await dialog.getByRole('button',{name:'Удалить',exact:true}).click();
      await page.getByRole('button',{name:'Загрузить фото модели',exact:true}).waitFor();
      assert.deepEqual(writes.map(row=>row.method),['PUT','DELETE']);
      assert.deepEqual(errors,[]);await page.close();passed++;
    }
    console.log(JSON.stringify({engine,passed}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
