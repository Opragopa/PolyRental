const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('app/miniapp_static/app.js', 'utf8');
const motion = source.slice(source.indexOf('  // Animate the element'), source.indexOf('  const tg ='));
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({reducedMotion});
      await page.setContent('<details><summary>Развернуть</summary><div style="height:180px">Содержимое</div></details><p id="after">Ниже</p>');
      await page.addScriptTag({content: motion});
      const after = page.locator('#after');
      const before = (await after.boundingBox()).y;
      await page.locator('summary').click();
      if (reducedMotion === 'no-preference') {
        await page.waitForTimeout(90);
        const during = (await after.boundingBox()).y;
        assert(during > before && during < before + 180, `content should move gradually: ${during-before}`);
      }
      await page.waitForTimeout(350);
      assert((await after.boundingBox()).y >= before + 179);
      await page.locator('summary').click();
      await page.waitForTimeout(350);
      assert(Math.abs((await after.boundingBox()).y - before) < 1);
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      assert(await page.locator('details').evaluate(el => el.open));
      await page.setContent('<style>#tiles{display:grid;grid-template-columns:1fr;width:300px}#tiles.grid{grid-template-columns:1fr 1fr}#tiles div{height:60px}</style><div id="tiles"><div>A</div><div>B</div><div>C</div><div>D</div></div>');
      await page.addScriptTag({content:fs.readFileSync('app/miniapp_static/motion.js','utf8')});
      const initialHeight = await page.locator('#tiles').evaluate(el=>el.getBoundingClientRect().height);
      await page.evaluate(()=>PolyRentalMotion.reflow([document.querySelector('#tiles')],()=>document.querySelector('#tiles').classList.add('grid')));
      if (reducedMotion === 'no-preference') {
        await page.waitForTimeout(80);
        const during = await page.locator('#tiles').evaluate(el=>el.getBoundingClientRect().height);
        assert(during < initialHeight && during > 120, `grid height should change gradually: ${during}`);
        const reversal = await page.evaluate(()=>{ const host=document.querySelector('#tiles'), before=host.getBoundingClientRect().height; PolyRentalMotion.reflow([host],()=>host.classList.remove('grid')); return {before, after:host.getBoundingClientRect().height}; });
        assert(Math.abs(reversal.before-reversal.after)<1, `reversal must start from the visible height: ${JSON.stringify(reversal)}`);
        await page.waitForTimeout(350);
        assert(Math.abs(await page.locator('#tiles').evaluate(el=>el.getBoundingClientRect().height)-initialHeight)<1,'rapid reversal settles to the correct height');
      } else {
        assert.equal(await page.locator('#tiles').evaluate(el=>el.getAnimations().length),0);
      }
      await page.setContent('<div id="product" style="width:160px;height:80px">Камера</div><button id="basket" style="position:fixed;bottom:10px;right:10px">Корзина</button>');
      await page.evaluate(()=>PolyRentalMotion.flyToCart(document.querySelector('#product'),document.querySelector('#basket')));
      if (reducedMotion === 'no-preference') {
        assert.equal(await page.locator('.cart-flight').count(),1);
        assert.equal(await page.locator('.cart-flight').getAttribute('aria-hidden'),'true');
        await page.evaluate(()=>{ for (let i=0;i<5;i++) PolyRentalMotion.flyToCart(document.querySelector('#product'),document.querySelector('#basket')); });
        assert.equal(await page.locator('.cart-flight').count(),3,'rapid clicks keep at most three visual copies');
        await page.evaluate(()=>PolyRentalMotion.cancelTransient());
        assert.equal(await page.locator('.cart-flight').count(),0,'leaving the screen removes transient animation');
        await page.evaluate(()=>PolyRentalMotion.flyToCart(document.querySelector('#product'),document.querySelector('#basket')));
        await page.locator('.cart-flight').evaluateAll(nodes=>nodes.forEach(node=>node.getAnimations().forEach(animation=>animation.finish())));
        await page.waitForFunction(()=>!document.querySelector('.cart-flight'));
      } else assert.equal(await page.locator('.cart-flight').count(),0);
      await page.setContent('<h2 id="heading">Каталог</h2>');
      await page.evaluate(()=>PolyRentalMotion.morphText(document.querySelector('#heading'),'Управление'));
      assert.equal(await page.locator('#heading').innerText(),'Управление');
      if (reducedMotion === 'no-preference') {
        assert.equal(await page.locator('.heading-morph-copy').count(),1);
        await page.evaluate(()=>PolyRentalMotion.morphText(document.querySelector('#heading'),'Профиль'));
        await page.locator('.heading-morph-copy').evaluateAll(nodes=>nodes.forEach(node=>node.getAnimations().forEach(animation=>animation.finish())));
        await page.waitForFunction(()=>!document.querySelector('.heading-morph-copy'));
      } else assert.equal(await page.locator('.heading-morph-copy').count(),0);
      await page.close();
    }
    console.log('Disclosure motion, layout, keyboard and reduced motion: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
