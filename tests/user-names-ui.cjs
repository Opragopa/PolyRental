/* Public names replace Telegram IDs in staff views; IDs still select actions. */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const { fixture, base } = require('./completion-ui.cjs');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const order = {...base('pending'), operation_lease:{stage:'pending',actor_id:987654321,actor_name:'Анна Иванова',expires_at:'2026-10-29T11:00:00Z'}};
    const {page,errors} = await fixture(browser,{admin:true,role:'admin',order});
    await page.getByText(/Обрабатывает: Анна Иванова/).waitFor();
    await page.route('**/api/miniapp/admin/bookings/*/history?*', route => route.fulfill({json:{items:[
      {id:'audit:1',action:'assignee:987654321',actor_id:123456789,actor_name:'@manager_anna',target_name:'Борис',created_at:'2026-10-29T10:00:00Z'},
      {id:'audit:2',action:'confirmed',actor_id:234567890,created_at:'2026-10-29T10:01:00Z'},
      {id:'audit:3',action:'expired',actor_id:0,actor_name:'Система',created_at:'2026-10-29T10:02:00Z'},
    ],total:3,page:0,page_size:20}}));
    await page.locator('.request-toggle').first().click();
    await page.locator('.request-toggle').first().click();
    const history = page.locator('.request-history');
    await history.locator('summary').click();
    await history.getByText('Назначен ответственный: Борис').waitFor();
    assert.match(await history.innerText(), /@manager_anna/);
    assert.match(await history.innerText(), /Пользователь/);
    assert.match(await history.innerText(), /Система/);
    assert.doesNotMatch(await history.innerText(), /123456789|234567890|987654321|\bID\b/);

    await page.route('**/api/miniapp/admin/staff', route => route.fulfill({json:{items:[
      {telegram_id:123456789,role:'admin',name:'@manager_anna',full_name:''},
      {telegram_id:987654321,role:'operator',name:'Борис',full_name:''}
    ]}}));
    await page.locator('#admin-settings > summary').click();
    await page.getByRole('button',{name:'Сотрудники',exact:true}).click();
    const staff = page.locator('.workflow-dialog select[name="staff"]');
    await staff.waitFor();
    assert.deepEqual(await staff.locator('option').allTextContents(), ['@manager_anna','Борис']);
    await staff.selectOption('987654321');
    assert.equal(await staff.inputValue(), '987654321');

    await page.route('**/api/miniapp/me', route => route.fulfill({json:{id:100,admin:true,staff_role:'admin',pii_admin:true}}));
    await page.route('**/api/miniapp/admin/support?*', route => route.fulfill({json:{items:[
      {id:1,status:'new',owner_id:100,owner_name:'Анна Иванова',screen:'profile',created_at:'2026-10-29T10:00:00Z'}
    ],total:1,eligible_owners:[987654321],eligible_staff:[{id:987654321,name:'Борис'}]}}));
    await page.route('**/api/miniapp/admin/support/1/messages', route => route.fulfill({json:{customer_id:234567890,customer_name:'@customer_name',screen:'profile',items:[]}}));
    await page.reload();
    await page.locator('[data-mode="support"]').click();
    await page.getByText(/Ответственный: Анна Иванова/).waitFor();
    await page.getByRole('button',{name:'Открыть сообщения'}).click();
    await page.getByText('@customer_name · экран profile').waitFor();
    const support = page.locator('[data-support-thread-id="1"]');
    assert.deepEqual(await support.locator('select option').allTextContents(), ['Борис']);
    assert.doesNotMatch(await support.innerText(), /234567890|987654321|Telegram ID/);
    assert.deepEqual(errors,[]);
    console.log('User display names: passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
