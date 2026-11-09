const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
const preview='data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA';
const fs=require('node:fs'),path=require('node:path');
const output=process.env.PHOTO_QA_OUTPUT;
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
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
  console.log('Request photos: fresh management entry, request and inspection rows, centered images at 320/390/1440px passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
