/* Browser motion audit. Offline interactions + optional isolated QA staff UI.
 * NODE_PATH=tools/browser-qa/node_modules node tests/motion-qa.cjs
 * QA_LIVE_URL=http://127.0.0.1:8001 enables the real staff dialog scenario. */
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const assets = path.resolve(__dirname, "../app/miniapp_static");
const output = path.resolve(__dirname, "../artifacts/motion-qa");
fs.mkdirSync(output, {recursive: true});
const results = [];
const settle = page => page.waitForTimeout(300);

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge"});
  try {
    for (const [width, height, cpu] of (process.env.QA_MOTION_LIVE_ONLY ? [] : [[240,320,1],[390,844,1],[568,320,1],[1440,900,1],[390,844,4]]).filter(item=>!process.env.QA_MOTION_CPU_ONLY || item[2]===Number(process.env.QA_MOTION_CPU_ONLY))) {
      const context = await browser.newContext({viewport: {width,height}, recordVideo: {dir: output, size: {width: Math.min(width, 720), height: Math.min(height, 900)}}});
      const page = await context.newPage();
      const traceEnabled=cpu===4 && !process.env.QA_MOTION_NO_TRACE;
      if(traceEnabled) await context.tracing.start({screenshots:true,snapshots:true});
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", {rate: cpu});
      await page.addInitScript(() => {
        window.motionAudit = {frames: [], longTasks: [], active: false, phase:'disclosures'};
        let last;
        function frame(time) { if (motionAudit.active && last) motionAudit.frames.push(time-last); last=time; requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
        new PerformanceObserver(list => {if(motionAudit.active) motionAudit.longTasks.push(...list.getEntries().map(e=>({duration:e.duration,phase:motionAudit.phase})));}).observe({type:"longtask",buffered:true});
      });
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "polyrental.test") return route.fulfill({body:"",contentType:"text/javascript"});
        const file = path.join(assets, url.pathname.startsWith("/miniapp/static/") ? path.basename(url.pathname) : "index.html");
        const type = {".html":"text/html",".css":"text/css",".js":"text/javascript",".woff2":"font/woff2"}[path.extname(file)];
        return route.fulfill({body:fs.readFileSync(file),contentType:type||"application/octet-stream"});
      });
      await page.goto("http://polyrental.test/miniapp?preview=1");
      await page.locator(".item-card").first().waitFor();
      await settle(page);
      await page.evaluate(() => motionAudit.active=true);
      // Product disclosures must reverse from the currently displayed height.
      const detail = page.locator(".client-item-details").first();
      for (let i=0;i<5;i++) {
        await detail.locator("summary").dispatchEvent("click");
        await page.waitForTimeout(35);
      }
      await settle(page);
      assert.equal(await detail.evaluate(el=>el.open), true);
      assert.equal(await detail.evaluate(el=>el.style.overflow), "");
      const neighbour = await detail.evaluate(el=>el.getBoundingClientRect().height);
      assert.ok(neighbour > 0);
      await detail.locator("summary").click();
      await settle(page);
      assert.equal(await detail.evaluate(el=>el.open),false);
      await detail.locator("summary").dispatchEvent("click");
      await page.waitForTimeout(35);
      await detail.evaluate(el=>el.getAnimations().forEach(animation=>animation.cancel()));
      await page.waitForTimeout(35);
      assert.equal(await detail.evaluate(el=>el.style.overflow),"","cancelled disclosure releases clipping");
      await settle(page);
      await page.evaluate(()=>motionAudit.phase='quantities-and-cart');
      await page.locator(".item-card").first().evaluate(el=>window.auditCard=el);
      await page.locator(".item-card .plus").first().click();
      for(let i=0;i<4;i++) await page.locator(".item-card .plus").first().dispatchEvent("click");
      assert.equal(await page.locator(".quantity-value").first().textContent(),"3");
      assert.ok(await page.evaluate(()=>auditCard.isConnected && auditCard.querySelector('details').open),"quantity changes preserve the card and disclosure");
      await page.locator("#main-button").click();
      await page.locator('#cart-items .cart-item').first().evaluate(el=>window.auditCartRow=el);
      await page.locator('#cart-items .minus').first().click();
      await page.locator('#cart-items .plus').first().click();
      assert.ok(await page.evaluate(()=>auditCartRow.isConnected),'cart quantity changes preserve the row');
      for(let i=0;i<3;i++) await page.locator('#cart-items .minus').first().click();
      await settle(page);
      assert.ok(await page.evaluate(()=>!auditCartRow.isConnected),'removed cart row completes its exit');
      await page.locator('#top-back-button').click();
      await page.locator('.item-card .plus').first().click();
      await page.locator('#main-button').click();
      await page.locator("#customer-name").fill("Анна");
      await page.locator("#customer-contact").fill("@anna_test");
      await page.locator("#main-button").click();
      await settle(page);
      await page.evaluate(()=>motionAudit.phase='calendar');
      // Availability refreshes must keep node identity, keyboard focus and motion.
      const calendar = page.locator("#range-calendar");
      const days = calendar.locator(".calendar-day:not(:disabled):not(.outside-month)");
      await days.nth(2).click();
      await days.nth(8).click();
      await page.evaluate(() => {
        const host=document.querySelector('#range-calendar');
        window.auditDay=host.querySelector('.calendar-day.selected');
        auditDay.focus();
      });
      // Actual selection nodes survive the app's async availability update.
      await page.waitForTimeout(350);
      assert.ok(await page.evaluate(()=>auditDay.isConnected));
      assert.ok(await page.evaluate(()=>document.activeElement===auditDay));
      const nav = calendar.getByRole("button", {name:"Следующий месяц"});
      await nav.click(); await nav.click();
      await settle(page);
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')), "Следующий месяц");
      assert.equal(await calendar.locator(".calendar-day").count(),42);
      await page.evaluate(()=>motionAudit.phase='profile-and-dialogs');
      await page.locator("#tab-orders").click();
      await page.locator("#profile-header > summary").click();
      await settle(page);
      await page.locator("#onboarding-reopen").click();
      const dialog = page.locator("#onboarding-dialog");
      await settle(page);
      await page.locator("#onboarding-skip").click();
      // Logical closure is immediate; the visual exit remains rendered briefly.
      const exit = await dialog.evaluate(el=>({hidden:el.hidden,display:getComputedStyle(el).display,animations:el.getAnimations({subtree:true}).length}));
      assert.equal(exit.hidden,true);
      assert.equal(await dialog.evaluate(el=>el.inert),true,"closing modal cannot receive keyboard input");
      assert.ok(exit.animations>0, `missing modal exit: ${JSON.stringify(exit)}`);
      assert.notEqual(exit.display,"none");
      await settle(page);
      assert.equal(await dialog.evaluate(el=>getComputedStyle(el).display),"none");
      // Reopen during a close; CSS transitions reverse without leaving a layer.
      await page.locator("#onboarding-reopen").click();
      await page.waitForTimeout(35);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(35);
      await page.locator("#onboarding-reopen").dispatchEvent("click");
      await settle(page);
      assert.equal(await dialog.evaluate(el=>el.hidden),false);
      assert.equal(await dialog.evaluate(el=>getComputedStyle(el).opacity),"1");
      await page.locator("#onboarding-skip").click();
      await settle(page);
      // A dynamically removed staff-style modal uses the shared real exit helper.
      const dynamic = await page.evaluate(async () => {
        const el=document.createElement('section');el.className='dialog-backdrop workflow-dialog';el.innerHTML='<div class="dialog-card"><h2>Проверка</h2></div>';document.body.append(el);
        await new Promise(r=>setTimeout(r,40));
        const first=PolyRentalMotion.removeDialog(el), second=PolyRentalMotion.removeDialog(el);
        const inert=el.inert, same=first===second;
        await first;
        return {inert,same,removed:!el.isConnected};
      });
      assert.deepEqual(dynamic,{inert:true,same:true,removed:true});
      // Preference changes during a JS height animation must finish immediately.
      await page.locator("#profile-header > summary").dispatchEvent("click");
      await page.emulateMedia({reducedMotion:"reduce"});
      await page.waitForTimeout(70);
      assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
      await page.locator("#profile-header > summary").dispatchEvent("click");
      await page.waitForTimeout(30);
      assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
      const metrics=await page.evaluate(()=>{motionAudit.active=false;return motionAudit;});
      const frames=metrics.frames.sort((a,b)=>a-b);
      const p95=frames[Math.floor(frames.length*.95)]||0;
      const report={width,height,cpu,trace:traceEnabled,frames:frames.length,p95ms:+p95.toFixed(1),maxGapMs:+Math.max(...frames).toFixed(1),longTasks:metrics.longTasks.map(x=>({...x,duration:+x.duration.toFixed(1)}))};
      assert.ok(p95 < (cpu===1?55:110),`frame pacing regression: ${JSON.stringify(report)}`);
      assert.deepEqual(errors,[],`page errors: ${errors.join(' | ')}`);
      results.push(report);
      const video=await page.video().path();
      if(traceEnabled) await context.tracing.stop({path:path.join(output,'motion-cpu4-trace.zip')});
      await context.close();
      report.video=`motion-${width}x${height}-cpu${cpu}${traceEnabled?'-trace':''}.webm`;
      fs.copyFileSync(video,path.join(output,report.video));
      console.log(`PASS motion ${width}x${height} CPU×${cpu}: p95 ${report.p95ms}ms, max gap ${report.maxGapMs}ms`);
    }
    if (process.env.QA_LIVE_URL) {
      const page=await browser.newPage({viewport:{width:390,height:844}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${process.env.QA_LIVE_URL}/qa/admin`);
      await page.locator('#tab-admin').waitFor({state:'visible'});
      await page.waitForTimeout(800);
      if(await page.locator('#release-close').isVisible()) await page.locator('#release-close').click();
      if(await page.locator('#onboarding-skip').isVisible()) await page.locator('#onboarding-skip').click();
      await page.locator('#tab-admin').click();
      await page.locator('.admin-mode[data-mode="catalog"]').click();
      await page.getByRole('button',{name:'Редактировать категории',exact:true}).click();
      await page.locator('.category-add').click();
      const dialog=page.locator('.workflow-dialog');
      await dialog.waitFor();await settle(page);
      await dialog.locator('.workflow-cancel').click();
      assert.equal(await dialog.evaluate(el=>el.inert),true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
      assert.ok(await page.evaluate(()=>document.activeElement.classList.contains('category-add')),'focus restored after real workflow modal closes');
      assert.deepEqual(errors,[]);
      results.push({scenario:'live-staff-dialog',passed:true});
      await page.close();console.log('PASS live staff workflow dialog: exit, repeated close, focus restoration');
    }
    fs.writeFileSync(path.join(output,process.env.QA_MOTION_NO_TRACE?"results-without-trace.json":"results.json"),JSON.stringify(results,null,2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
