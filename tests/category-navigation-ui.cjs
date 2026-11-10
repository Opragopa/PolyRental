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
 let delayNextCatalog=false, releaseCatalog; const heldCatalog=new Promise(resolve=>{releaseCatalog=resolve});
 await page.route('**/*',async route=>{const u=new URL(route.request().url()),p=u.pathname,m=route.request().method();
 if(u.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:100}},BackButton:{show(){},hide(){},onClick(f){window.__telegramBack=f}}}}'});
 if(p.startsWith('/miniapp/static/')){const file=path.join(assets,path.basename(p));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
 if(p==='/api/miniapp/me')return route.fulfill({json:{id:100,admin:true,staff_role:'admin'}});
 if(p==='/api/miniapp/profile')return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking',system_admin:true}});
 if(p==='/api/miniapp/cart'&&m==='GET')return route.fulfill({json:cart});
 if(p==='/api/miniapp/cart'&&m==='PUT'){cart={...route.request().postDataJSON(),version:cart.version+1};return route.fulfill({json:cart});}
 if(p==='/api/miniapp/catalog/categories')return route.fulfill({json:{items:categories}});
 if(p==='/api/miniapp/availability'||p==='/api/miniapp/catalog'){if(delayNextCatalog){delayNextCatalog=false;await heldCatalog;} const category=u.searchParams.get('category'); const items=category==='light'?[]:[article];return route.fulfill({json:{items,all_items:items,selected_items:u.searchParams.getAll('selected').length?[article]:[],total:items.length,page:0,page_size:20,unavailable:[],unavailable_count:0}});}
 if(p==='/api/miniapp/admin/catalog/categories/camera/edit'&&m==='POST'){categories[0].name='Фотоаппараты';categories[0].image_data='data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA=';return route.fulfill({json:{ok:true}});}
 if(p==='/api/miniapp/admin/catalog'){const rows=u.searchParams.get('category')==='light'?[]:[article];return route.fulfill({json:{categories,articles:rows,dependencies:[],total:rows.length,page:0,page_size:20}});}
 if(p.startsWith('/api/'))return route.fulfill({json:{items:[]}});
 return route.fulfill({body:html,contentType:'text/html'});
 });
 await page.addInitScript(() => { const original=Element.prototype.scrollIntoView; Element.prototype.scrollIntoView=function(options){ if(this.id==='catalog-page-title'||this.id==='admin-catalog-heading') window.__categoryScrollOptions=options; return original.call(this,options); }; });
 await page.clock.install({time:new Date('2026-10-26T10:00:00Z')}); await page.goto('http://polyrental.test/miniapp'); await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
 await page.locator('#catalog-grid').click();
 assert.equal(await page.locator('#client-categories').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'category tiles need two columns on a phone');
 assert.equal(await page.evaluate(()=>localStorage.getItem('polyrental-catalog-layout')),'grid');
 if(process.env.QA_SCREENSHOTS){await page.clock.runFor(500); await page.screenshot({path:'artifacts/category-light.png',animations:'disabled'}); await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';}); await page.clock.runFor(500); await page.screenshot({path:'artifacts/category-dark.png',animations:'disabled'});}
 await page.locator('#catalog-list').click();
 await page.locator('#client-categories').evaluate(host => { const spacer=document.createElement('div'); spacer.style.height='900px'; host.prepend(spacer); });
 const versionX=await page.locator('#app-version').evaluate(el=>el.getBoundingClientRect().x);
 await page.locator('#client-categories').getByRole('button',{name:'Камеры'}).scrollIntoViewIfNeeded();
 await page.evaluate(()=>document.addEventListener("click",()=>{window.__categoryScrollAtClick=scrollY;},{capture:true,once:true}));
 delayNextCatalog=true; await page.locator('#client-categories').getByRole('button',{name:'Камеры'}).click();
 const categoryScrollY=await page.evaluate(()=>window.__categoryScrollAtClick);
 assert.equal(await page.evaluate(()=>window.__categoryScrollOptions),undefined,'category navigation must not force a scroll to the heading');
 {const now=await page.evaluate(()=>scrollY); assert(Math.abs(now-categoryScrollY)<2,`opening a category preserves scroll: ${categoryScrollY} -> ${now}`);}
 assert(Math.abs(await page.locator('#app-version').evaluate(el=>el.getBoundingClientRect().x)-versionX)<1,'category navigation must not shift the page horizontally');
 await page.locator('#items-grid .loading-skeleton').waitFor({state:'visible'});
 await page.locator('.category-transition-shape').waitFor({state:'attached'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false,'category transition must not widen the page');
 releaseCatalog();
 await page.locator('#catalog-page-title').getByText('Камеры',{exact:true}).waitFor();
 await page.locator('.category-transition-shape').waitFor({state:'attached'});
 assert.equal(await page.locator('.category-transition-shape').getAttribute('aria-hidden'),'true');
 await page.locator('.category-transition-shape').evaluate(el=>el.getAnimations().forEach(animation=>animation.finish()));
 await page.locator('.category-transition-shape').waitFor({state:'detached'});
 await page.clock.runFor(850);
 {const info=await page.evaluate(()=>({y:scrollY,max:document.documentElement.scrollHeight-innerHeight,panel:document.querySelector('#step-items').getBoundingClientRect().toJSON(),floor:document.querySelector('#step-items').style.getPropertyValue('--category-scroll-floor'),min:getComputedStyle(document.querySelector('#step-items')).minHeight})); assert(Math.abs(info.y-categoryScrollY)<2,`releasing transition preserves scroll: ${categoryScrollY} -> ${JSON.stringify(info)}`);}
 assert.equal(await page.locator('#client-categories').getByRole('button',{name:'Свет'}).count(),0); assert.equal(await page.locator('.category-morph-surface, .category-morph-label').count(),0);
 assert.equal(await page.locator('#catalog-page-title').evaluate(el=>el===document.activeElement),true);
 await page.locator('#client-catalog-search').fill('Sony'); await page.clock.runFor(350);
 await page.locator('#client-search-hide-keyboard').click();
 assert.equal(await page.locator('#client-catalog-search').evaluate(el=>el===document.activeElement),false);
 await page.locator('#top-back-button').click();
 assert.equal(await page.locator('#client-catalog-search').inputValue(),'Sony','search survives leaving the category');
 await page.locator('#client-catalog-search').fill(''); await page.clock.runFor(350);
 await page.locator('#client-categories').getByRole('button',{name:'Камеры'}).click();
 await page.locator('#client-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#catalog-page-title').getByText('Кинокамеры').waitFor();
 await page.getByRole('button',{name:'Увеличить количество: Sony FX3'}).click(); assert.equal(await page.locator('#selected-count').innerText(),'1');
 assert.equal(await page.locator('.cart-flight').count(),1,'adding equipment animates a card toward the basket');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false,'cart animation must not widen the page');
 await page.locator('.cart-flight').evaluate(el=>el.getAnimations().forEach(animation=>animation.finish()));
 await page.locator('.cart-flight').waitFor({state:'detached'});
 await page.evaluate(()=>window.__telegramBack()); await page.locator('#catalog-page-title').getByText('Камеры',{exact:true}).waitFor();
 await page.locator('#top-back-button').click(); await page.locator('#catalog-page-title').getByText('Каталог оборудования').waitFor(); assert.equal(await page.locator('#selected-count').innerText(),'1');
 await page.locator('#client-categories').getByRole('button',{name:'Свет'}).click();
 await page.locator('#step-items .category-empty-overlay').getByText('Тут ещё ничего нет :(',{exact:true}).waitFor();
 const clientEmpty=page.locator('#step-items .category-empty-overlay');
 assert(await clientEmpty.getByRole('button',{name:'Назад',exact:true}).isVisible());
 assert((await clientEmpty.getByRole('button',{name:'Назад',exact:true}).boundingBox()).width>=180,'empty back button has a generous target');
 {const rect=await clientEmpty.getByRole('button',{name:'Назад',exact:true}).boundingBox();assert(rect.y>=0 && rect.y+rect.height<844,'empty back button must be in the viewport');}
 await page.clock.runFor(900);
 const emptyGeometry = await page.evaluate(()=>{const heading=document.querySelector('#catalog-page-title').getBoundingClientRect();return {target:heading.top+scrollY,max:document.documentElement.scrollHeight-innerHeight};});
 assert(emptyGeometry.max >= emptyGeometry.target-1, `empty category must not clamp the heading scroll: ${JSON.stringify(emptyGeometry)}`);
 await clientEmpty.getByRole('button',{name:'Назад',exact:true}).click(); await page.locator('#catalog-page-title').getByText('Каталог оборудования').waitFor();
 await page.locator('#tab-admin').click(); await page.locator('[data-mode="catalog"]').click();
 await page.locator('.admin-categories').evaluate(host=>{const spacer=document.createElement('div');spacer.style.height='900px';host.prepend(spacer);});
 await page.locator('.admin-categories').getByRole('button',{name:'Свет'}).scrollIntoViewIfNeeded();
 const adminVersionX=await page.locator('#app-version').evaluate(el=>el.getBoundingClientRect().x);
 await page.evaluate(()=>document.addEventListener('click',()=>{window.__adminScrollAtClick=scrollY;},{capture:true,once:true}));
 await page.locator('.admin-categories').getByRole('button',{name:'Свет'}).click();
 const adminScrollY=await page.evaluate(()=>window.__adminScrollAtClick);
 const adminEmpty=page.locator('#admin-content .category-empty-overlay');
 await adminEmpty.getByText('Тут ещё ничего нет :(').waitFor();
 {const rect=await adminEmpty.getByRole('button',{name:'Назад',exact:true}).boundingBox();assert(rect.y>=0 && rect.y+rect.height<844,'empty admin back button must be in the viewport');}
 await page.clock.runFor(900);
 {const now=await page.evaluate(()=>scrollY);assert(Math.abs(now-adminScrollY)<2,`empty admin category preserves scroll: ${adminScrollY} -> ${now}`);}
 await page.evaluate(()=>window.scrollTo(0,0)); await page.clock.runFor(100);
 {const region=await page.locator('.admin-catalog-items').boundingBox(); const empty=await adminEmpty.boundingBox(); if(empty) assert(empty.y>=Math.max(0,region.y)-1,'empty state remains inside product area');}
 assert(Math.abs(await page.locator('#app-version').evaluate(el=>el.getBoundingClientRect().x)-adminVersionX)<1,'admin category must not shift the page horizontally');
 await page.locator('.catalog-controls input').fill('SERIAL-123');
 assert.equal(await page.locator('.category-empty-overlay').count(),0,'typing a serial number immediately dismisses the empty state');
 await page.locator('.catalog-controls input').fill(''); await page.clock.runFor(350);
 await page.locator('#admin-content .category-empty-overlay').waitFor({state:'attached'});
 await page.evaluate(y=>window.scrollTo(0,y),adminScrollY); await page.clock.runFor(50);
 await adminEmpty.getByRole('button',{name:'Назад',exact:true}).click(); await page.locator('#admin-catalog-heading').getByText('Каталог оборудования').waitFor(); await page.locator('.catalog-controls input').fill('Sony'); await page.locator('.admin-search-hide-keyboard').click(); await page.clock.runFor(350); await page.waitForTimeout(100); assert.equal(await page.locator('.catalog-controls input').evaluate(el=>el===document.activeElement),false,'refresh must not reopen keyboard'); await page.locator('.catalog-controls input').fill(''); await page.clock.runFor(350); await page.locator('.admin-categories').getByRole('button',{name:'Камеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Камеры',{exact:true}).waitFor();
 await page.locator('.admin-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Кинокамеры').waitFor(); await page.evaluate(()=>window.__telegramBack()); await page.locator('#admin-catalog-heading').getByText('Камеры',{exact:true}).waitFor();
 await page.emulateMedia({reducedMotion:'reduce'}); await page.locator('.admin-categories').getByRole('button',{name:'Кинокамеры'}).click(); await page.locator('#admin-catalog-heading').getByText('Кинокамеры',{exact:true}).waitFor(); assert.equal(await page.locator('.category-transition-shape').count(),0); assert.equal(await page.locator('.category-morph-surface, .category-morph-label').count(),0);
 await page.evaluate(()=>window.__telegramBack()); await page.evaluate(()=>window.__telegramBack());
 await page.locator('#admin-catalog-heading').getByText('Каталог оборудования').waitFor();
 await page.locator('.admin-categories').getByRole('button',{name:'Свет'}).click();
 await page.locator('#admin-content').getByText('Тут ещё ничего нет :(').waitFor();
 await page.evaluate(()=>window.__telegramBack()); await page.locator('#admin-catalog-heading').getByText('Каталог оборудования').waitFor();
 await page.locator('.catalog-manage-categories').click();
 await page.getByRole('button',{name:'Изменить категорию: Камеры'}).click();
 const dialog=page.locator('.workflow-dialog'); await dialog.locator('input[name=name]').fill('Фотоаппараты');
 await dialog.locator('input[name=photo]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')});
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
 await page.locator('.admin-categories').getByRole('button',{name:'Фотоаппараты',exact:true}).waitFor();
 assert.equal(await page.locator('.admin-categories img.category-card-photo').count(),1);
 assert.deepEqual(errors,[]);console.log('Category screens, focus, Telegram back and retained selection: passed');
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
