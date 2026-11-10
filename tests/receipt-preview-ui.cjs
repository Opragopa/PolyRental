/* Real PDF rendering, synthetic bytes only; no native browser PDF plug-in. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture,base} = require('./completion-ui.cjs');
const suppliedPdf = process.env.RECEIPT_PDF_STDIN ? require('node:fs').readFileSync(0) : null;

function samplePdf() {
  if(suppliedPdf) return suppliedPdf;
  const stream='BT /F1 24 Tf 40 150 Td (Synthetic receipt preview) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;});
  const start=Buffer.byteLength(pdf);
  pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

(async()=>{
  const engine=process.env.PLAYWRIGHT_BROWSER||'chromium';
  const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    for (const admin of [false,true]) {
      const {page,errors}=await fixture(browser,{admin,role:'admin',order:base('returned'),receipt:{body:samplePdf()}});
      if(admin) { // Synthetic fixture normally has no PII access; enable only this permitted preview action.
        await page.route('**/api/miniapp/me',route=>route.fulfill({json:{id:100,admin:true,pii_admin:true,staff_role:'admin'}}));
        await page.reload(); await page.locator('.request-toggle').click();
      }
      await page.locator(admin ? '.request-more-actions > summary' : '.customer-actions > summary').first().click();
      await page.getByRole('button',{name:'Предпросмотр расписки',exact:true}).click();
      await page.locator('[data-preview-ready="true"]').waitFor({timeout:20000});
      assert.ok(await page.locator('.receipt-pages canvas').count()>=1);
      if(!suppliedPdf) assert.equal(await page.locator('.receipt-pages canvas').count(),2);
      assert.equal(await page.locator('.workflow-dialog iframe').count(),0);
      assert.ok(await page.locator('.receipt-pages canvas').first().evaluate(canvas=>{
        const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        return canvas.width>0&&[...bytes].some((value,i)=>i%4!==3&&value<200);
      }),'PDF page contains rendered text, not a blank canvas');
      assert.ok(await page.getByRole('button',{name:'Скачать PDF',exact:true}).isVisible());
      await page.getByRole('button',{name:'Назад к заявке',exact:true}).click();
      await page.locator('.workflow-dialog').waitFor({state:'detached'});
      assert.equal(await page.locator('.receipt-pages canvas').count(),0);
      assert.deepEqual(errors,[]); await page.close();
    }
    {
      const {page}=await fixture(browser,{receipt:{body:Buffer.from('invalid pdf')}});
      await page.locator('.customer-actions > summary').click();
      await page.getByRole('button',{name:'Предпросмотр расписки',exact:true}).click();
      await page.getByText('Не удалось показать страницы. Скачайте сохранённый PDF, чтобы открыть его на устройстве.',{exact:true}).waitFor();
      assert.ok(await page.getByRole('button',{name:'Скачать PDF',exact:true}).isVisible());
      await page.close();
    }
    {
      const {page}=await fixture(browser,{receipt:{status:404,type:'application/json',body:JSON.stringify({detail:'Срок хранения расписки истёк'})}});
      await page.locator('.customer-actions > summary').click();
      await page.getByRole('button',{name:'Предпросмотр расписки',exact:true}).click();
      await page.getByText('Срок хранения расписки истёк',{exact:true}).waitFor();
      assert.equal(await page.locator('.workflow-dialog').count(),0); await page.close();
    }
    console.log(`Receipt preview (${engine}): customer/staff PDF pages, cleanup and API errors passed`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
