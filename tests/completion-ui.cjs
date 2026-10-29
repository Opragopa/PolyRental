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

async function fixture(browser,{admin=false,role='operator',order=base(),change=null,width=390,failWriteOnce=false}={}) {
  const page=await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true});
  const errors=[],writes=[];let catalogPreview='';
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date('2026-10-29T10:00:00Z')});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();
    if (url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"synthetic",initDataUnsafe:{user:{id:42}}}}'});
    if (url.pathname.startsWith('/miniapp/static/')) {const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
    if (url.pathname==='/api/miniapp/me') return route.fulfill({json:{id:admin?100:42,admin,pii_admin:false,...(admin?{staff_role:role}:{})}});
    if (url.pathname==='/api/miniapp/profile') return route.fulfill({json:{display_name:'QA',onboarding_seen:true,client_allowed:true,system_admin:role==='admin',start_screen:admin?'management':'booking'}});
    if (url.pathname==='/api/miniapp/operator/last-section') return route.fulfill({json:{section:'orders'}});
    if (url.pathname==='/api/miniapp/cart') return route.fulfill({json:{version:0,start:'',end:'',lines:[]}});
    if (url.pathname==='/api/miniapp/profile/history'||url.pathname==='/api/miniapp/admin/bookings') return route.fulfill({json:{items:[order],total:1,undo_seconds:5}});
    if (url.pathname.endsWith('/history')) return route.fulfill({json:{items:[]}});
    if (url.pathname==='/api/miniapp/admin/catalog') return route.fulfill({json:{articles:[{id:1,name:'Камера Sony',title:'Камера Sony',sku:'CAM',category:'camera',image_data:catalogPreview,composition:'Корпус\nКабель',equipment:Array.from({length:15},(_,index)=>({id:21+index,asset_code:`CAM-${index+1}`,condition:'available',location:'A1'}))}],dependencies:[]}});
    if (url.pathname==='/api/miniapp/admin/staff') return route.fulfill({json:{items:[{telegram_id:100,role:'admin',full_name:'QA Admin',trusted:true},{telegram_id:200,role:'operator',full_name:'QA Staff',trusted:false}]}});
    if (url.pathname.endsWith('/changes')&&method==='GET') return route.fulfill({json:change});
    if(url.pathname.endsWith('/photo')&&['PUT','DELETE'].includes(method)){
      writes.push({path:url.pathname,method});
      catalogPreview=method==='PUT'?'data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA':'';
      return route.fulfill({json:{ok:true}});
    }
    if (['POST','PUT','DELETE'].includes(method)) {
      const body=route.request().postDataJSON(); writes.push({path:url.pathname,body});
      if(failWriteOnce){failWriteOnce=false;return route.fulfill({status:409,json:{detail:'Синтетический конфликт: повторите'}});}
      if (url.pathname.endsWith('/attest')) order.handover.received_at='2026-10-29T10:00:00Z';
      if (url.pathname.endsWith('/paper-signature')) order.handover.issue_signature={actor_id:100,full_name:'QA Admin'};
      if (url.pathname.endsWith('/transition')) order.status=body.action;
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
  else {await page.locator('#tab-orders').click();await page.locator('#orders-content .order-card').waitFor();}
  return {page,errors,writes};
}

async function noOverflow(page) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page must fit the viewport');
  const dialog=page.locator('.workflow-dialog .dialog-card');
  if (await dialog.count()) assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog must fit the viewport');
}

(async()=>{
  const engine=process.env.PLAYWRIGHT_BROWSER||'chromium';
  const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  let passed=0;
  try {
    for (const width of [320,390]) {
      const {page,errors,writes}=await fixture(browser,{width});
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
      const order=base();order.handover.received_at='2026-10-29T10:00:00Z';
      const {page,errors,writes}=await fixture(browser,{admin:true,order});
      assert.equal(await page.getByRole('button',{name:'Скачать расписку PDF',exact:true}).count(),0,'operator cannot receive full PII PDF');
      await page.getByRole('button',{name:'Подписал: выдача',exact:true}).click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.getByLabel('Личность сверена',{exact:true}).check();
      await dialog.getByLabel('Бумажная расписка подписана мной').check();await noOverflow(page);
      await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
      await page.getByRole('button',{name:'Выдать оборудование',exact:true}).click();
      assert.ok(writes.some(row=>row.path.endsWith('/paper-signature')&&row.body.paper_signed&&row.body.identity_matches));
      assert.ok(writes.some(row=>row.body.action==='issued'));assert.deepEqual(errors,[]);await page.close();passed++;
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
