const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const role of ['operator', 'manager', 'admin']) {
      const {page, errors} = await fixture(browser, {admin:true, role, order:base('pending')});
      let deleted = false;
      await page.route('**/api/miniapp/admin/catalog?*', route => route.fulfill({json:{
        articles: deleted ? [] : [{id:1,name:'Камера Sony',sku:'CAM-01',category:'camera',active:true,equipment:[{id:21,asset_code:'A1',condition:'available'}]}],
        categories:[], dependencies:[], total:deleted ? 0 : 1, page:0, page_size:20,
      }}));
      await page.route('**/api/miniapp/admin/catalog/articles/1', route => {
        assert.equal(route.request().method(), 'DELETE'); deleted = true;
        return route.fulfill({json:{article_id:1,equipment_count:1}});
      });
      await page.locator('[data-mode="catalog"]').click();
      const button = page.getByRole('button', {name:'Удалить артикул: Камера Sony'});
      await page.getByText('Камера Sony', {exact:true}).first().waitFor();
      await page.locator('.article-toggle').first().click();
      assert.equal(await button.count(), role === 'admin' ? 1 : 0);
      if (role === 'admin') {
        await button.click();
        const dialog = page.getByRole('dialog', {name:'Удалить артикул из каталога?'});
        assert.match(await dialog.innerText(), /Предыдущие заявки, выдачи и ремонты сохранятся/);
        await dialog.locator('input').fill('WRONG');
        await dialog.getByRole('button', {name:'Удалить артикул', exact:true}).click();
        assert.match(await dialog.locator('[role="alert"]').innerText(), /неверно/);
        assert.equal(deleted, false);
        await dialog.locator('input').fill('CAM-01');
        await dialog.getByRole('button', {name:'Удалить артикул', exact:true}).click();
        await dialog.waitFor({state:'hidden'});
        await page.getByText('Показано моделей: 0 из 0').waitFor();
        assert.equal(deleted, true);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Article removal: admin permission, confirmation and catalog refresh passed');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
