const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture, base} = require('./completion-ui.cjs');
(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  try {
    for (const dark of [false, true]) {
      const order = base('needs_changes'); order.assets = [];
      order.lines.push({id:12,article_id:2,name:'Микрофон',quantity:1});
      order.lines.push({id:14,article_id:4,name:'Неизменённый штатив',quantity:1});
      const before = {start:order.starts_at,end:order.ends_at,lines:order.lines.map(row=>({...row}))};
      const after = {...before,start:'2026-11-05T10:00:00+03:00',lines:[{article_id:1,name:'Камера Sony',quantity:1},{article_id:3,name:'Новый <свет>',quantity:1},{article_id:4,name:'Неизменённый штатив',quantity:1}]};
      const change = {id:9,change_type:'manager_edit',status:'pending',before,after,comment:'PRIVATE'};
      const {page,errors,writes} = await fixture(browser,{admin:true,order,change});
      if(dark) await page.evaluate(()=>{document.documentElement.style.setProperty('--surface','#202126');document.documentElement.style.setProperty('--text','#f5f5f5');document.documentElement.style.setProperty('--line','#44464b');});
      await page.locator('.request-equipment-row.equipment-change-added').waitFor();
      assert.equal(await page.locator('.request-equipment-row.equipment-change-updated').count(),1);
      assert.equal(await page.locator('.request-equipment-row.equipment-change-removed').count(),1);
      assert.equal(await page.locator('[data-article-id="4"][class*="equipment-change-"]').count(),0);
      await page.waitForFunction(()=>new Set([...document.querySelectorAll('.request-equipment > .request-equipment-row')].map(row=>getComputedStyle(row).backgroundColor)).size===4);
      const colors = await page.locator('.request-equipment > .request-equipment-row').evaluateAll(rows=>rows.map(row=>getComputedStyle(row).backgroundColor));
      assert.equal(new Set(colors).size,4,JSON.stringify(colors));
      await page.locator('[data-article-id="1"]').click();
      assert.match(await page.locator('.workflow-dialog').innerText(),/2 → 1/);
      assert.doesNotMatch(await page.locator('.workflow-dialog').innerText(),/PRIVATE/);
      await page.locator('.workflow-dialog').getByRole('button',{name:'Закрыть',exact:true}).click();
      await page.locator('[data-article-id="3"]').focus(); await page.keyboard.press('Enter');
      assert.match(await page.locator('.workflow-dialog').innerText(),/Новый <свет>/);
      assert.equal(await page.locator('.workflow-dialog свет').count(),0);
      await page.locator('.workflow-dialog').getByRole('button',{name:'Закрыть',exact:true}).click();
      await page.locator('.rental-period.equipment-change-updated').click();
      assert.match(await page.locator('.workflow-dialog').innerText(),/Выдача:/);
      await page.locator('.workflow-dialog').getByRole('button',{name:'Закрыть',exact:true}).click();
      await page.locator('.request-toggle').click(); await page.locator('.request-toggle').click();
      assert.equal(await page.locator('.equipment-change-marker').count(),3,'reopening does not duplicate markers');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
      assert.deepEqual(errors,[]); assert.equal(writes.filter(row=>!row.path.endsWith('/last-section')).length,0);
      fs.mkdirSync('artifacts/booking-change-hotfix',{recursive:true});
      await page.screenshot({path:`artifacts/booking-change-hotfix/${dark?'dark':'light'}.png`,fullPage:true});
      await page.close();
    }
    console.log('Changed product cards: colors, click/keyboard details, dates, escaping, unchanged rows and reopening passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
