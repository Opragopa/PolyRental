const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('app/miniapp_static/app.js', 'utf8');
const motion = source.slice(source.indexOf('  // Animate the element'), source.indexOf('  const tg ='));
const viewportFocus = fs.readFileSync('app/miniapp_static/viewport-focus.js', 'utf8');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({reducedMotion, viewport:{width:390,height:844}});
      await page.setContent('<details><summary>Развернуть</summary><div style="height:180px">Содержимое</div></details><p id="after">Ниже</p>');
      await page.addScriptTag({content: viewportFocus});
      await page.addScriptTag({content: motion});
      const after = page.locator('#after');
      const before = (await after.boundingBox()).y;
      // Native summary marker metrics differ between engines (WebKit's closed
      // line is taller). Compare with the real expanded layout, not 180px.
      const expanded = await page.evaluate(() => {
        const details = document.querySelector('details');
        details.open = true;
        const y = document.querySelector('#after').getBoundingClientRect().y;
        details.open = false;
        return y;
      });
      await page.locator('summary').click();
      if (reducedMotion === 'no-preference') {
        await page.waitForTimeout(90);
        const during = (await after.boundingBox()).y;
        assert(during > before && during < expanded, `content should move gradually: ${during-before}`);
      }
      await page.waitForTimeout(350);
      assert(Math.abs((await after.boundingBox()).y - expanded) < 1);
      await page.locator('summary').click();
      await page.waitForTimeout(350);
      assert(Math.abs((await after.boundingBox()).y - before) < 1);
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      assert(await page.locator('details').evaluate(el => el.open));
      await page.locator('summary').evaluate(el => { el.click(); el.click(); el.click(); });
      await page.waitForFunction(() => !document.querySelector('details').open && !document.querySelector('details').style.overflow);
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
      await page.setContent('<section id="category" style="width:240px;height:70px"><button>Очень длинное название категории</button></section>');
      await page.evaluate(()=>{const source=document.querySelector('#category'); PolyRentalMotion.transitionCategoryView(PolyRentalMotion.captureCategoryView(source),source,1);});
      if (reducedMotion === 'no-preference') {
        const clone=page.locator('.category-level-transition');
        assert.equal(await clone.getAttribute('aria-hidden'),'true');
        assert.equal(await clone.evaluate(el=>el.getAnimations({subtree:true})[0].effect.getKeyframes()[1].transform),'translateX(-240px)');
        await page.evaluate(()=>PolyRentalMotion.cancelTransient());
        await page.evaluate(()=>{const source=document.querySelector('#category'); PolyRentalMotion.transitionCategoryView(PolyRentalMotion.captureCategoryView(source),source,-1);});
        assert.equal(await clone.evaluate(el=>el.getAnimations({subtree:true})[0].effect.getKeyframes()[1].transform),'translateX(240px)');
        await page.evaluate(()=>PolyRentalMotion.cancelTransient());
      } else assert.equal(await page.locator('.category-level-transition').count(),0);
      await page.close();
    }
    for (const width of [390, 1440]) for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({viewport: {width, height: 640}, reducedMotion});
      await page.setContent(`<style>
        body { margin: 0; } header { position: fixed; inset: 0 0 auto; height: 56px; }
        .tabs { position: fixed; inset: auto 0 0; height: 64px; }
        #space, #tail { height: 900px; } #target { height: 180px; }
        #target.tall { height: 850px; }
        [role=dialog] { position: fixed; inset: 80px 20px; overflow: auto; background: white; }
      </style><header></header><div id="space"></div><section id="target"></section><div id="tail"></div><nav class="tabs"></nav>`);
      await page.addScriptTag({content: viewportFocus});
      const dimensions = await page.evaluate(async () => {
        const target = document.querySelector('#target');
        const original = window.scrollTo;
        const commands = [];
        window.scrollTo = function (options) { commands.push([options.behavior, target.getBoundingClientRect().height]); return original.call(this, options); };
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          target.animate([{height:'60px'}, {height:'180px'}], {duration:160});
        }
        await PolyRentalViewportFocus.reveal(target);
        const rect = target.getBoundingClientRect();
        return {center: (rect.top + rect.bottom) / 2, commands};
      });
      assert(Math.abs(dimensions.center - 316) <= 2, JSON.stringify(dimensions));
      assert.deepEqual(dimensions.commands[0], [reducedMotion === 'reduce' ? 'instant' : 'smooth', 180],
        'positioning uses the settled height');
      const tallTop = await page.evaluate(async () => {
        const target = document.querySelector('#target');
        target.classList.add('tall');
        await PolyRentalViewportFocus.reveal(target);
        return target.getBoundingClientRect().top;
      });
      assert(Math.abs(tallTop - 68) <= 2, `tall content should align under the header: ${tallTop}`);
      const modal = await page.evaluate(async () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        dialog.innerHTML = '<div style="height:580px"></div><div id="inner" style="height:100px"></div><div style="height:580px"></div>';
        document.body.append(dialog);
        const scrollBefore = window.scrollY;
        await PolyRentalViewportFocus.reveal(dialog.querySelector('#inner'));
        return {windowUnchanged: scrollBefore === window.scrollY, internalScroll: dialog.scrollTop};
      });
      assert(modal.windowUnchanged && modal.internalScroll > 0, JSON.stringify(modal));
      await page.close();
    }
    {
      const page = await browser.newPage();
      await page.setContent('<div style="height:950px"></div><section id="target" style="height:180px"></section><div style="height:1200px"></div>');
      await page.addScriptTag({content: viewportFocus});
      await page.evaluate(() => {
        const target = document.querySelector('#target');
        target.animate([{height:'0px'}, {height:'180px'}], {duration: 320});
        window.revealResult = PolyRentalViewportFocus.reveal(target);
      });
      await page.mouse.wheel(0, 50);
      assert.equal(await page.evaluate(() => revealResult), false, 'manual scrolling cancels a pending reveal');
      await page.evaluate(() => { window.revealResult = PolyRentalViewportFocus.reveal(document.querySelector('#target')); });
      await page.waitForFunction(() => window.scrollY > 90);
      await page.mouse.wheel(0, -50);
      assert.equal(await page.evaluate(() => revealResult), false, 'manual scrolling cancels native smooth scrolling');
      await page.waitForTimeout(450);
      assert((await page.evaluate(() => window.scrollY)) < 650, 'the old scroll destination must not be restored');
      await page.evaluate(() => {
        const target = document.querySelector('#target');
        target.animate([{height:'90px'}, {height:'180px'}], {duration: 320});
        window.revealResult = PolyRentalViewportFocus.reveal(target);
      });
      await page.mouse.click(10, 10);
      assert.equal(await page.evaluate(() => revealResult), false, 'clicking elsewhere cancels a pending reveal');
      await page.close();
    }
    const wide = await browser.newPage({viewport:{width:1440,height:900}});
    await wide.setContent('<h2 id="heading">Каталог</h2><section id="category" style="width:900px;height:180px"><button id="card">Камера</button></section><button id="cart">Корзина</button>');
    await wide.addScriptTag({content:fs.readFileSync('app/miniapp_static/motion.js','utf8')});
    const desktop = await wide.evaluate(() => {
      const motion = PolyRentalMotion;
      const category = document.querySelector('#category'), heading = document.querySelector('#heading');
      const card = document.querySelector('#card'), cart = document.querySelector('#cart');
      motion.transitionCategoryView(motion.captureCategoryView(category), category, 1);
      motion.morphText(heading, 'Камеры');
      motion.flyToCart(card, cart);
      motion.quantityFeedback(card, cart);
      const categoryEffect = category.getAnimations()[0].effect;
      return {
        copies: document.querySelectorAll('.cart-flight,.category-level-transition,.heading-morph-copy').length,
        duration: categoryEffect.getTiming().duration,
        slides: categoryEffect.getKeyframes().some(frame => frame.transform),
        caption: heading.textContent,
        cartPulse: cart.getAnimations()[0].effect.getTiming().duration,
      };
    });
    assert.deepEqual(desktop, {copies:0, duration:160, slides:false, caption:'Камеры', cartPulse:180});
    const dialogMotion = await wide.evaluate(async () => {
      const dialog = document.createElement('section');
      dialog.innerHTML = '<div class="dialog-card"><button>Закрыть</button></div>';
      document.body.append(dialog);
      const close = dialog.querySelector('button');
      PolyRentalMotion.morphEquipmentPreview(dialog, {left:10, top:10, width:50, height:30}, '12px', close);
      const center = dialog.querySelector('.dialog-card').getAnimations()[0].effect.getKeyframes()[0].transform;
      const hasCopy = Boolean(dialog.querySelector('.equipment-preview-morph'));
      const keyboardFocus = document.activeElement === close;
      await PolyRentalMotion.removeDialog(dialog);
      return {center, hasCopy, keyboardFocus, removed:!dialog.isConnected};
    });
    assert.deepEqual(dialogMotion, {center:'scale(0.985)', hasCopy:false, keyboardFocus:true, removed:true});
    await wide.emulateMedia({reducedMotion:'reduce'});
    await wide.waitForFunction(() => document.getAnimations().length === 0);
    await wide.close();
    console.log('Mobile and desktop disclosure, motion, keyboard and reduced motion: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
