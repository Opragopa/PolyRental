/* Observe interaction timing, geometry, focus, motion cleanup and real flow. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture, base} = require('./completion-ui.cjs');
const gate = () => {let resolve;const promise = new Promise(r => {resolve=r;});return {promise,resolve};};

(async () => {
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  {
   const page=await browser.newPage({reducedMotion:'no-preference'});
   await page.setContent('<style>:root{--accent:#244bd6}button{width:120px;height:48px}#number{display:inline-block}.press-feedback,.cart-flight{position:fixed;pointer-events:none}</style><button id="add">Добавить</button><strong id="number">1</strong><div id="surface">Содержание</div><div id="mark">✓</div>');
   await page.evaluate(()=>{window.motionRecords=[];const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){window.motionRecords.push({id:this.id,frames,options});return animate.call(this,frames,options);};});
   await page.addScriptTag({content:fs.readFileSync('app/miniapp_static/motion.js','utf8')});
   const button=page.locator('#add'),before=await button.boundingBox();
   await button.hover();await page.mouse.down();
   assert.equal(await page.locator('.press-feedback').count(),1,'anticipation starts at pointer-down, before activation');
   assert.deepEqual(await button.boundingBox(),before,'press preparation does not move a hit area');
   await page.mouse.up();
   await page.evaluate(()=>{
    const m=PolyRentalMotion;m.quantityFeedback(document.querySelector('#number'),document.querySelector('#add'));
    m.stage(document.querySelector('#surface'));m.result(document.querySelector('#mark'));
    m.flyToCart(document.querySelector('#surface'),document.querySelector('#add'));
   });
   const records=await page.evaluate(()=>motionRecords);
   const squash=records.find(r=>r.id==='number');
   assert.match(squash.frames[1].transform,/1\.16,\.84/,'squash and stretch affects the counter');
   assert.equal(squash.frames.at(-1).transform,'scale(1)','feedback settles to its exact resting pose');
   const follow=records.find(r=>r.id==='add');
   assert.equal(follow.options.delay,80,'secondary follow-through follows primary feedback');
   assert.ok(follow.options.duration<=320);
   assert.equal(records.find(r=>r.id==='surface').options.duration,220,'stage transition is short');
   assert.match(records.find(r=>r.id==='mark').frames[0].transform,/perspective/,'confirmation uses consistent depth');
   assert.equal(await page.locator('.cart-flight').getAttribute('aria-hidden'),'true');
   const arc=records.find(r=>r.options.duration===420);
   assert.equal(arc.frames.length,3,'arc has an explicit intermediate pose');
   const point = frame => frame.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)?.slice(1).map(Number);
   const mid=point(arc.frames[1]),end=point(arc.frames[2]);
   assert.ok(mid[1]<end[1]*.48,'intermediate pose bends away from the straight trajectory');
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.waitForFunction(()=>!document.querySelector('.press-feedback,.cart-flight'));
   assert.equal(await page.locator('#number').evaluate(el=>el.getAnimations().length),0);
   await page.evaluate(()=>PolyRentalMotion.quantityFeedback(document.querySelector('#number')));
   assert.equal(await page.locator('#number').evaluate(el=>el.getAnimations().length),0,'new feedback also respects reduced motion');
   assert.deepEqual(await button.boundingBox(),before);
   await page.close();
  }
  {
   const {page,errors}=await fixture(browser,{width:320,order:base('pending')});
   const item={id:1,name:'Камера Sony',category:'generic',capacity:3,available_quantity:3};
   await page.route('**/api/miniapp/catalog?*',r=>r.fulfill({json:{items:[item],selected_items:[item],page:0,page_size:20,total:1}}));
   await page.route('**/api/miniapp/cart',r=>r.fulfill({json:r.request().method()==='PUT'?{...r.request().postDataJSON(),version:1}:{start:'',end:'',lines:[],version:0}}));
   const availability=gate(),received=gate();
   await page.route('**/api/miniapp/availability?*',async r=>{received.resolve();await availability.promise;await r.fulfill({json:{items:[item],all_items:[item],selected_items:[item],unavailable_count:0}});});
   await page.locator('#tab-new').click();
   assert.equal(await page.locator('#frame-progress').isVisible(),true,'four chunks are visible in classic style too');
   await page.locator('[data-category-code="generic"]').click();
   await page.locator('#client-catalog-back').click();
   await page.locator('#recent-category').waitFor();
   assert.match(await page.locator('#recent-category').innerText(),/Оборудование/);
   await page.reload();await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
   await page.locator('#recent-category').click();
   const immediate=await page.locator('.item-card .plus').first().evaluate(el=>{const start=performance.now();el.click();return {elapsed:performance.now()-start,count:document.querySelector('.quantity-value').textContent,footer:document.querySelector('#main-button').textContent};});
   assert.equal(immediate.count,'1');assert.match(immediate.footer,/1/);assert.ok(immediate.elapsed<100,`immediate local feedback: ${immediate.elapsed}ms`);
   const targets=await page.locator('#client-search-hide-keyboard,#app-version,.notification-bell,.catalog-layout-icon,.item-card .plus').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({id:n.id||n.className,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})));
   assert.ok(targets.every(t=>t.w>=43.9&&t.h>=43.9),JSON.stringify(targets));
   await page.locator('#main-button').click();
   assert.equal(await page.locator('#step-contact h2').evaluate(n=>n===document.activeElement),true,'stage heading receives focus');

   await page.locator('#main-button').click();
   assert.equal(await page.locator('#customer-name,#customer-contact').count(),0,'contacts are collected in the identity form');
   await page.locator('[data-date="2026-11-03"]').click();await page.locator('[data-date="2026-11-04"]').click();
   await page.locator('#start-time').fill('10:00');await page.locator('#end-time').fill('18:00');
   await page.locator('#main-button').click();await received.promise;
   assert.equal(await page.locator('#main-button').getAttribute('aria-busy'),'true','immediate and honest waiting state');
   assert.match(await page.locator('#main-button').innerText(),/Проверяем доступность/);
   assert.equal(await page.locator('#main-button').isDisabled(),true);
   availability.resolve();await page.locator('#step-review').waitFor();
   assert.equal(await page.locator('#main-button').getAttribute('aria-busy'),'false');
   assert.match(await page.locator('#review-content').innerText(),/ФИО и телефон вы укажете в анкете/);
   assert.equal(await page.locator('#frame-progress [aria-current]').innerText(),'4\nПроверка');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log(`Interaction principles (${engine.name()}): press geometry, squash/settle, follow-through, arc, depth, timing, reduced motion, targets, four stages, focus, recent shortcut, tolerant contact and delayed response passed`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
