const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa');
(async () => {
  const name=process.env.PLAYWRIGHT_BROWSER||'chromium';
  const browser=await (name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[], questions=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='telegram.org') return route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:42}}}}'});
      if(url.pathname.startsWith('/miniapp/static/')) {const file=path.join(assets,path.basename(url.pathname)); return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'text/javascript'});}
      if(url.pathname==='/api/miniapp/me') return route.fulfill({json:{id:42,admin:false,pii_admin:false}});
      if(url.pathname==='/api/miniapp/profile') return route.fulfill({json:{display_name:'QA',onboarding_seen:true,start_screen:'booking',reminders_enabled:true}});
      if(url.pathname==='/api/miniapp/cart') return route.fulfill({json:{start:'',end:'',lines:[],version:0}});
      if(url.pathname==='/api/miniapp/support/faq') return route.fulfill({json:{items:[{question:'Как?',answer:'Выберите даты.'}]}});
      if(url.pathname==='/api/miniapp/support/questions') {questions.push(route.request().postDataJSON()); return route.fulfill({json:{status:'Обращение получено',id:1}});}
      if(url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[],total:0}});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://polyrental.test/miniapp');
    await page.locator('#tab-orders').click();
    await page.locator('#profile-header > summary').click();
    await page.getByRole('button',{name:'Поддержка',exact:true}).click();
    const dialog=page.locator('#support-dialog'); await dialog.waitFor({state:'visible'});
    await dialog.getByText('Как?',{exact:true}).click();
    await dialog.getByText('Выберите даты.').waitFor({state:'visible'});
    assert.equal(await dialog.getByText('Выберите даты.').isVisible(),true);
    await dialog.locator('#support-question').fill('Нужна помощь');
    await dialog.getByRole('button',{name:'Отправить вопрос'}).click();
    await dialog.getByText('Обращение получено').waitFor();
    assert.deepEqual(questions,[{question:'Нужна помощь',screen:'profile',booking_id:null}]);
    await dialog.getByRole('button',{name:'Закрыть'}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await dialog.isHidden(),true); assert.deepEqual(errors,[]);
    console.log('Support sheet checks passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
