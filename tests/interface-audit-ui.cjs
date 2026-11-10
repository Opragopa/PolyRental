/* Desktop interaction audit, entirely synthetic data. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const {page, errors} = await fixture(browser, {admin:true, role:'manager', width:1024, order:base('ready')});
    assert.equal(await page.locator('.handover-progress input[type=checkbox]').count(), 0, 'issue progress must not contain checkboxes');
    await page.locator('[data-mode="catalog"]').click();
    const category = page.locator('.admin-categories .category-card').filter({hasText:'Камера'});
    if (await category.count()) await category.click();
    const layouts = page.locator('#admin-catalog-level .product-layout');
    if (await layouts.isVisible()) {
      await layouts.getByRole('button',{name:'Плитка'}).click();
      assert.equal(await page.locator('.admin-catalog-items').evaluate(el=>el.classList.contains('tiles')),true);
    } else assert.equal(await page.locator('.admin-catalog-layout').count(),0, 'Корневые категории не переключаются в сетку');
    await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
    await page.locator('.catalog-form').getByRole('button',{name:'Создать категорию',exact:true}).click();
    const dialog = page.locator('.workflow-dialog');
    await dialog.locator('input[name="name"]').fill('Синтетическая категория');
    let asked=0;
    page.on('dialog', async prompt=>{asked++; if(asked===1)await prompt.dismiss();else await prompt.accept();});
    await page.mouse.click(5,5);
    assert.equal(asked,1);assert.equal(await dialog.isVisible(),true);
    await page.mouse.click(5,5);
    assert.equal(asked,2);await dialog.waitFor({state:'detached'});
    if(process.env.QA_SCREENSHOTS) await page.screenshot({path:`${process.env.QA_SCREENSHOTS}/staff-desktop.png`});
    assert.deepEqual(errors, []);await page.close();
    console.log('Desktop catalog, issue status and sensitive dialog dismissal: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error);process.exitCode=1; });
