const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const assets=path.resolve(__dirname,'../app/miniapp_static');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());
 if(url.hostname==='telegram.org')return route.fulfill({body:'',contentType:'text/javascript'});
 if(url.pathname.startsWith('/miniapp/static/')) {const file=path.resolve(assets,url.pathname.slice('/miniapp/static/'.length));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
 if(url.pathname==='/api/site/session')return route.fulfill({json:{id:42,first_name:'Ирина'}});
 if(url.pathname==='/api/miniapp/me')return route.fulfill({json:{id:42,admin:false}});
 if(url.pathname==='/api/miniapp/profile')return route.fulfill({json:{onboarding_seen:true,start_screen:'booking'}});
 if(url.pathname==='/api/miniapp/cart')return route.fulfill({json:{version:0,start:'',end:'',lines:[]}});
 if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[]}});
 return route.fulfill({body:fs.readFileSync(path.join(assets,'index.html'),'utf8').replaceAll('__APP_VERSION__','qa'),contentType:'text/html'});
 });
 await page.goto('http://polyrental.test/site');
 await page.getByRole('button',{name:'Выйти'}).waitFor();
 assert.equal(await page.locator('#customer-name').inputValue(),'Ирина');
 assert.match(await page.locator('#mode-banner').innerText(),/Вы вошли через Telegram/);
 assert.deepEqual(errors,[]);console.log('site session UI: passed');await page.close();
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});

