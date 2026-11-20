const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({headless:true,
    ...(engine === 'chromium' ? {channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'} : {})});
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({viewport:{width,height:800}});
      await page.setContent(`<style>body{margin:0}.long{height:3500px}.collapsed{display:none}[role=dialog]{position:fixed;inset:20px;background:white;z-index:10}</style>
        <button id="outside">Главная</button><div class="long"></div>
        <section id="host"><details id="details" open><summary>Анкета</summary>
        <div id="dialog" hidden role="dialog" aria-modal="true"><button>Документы</button></div></details></section>`);
      const assets = process.env.POLYRENTAL_QA_ASSETS || path.resolve(__dirname,'../app/miniapp_static');
      await page.addScriptTag({path:path.join(assets,'dialogs.js')});
      await page.addScriptTag({path:path.join(assets,'motion.js')});
      const locked = () => page.waitForFunction(() => document.body.style.position === 'fixed');
      const unlocked = async () => {
        await page.waitForFunction(() => document.body.style.position !== 'fixed' && document.documentElement.style.overflow !== 'hidden' && !document.querySelector('#outside').inert);
        await page.evaluate(() => window.scrollTo(0, 700));
        assert.equal(await page.evaluate(() => window.scrollY),700);
        if (width === 1440) {
          await page.mouse.move(10,300); await page.mouse.wheel(0,300);
          await page.waitForFunction(() => scrollY > 700);
        }
      };
      for (const action of ['hide', 'ancestor', 'collapse', 'closing', 'class', 'visibility', 'remove']) {
        await page.evaluate(() => {
          document.querySelector('#host').hidden=false;
          document.querySelector('#host').className='';
          document.querySelector('#details').open=true;
          const dialog=document.querySelector('#dialog'); dialog.removeAttribute('data-modal-closing'); dialog.style.visibility=''; dialog.hidden=false;
        });
        await locked();
        await page.evaluate(action => {
          const dialog=document.querySelector('#dialog');
          if(action==='hide') dialog.hidden=true;
          if(action==='ancestor') document.querySelector('#host').hidden=true;
          if(action==='collapse') document.querySelector('#details').open=false;
          if(action==='closing') dialog.setAttribute('data-modal-closing','');
          if(action==='class') document.querySelector('#host').classList.add('collapsed');
          if(action==='visibility') dialog.style.visibility='hidden';
          if(action==='remove') dialog.remove();
        },action);
        await unlocked();
      }
      await page.evaluate(() => {
        const dialog = document.createElement('section');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        document.body.append(dialog);
        dialog.animate = () => ({finished: new Promise(() => {}), cancel() {}});
        void window.PolyRentalMotion.removeDialog(dialog);
      });
      await page.waitForFunction(() => !document.querySelector('[data-modal-closing]'));
      await unlocked();
      await page.close();
    }
    console.log(`${engine}: scroll restored for 8 modal exit paths at 390/1440px`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
