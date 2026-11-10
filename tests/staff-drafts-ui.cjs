/* Unsaved staff forms: navigation guard and safe-field-only draft recovery. */
const {chromium,webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture,base} = require('./completion-ui.cjs');
(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const {page,errors} = await fixture(browser,{admin:true,role:'admin',order:base('pending')});
    await page.route('**/api/miniapp/admin/catalog?*', route => route.fulfill({json:{
      categories:[{code:'camera',name:'Камера'},{code:'generic',name:'Оборудование'}],
      articles:[{id:1,name:'Камера Sony',sku:'CAM',category:'camera',active:true,equipment:[]}],dependencies:[],page:0,page_size:20,total:1,
    }}));
    await page.locator('[data-mode="catalog"]').click();
    await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
    const form=page.locator('.catalog-form');
    await form.locator('[name="name"]').fill('Личные данные тест 123456');
    await form.locator('[name="category"]').evaluate(select => select.add(new Option('Готовые комплекты', 'kits')));
    await form.locator('[name="category"]').selectOption('kits');
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('polyrental-staff-catalog-draft-v1:')));
    assert.equal(stored.length,1);
    assert.ok(!JSON.stringify(stored).includes('Личные данные тест'));
    assert.equal(JSON.parse(stored[0][1]).values.category,'kits');
    await form.locator('[name="category"]').selectOption('camera');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#tab-new').click();
    assert.equal(await form.isVisible(),true, 'back must protect unsaved staff data');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#tab-orders').click();
    assert.equal(await form.isVisible(),true);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#tab-orders').click();
    await page.locator('#orders-panel').waitFor({state:'visible'});
    await page.locator('#tab-admin').click();
    await page.locator('[data-mode="catalog"]').click();
    await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
    await page.getByText('Восстановлены безопасные поля черновика.',{exact:false}).waitFor();
    assert.equal(await form.locator('[name="category"]').inputValue(),'camera');
    assert.equal(await form.locator('[name="name"]').inputValue(),'');
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button',{name:'Отмена'}).click();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('polyrental-staff-catalog-draft-v1:')).length),0);
    await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
    await form.locator('[name="category"]').selectOption('camera');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#tab-orders').click();
    await page.evaluate(() => { const key=Object.keys(localStorage).find(key=>key.startsWith('polyrental-staff-catalog-draft-v1:')); const draft=JSON.parse(localStorage.getItem(key)); draft.baseline.category='optics'; localStorage.setItem(key,JSON.stringify(draft)); });
    await page.locator('#tab-admin').click();
    await page.locator('[data-mode="catalog"]').click();
    await page.getByRole('button',{name:'Новый артикул',exact:true}).click();
    await page.getByText('Карточка изменилась после сохранения черновика.',{exact:false}).waitFor();
    assert.equal(await form.locator('[name="category"]').inputValue(),'generic');
    assert.deepEqual(errors,[]);
    await form.getByRole('button',{name:'Отмена'}).click();
    await page.route('**/api/miniapp/admin/catalog/articles', route => route.fulfill({status:409,json:{detail:'Карточка модели изменилась. Откройте её заново'}}));
    await page.getByRole('button',{name:'Камера',exact:true}).click();
    await page.getByRole('button',{name:/Изменить артикул:/}).click();
    await form.locator('[name="name"]').fill('Мои несохранённые изменения');
    await form.getByRole('button',{name:'Сохранить артикул'}).click();
    await page.getByText('Карточка модели изменилась. Откройте её заново',{exact:false}).waitFor();
    assert.equal(await form.locator('[name="name"]').inputValue(),'Мои несохранённые изменения');
    assert.deepEqual(errors,[]);
    console.log('Staff draft recovery and navigation guard: passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
