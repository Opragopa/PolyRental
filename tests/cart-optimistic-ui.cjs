/* Optimistic cart reconciliation, conflicts and lost responses. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
const html=fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','qa');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 async function setup(mode){
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
  let server={start:'2026-11-01T10:00',end:'2026-11-02T10:00',lines:[],version:1}, writes=0, offline=false, release, received;
  const requestReceived=new Promise(resolve=>{received=resolve});const gate=new Promise(resolve=>{release=resolve});
  const items=[1,2].map(id=>({id,name:`Камера ${id}`,title:`Камера ${id}`,sku:`CAM-${id}`,description:'',available:true,capacity:3,available_quantity:3}));
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),method=route.request().method();
   if(url.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
   if(url.pathname.startsWith('/miniapp/static/')){const f=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(f),contentType:f.endsWith('.css')?'text/css':'text/javascript'});}
   if(url.pathname==='/api/miniapp/me')return route.fulfill({json:{id:42,admin:false}});
   if(url.pathname==='/api/miniapp/profile')return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking'}});
   if(url.pathname==='/api/miniapp/catalog/categories')return route.fulfill({json:{items:mode==='success'?[{code:'camera',name:'Камеры'}]:[]}});
   if(url.pathname==='/api/miniapp/cart'&&method==='GET'){if(offline)return route.abort('failed');return route.fulfill({json:server});}
   if(url.pathname==='/api/miniapp/cart'&&method==='PUT'){
    const payload=route.request().postDataJSON();writes++; if(writes===1){received();await gate;
      if(mode==='conflict'){server={...server,lines:[{article_id:2,quantity:1}],version:2};return route.fulfill({status:409,json:{detail:'Изменено на другом устройстве'}});}
      if(mode==='lost-ack'){server={...payload,version:payload.version+1};return route.abort('failed');}
      if(mode==='offline'){offline=true;return route.abort('failed');}
    }
    if(payload.version!==server.version)return route.fulfill({status:409,json:{detail:'Версия изменилась'}});
    server={...payload,version:server.version+1};return route.fulfill({json:server});
   }
   if(url.pathname==='/api/miniapp/catalog')return route.fulfill({json:{items,selected_items:items,page:0,page_size:20,total:items.length}});
   if(url.pathname==='/api/miniapp/availability')return route.fulfill({json:{items,all_items:items,unavailable_count:0,unavailable:[]}});
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[]}});
   return route.fulfill({body:html,contentType:'text/html'});
  });
  await page.clock.install({time:new Date('2026-10-26T10:00:00Z')});await page.goto('http://polyrental.test/miniapp');await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
  return {page,errors,release,requestReceived,getServer:()=>server,getWrites:()=>writes,setOnline:()=>{offline=false}};
 }
 {
  const f=await setup('success'), {page}=f;
  await page.setViewportSize({width:320,height:844});
  await page.getByRole('button',{name:'Камеры',exact:true}).click();
  for (const layout of ['list','grid']) {
   await page.locator('#client-product-layout').getByRole('button',{name:layout==='list'?'Список':'Плитка'}).click();
   const card=page.locator('.item-card').first();
   assert.equal(await card.locator('.quantity-control').innerText(),'−\n0\n+');
   assert.equal(await page.locator('#main-button').innerText(),'В корзину · 0');
   for (const [control,expected] of [['plus',1],['plus',2],['minus',1],['minus',0]]) {
    const actual=await card.locator(`.${control}`).evaluate(button=>{button.click();return document.querySelector('#main-button').textContent;});
    assert.equal(actual,`В корзину · ${expected}`,'footer must change in the same click handler, before cart sync');
    assert.equal(await card.locator('.quantity-value').innerText(),String(expected));
    assert.equal(f.getWrites(),0,'the update must not wait for the server or debounce');
   }
   assert.equal(await card.locator('.minus').isDisabled(),true);
   await card.locator('.plus').evaluate(()=>{for(let i=0;i<30;i++)document.querySelector('.item-card .plus').click();});
   assert.equal(await page.locator('#main-button').innerText(),'В корзину · 3');
   assert.equal(await card.locator('.plus').isDisabled(),true);
   assert.equal(await card.locator('.quantity-value').innerText(),'3');
   assert.doesNotMatch(await card.innerText(),/добавить в корзину|в корзине:/i);
   const size=await card.locator('.quantity-control').evaluate(el=>({width:el.getBoundingClientRect().width,available:el.parentElement.getBoundingClientRect().width,buttons:[...el.querySelectorAll('button')].map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))}));
   assert.ok(size.width<=size.available+1,JSON.stringify(size));
   assert.ok(size.buttons.every(button=>button.width>=44 && button.height>=44),JSON.stringify(size));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   fs.mkdirSync('artifacts/catalog-quantity-hotfix',{recursive:true});await card.screenshot({path:`artifacts/catalog-quantity-hotfix/${layout}.png`});
   await card.locator('.minus').evaluate(()=>{for(let i=0;i<30;i++)document.querySelector('.item-card .minus').click();});
  }
  await page.locator('.item-card .plus').first().click();
  await page.locator('#main-button').click();assert.equal(await page.locator('#main-button').innerText(),'Выбрать даты','cart count updates must preserve the next step action');
  f.release();await page.clock.runFor(350);await f.requestReceived;
  assert.deepEqual(f.errors,[]);await page.close();
 }
 {
  const f=await setup('conflict'), {page}=f;const plus=page.getByRole('button',{name:'Увеличить количество: Камера 1'});
  await plus.click();await page.clock.runFor(350);await f.requestReceived;await plus.click();assert.equal(await page.locator('#selected-count').innerText(),'2');assert.equal(await page.locator('#main-button').innerText(),'В корзину · 2');
  f.release();await page.locator('#cart-sync-notice').waitFor();assert.equal(await page.locator('#selected-count').innerText(),'1');assert.equal(await page.locator('#main-button').innerText(),'В корзину · 1');
  assert.match(await page.locator('#cart-sync-summary').innerText(),/на сервере: 1 шт\.; в ваших несохранённых изменениях: 2 шт/i);
  await page.reload();await page.locator('#cart-sync-notice').waitFor();
  await page.getByRole('button',{name:'Сохранить мои изменения'}).click();await page.locator('#cart-sync-notice').waitFor({state:'hidden'});
  assert.deepEqual(f.getServer().lines,[{article_id:1,quantity:2}]);assert.equal(f.getServer().version,3);assert.deepEqual(f.errors,[]);await page.close();
 }
 {
  const f=await setup('lost-ack'), {page}=f;await page.getByRole('button',{name:'Увеличить количество: Камера 1'}).click();await page.clock.runFor(350);await f.requestReceived;f.release();
  await page.waitForFunction(()=>!Object.keys(localStorage).some(k=>k.endsWith(':unsynced')));
  assert.equal(await page.locator('#cart-sync-notice').isHidden(),true);assert.equal(await page.locator('#selected-count').innerText(),'1');assert.equal(f.getServer().lines[0].quantity,1);assert.deepEqual(f.errors,[]);await page.close();
 }
 {
  const f=await setup('offline'), {page}=f;await page.getByRole('button',{name:'Увеличить количество: Камера 1'}).click();await page.clock.runFor(350);await f.requestReceived;f.release();await page.locator('#cart-sync-notice').waitFor();
  assert.equal(await page.locator('#selected-count').innerText(),'0');await page.getByRole('button',{name:'Использовать серверную подборку'}).click();assert.equal(await page.locator('#cart-sync-notice').isVisible(),true);
  f.setOnline();await page.getByRole('button',{name:'Использовать серверную подборку'}).click();await page.locator('#cart-sync-notice').waitFor({state:'hidden'});assert.equal(await page.locator('#selected-count').innerText(),'0');assert.deepEqual(f.errors,[]);await page.close();
 }
 console.log('Optimistic cart conflict, rollback and lost response: passed');
 }finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
