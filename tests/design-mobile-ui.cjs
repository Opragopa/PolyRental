/* Mobile UX regression. All HTTP requests use synthetic, local fixtures. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
const longName = 'Кинокамера Sony Cinema Line FX3 с полнокадровой матрицей и комплектом аксессуаров';
const items = [{id:1,sku:'CAM-FX3',name:longName,brand:'Sony',category:'camera',description:'Компактная кинокамера',available_quantity:3},
  {id:2,sku:'LENS-2470',name:'Объектив Sony FE 24–70 мм F2.8 GM II',category:'optics',available_quantity:4},
  {id:3,sku:'TRIPOD',name:'Штатив Manfrotto с видеоголовой и площадкой',category:'accessory',available_quantity:2}];
const orderFor = (status='ready') => ({id:7,human_number:'ТС260007',status,identity_status:'verified',assignee_id:100,
  starts_at:'2026-11-03T10:00:00+03:00',ends_at:'2026-11-04T16:00:00+03:00',customer_name:'Анна',customer_contact:'@synthetic_customer',
  partial_issue:true,receipt_available:true,receipt_kind:'receipt_docx',items:items.slice(0,2).map(i=>({...i,quantity:1})),
  lines:items.slice(0,2).map(i=>({...i,id:i.id+10,article_id:i.id,quantity:1})),
  assets:items.slice(0,2).map(i=>({id:i.id+20,article_id:i.id,name:i.name,serial:`QA-${i.id}`,location:'А-01',inspection_profile:'generic'})),
  inspections:[],archived_documents:['receipt_docx'],handover:{receipt_kind:'receipt_docx',snapshot:[{id:21,name:longName,features:[{description:'Небольшая царапина на корпусе'}]}],exceptions:[{line_id:12,name:items[1].name,reason:'missing',note:'Нет на складе'}]}});

async function fixture(browser,{admin=false,role='operator',status='ready',width=440,dark=false}={}) {
  const page=await browser.newPage({viewport:{width,height:956},deviceScaleFactor:3,isMobile:true,hasTouch:true,colorScheme:dark?'dark':'light'});
  const errors=[],writes=[],order=orderFor(status);
  const categories=[{code:'camera',name:'Камера'},{code:'optics',name:'Оптика'},{code:'generic',name:'Оборудование'}];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-26T10:00:00Z')});
  await page.route('**/*', async route=>{
    const url=new URL(route.request().url()),method=route.request().method(),p=url.pathname;
    if(url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"synthetic",initDataUnsafe:{user:{id:42}}}}'});
    if(p.startsWith('/miniapp/static/')) {const file=path.join(assets,path.basename(p));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
    if(p==='/api/miniapp/notifications/claim') return route.fulfill({json:{items:[]}});
    if(p==='/api/miniapp/me') return route.fulfill({json:{id:admin?100:42,admin,pii_admin:false,...(admin?{staff_role:role}:{})}});
    if(p==='/api/miniapp/profile') return route.fulfill({json:{display_name:'Анна',onboarding_seen:true,client_allowed:true,system_admin:admin&&role==='admin',start_screen:admin?'management':'booking',reminders_enabled:true}});
    if(p==='/api/miniapp/operator/last-section') return route.fulfill({json:{section:'orders'}});
    if(p==='/api/miniapp/cart') return route.fulfill({json:{version:0,start:'',end:'',lines:[]}});
    if(p==='/api/miniapp/availability') return route.fulfill({json:{items,unavailable:[],unavailable_count:0}});
    if(p==='/api/miniapp/catalog/categories') return route.fulfill({json:{items:categories}});
    if(p==='/api/miniapp/admin/catalog/categories') {const category={code:'custom_audio',name:route.request().postDataJSON().name};categories.push(category);return route.fulfill({json:category});}
    if(p==='/api/miniapp/profile/history'||p==='/api/miniapp/admin/bookings') return route.fulfill({json:{items:[order],total:1,undo_seconds:5}});
    if(p.endsWith('/history')) return route.fulfill({json:{items:[]}});
    if(p==='/api/miniapp/admin/catalog') return route.fulfill({json:{articles:items.map(i=>({...i,inspection_profile:'camera',active:true,composition:'Корпус\nКабель\nКрышка',equipment:Array.from({length:3},(_,index)=>({id:i.id*20+index,asset_code:`${i.sku}-${index+1}`,condition:'available',location:'А-01',serial:`SERIAL-${index+1}`}))})),dependencies:[]}});
    if(p==='/api/miniapp/admin/assignees') return route.fulfill({json:{items:[{id:100,name:'Оператор Анна'},{id:200,name:'Менеджер Мария'}]}});
    if(p.endsWith('/receipt') && url.searchParams.has('preview')) return route.fulfill({json:{blocks:[{type:'paragraph',text:'Сохранная расписка'},{type:'table',rows:[['Камера','1']]}]}});
    if(p==='/api/miniapp/support/faq') return route.fulfill({json:{items:[{question:'Как получить оборудование?',answer:'Дождитесь статуса готовности и приходите в выбранное время.'}]}});
    if(['POST','PUT','DELETE'].includes(method)) {writes.push({path:p,body:route.request().postDataJSON()});return route.fulfill({json:order});}
    if(p.startsWith('/api/')) return route.fulfill({json:{items:[],total:0}});
    return route.fulfill({body:html,contentType:'text/html'});
  });
  await page.goto('http://polyrental.test/miniapp');
  await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
  if(admin) await page.locator('.request-toggle').waitFor();
  return {page,errors,writes};
}

