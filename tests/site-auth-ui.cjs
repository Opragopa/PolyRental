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
 assert.deepEqual(errors,[]);await page.close();
 const login=await browser.newPage();let attempts=0;
 await login.route('**/telegram-widget.js*',route=>{attempts++;if(attempts===1)return route.abort();return route.fulfill({contentType:'text/javascript',body:'const f=document.createElement("iframe");f.src="about:blank";document.currentScript.parentNode.insertBefore(f,document.currentScript);'});});
 await login.route('**/site-login.js*',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(assets,'site-login.js'))}));
 await login.route('**/login-test',route=>route.fulfill({contentType:'text/html',body:'<div id="login-widget" data-bot="test_bot" data-callback="https://example.test/site/auth?state=abc"></div><div id="login-fallback" hidden><button id="login-retry">Повторить загрузку</button></div><script src="/site-login.js"></script>'}));
 await login.goto('http://polyrental.test/login-test');
 await login.locator('#login-retry').click();
 await login.locator('#login-widget iframe').waitFor();
 assert.equal(attempts,2);assert.equal(await login.locator('#login-fallback').isHidden(),true);
 assert.equal(await login.locator('#login-widget script').getAttribute('data-auth-url'),'https://example.test/site/auth?state=abc');
 await login.close();console.log('site session and Telegram login recovery: passed');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});

