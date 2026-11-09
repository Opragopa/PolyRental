const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
const {page,errors}=await fixture(browser,{admin:true,role:'manager',order:base('pending')});
// Inspect the actual FormData file before fetch. WebKit's intercepted binary
// multipart postDataBuffer is not a reliable byte-for-byte representation.
await page.evaluate(()=>{
 const original=window.fetch;
 window.fetch=async(input,options)=>{
   if(String(input).endsWith('/photo') && options?.body instanceof FormData){
     const file=options.body.get('photo');
     const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
     window.__photoUpload={mime:file.type,name:file.name,base64};
   }
   return original(input,options);
 };
});
await page.route('**/api/miniapp/admin/catalog/articles/1/photo',route=>route.fulfill({json:{ok:true}}));
await page.locator('[data-mode="catalog"]').click();
for(const type of ['image/png','image/webp','image/jpeg']){
 if(await page.locator('.article-toggle').getAttribute('aria-expanded')!=='true')await page.locator('.article-toggle').click();
 await page.getByRole('button',{name:'Загрузить фото модели',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Фото модели оборудования'});await dialog.waitFor();
 const base64=await page.evaluate(type=>{const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;const c=canvas.getContext('2d');c.fillStyle='rgba(30,170,90,.5)';c.fillRect(32,0,64,64);return canvas.toDataURL(type).split(',')[1];},type);
 await dialog.locator('[name="photo"]').setInputFiles({name:'photo.'+type.split('/')[1],mimeType:type,buffer:Buffer.from(base64,'base64')});
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await dialog.waitFor({state:'detached'});
 const uploaded=await page.evaluate(()=>window.__photoUpload);assert.ok(uploaded);
 const mime=uploaded.mime;
 assert.ok(['image/webp','image/png'].includes(mime),'upload must use WebP or transparent PNG fallback');
 const pixels=await page.evaluate(async({mime,base64})=>{const image=new Image();image.src=`data:${mime};base64,${base64}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);return [c.getImageData(5,5,1,1).data[3],c.getImageData(60,5,1,1).data[3]];},{mime,base64:uploaded.base64});
 if(type==='image/jpeg')assert.deepEqual(pixels,[255,255]);else assert.deepEqual(pixels,[0,128]);
 await page.locator('.article-toggle').waitFor();
}
assert.deepEqual(errors,[]);await page.close();console.log('Catalog photo upload: PNG/WebP/JPEG converted to WebP with alpha preserved');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
