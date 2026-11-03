/* Server-side catalog search, page navigation and article picker. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const {page,errors}=await fixture(browser,{admin:true,role:'operator',order:base('pending')});
 const articles=Array.from({length:45},(_,i)=>({id:i+1,name:`Камера ${String(i+1).padStart(2,'0')}`,sku:`SKU-${i+1}`,category:'camera',active:true,description:'',equipment:[{id:i+101,asset_code:`ID-${i+1}`,condition:i===44?'maintenance':'available',location:'A1'}]}));
 let last;
 await page.route('**/api/miniapp/admin/catalog?*',route=>{const q=new URL(route.request().url()).searchParams;last=Object.fromEntries(q);const matches=articles.filter(a=>(!q.get('q')||`${a.name} ${a.sku}`.toLowerCase().includes(q.get('q').toLowerCase()))&&(q.get('condition')==='all'||a.equipment.some(e=>e.condition===q.get('condition'))));const pageNum=Number(q.get('page'));return route.fulfill({json:{articles:matches.slice(pageNum*20,pageNum*20+20),categories:[{code:'camera',name:'Камера'}],dependencies:[],total:matches.length,page:pageNum,page_size:20}})});
 await page.route('**/api/miniapp/admin/catalog/options?*',route=>{const q=new URL(route.request().url()).searchParams;const matches=articles.filter(a=>`${a.name} ${a.sku}`.toLowerCase().includes((q.get('q')||'').toLowerCase()));const n=Number(q.get('page'));return route.fulfill({json:{items:matches.slice(n*20,n*20+20),total:matches.length,page:n,page_size:20}})});
 await page.locator('[data-mode="catalog"]').click();
 await page.locator('.admin-categories').getByRole('button',{name:'Камера'}).click();
 await page.getByText('Показано моделей: 20 из 45').waitFor();
 await page.locator('.catalog-pagination').getByRole('button',{name:'Далее'}).click();
 await page.getByText('Камера 21',{exact:true}).first().waitFor();assert.equal(last.page,'1');
 const search=page.locator('.catalog-controls input');await search.fill('Камера 45');await page.clock.runFor(350);
 await page.getByText('Показано моделей: 1 из 1').waitFor();assert.equal(last.q,'Камера 45');assert.equal(last.page,'0');
 await search.fill('');await page.clock.runFor(350);await page.getByText('Показано моделей: 20 из 45').waitFor();
 await page.getByRole('button',{name:'Новый экземпляр',exact:true}).click();
 const form=page.locator('.catalog-form'), picker=form.getByRole('searchbox',{name:'Поиск: Артикул'});
 await picker.fill('Камера 45');await page.clock.runFor(350);
 await form.locator('select[name="article_id"] option').filter({hasText:'Камера 45'}).waitFor({state:'attached'});
 await form.locator('select[name="article_id"]').selectOption('45');
 assert.equal(await form.locator('select[name="article_id"]').inputValue(),'45');
 assert.deepEqual(errors,[]);console.log('Catalog pagination, search and picker: passed');await page.close();
 }finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
