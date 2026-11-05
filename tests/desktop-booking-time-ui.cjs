/* Desktop booking time is entered as text; mobile keeps the native picker. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
const version=fs.readFileSync(path.resolve(__dirname,'../VERSION'),'utf8').trim();
const html=fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__',version);
(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  for(const width of [1024,1440]){
   const page=await browser.newPage({viewport:{width,height:1000},hasTouch:false,isMobile:false});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:''});
    if(url.pathname.startsWith('/miniapp/static/')){const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream'});}
    return route.fulfill({body:html,contentType:'text/html'});
   });
   await page.clock.install({time:new Date('2026-10-29T10:00:00Z')});
   await page.goto('http://polyrental.test/miniapp?preview=1');
   await page.locator('.item-card .plus').first().click();await page.locator('#main-button').click();
   await page.locator('#customer-name').fill('Анна');await page.locator('#customer-contact').fill('@anna_user');await page.locator('#main-button').click();
   await page.locator('[data-date="2026-10-30"]').click();await page.locator('[data-date="2026-11-02"]').click();
   const start=page.locator('#start-time'),end=page.locator('#end-time');
   assert.equal(await start.getAttribute('type'),'text');assert.equal(await start.inputValue(),'');assert.equal(await end.inputValue(),'');
   await start.focus();await start.pressSequentially('0930');await start.press('Tab');
   assert.equal(await start.inputValue(),'09:30');assert.equal(await end.evaluate(el=>el===document.activeElement),true);
   await end.pressSequentially('1830');await end.press('Enter');
   assert.equal(await end.inputValue(),'18:30');assert.equal(await page.locator('#main-button').evaluate(el=>el===document.activeElement),true);
   assert.equal(await page.locator('#start').inputValue(),'2026-10-30T09:30');
   assert.equal(await page.locator('#end').inputValue(),'2026-11-02T18:30');
   await start.focus();await start.pressSequentially('9:45');await start.press('Enter');assert.equal(await start.inputValue(),'09:45');
   assert.equal(await end.evaluate(el=>el===document.activeElement),true);
   for(const invalid of ['25:00','1260','12:3','text']){
    await end.fill(invalid);await end.press('Tab');assert.equal(await end.getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#end').inputValue(),'');assert.equal(await page.locator('#main-button').isDisabled(),true);
   }
   await end.fill('18.15');await end.press('Tab');assert.equal(await end.inputValue(),'18:15');assert.equal(await end.getAttribute('aria-invalid'),'false');
   await start.fill('9');await start.press('Tab');assert.equal(await start.inputValue(),'09:00');
   await end.fill('');await page.locator('#main-button').click();assert.equal(await end.getAttribute('aria-invalid'),'true');
   await end.fill('19:00');await end.press('Tab');
   await page.clock.runFor(400);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   fs.mkdirSync('artifacts/desktop-booking-time',{recursive:true});await page.screenshot({path:`artifacts/desktop-booking-time/${width}.png`,fullPage:true});
   await page.locator('#main-button').click();await page.locator('#step-review').waitFor();
   assert.match(await page.locator('#review-content').innerText(),/09:00/);assert.match(await page.locator('#review-content').innerText(),/19:00/);
   await page.locator('#top-back-button').click();assert.equal(await start.inputValue(),'09:00');assert.equal(await end.inputValue(),'19:00');
   await page.reload();await page.locator('.item-card').first().waitFor();
   assert.equal(await start.inputValue(),'09:00');assert.equal(await end.inputValue(),'19:00');
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Desktop keyboard time: typing, select/replace, Tab/Enter, validation, review and draft restore passed at 1024/1440px');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
