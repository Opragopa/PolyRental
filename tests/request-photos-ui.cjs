const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
const preview='data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA';
const fs=require('node:fs'),path=require('node:path');
const output=process.env.PHOTO_QA_OUTPUT;
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  for(const admin of [false,true]){
   const order=base('pending');
   order.article_media={1:{title:'Sony FX3',name:'Камера Sony FX3',category:'camera',description:'Полнокадровая кинокамера.',image_data:preview}};
   order.items[0].title=order.lines[0].title='Sony FX3';
   const {page,errors}=await fixture(browser,{admin,role:'manager',order,width:390,isMobile:false});
   const row=page.locator('.request-equipment-row:visible').first();
   const trigger=row.locator('.equipment-preview-trigger');
   const dialog=page.getByRole('dialog',{name:'Sony FX3',exact:true});
   await page.emulateMedia({reducedMotion:'reduce'});
   await trigger.scrollIntoViewIfNeeded();
   const {x,y}=await trigger.boundingBox();
   await page.mouse.move(x+20,y+20);
   await page.mouse.down();
   await page.mouse.move(x+20,y+34);
   await page.clock.runFor(550);
   assert.equal(await dialog.count(),0,'a scrolling gesture must not open the preview');
   await page.mouse.up();
   const down=()=>trigger.evaluate(el=>el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,pointerType:'touch',pointerId:5,button:0,clientX:10,clientY:10})));
   await down();
   await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:5})));
   await page.clock.runFor(550);
   assert.equal(await dialog.count(),0,'pointer cancellation must clear the hold');
   await down();
   await page.clock.runFor(500);
   await dialog.waitFor();
   assert.equal(await dialog.locator('.equipment-preview-morph').count(),0,'reduced motion opens the preview immediately');
   await dialog.locator('.equipment-preview-description').waitFor();
   assert.equal(await dialog.locator('.equipment-preview-description').innerText(),'Полнокадровая кинокамера.');
   assert.equal(await dialog.locator('img').getAttribute('src'),preview);
   await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
   await dialog.waitFor({state:'detached'});
   await page.waitForFunction(el=>document.activeElement===el,await row.elementHandle());
   await row.press(admin?'Shift+Enter':'Enter');
   await dialog.waitFor();
   await page.keyboard.press('Escape');
   await dialog.waitFor({state:'detached'});
   await page.emulateMedia({reducedMotion:'no-preference'});
   await trigger.scrollIntoViewIfNeeded();
   await page.waitForTimeout(400);
   const beforeHold=await row.evaluate(el=>el.getBoundingClientRect().width);
   await down();
   await page.waitForFunction(el=>parseFloat(getComputedStyle(el).scale)<.99,await row.elementHandle());
   assert.equal(await dialog.count(),0,'press feedback precedes the preview');
   await page.clock.runFor(500);
   const shell=dialog.locator('.equipment-preview-morph');
   await shell.waitFor();
   await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
   assert(await shell.count(),'viewport resize must not interrupt the morph');
   const geometry=await shell.evaluate(el=>{
    const animation=el.getAnimations()[0];
    animation.pause();
    const frames=animation.effect.getKeyframes();
    const matrix=new DOMMatrixReadOnly(frames[0].transform);
    return {from:el.offsetWidth*matrix.a,to:el.offsetWidth,fromHeight:el.offsetHeight*matrix.d,toHeight:el.offsetHeight};
   });
   assert(geometry.from<beforeHold && geometry.fromHeight<geometry.toHeight,JSON.stringify(geometry));
   assert.equal(await dialog.locator('img').isVisible(),false,'photo is hidden during the morph');
   assert.equal(await dialog.locator('.equipment-preview-description').isVisible(),false,'description is hidden during the morph');
   await shell.evaluate(el=>el.getAnimations()[0].finish());
   await shell.waitFor({state:'detached'});
   assert(await dialog.locator('.equipment-preview-description').isVisible());
   await page.keyboard.press('Escape');
   await dialog.waitFor({state:'detached'});
   assert(await page.evaluate(()=>document.body.style.position!=='fixed' && document.documentElement.style.overflow!=='hidden'));
   if(admin){
    const before=await row.getAttribute('aria-expanded');
    await trigger.click();
    assert.notEqual(await row.getAttribute('aria-expanded'),before,'a short click still toggles inline details');
    assert.equal(await dialog.count(),0);
   }
   assert.deepEqual(errors,[]);
   await page.close();
  }
  if(engine===chromium){
   const order=base('pending');
   order.article_media={1:{name:'Камера Sony',description:'Характеристики камеры. '.repeat(150),image_data:preview}};
   const {page,errors}=await fixture(browser,{order,width:390,isMobile:true});
   const row=page.locator('.request-equipment-row:visible').first();
   const thumbnail=row.locator('.request-equipment-thumb');
   await page.clock.runFor(450);
   await page.waitForFunction(()=>document.querySelector('.customer-order-accordion').style.overflow!=='hidden');
   await thumbnail.evaluate(el=>{
    document.documentElement.style.scrollBehavior='auto';
    scrollBy(0,el.getBoundingClientRect().top-innerHeight/2);
   });
   const box=await thumbnail.boundingBox();
   const point={x:box.x+box.width/2,y:box.y+box.height/2};
   const hit=await page.evaluate(({x,y})=>{
    const target=document.elementFromPoint(x,y);
    return {preview:Boolean(target?.closest('.equipment-preview-trigger')),target:target?.outerHTML.slice(0,150),width:innerWidth,height:innerHeight,
     scroll:scrollY,docHeight:document.documentElement.scrollHeight,bodyStyle:document.body.getAttribute('style'),
     dialogs:[...document.querySelectorAll('[role="dialog"]:not([hidden])')].filter(d=>d.getClientRects().length).map(d=>d.getAttribute('aria-label')||d.id)};
   },point);
   assert(hit.preview,'the thumbnail must be reachable by a touch: '+JSON.stringify({point,hit}));
   const touch=await page.context().newCDPSession(page);
   await page.evaluate(()=>{
    window.previewTouchEvents=[];
    for (const type of ['pointerdown','pointerup','pointercancel','pointermove','contextmenu','blur']) {
     window.addEventListener(type,event=>window.previewTouchEvents.push([type,event.pointerType,event.clientX,event.clientY]),true);
    }
   });
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
   assert(await row.evaluate(el=>el.classList.contains('is-preview-pressed')),'the first touch starts the hold');
   const dialog=page.getByRole('dialog',{name:'Камера Sony',exact:true});
   await page.clock.runFor(470);
   assert(await dialog.count(),'the first hold opens the preview: '+JSON.stringify(await page.evaluate(()=>window.previewTouchEvents)));
   assert(await dialog.locator('.equipment-preview-morph').count(),'the first hold uses the morph');
   await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await dialog.locator('.equipment-preview-description').waitFor();
   const form=dialog.locator('.dialog-card');
   await form.evaluate(el=>{el.scrollTop=160;});
   assert(await form.evaluate(el=>el.scrollTop>0),'long descriptions remain scrollable');
   await dialog.getByRole('button',{name:'Закрыть',exact:true}).tap();
   await dialog.waitFor({state:'detached'});
   await page.evaluate(()=>{
    const spacer=document.createElement('div');
    spacer.style.height='1200px';
    document.querySelector('#orders-content').append(spacer);
    scrollTo(0,100);
   });
   await page.waitForFunction(()=>scrollY===100);
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:630}]});
   for(const y of [592,544,488]) {
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y}]});
    await page.waitForTimeout(24);
   }
   await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForFunction(()=>scrollY>150);
   assert.deepEqual(errors,[]);
   await page.close();
  }
  for(const width of [320,390,1440])for(const status of ['pending','preparing','return_inspection']){
   const order=base(status);
   order.article_media={1:{name:'Камера Sony',category:'camera',image_data:preview}};
   const {page,errors}=await fixture(browser,{admin:true,role:'manager',order,width,isMobile:width<768});
   const thumbs=page.locator('.request-equipment-thumb:visible');
   assert.ok(await thumbs.count()>0);
   for(const thumb of await thumbs.all()){
    await thumb.scrollIntoViewIfNeeded();
    await page.waitForFunction(node=>node.querySelector('.catalog-media')?.dataset.photoState==='loaded',await thumb.elementHandle());
    const image=thumb.locator('img');
    assert.equal(await image.getAttribute('src'),preview,'freshly opened request uses its own photo, without visiting catalog');
    const bounds=await thumb.evaluate(node=>{
     const frame=node.getBoundingClientRect(),media=node.querySelector('.catalog-media').getBoundingClientRect(),image=node.querySelector('img').getBoundingClientRect();
     return {centerX:Math.abs((frame.left+frame.right-image.left-image.right)/2),centerY:Math.abs((frame.top+frame.bottom-image.top-image.bottom)/2),width:Math.abs(node.clientWidth-media.width),height:Math.abs(node.clientHeight-media.height)};
    });
    for(const [dimension,delta]of Object.entries(bounds))assert.ok(delta<1,`${status} ${width}px ${dimension}: ${delta}`);
    assert.ok(await image.isVisible());
   }
   if(output&&width===390){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${status}.png`),fullPage:true});}
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Request photos and long-press previews passed in customer and staff requests');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
