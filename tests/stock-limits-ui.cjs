const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const {fixture,base}=require('./completion-ui.cjs');
(async()=>{const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
const {page,errors}=await fixture(browser,{order:base('pending')});
let capacity=3,free=2,cart={start:'',end:'',lines:[],version:0};
const catalog=()=>[0,1,capacity,40,null].map((count,id)=>({id:id+1,name:`Модель ${id+1}`,sku:`MODEL-${id+1}`,...(count===null?{}:{capacity:count})}));
await page.route('**/api/miniapp/catalog/categories',route=>route.fulfill({json:{items:[]}}));
await page.route(/\/api\/miniapp\/catalog(?:\?.*)?$/,route=>route.fulfill({json:{items:catalog(),selected_items:catalog(),page:0,page_size:20,total:5}}));
await page.route('**/api/miniapp/cart',route=>{if(route.request().method()==='PUT')cart={...route.request().postDataJSON(),version:cart.version+1};return route.fulfill({json:cart});});
await page.route(/\/api\/miniapp\/availability\?.*/,route=>{const items=catalog().map(item=>({...item,available_quantity:item.id===3?free:0}));return route.fulfill({json:{items,all_items:items,selected_items:items,unavailable:[]}});});
await page.reload();await page.locator('.item-card').first().waitFor();
const card=id=>page.locator('.item-card').filter({has:page.getByRole('heading',{name:`Модель ${id}`,exact:true})});
for(const id of [1,5]){assert.equal(await card(id).locator('.plus').isDisabled(),true);await card(id).locator('.plus').dispatchEvent('click');assert.equal(await card(id).locator('.quantity-value').innerText(),'0');}
for(const [id,limit] of [[2,1],[3,3],[4,30]]){
 await card(id).locator('.plus').evaluate(button=>{for(let i=0;i<40;i++)button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 assert.equal(await card(id).locator('.quantity-value').innerText(),String(limit));assert.equal(await card(id).locator('.plus').isDisabled(),true);
 if(id!==3)await card(id).locator('.minus').evaluate(button=>{for(let i=0;i<40;i++)button.click();});
}
await page.locator('#main-button').click();
assert.equal(await page.locator('#cart-items .plus').isDisabled(),true);
await page.locator('#cart-items .minus').click();assert.equal(await page.locator('#cart-items .plus').isEnabled(),true);
await page.locator('#cart-items .plus').click();assert.equal(await page.locator('#cart-items .plus').isDisabled(),true);
await page.locator('#customer-name').fill('Тест');await page.locator('#customer-contact').fill('@test_user');await page.locator('#main-button').click();
await page.locator('[data-date="2026-11-03"]').click();await page.locator('[data-date="2026-11-04"]').click();await page.locator('#start-time').fill('10:00');await page.locator('#end-time').fill('18:00');await page.locator('#main-button').click();
await page.locator('#availability-result').getByText(/нужно 3 шт., доступно 2 шт./).waitFor();await page.locator('#availability-edit-cart').click();
assert.equal(await page.locator('#cart-items .plus').isDisabled(),true);await page.locator('#cart-items .plus').dispatchEvent('click');
assert.equal(await page.locator('#cart-items .quantity-control strong').innerText(),'3');
await page.locator('#cart-items .minus').click();await page.locator('#cart-items .minus').click();
assert.equal(await page.locator('#cart-items .plus').isEnabled(),true);
await page.locator('#cart-items .plus').click();assert.equal(await page.locator('#cart-items .plus').isDisabled(),true);
await page.locator('#main-button').click();await page.locator('#main-button').click();await page.locator('#step-review').waitFor();
assert.equal(await page.locator('.review-plus').isDisabled(),true);await page.locator('.review-plus').dispatchEvent('click');assert.equal(await page.locator('.review-items .quantity-control strong').innerText(),'2');
await page.locator('.review-minus').click();assert.equal(await page.locator('.review-plus').isEnabled(),true);
await page.locator('.review-plus').click();assert.equal(await page.locator('.review-plus').isDisabled(),true);
await page.clock.runFor(400);assert.equal(await page.locator('#main-button').isEnabled(),true,'changing quantity preserves the checked period limit');
await page.locator('#top-back-button').click();await page.locator('#end-time').fill('19:00');await page.locator('#top-back-button').click();
assert.equal(await page.locator('#cart-items .plus').isDisabled(),true,'a changed period cannot reuse an old stock count');
await page.locator('#main-button').click();free=1;await page.locator('#main-button').click();
await page.locator('#availability-result').getByText(/нужно 2 шт., доступно 1 шт./).waitFor();
// A restored oversized cart remains visible for explicit correction.
await page.clock.runFor(400);await page.evaluate(()=>localStorage.clear());
capacity=1;cart={start:'',end:'',lines:[{article_id:3,quantity:3}],version:10};await page.reload();await card(3).waitFor();
assert.equal(await card(3).locator('.quantity-value').innerText(),'3');assert.match(await card(3).innerText(),/Уменьшите количество/);
await page.locator('#main-button').click();await page.locator('#cart-items .minus').click();assert.equal(await page.locator('#cart-items .quantity-control strong').innerText(),'2');assert.equal(await page.locator('#cart-items .plus').isDisabled(),true);
assert.deepEqual(errors,[]);await page.close();console.log('Stock limits: catalog, cart, review, 0/1/30, unknown stock and restored surplus passed');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
