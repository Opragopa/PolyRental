const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const {page,writes,errors}=await fixture(browser,{admin:true,role:'manager',order:base('pending')});
 await page.route('**/api/miniapp/availability?*',route=>route.fulfill({json:{all_items:[{id:1,name:'Камера Sony',available_quantity:2},{id:2,name:'Объектив Canon',sku:'LENS',available_quantity:2},{id:3,name:'Штатив',available_quantity:0}]}}));
 await page.getByRole('button',{name:'Изменить заявку',exact:true}).click();
 const edit=page.getByRole('dialog',{name:'Изменить заявку'});
 await edit.getByRole('button',{name:'Добавить позицию'}).click();
 const picker=page.getByRole('dialog',{name:'Добавить оборудование'});
 await picker.getByText('Объектив Canon').waitFor();
 await picker.locator('input[type=search]').fill('нет совпадений');
 assert.match(await picker.innerText(),/Ничего не найдено/);
 await picker.locator('input[type=search]').fill('Canon');
 await picker.getByRole('button',{name:'Добавить: Объектив Canon'}).click();
 await picker.getByRole('button',{name:'Добавить: Объектив Canon'}).click();
 assert.equal(await picker.getByRole('button',{name:'Добавить: Объектив Canon'}).isDisabled(),true);
 await picker.getByRole('button',{name:'Добавить выбранное'}).click();
 await picker.waitFor({state:'detached'});
 assert.equal(await edit.locator('[name="quantity-2"]').inputValue(),'2');
 assert.equal(writes.length,0);
 await edit.locator('[name="comment"]').fill('Добавили объектив');
 const saved=page.waitForResponse(response=>response.url().endsWith('/changes')&&response.request().method()==='POST');
 await edit.getByRole('button',{name:'Подтвердить',exact:true}).click();
 await saved;
 assert.ok(writes[0].body.proposed.lines.some(x=>x.article_id===2&&x.quantity===2));
 assert.deepEqual(errors,[]);await page.close();console.log('equipment selection: passed');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});

