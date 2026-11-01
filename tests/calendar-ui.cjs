/* Run with NODE_PATH pointing to an installed playwright package. No server,
 * database, Telegram traffic or personal data is used by this browser suite. */
const { chromium, webkit } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const assets = path.join(root, "app", "miniapp_static");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8").replaceAll("__APP_VERSION__", version);

(async () => {
  const engineName = process.env.PLAYWRIGHT_BROWSER || "chromium";
  assert.ok(["chromium", "webkit"].includes(engineName), "Unsupported browser engine");
  const engine = engineName === "webkit" ? webkit : chromium;
  const browser = await engine.launch({ headless: true, ...(engineName === "chromium" && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}) });
  const results = [];
  try {
    for (const [width, height] of [[320,640], [360,640], [390,844], [430,844]]) {
      for (const dark of [false, true]) {
        const page = await browser.newPage({ viewport:{width,height}, isMobile:true, hasTouch:true, timezoneId:"America/Los_Angeles", colorScheme:dark?"dark":"light" });
        const errors = [], requests = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
          const url = new URL(route.request().url()); requests.push(url.pathname);
          if (url.pathname.startsWith("/miniapp/static/")) {
            const file = path.join(assets, path.basename(url.pathname));
            return route.fulfill({body:fs.readFileSync(file), contentType:file.endsWith(".css")?"text/css":"text/javascript"});
          }
          if (url.hostname === "telegram.org") return route.fulfill({body:"",contentType:"text/javascript"});
          return route.fulfill({body:html, contentType:"text/html"});
        });
        await page.clock.install({time:new Date("2026-10-26T10:00:00Z")});
        await page.goto("http://polyrental.test/miniapp?preview=1");
        if (dark) await page.evaluate(() => {
          const style = document.documentElement.style;
          for (const [name,value] of Object.entries({"bg-color":"#17212b", "secondary-bg-color":"#232e3c", "text-color":"#ffffff", "hint-color":"#b4c0cc", "button-color":"#8bd4c3", "button-text-color":"#102e27"})) style.setProperty(`--tg-theme-${name}`,value);
        });
        assert.equal(await page.locator(".calendar-day").count(),42);
        assert.equal(await page.locator("#main-button").isDisabled(),true);
        assert.equal(await page.locator('[data-date="2026-10-26"]').isDisabled(),true);
        await page.locator('[data-date="2026-10-30"]').click();
        assert.equal(await page.locator('[data-date="2026-10-30"]').getAttribute("aria-pressed"),"true");
        assert.equal(await page.locator("#start-time").isDisabled(),true);
        await page.locator('[data-date="2026-11-02"]').click();
        assert.equal(await page.locator(".calendar-day.in-range").count(),2);
        assert.equal(await page.locator("#start-time").isDisabled(),false);
        assert.equal(await page.locator("#main-button").isDisabled(),false);
        await page.locator("#start-time").fill("10:00");
        await page.locator("#end-time").fill("18:00");
        assert.match(await page.locator("#period-summary").innerText(), /10:00.*18:00.*МСК/);
        const bounds = await page.evaluate(() => {
          const rect = id => { const r=document.getElementById(id).getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; };
          return {calendar:rect("range-calendar"), time:rect("end-time"), summary:rect("period-summary"), button:rect("main-button"), action:rect("action-bar"), scroll:scrollY, overflow:document.documentElement.scrollWidth>innerWidth,
            touch:[...document.querySelectorAll(".calendar-day")].every(b=>b.getBoundingClientRect().width>=44 && b.getBoundingClientRect().height>=44),
            renderMs:(()=>{const target=document.createElement("div"); const start=performance.now();new PolyRentalCalendar.RangeCalendar(target,{minimum:"2026-10-30"});return performance.now()-start;})()};
        });
        assert.equal(bounds.overflow,false,JSON.stringify({width,dark,bounds}));
        assert.equal(await page.getByText('Условия и быстрый срок · МСК',{exact:true}).count(),0,'ФТ-UI-08: quick durations are removed');
        assert.equal(await page.locator('.duration-option, #duration-apply').count(),0);
        assert.match(await page.locator('#start-hint').innerText(),/Выдача с.*Время по Москве/);
        assert.equal(bounds.touch,true);
        await page.locator('#period-summary').evaluate(node => node.scrollIntoView({block: 'center'}));
        const visibleSummary = await page.evaluate(() => ({summary:document.querySelector('#period-summary').getBoundingClientRect().toJSON(), action:document.querySelector('#action-bar').getBoundingClientRect().toJSON(), tabs:document.querySelector('.tabs').getBoundingClientRect().toJSON()}));
        assert.ok(visibleSummary.summary.bottom <= visibleSummary.action.top && visibleSummary.action.bottom <= visibleSummary.tabs.top, JSON.stringify({width,dark,visibleSummary}));
        assert.ok(await page.locator('.tabs .tab:visible').evaluateAll(buttons => buttons.every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth; })), 'bottom navigation stays visible and tappable');
        assert.ok(bounds.button.bottom<=height && bounds.button.top>=0);
        assert.ok(bounds.renderMs<100,JSON.stringify(bounds));
        await page.locator("#main-button").click();
        await page.locator('#back-button').click();
        assert.equal(await page.locator("#start-time").inputValue(),"10:00");
        assert.equal(await page.locator("#start-date").inputValue(),"2026-10-30");
        assert.equal(requests.filter(url=>url.startsWith("/api/")).length,0);
        const media = await page.evaluate(async () => {
          const host=document.createElement("div"); host.className="article-card-head";
          host.style.cssText="position:fixed;opacity:0;width:300px;pointer-events:none";
          const image=document.createElement("img"); image.className="article-photo"; host.append(image,document.createElement("span"));document.body.append(host);
          const measurements=[];
          for(const [w,h] of [[4000,200],[100,3000],[120,120]]) {
            image.src=`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="gray"/></svg>`)}`;
            await image.decode(); const rect=image.getBoundingClientRect(); measurements.push([rect.width,rect.height]);
          }
          host.remove();return measurements;
        });
        assert.deepEqual(media,[[64,48],[64,48],[64,48]]);
        await page.locator('[data-date="2026-10-30"]').focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator(":focus").getAttribute("data-date"),"2026-10-31");
        const beforeMonth=await page.locator("#range-calendar").boundingBox();
        await page.getByRole("button",{name:"Следующий месяц"}).click();
        const afterMonth=await page.locator("#range-calendar").boundingBox();
        assert.equal(afterMonth.height,beforeMonth.height);
        await page.getByRole("button",{name:"Предыдущий месяц"}).click();
        if (process.env.QA_SCREENSHOTS && engineName === "chromium" && ((width===360&&!dark) || (width===390&&dark))) {
          fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});
          await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`v${version}-calendar-${width}-${dark?"dark":"light"}.png`)});
        }
        await page.locator('[data-date="2026-10-30"]').click();
        assert.equal(await page.locator(".calendar-day.selected").count(),1);
        await page.locator('[data-date="2026-10-30"]').click();
        assert.equal(await page.locator("#main-button").isDisabled(),false); // 10:00–18:00 same day
        await page.locator("#end-time").fill("09:00");
        assert.equal(await page.locator("#main-button").isDisabled(),true);
        assert.match(await page.locator("#period-error").innerText(),/позже/);
        assert.deepEqual(errors,[]);
        results.push({width,height,dark,renderMs:Math.round(bounds.renderMs*10)/10});
        await page.close();
      }
    }
    // Signed launch uses the server's role, including the optional client mode.
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const errors=[]; page.on("pageerror",error=>errors.push(error.message));
    let piiAdmin=false; const reviews=[];
    const order={id:7,status:"confirmed",identity_status:"submitted",items:[],assets:[],lines:[],inspections:[],starts_at:"2026-11-02T10:00:00+03:00",ends_at:"2026-11-02T18:00:00+03:00",customer_name:"QA",customer_contact:"@qa_user"};
    await page.route("**/*",async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==="telegram.org")return route.fulfill({contentType:"text/javascript",body:'window.Telegram={WebApp:{initData:"signed-test",initDataUnsafe:{user:{id:42}}}}'});
      if(url.pathname.startsWith("/miniapp/static/")){const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith("css")?"text/css":"text/javascript"});}
      if(url.pathname==="/api/miniapp/me")return route.fulfill({json:{id:piiAdmin?200:100,admin:true,pii_admin:piiAdmin}});
      if(url.pathname==="/api/miniapp/admin/bookings")return route.fulfill({json:{items:[order]}});
      if(url.pathname.endsWith("/identity/review")){reviews.push(route.request().postDataJSON());return route.fulfill({json:{status:"saved"}});}
      if(url.pathname.endsWith("/identity"))return route.fulfill({json:{document_checks:{student_front:{document:"not_document",student:"unknown",reason:"blank_image",manual_review:true}}}});
      if(url.pathname.startsWith("/api/"))return route.fulfill({json:{items:[]}});
      return route.fulfill({body:html,contentType:"text/html"});
    });
    await page.goto("http://polyrental.test/miniapp");
    try { await page.locator("#admin-panel").waitFor({state:"visible"}); }
    catch (error) { console.error("Page errors:", errors, await page.evaluate(() => ({error: document.querySelector('#global-error')?.textContent, banner: document.querySelector('#mode-banner')?.textContent, rolePending: document.documentElement.classList.contains('role-pending'), title: document.querySelector('#page-intro')?.textContent, admin: (() => { const el = document.querySelector('#admin-panel'); return {hidden: el.hidden, display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, bounds: el.getBoundingClientRect().toJSON(), parentDisplay: getComputedStyle(el.parentElement).display}; })()}))); throw error; }
    await page.locator(".admin-card").waitFor();
    assert.equal(await page.getByRole("button",{name:/^Проверить анкету/}).count(),0);
    await page.locator("#tab-new").click();
    assert.equal(await page.locator("#range-calendar").isVisible(),true);
    piiAdmin=true; await page.reload();
    await page.locator('.request-card[data-booking-id="7"] .request-toggle').click();
    await page.getByRole("button",{name:/^Проверить анкету/}).click();
    assert.match(await page.locator(".identity-check-review").innerText(),/не документ.*однотонное фото/s);
    page.on("dialog",dialog=>dialog.accept());
    await Promise.all([page.waitForResponse(response=>response.url().endsWith("/identity/review")),page.getByRole("button",{name:"Подтвердить документы",exact:true}).click()]);
    assert.equal(reviews[0].approved,true);
    await page.getByRole("button",{name:/^Проверить анкету/}).click();
    await page.getByRole("button",{name:"Отклонить / исправить",exact:true}).click();
    await page.locator('#identity-review-form input[value="student_front"]').check();
    await page.locator('#identity-review-form textarea').fill("Замените однотонное фото");
    await Promise.all([page.waitForResponse(response=>response.url().endsWith("/identity/review")),page.locator("#identity-review-submit").click()]);
    assert.equal(reviews[1].approved,false);
    assert.deepEqual(reviews[1].fields,["student_front"]);
    assert.deepEqual(errors,[]);
    await page.close();
    // Exercise native SDK button/activation/theme semantics, separately from DOM buttons.
    const native=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const nativeErrors=[];native.on("pageerror",error=>nativeErrors.push(error.message));
    const sdk=`window.__qaSdk={visible:false,enabled:false,theme:"light",events:{}};
      window.Telegram={WebApp:{initData:"signed-test",colorScheme:"light",platform:"ios",
        onEvent:(name,fn)=>window.__qaSdk.events[name]=fn,
        MainButton:{setText:()=>{},show:()=>window.__qaSdk.visible=true,hide:()=>window.__qaSdk.visible=false,
          enable:()=>window.__qaSdk.enabled=true,disable:()=>window.__qaSdk.enabled=false,
          onClick:fn=>window.__qaSdk.click=fn,showProgress:()=>{},hideProgress:()=>{}},
        BackButton:{show:()=>{},hide:()=>{},onClick:()=>{}},ready:()=>{},expand:()=>{}}};`;
    await native.route("**/*",async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==="telegram.org")return route.fulfill({contentType:"text/javascript",body:sdk});
      if(url.pathname.startsWith("/miniapp/static/")){const file=path.join(assets,path.basename(url.pathname));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith("css")?"text/css":"text/javascript"});}
      if(url.pathname==="/api/miniapp/me")return route.fulfill({json:{id:42,admin:false,pii_admin:false}});
      if(url.pathname.startsWith("/api/"))return route.fulfill({json:{items:[]}});
      return route.fulfill({body:html,contentType:"text/html"});
    });
    await native.clock.install({time:new Date("2026-10-26T10:00:00Z")});
    await native.goto("http://polyrental.test/miniapp");
    assert.equal(await native.locator("#action-bar").isHidden(),true);
    assert.equal(await native.locator(".tabs").isVisible(),true);
    assert.deepEqual(await native.evaluate(()=>[__qaSdk.visible,__qaSdk.enabled]),[true,false]);
    await native.locator('[data-date="2026-10-30"]').tap();
    await native.locator('[data-date="2026-10-31"]').tap();
    assert.equal(await native.evaluate(()=>__qaSdk.enabled),true);
    await native.evaluate(()=>{Telegram.WebApp.colorScheme="dark";__qaSdk.events.themeChanged();});
    assert.equal(await native.locator("html").getAttribute("data-theme"),"dark");
    await native.locator('[data-date="2026-10-30"]').tap();
    assert.equal(await native.evaluate(()=>__qaSdk.enabled),false);
    assert.deepEqual(nativeErrors,[]);await native.close();
    console.log(JSON.stringify({engine:engineName,passed:results.length+3,viewports:results},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
