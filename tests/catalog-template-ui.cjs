/* Download the actual CSV template from both entry points and Telegram. */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
try {const {page,errors}=await fixture(browser,{admin:true,role:'operator',order:base('pending')});
await page.locator('[data-mode="catalog"]').click();
await page.locator('.catalog-operations > summary').click();
await page.locator('.catalog-import > summary').click();
const button=page.getByRole('button',{name:'Скачать шаблон CSV'});
await page.evaluate(()=>{const original=URL.createObjectURL.bind(URL); URL.createObjectURL=blob=>{window.__csvBlob=blob;return original(blob);}; const click=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){if(this.download){window.__csvFilename=this.download;return;}return click.call(this);};});
for(const entry of ['/miniapp','/site']) {
  await page.evaluate(entry=>{history.replaceState({},'',entry);window.__csvBlob=null;},entry);
  await button.click();
  await page.waitForFunction(()=>Boolean(window.__csvBlob));
  assert.equal(await page.evaluate(()=>window.__csvFilename),'equipment-import-template.csv');
  const contents=await page.evaluate(()=>window.__csvBlob.text());
  assert.match(contents,/^sku;name;serial;inventory_code;/);
}
await page.evaluate(()=>{window.Telegram.WebApp.version='8.0';window.Telegram.WebApp.downloadFile=value=>{window.__templateDownload=value;};});
await button.click();
const native=await page.evaluate(()=>window.__templateDownload);
assert.equal(native.url,'http://polyrental.test/miniapp/static/equipment-import-template.csv');
assert.equal(native.file_name,'equipment-import-template.csv');
assert.deepEqual(errors,[]); console.log('CSV template download for browser, site and Telegram: passed');
await page.close();} finally {await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