const report=[];
async function capture(page,name) {
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
  const dimensions=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
    smallTargets:[...document.querySelectorAll('button,summary,input:not([type="hidden"]),select')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&r.height<44;}).map(el=>({text:el.textContent.trim().slice(0,70)||el.id,height:el.getBoundingClientRect().height})),
    overflows:[...document.querySelectorAll('main *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1);}).slice(0,10).map(el=>({tag:el.tagName,class:el.className,text:el.textContent.trim().slice(0,70)}))}));
  report.push({name,...dimensions});
  assert.ok(dimensions.scrollWidth<=dimensions.width+1,`Viewport overflow in ${name}: ${JSON.stringify(dimensions.overflows)}`);
  if(process.env.QA_SCREENSHOTS) {fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`${name}.png`)});}
}

(async()=>{
  const engine=process.env.PLAYWRIGHT_BROWSER||'chromium';
  const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    for(const [width,dark] of [[440,false],[440,true],[320,false]]) {
      const suffix=`${width}-${dark?'dark':'light'}`;
      const {page,errors}=await fixture(browser,{width,dark,status:"issued"});
      await page.locator('[data-date="2026-10-30"]').tap();await page.locator('[data-date="2026-11-02"]').tap();
      await page.locator('#start-time').fill('10:00');await page.locator('#end-time').fill('16:00');
      await capture(page,`dates-${suffix}`);await page.locator('#main-button').tap();
      await page.locator('.category-card').getByText('Камера', {exact:true}).tap();
      await page.locator('.item-card').first().waitFor();await capture(page,`catalog-${suffix}`);
      await page.locator('.item-card .plus').first().tap();await page.locator('#main-button').tap();
      await page.locator('#customer-name').fill('Анна');await page.locator('#customer-contact').fill('@synthetic_customer');
      await capture(page,`contact-${suffix}`);await page.locator('#main-button').tap();await capture(page,`review-${suffix}`);
      await page.locator('#tab-orders').tap();await page.locator('.customer-order-toggle').tap();await capture(page,`profile-${suffix}`);
      await page.getByRole('button',{name:'Предпросмотр расписки',exact:true}).tap();
      await page.locator('.receipt-docx-preview').waitFor();
      assert.match(await page.locator('.receipt-docx-preview').innerText(),/Сохранная расписка/);
      assert.ok(await page.getByRole('button',{name:'Скачать DOCX',exact:true}).isVisible());
      await capture(page,`docx-summary-${suffix}`);
      await page.getByRole('button',{name:'Назад к заявке',exact:true}).tap();
      await page.getByRole('button',{name:'Получил',exact:true}).tap();await capture(page,`receipt-dialog-${suffix}`);
      await page.locator('.workflow-dialog').getByRole('button',{name:'Отмена',exact:true}).tap();
      await page.locator('#profile-header > summary').tap();await page.locator('#profile-support').tap();
      await capture(page,`support-${suffix}`);
      assert.deepEqual(errors,[]);await page.close();
    }
    for(const status of ['pending','preparing','ready','return_inspection']) {
      const {page,errors}=await fixture(browser,{admin:true,status});
      await page.locator('.request-toggle').tap();await capture(page,`staff-${status}`);
      if(status==='pending') {
        await page.locator('[data-mode="catalog"]').tap();await page.locator('.article-card').first().waitFor();assert.ok(await page.locator('#admin-content > .action-row > .button').first().evaluate(el=>el.getBoundingClientRect().height>=44));
        await page.locator('.article-details > summary').first().click();
        assert.ok(!(await page.locator('.article-details').first().innerText()).includes('Профиль проверки: camera'));
        await page.locator('.article-details > summary').first().click();
        await capture(page,'staff-catalog');
        await page.getByRole('button',{name:'Новый артикул',exact:true}).tap();await page.locator('.catalog-form').waitFor();
        assert.equal(await page.locator('.editor-card h3').evaluate(el=>el===document.activeElement),true,'Editor receives focus');
        assert.ok(await page.locator('.editor-card h3').evaluate(el=>el.getBoundingClientRect().top<innerHeight/2),'Editor opens in view');
        await capture(page,'staff-catalog-editor');
        await page.locator('.catalog-form').getByRole('button',{name:'Создать категорию',exact:true}).tap();await capture(page,'staff-category-dialog');
      }
      assert.deepEqual(errors,[]);await page.close();
    }
    if(process.env.QA_SCREENSHOTS)fs.writeFileSync(path.join(process.env.QA_SCREENSHOTS,'metrics.json'),JSON.stringify(report,null,2));
    console.log(`Mobile design (${engine}): ${report.length} screen captures checked; 440 × 956 CSS at DPR 3 (1320 × 2868 pixels), dark and 320px variants`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
