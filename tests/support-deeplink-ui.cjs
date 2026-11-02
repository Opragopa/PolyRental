const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());
 if(url.hostname==='telegram.org')return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:100}}}}'});
 if(url.pathname.startsWith('/miniapp/static/')){const file=path.resolve(assets,url.pathname.slice('/miniapp/static/'.length));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
 if(url.pathname==='/api/miniapp/me')return route.fulfill({json:{id:100,admin:true,pii_admin:true,staff_role:'admin'}});
 if(url.pathname==='/api/miniapp/profile')return route.fulfill({json:{onboarding_seen:true,start_screen:'management'}});
 if(url.pathname==='/api/miniapp/cart')return route.fulfill({json:{version:0,start:'',end:'',lines:[]}});
 if(url.pathname==='/api/miniapp/admin/support')return route.fulfill({json:{items:[{id:45,request_number:'ТС260045',status:'in_progress',owner_id:100,created_at:'2026-11-02T10:00:00Z'}],eligible_owners:[100]}});
 if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[]}});
 return route.fulfill({body:fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','qa'),contentType:'text/html'});
 });
 await page.goto('http://polyrental.test/miniapp?startapp=support_45');
 const card=page.locator('[data-support-thread-id="45"]');await card.waitFor();
 assert.match(await card.innerText(),/Обращение №45/);
 assert.equal(await page.getByText('Открыть сообщения').count(),1);
 assert.deepEqual(errors,[]);console.log('support deep link: passed');await page.close();
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
