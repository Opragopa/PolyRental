const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,base}=require('./completion-ui.cjs');
const settle=page=>page.waitForFunction(()=>!document.querySelector('#admin-panel').getAnimations({subtree:true}).some(a=>a.playState==='running'));
async function checkHeadingSlide(page, expected, direction) {
 const copy = page.locator('.admin-heading-viewport > .admin-heading-copy');
 await copy.waitFor({state:'attached'});
 const motion = await copy.evaluate(outgoing => {
  const heading = document.querySelector('#admin-heading');
  return {
   previous:outgoing.textContent, current:heading.textContent,
   hidden:outgoing.getAttribute('aria-hidden'), panelOpacity:getComputedStyle(document.querySelector('#admin-panel')).opacity,
   exit:outgoing.getAnimations()[0].effect.getKeyframes(),
   entry:heading.getAnimations()[0].effect.getKeyframes()
  };
 });
 assert.equal(motion.previous, direction>0?'Управление':'Настройки');
 assert.equal(motion.current,expected);
 assert.equal(motion.hidden,'true');
 assert.equal(motion.panelOpacity,'1');
 assert.equal(Number(motion.exit.at(-1).opacity),0);
 assert.equal(Number(motion.entry[0].opacity),0);
 assert.equal(Number(motion.entry.at(-1).opacity),1);
 assert.equal(Math.sign(Number(motion.exit.at(-1).transform.match(/translateX\(([-\d.]+)/)[1])),-direction);
 assert.equal(Math.sign(Number(motion.entry[0].transform.match(/translateX\(([-\d.]+)/)[1])),direction);
 await copy.waitFor({state:'detached'});
}
async function centeredIcons(page,label) {
 const offsets=await page.evaluate(()=>[...document.querySelectorAll('.catalog-search-back, .notification-bell, .icon-action, .catalog-layout-icon, .category-card-icon, .catalog-manage-categories, .category-edit, .category-delete')].flatMap(el=>{
  const svg=el.querySelector(':scope > svg'),a=el.getBoundingClientRect(),b=svg?.getBoundingClientRect();
  return b&&a.width&&a.height&&b.width?[{id:el.id||el.className,x:Math.abs(a.x+a.width/2-b.x-b.width/2),y:Math.abs(a.y+a.height/2-b.y-b.height/2)}]:[];
 }));
 assert(offsets.length>0);
 assert.deepEqual(offsets.filter(row=>row.x>1||row.y>1),[],`${label}: icons are centered`);
}

(async()=>{
 const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try {
  {
   const page=await browser.newPage();
   await page.setContent('<div id="host"><div id="content" style="height:100px"></div></div>');
   await page.addScriptTag({content:fs.readFileSync('app/miniapp_static/motion.js','utf8')});
   await page.evaluate(()=>PolyRentalMotion.surface(document.querySelector('#host'),()=>document.querySelector('#content').style.height='300px'));
   await page.waitForFunction(()=>{const h=document.querySelector('#host').getBoundingClientRect().height;return h>110&&h<290;});
   const reversal=await page.evaluate(()=>{
    const host=document.querySelector('#host'),before=host.getBoundingClientRect().height;
    PolyRentalMotion.surface(host,()=>document.querySelector('#content').style.height='160px');
    return {before,after:host.getBoundingClientRect().height};
   });
   assert(Math.abs(reversal.before-reversal.after)<1,'rapid changes start at the visible height');
   await page.evaluate(()=>document.querySelector('#content').style.height='420px');
   await page.waitForFunction(()=>document.querySelector('#host').getAnimations().length===0);
   assert.equal(await page.locator('#host').evaluate(el=>el.getBoundingClientRect().height),420,'late content determines the final height');
   await page.evaluate(()=>{PolyRentalMotion.surface(document.querySelector('#host'),()=>document.querySelector('#content').style.height='100px');PolyRentalMotion.cancelTransient();});
   assert.equal(await page.locator('#host').evaluate(el=>el.getAnimations().length),0);
   assert.equal(await page.locator('#host').evaluate(el=>el.style.overflow),'');
   await page.close();
  }
  for(const reducedMotion of ['no-preference','reduce']) {
   const {page,errors}=await fixture(browser,{admin:true,role:'admin',order:base('issued')});
   await page.emulateMedia({reducedMotion});
   await page.route('**/api/miniapp/admin/handover-settings',r=>r.fulfill({json:{pickup_location:'Тестовый склад',pickup_instructions:'По времени заявки'}}));
   await page.route('**/api/miniapp/admin/booking-settings',r=>r.fulfill({json:{rental_purpose_enabled:true}}));
   await page.locator('#admin-settings-open').click();
   if (reducedMotion==='no-preference') await checkHeadingSlide(page,'Настройки',1);
   else assert.equal(await page.locator('.admin-heading-copy').count(),0);
   await page.locator('#settings-tab-handover').click();
   await page.locator('#settings-tab-calendar').click();
   await page.locator('#settings-tab-booking').click();
   await page.locator('#settings-tab-notifications').click();
   const details=page.locator('#operator-notification-settings');
   await details.locator('summary').click();
   await page.waitForFunction(()=>!document.querySelector('#operator-notification-settings').open);
   assert.equal(await details.evaluate(el=>el.open),false);
   await details.locator('summary').focus();await page.keyboard.press('Enter');
   await settle(page);
   assert.equal(await details.evaluate(el=>el.open),true);
   assert.equal(await page.locator('#admin-settings [role=tabpanel]:not([hidden])').count(),1);
   assert.equal(await page.locator('#admin-panel').evaluate(el=>el.style.overflow),'');
   await page.locator('#settings-tab-notifications').focus();
   await page.keyboard.press('ArrowRight');
   assert.equal(await page.locator('#settings-tab-calendar').getAttribute('aria-selected'),'true');
   await settle(page);
   assert.equal(await page.locator('#admin-settings').evaluate(el=>el.getAnimations().length),0);
   await page.locator('#admin-back-button').click();
   if (reducedMotion==='no-preference') await checkHeadingSlide(page,'Управление',-1);
   await settle(page);
   assert.equal(await page.locator('#admin-settings').isVisible(),false);
   assert.equal(await page.locator('#admin-settings-open').evaluate(el=>el===document.activeElement),true);
   if (reducedMotion==='no-preference') {
    const reversal=await page.evaluate(()=>{
     document.querySelector('#admin-settings-open').click();
     const heading=document.querySelector('#admin-heading');
     const outgoing=document.querySelector('.admin-heading-copy');
     const exit=outgoing.getAnimations()[0];
     exit.pause();
     exit.currentTime=40;
     const before=Number(getComputedStyle(outgoing).opacity);
     document.querySelector('#admin-back-button').click();
     return {before,after:Number(heading.getAnimations()[0].effect.getKeyframes()[0].opacity),
      copies:document.querySelectorAll('.admin-heading-copy').length};
    });
    assert(reversal.before>0 && reversal.before<1);
    assert.equal(reversal.after,reversal.before);
    assert.equal(reversal.copies,1);
    await settle(page);
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await fixture(browser,{surface:'site',width:1440,height:810,isMobile:false,admin:true,role:'admin',openOrder:false});
   await page.locator('#admin-settings-open').click();
   await checkHeadingSlide(page,'Настройки',1);
   await page.locator('#admin-back-button').click();
   await checkHeadingSlide(page,'Управление',-1);
   assert.deepEqual(errors,[]);await page.close();
  }
  for(const [width,height,insets] of [
   [440,956,{top:[62,56],bottom:[34,0],left:[0,0],right:[0,0]}],
   [956,440,{top:[0,56],bottom:[22,0],left:[62,0],right:[62,0]}]
  ]) {
   const {page,errors}=await fixture(browser,{width,height,isMobile:true,admin:true,role:'admin',openOrder:false});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(insets=>{
    const root=document.documentElement;
    for(const [side,[device,content]] of Object.entries(insets)) {
     root.style.setProperty(`--tg-safe-area-inset-${side}`,`${device}px`);
     root.style.setProperty(`--tg-content-safe-area-inset-${side}`,`${content}px`);
    }
   },insets);
   const safeSide=side=>insets[side][0]+insets[side][1];
   const topbar=await page.locator('.topbar').boundingBox();
   assert(topbar.y>=safeSide('top')-1);
   assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)),safeSide('top'));
   await page.locator('#admin-settings-open').click();
   const back=await page.locator('#admin-back-button').boundingBox();
   assert(back.y>=safeSide('top')-1 && back.x>=safeSide('left')-1);
   for(const box of await page.locator('.tabs .tab:visible').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()))) {
    assert(box.left>=safeSide('left')-1 && box.right<=width-safeSide('right')+1);
    assert(box.top>=safeSide('top')-1 && box.bottom<=height-safeSide('bottom')+1);
   }
   await page.locator('#tab-orders').click();
   await page.locator('#profile-support').click();
   const card=await page.locator('#support-dialog .dialog-card').boundingBox();
   assert(card.y>=safeSide('top')-1 && card.y+card.height<=height-safeSide('bottom')+1);
   assert(card.x>=safeSide('left')-1 && card.x+card.width<=width-safeSide('right')+1);
   await page.evaluate(()=>{document.documentElement.style.removeProperty('--tg-content-safe-area-inset-top');});
   assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)),insets.top[0]);
   assert.deepEqual(errors,[]);await page.close();
  }
  for(const width of [320,1440]) for(const style of ['classic','studio','frame']) for(const theme of ['light','dark']) {
   const {page,errors}=await fixture(browser,{admin:true,role:'admin',order:base('issued'),width,isMobile:width<700});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(({style,theme})=>{document.documentElement.dataset.style=style;document.documentElement.dataset.theme=theme;},{style,theme});
   await centeredIcons(page,`${width}/${style}/${theme}/operator`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(width===320&&style==='frame'&&theme==='light') {
    fs.mkdirSync('artifacts/settings-return',{recursive:true});
    await page.screenshot({path:`artifacts/settings-return/${engine.name()}-operator.png`,fullPage:true});
   }
   await page.locator('#tab-new').click();
   await page.locator('#client-categories .category-card').first().waitFor();
   await centeredIcons(page,`${width}/${style}/${theme}/customer`);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const order=base('issued'),{page,errors}=await fixture(browser,{admin:true,order});let calls=0;
   await page.route('**/return-without-customer',r=>{calls++;order.status='return_inspection';order.handover.operator_return={actor_id:100,at:new Date().toISOString()};return r.fulfill({json:order});});
   await page.getByRole('button',{name:'Подтвердить получение оборудования',exact:true}).click();
   assert.equal(calls,0);
   const dialog=page.locator('.workflow-dialog');
   assert.match(await dialog.innerText(),/оборудование уже у вас/);
   await dialog.getByRole('button',{name:'Подтвердить получение',exact:true}).click();
   await page.getByRole('button',{name:'Завершить заявку',exact:true}).waitFor();
   assert.equal(calls,1);assert.equal(order.handover.returning_at,undefined);
   assert.match(await page.locator('.handover-progress').innerText(),/Сотрудник подтвердил фактический возврат/);
   assert.equal(await page.getByRole('button',{name:'Завершить заявку',exact:true}).isDisabled(),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log(`Settings, centered icons and operator return (${engine.name()}): passed`);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
