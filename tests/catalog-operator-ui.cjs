const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');
(async () => {
 const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
 const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
 try {
  const {page, errors} = await fixture(browser, {admin:true,role:'operator',order:base('pending')});
  const categories=[{code:'generic',name:'Оборудование'},{code:'camera',name:'Камера'}]; let hidden=false, created=false, removed=false;
  await page.route('**/api/miniapp/admin/catalog?*', route => route.fulfill({json:{categories,articles:[{id:1,name:'Камера Sony',sku:'CAM-01',category:'camera',active:!hidden,equipment:[]}],dependencies:[],total:1,page:0,page_size:20}}));
  await page.route('**/api/miniapp/admin/catalog/categories', route => { created=true; const item={code:'custom_new',name:route.request().postDataJSON().name}; categories.push(item); return route.fulfill({json:item}); });
  await page.route('**/api/miniapp/admin/catalog/categories/custom_new', route => { removed=true; categories.splice(categories.findIndex(c=>c.code==='custom_new'),1); return route.fulfill({json:{ok:true}}); });
  await page.route('**/api/miniapp/admin/catalog/categories/camera', route => route.fulfill({status:409,json:{detail:'Сначала перенесите артикулы в другую категорию'}}));
  await page.route('**/api/miniapp/admin/catalog/articles/1/hide', route => { hidden=true; return route.fulfill({json:{ok:true}}); });
  await page.locator('[data-mode="catalog"]').click();
  assert.equal(await page.getByRole('button',{name:'Настроить состав комплекта',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Импорт CSV',exact:true}).isVisible(),false);
  assert.equal(await page.getByText('Скрытые тестовые').count(),0);
  assert.equal(await page.getByRole('button',{name:'Создать категорию'}).count(),0);
  await page.getByRole('button',{name:'Редактировать категории'}).click();
  assert.equal(await page.getByRole('button',{name:'Завершить редактирование категорий'}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.category-edit-tile').count(),2);
  assert.equal(await page.getByRole('button',{name:'Удалить категорию: Оборудование'}).count(),0);
  page.once('dialog',d=>d.accept()); await page.getByRole('button',{name:'Удалить категорию: Камера'}).click();
  await page.locator('#global-error').getByText('Сначала перенесите артикулы в другую категорию').waitFor();
  assert.equal(await page.getByRole('button',{name:'Удалить категорию: Камера'}).count(),1);
  await page.getByRole('button',{name:'Создать категорию'}).click();
  const create=page.getByRole('dialog',{name:'Создать категорию'}); await create.locator('[name="name"]').fill('Новая категория'); await create.getByRole('button',{name:'Создать',exact:true}).click(); await create.waitFor({state:'hidden'}); assert.equal(created,true);
  const remove=page.getByRole('button',{name:'Удалить категорию: Новая категория'}); await remove.waitFor();
  page.once('dialog',d=>d.dismiss()); await remove.click(); assert.equal(removed,false);
  page.once('dialog',d=>d.accept()); await remove.click(); await page.getByRole('button',{name:'Удалить категорию: Новая категория'}).waitFor({state:'detached'}); assert.equal(removed,true);
  // The edit tiles wiggle continuously. Test their reduced-motion behavior
  // before clicking so WebKit can wait for a stable, actionable button.
  assert.equal(await page.locator('.category-edit-tile .category-card').first().evaluate(el=>getComputedStyle(el).animationName),'category-edit-wiggle');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.category-edit-tile .category-card').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.getByRole('button',{name:'Камера',exact:true}).click(); await page.locator('#admin-catalog-heading').getByText('Камера',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Создать категорию'}).click(); const nested=page.getByRole('dialog',{name:'Создать категорию'}); assert.equal(await nested.locator('[name="parent_code"]').inputValue(),'camera'); await nested.getByRole('button',{name:'Отмена'}).click();
  await page.locator('#admin-catalog-level .catalog-search-back').click(); await page.locator('#admin-catalog-heading').getByText('Каталог оборудования',{exact:true}).waitFor();
  await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await page.locator('.category-edit-tile .category-card').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.getByRole('button',{name:'Завершить редактирование категорий'}).click(); assert.equal(await page.getByRole('button',{name:'Создать категорию'}).count(),0);
  await page.getByRole('button',{name:'Камера',exact:true}).click();
  await page.getByText('Камера Sony',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'Изменить артикул'}).count(),0);
  await page.locator('.article-toggle').first().click();
  page.once('dialog',d=>d.accept()); await page.getByRole('button',{name:'Скрыть от клиентов'}).click(); assert.equal(hidden,true);
  assert.deepEqual(errors,[]); await page.close(); console.log('Operator category controls and article visibility: passed');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
