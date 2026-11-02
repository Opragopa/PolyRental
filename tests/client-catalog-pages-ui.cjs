/* Client catalog keeps and rechecks selections outside the visible page. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
const html=fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','qa');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
 const items=Array.from({length:45},(_,i)=>({id:i+1,name:`Камера ${String(i+1).padStart(2,'0')}`,title:`Камера ${String(i+1).padStart(2,'0')}`,sku:`CAM-${i+1}`,description:'',available:true,available_quantity:2}));
 let unavailable=false, lastSelected=[];let cart={start:'2026-11-01T10:00',end:'2026-11-02T10:00',lines:[],version:0};
 await page.route('**/*',async route=>{const url=new URL(route.request().url()), method=route.request().method();
 if(url.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
 if(url.pathname.startsWith('/miniapp/static/')){const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
 if(url.pathname==='/api/miniapp/me')return route.fulfill({json:{id:42,admin:false}});
 if(url.pathname==='/api/miniapp/profile')return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking'}});
 if(url.pathname==='/api/miniapp/cart'&&method==='GET')return route.fulfill({json:cart});
 if(url.pathname==='/api/miniapp/cart'&&method==='PUT'){cart={...route.request().postDataJSON(),version:cart.version+1};return route.fulfill({json:cart});}
 if(url.pathname==='/api/miniapp/availability') {const q=url.searchParams.get('q')||'',n=Number(url.searchParams.get('page'));lastSelected=url.searchParams.getAll('selected').map(Number);const all=items.map(x=>x.id===1&&unavailable?{...x,available:false,available_quantity:0}:x), matches=all.filter(x=>x.name.toLowerCase().includes(q.toLowerCase()));return route.fulfill({json:{items:matches.slice(n*20,n*20+20),all_items:matches.slice(n*20,n*20+20),selected_items:all.filter(x=>lastSelected.includes(x.id)),total:matches.length,page:n,page_size:20,unavailable:[],unavailable_count:0}});}
 if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[]}});
 return route.fulfill({body:html,contentType:'text/html'});});
 await page.clock.install({time:new Date('2026-10-26T10:00:00Z')});await page.goto('http://polyrental.test/miniapp');await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
 await page.locator('#main-button').click();await page.getByRole('button',{name:'Увеличить количество: Камера 01'}).click();
 await page.locator('#client-catalog-next').click();await page.getByRole('button',{name:'Увеличить количество: Камера 21'}).click();
 await page.locator('#client-catalog-search').fill('Камера 45');await page.clock.runFor(350);await page.getByRole('button',{name:'Увеличить количество: Камера 45'}).click();
 assert.equal(await page.locator('#selected-count').innerText(),'3');assert.deepEqual(lastSelected.sort((a,b)=>a-b),[1,21]);
 await page.locator('#main-button').click();await page.locator('#cart-items').getByText('Камера 01',{exact:true}).waitFor();await page.locator('#cart-items').getByText('Камера 21',{exact:true}).waitFor();await page.locator('#cart-items').getByText('Камера 45',{exact:true}).waitFor();
 await page.locator('#customer-name').fill('Анна');await page.locator('#customer-contact').fill('@anna_user');unavailable=true;
 await page.locator('#main-button').click();await page.getByText('Выбранного количества уже нет.',{exact:false}).waitFor();
 assert.deepEqual(lastSelected.sort((a,b)=>a-b),[1,21,45]);assert.equal(await page.locator('#step-items').isVisible(),true);
 assert.deepEqual(errors,[]);console.log('Client catalog pages and selected-item revalidation: passed');await page.close();
 }finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
