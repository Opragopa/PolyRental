/* Request permission, require a reason, and decide without prematurely editing. */
const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {fixture, base} = require('./completion-ui.cjs');

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true,...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const width of [320,390]) {
      const order = {...base('confirmed'),identity_status:'submitted',can_request_changes:true,customer_change_request:null};
      const client = await fixture(browser,{order,width});
      const submitted=[];
      await client.page.route('**/api/miniapp/bookings/7/change-request', route => {
        if(route.request().method()==='POST') {
          submitted.push(route.request().postDataJSON());
          order.can_request_changes=false;
          order.customer_change_request={id:91,status:'pending',created_at:'2026-10-29T10:00:00Z'};
          return route.fulfill({json:order.customer_change_request});
        }
        return route.fulfill({json:{...order.customer_change_request,reason:'Перенесли съёмку'}});
      });
      await client.page.getByRole('button',{name:'Запросить изменения',exact:true}).click();
      const dialog=client.page.locator('.workflow-dialog');
      await dialog.getByRole('button',{name:'Отправить запрос',exact:true}).click();
      assert.equal(submitted.length,0);
      await dialog.locator('textarea[name="reason"]').fill('   ');
      await dialog.getByRole('button',{name:'Отправить запрос',exact:true}).click();
      await dialog.getByText('Обязательно укажите причину запроса.').waitFor();
      assert.equal(submitted.length,0);
      await dialog.locator('textarea[name="reason"]').fill('  Перенесли съёмку  ');
      await dialog.getByRole('button',{name:'Отправить запрос',exact:true}).click();
      await client.page.getByText('Запрос на изменения отправлен. Дождитесь решения оператора.').waitFor();
      assert.deepEqual(submitted,[{reason:'Перенесли съёмку'}]);
      assert.equal(order.status,'confirmed');
      assert.equal(await client.page.getByRole('button',{name:'Запросить изменения',exact:true}).count(),0);
      assert.equal(await client.page.getByRole('button',{name:'Изменить заявку',exact:true}).count(),0);
      assert.ok(await client.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.deepEqual(client.errors,[]);
      await client.page.close();

      const corrected={...base('needs_changes'),customer_change_request:{id:91,status:'approved'},change_status:'pending'};
      const editing=await fixture(browser,{width,order:corrected,change:{id:92,change_type:'client_fix',status:'pending',comment:'Запрос одобрен. Исправьте заявку.'}});
      await editing.page.getByRole('button',{name:'Внести изменения',exact:true}).click();
      await editing.page.locator('.workflow-dialog').getByRole('button',{name:'Перейти к исправлению',exact:true}).click();
      const editDialog=editing.page.locator('.workflow-dialog');
      await editDialog.getByRole('heading',{name:'Исправить заявку'}).waitFor();
      await editDialog.getByRole('button',{name:'Подтверждаю',exact:true}).click();
      await editing.page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
      assert.ok(editing.writes.some(write=>write.path.endsWith('/changes/respond')&&write.body.change_id===92&&write.body.accept&&write.body.corrected.lines.length));
      assert.deepEqual(editing.errors,[]);
      await editing.page.close();

      for (const approve of [true,false]) {
        const pending={...base('confirmed'),identity_status:'verified',can_request_changes:false,customer_change_request:{id:91,status:'pending'}};
        const staff=await fixture(browser,{admin:true,role:'operator',order:pending,width});
        const decisions=[];
        await staff.page.route('**/api/miniapp/bookings/7/change-request',route=>route.fulfill({json:{id:91,status:'pending',reason:'Перенесли съёмку <b>на другой день</b>'}}));
        await staff.page.route('**/api/miniapp/admin/bookings/7/change-request/91/decision',route=>{
          decisions.push(route.request().postDataJSON());
          pending.customer_change_request.status=approve?'approved':'rejected';
          pending.status=approve?'needs_changes':'confirmed';
          return route.fulfill({json:pending.customer_change_request});
        });
        assert.equal(await staff.page.getByRole('button',{name:'Начать подготовку',exact:true}).count(),0);
        await staff.page.getByRole('button',{name:'Рассмотреть запрос на изменения',exact:true}).click();
        const review=staff.page.locator('.workflow-dialog');
        await review.getByText('Перенесли съёмку <b>на другой день</b>',{exact:true}).waitFor();
        assert.equal(await review.locator('b').count(),0);
        await review.locator('select[name="decision"]').selectOption(approve?'approve':'reject');
        await review.getByRole('button',{name:'Сохранить решение',exact:true}).click();
        await staff.page.waitForFunction(()=>!document.querySelector('.workflow-dialog'));
        assert.deepEqual(decisions,[{approve,comment:''}]);
        if(!approve) await staff.page.getByRole('button',{name:'Начать подготовку',exact:true}).waitFor();
        assert.deepEqual(staff.errors,[]);
        await staff.page.close();
      }
    }
    console.log('Customer change requests at 320/390px: passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
