const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {fixture,base} = require('./completion-ui.cjs');
const notes = JSON.parse(fs.readFileSync('app/assets/releases.json','utf8'))[0];
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  for(const admin of [false,true]) {
   const {page,errors}=await fixture(browser,{admin,role:'admin',order:base('pending'),width:320});
   let seen=false,version='0.5.1',failFeedback=true,acks=0;const suggestions=[];
   await page.route('**/api/miniapp/release',route=>route.fulfill({json:{release:{...notes,seen,items:notes.items.filter(item=>item.audience==='all'||admin)}}}));
   await page.route('**/api/miniapp/release/seen',route=>{assert.equal(route.request().postDataJSON().version,'0.5.1');seen=true;acks++;return route.fulfill({json:{status:'ok'}});});
   await page.route('**/api/miniapp/support/questions',route=>{
    if(failFeedback){failFeedback=false;return route.fulfill({status:503,json:{detail:'Не удалось отправить. Повторите попытку.'}});}
    suggestions.push(route.request().postDataJSON());return route.fulfill({json:{status:'Спасибо! Мы рассмотрим ваше предложение.',id:9}});
   });
   await page.route('**/miniapp',route=>route.fulfill({body:fs.readFileSync('app/miniapp_static/index.html','utf8').replaceAll('__APP_VERSION__',version),contentType:'text/html'}));
   await page.reload();const release=page.locator('#release-dialog');await release.waitFor({state:'visible'});
   assert.equal(await release.locator('#release-version').innerText(),'Версия 0.5.1');
   assert.equal(await release.locator('.release-items section').count(),admin?6:5);
   assert.equal(await page.locator('#action-bar').isHidden(),true);
   assert.equal(await release.locator('.dialog-card').evaluate(el=>el.scrollTop),0,'announcement opens at the title, including a longer staff release');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'release-feedback');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'release-close');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await release.locator('.dialog-card').evaluate(el=>el.scrollWidth>el.clientWidth),false);
   await release.locator('.dialog-card').evaluate(el=>el.scrollTop=0);
   fs.mkdirSync('artifacts/release-051',{recursive:true});await release.screenshot({path:`artifacts/release-051/${admin?'staff':'client'}.png`});
   await release.getByRole('button',{name:'Помогите нам стать лучше'}).click();
   const support=page.locator('#support-dialog');await support.waitFor({state:'visible'});
   await page.waitForFunction(()=>document.querySelector('#release-dialog').hidden);assert.equal(acks,1);
   assert.equal(await support.locator('#support-title').innerText(),'Предложить изменение');
   assert.equal(await support.locator('#support-faq').isHidden(),true);
   await support.locator('textarea').fill('Предлагаю <новую> возможность');
   await support.getByRole('button',{name:'Отправить предложение'}).click();
   await support.getByText('Не удалось отправить. Повторите попытку.').waitFor();
   assert.equal(await support.locator('textarea').inputValue(),'Предлагаю <новую> возможность');
   assert.doesNotMatch(await support.innerText(),/Спасибо!/);
   await support.getByRole('button',{name:'Отправить предложение'}).click();
   await support.getByText('Спасибо! Мы рассмотрим ваше предложение.').waitFor();
   assert.deepEqual(suggestions,[{screen:'feedback',booking_id:null,question:'Предлагаю <новую> возможность'}]);
   assert.equal(await support.locator('textarea').inputValue(),'');
   await support.getByRole('button',{name:'Закрыть',exact:true}).click();
   version='0.5.1-hotfix-1';const releaseResponse=page.waitForResponse(response=>response.url().endsWith('/api/miniapp/release'));await page.reload();await releaseResponse;await page.waitForFunction(()=>!document.documentElement.classList.contains('role-pending'));
   assert.equal(await release.isHidden(),true);assert.equal(acks,1);
   assert.deepEqual(errors,[]);await page.close();
  }
  // On a first visit the instruction finishes before release notes appear.
  const {page,errors}=await fixture(browser,{order:base('pending')});
  await page.route('**/api/miniapp/release',route=>route.fulfill({json:{release:{...notes,seen:false,items:notes.items.slice(0,3)}}}));
  await page.route('**/api/miniapp/profile',route=>route.fulfill({json:{display_name:'QA',onboarding_seen:false,start_screen:'booking'}}));
  await page.route('**/api/miniapp/onboarding/show',route=>route.fulfill({json:{first_show:true}}));
  await page.reload();await page.locator('#onboarding-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#release-dialog').isHidden(),true);
  await page.locator('#onboarding-skip').click();await page.locator('#release-dialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#release-dialog').isHidden(),true);
  assert.deepEqual(errors,[]);await page.close();
  console.log('Release window: once per account, hotfix, staff/client, onboarding order, focus, feedback retry and confirmation passed');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
