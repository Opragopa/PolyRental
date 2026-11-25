/* Receipt downloads use synthetic data and never start the embedded viewer. */
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
    for (const surface of ['site','miniapp']) {
      for (const admin of [false,true]) {
        const filename = 'receipt-synthetic.pdf';
        const {page,errors}=await fixture(browser,{surface,admin,role:'admin',piiAdmin:admin,order:base('returned'),
          receipt:{body:samplePdf(),headers:{'content-disposition':`attachment; filename="${filename}"`}}});
        if (!admin) await page.locator('.customer-actions > summary').click();
        const downloadAction = page.getByRole('button',{name:'Скачать расписку',exact:true});
        assert.equal(await downloadAction.count(),1);
        const downloaded = page.waitForEvent('download');
        await downloadAction.click();
        const file = await downloaded;
        assert.equal(file.suggestedFilename(), filename);
        assert.equal(await file.failure(),null);
        assert.equal(await page.locator('.receipt-preview-dialog').count(),0);
        assert.deepEqual(errors,[]);
        await page.close();
      }
    }
    for (const method of ['downloadFile','openLink']) {
      const {page,errors}=await fixture(browser,{order:base('returned')});
      const url = 'https://polyrental.test/api/miniapp/document-download/temporary-test';
      await page.route('**/receipt/download-link', route=>route.fulfill({json:{url, file_name:'receipt-synthetic.pdf'}}));
      await page.evaluate(method=>{
        const tg = window.Telegram.WebApp;
        tg.version = method === 'downloadFile' ? '8.0' : '7.0';
        tg[method] = value=>{ window.chosenDownload = value; };
      }, method);
      await page.locator('.customer-actions > summary').click();
      await page.getByRole('button',{name:'Скачать расписку',exact:true}).click();
      await page.waitForFunction(()=>window.chosenDownload);
      assert.deepEqual(await page.evaluate(()=>window.chosenDownload),
        method === 'downloadFile' ? {url,file_name:'receipt-synthetic.pdf'} : url);
      assert.equal(await page.locator('.receipt-preview-dialog').count(),0);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    {
      const {page}=await fixture(browser,{receipt:{status:410,type:'application/json',body:JSON.stringify({detail:'Срок хранения расписки истёк'})}});
      await page.locator('.customer-actions > summary').click();
      await page.getByRole('button',{name:'Скачать расписку',exact:true}).click();
      await page.getByText('Срок хранения расписки истёк',{exact:true}).waitFor();
      assert.equal(await page.locator('.workflow-dialog').count(),0);
      await page.close();
    }
    console.log(`Receipt downloads (${engine}): browser, native and external handoff passed`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
