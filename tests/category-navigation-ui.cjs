/* Category screens preserve the booking and use the same hierarchy for staff. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
const html=fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','qa');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium; const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const categories=[{code:'camera',name:'Камеры',icon:'camera'},{code:'cinema',name:'Кинокамеры',parent_code:'camera',icon:'camera'},{code:'light',name:'Свет',icon:'light'}];
 const article={id:1,sku:'A',name:'Sony FX3',title:'Sony FX3',category:'cinema',available:true,available_quantity:2,active:true,equipment:[{id:1,condition:'available',asset_code:'A1'}]};
 let cart={start:'2026-11-01T10:00',end:'2026-11-02T10:00',lines:[],version:0};
 await page.route('**/*',async route=>{const u=new URL(route.request().url()),p=u.pathname,m=route.request().method();
 if(u.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:100}},BackButton:{show(){},hide(){},onClick(f){window.__telegramBack=f}}}}'});
 if(p.startsWith('/miniapp/static/')){const file=path.join(assets,path.basename(p));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
 if(p==='/api/miniapp/me')return route.fulfill({json:{id:100,admin:true,staff_role:'admin'}});
 if(p==='/api/miniapp/profile')return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking',system_admin:true}});
 if(p==='/api/miniapp/cart'&&m==='GET')return route.fulfill({json:cart});
 if(p==='/api/miniapp/cart'&&m==='PUT'){cart={...route.request().postDataJSON(),version:cart.version+1};return route.fulfill({json:cart});}
 if(p==='/api/miniapp/catalog/categories')return route.fulfill({json:{items:categories}});
 if(p==='/api/miniapp/availability'||p==='/api/miniapp/catalog'){const category=u.searchParams.get('category'); const items=category==='light'?[]:[article];return route.fulfill({json:{items,all_items:items,selected_items:u.searchParams.getAll('selected').length?[article]:[],total:items.length,page:0,page_size:20,unavailable:[],unavailable_count:0}});}
 if(p==='/api/miniapp/admin/catalog')return route.fulfill({json:{categories,articles:[article],dependencies:[],total:1,page:0,page_size:20}});
 if(p.startsWith('/api/'))return route.fulfill({json:{items:[]}});
 return route.fulfill({body:html,contentType:'text/html'});
 });
 await page.clock.install({time:new Date('2026-10-26T10:00:00Z')}); await page.goto('http://polyrental.test/miniapp'); await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
 await page.locator('#client-categories').getByRole('button',{name:'Камеры'}).click(); await page.locator('#catalog-page-title').getByText('Камеры',{exact:true}).waitFor();
 assert.equal(await page.locator('#client-categories').getByRole('button',{name:'Свет'}).count(),0); assert.equal(await page.locator('.category-morph-surface, .category-morph-label').count(),0);
 assert.equal(await page.locator('#catalog-page-title').evaluate(el=>el===document.activeElement),true);
 await page.locator('#client-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#catalog-page-title').getByText('Кинокамеры').waitFor();
 await page.getByRole('button',{name:'Увеличить количество: Sony FX3'}).click(); assert.equal(await page.locator('#selected-count').innerText(),'1');
 await page.evaluate(()=>window.__telegramBack()); await page.locator('#catalog-page-title').getByText('Камеры',{exact:true}).waitFor();
 await page.locator('#top-back-button').click(); await page.locator('#catalog-page-title').getByText('Каталог оборудования').waitFor(); assert.equal(await page.locator('#selected-count').innerText(),'1');
 await page.locator('#tab-admin').click(); await page.locator('[data-mode="catalog"]').click(); await page.locator('.admin-categories').getByRole('button',{name:'Камеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Камеры',{exact:true}).waitFor();
 await page.locator('.admin-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Кинокамеры').waitFor(); await page.evaluate(()=>window.__telegramBack()); await page.locator('#admin-catalog-heading').getByText('Камеры',{exact:true}).waitFor();
 await page.emulateMedia({reducedMotion:'reduce'}); await page.locator('.admin-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Кинокамеры',{exact:true}).waitFor(); assert.equal(await page.locator('.category-morph-surface, .category-morph-label').count(),0);
 assert.deepEqual(errors,[]);console.log('Category screens, focus, Telegram back and retained selection: passed');
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
