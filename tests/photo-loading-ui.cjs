const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
const preview='data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA';
const waitForState=(page,state)=>page.waitForFunction(state=>document.querySelector('.article-media')?.dataset.photoState===state,state);
(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  const {page,errors}=await fixture(browser,{admin:true,role:'manager',order:base()});
  let current='',imageRequests=0,releaseImage,releaseUpload,uploads=0;
  let imageResponse=new Promise(resolve=>{releaseImage=resolve;});
  await page.route('https://images.test/camera.webp',async route=>{
   imageRequests++;await imageResponse;
   return imageRequests===1?route.fulfill({status:503,body:''}):route.fulfill({contentType:'image/webp',body:Buffer.from(preview.split(',')[1],'base64')});
  });
  await page.route(/\/api\/miniapp\/admin\/catalog(?:\?|$)/,route=>route.fulfill({json:{articles:[{id:1,name:'Камера Sony',sku:'CAM',category:'camera',image_data:current,image_url:current?'':'https://images.test/camera.webp',equipment:[]}],dependencies:[]}}));
  await page.locator('[data-mode="catalog"]').click();
  await page.waitForFunction(()=>document.querySelector('.article-media')?.getAttribute('aria-busy')==='true');
  assert.ok(await page.locator('.article-media .catalog-photo-progress').isVisible());
  releaseImage();await waitForState(page,'error');
  assert.ok(await page.locator('.catalog-photo-retry').isVisible());
  assert.equal(await page.locator('.article-media').getAttribute('aria-busy'),'false');
  imageResponse=new Promise(resolve=>{releaseImage=resolve;});
  await page.locator('.catalog-photo-retry').click();
  assert.ok(await page.locator('.catalog-photo-progress').isVisible());
  releaseImage();await waitForState(page,'loaded');
  assert.equal(await page.locator('.catalog-photo-progress').isVisible(),false);
  assert.equal(await page.locator('.catalog-photo-placeholder').isVisible(),false);
  assert.ok(await page.locator('.article-media img').isVisible());
  await page.locator('.article-toggle').click();
  await page.getByRole('button',{name:'Загрузить фото модели',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Фото модели оборудования'});
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;canvas.getContext('2d').fillRect(0,0,20,20);return canvas.toDataURL().split(',')[1];});
  await dialog.locator('input').setInputFiles({name:'camera.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  let uploadResponse=new Promise(resolve=>{releaseUpload=resolve;});
  await page.route('**/api/miniapp/admin/catalog/articles/1/photo',async route=>{
   uploads++;await uploadResponse;
   if(uploads===1)return route.fulfill({status:503,json:{detail:'Не удалось сохранить фото. Повторите.'}});
   current=preview;return route.fulfill({json:{ok:true,image_data:current}});
  });
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.catalog-photo-dialog form')?.getAttribute('aria-busy')==='true');
  assert.ok(await dialog.locator('.photo-save-status').isVisible());
  assert.ok(await dialog.locator('input').isDisabled());
  await dialog.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  releaseUpload();await dialog.getByRole('alert').waitFor();
  assert.equal(uploads,1,'duplicate submission is ignored');
  assert.equal(await dialog.locator('input').isDisabled(),false);
  assert.equal(await dialog.locator('.photo-save-status').isVisible(),false);
  assert.equal(await page.locator('.article-media img').getAttribute('src'),'https://images.test/camera.webp','failed save keeps existing photo');
  uploadResponse=new Promise(resolve=>{releaseUpload=resolve;});
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
  releaseUpload();await dialog.waitFor({state:'detached'});
  await waitForState(page,'loaded');
  assert.equal(await page.locator('.article-media img').getAttribute('src'),preview);
  await page.getByText('Фото сохранено.',{exact:true}).waitFor();
  for(let attempt=0;attempt<3;attempt++){
   await page.locator('[data-mode="orders"]').click();
   await page.locator('[data-mode="catalog"]').click();
   await waitForState(page,'loaded');
   assert.ok(await page.locator('.article-media img').isVisible());
   assert.equal(await page.locator('.catalog-photo-progress').isVisible(),false);
   assert.equal(await page.locator('.article-media img').evaluate(img=>getComputedStyle(img).opacity),'1');
  }
  assert.deepEqual(errors,[]);await page.close();
  console.log('Photo loading: progress, failed image retry, upload error/retry, duplicate guard, confirmed preview and cached reopen passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
