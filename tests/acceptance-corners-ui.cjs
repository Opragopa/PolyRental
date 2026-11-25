const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { fixture, base } = require('./completion-ui.cjs');

async function assertFullWidth(button) {
  const layout = await button.evaluate(element => {
    const buttonStyle = getComputedStyle(element);
    const row = element.parentElement;
    const rowStyle = getComputedStyle(row);
    return {
      width: element.offsetWidth,
      available: row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
      height: element.offsetHeight,
      justify: buttonStyle.justifyContent,
      align: buttonStyle.textAlign,
    };
  });
  assert.ok(Math.abs(layout.width - layout.available) <= 1, JSON.stringify(layout));
  assert.ok(layout.height >= 44, JSON.stringify(layout));
  assert.equal(layout.justify, 'center');
  assert.equal(layout.align, 'center');
}

async function assertFits(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
}

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const channel = engine === chromium ? process.env.PLAYWRIGHT_CHANNEL : undefined;
  const browser = await engine.launch({ ...(channel && { channel }) });
  try {
    for (const continuousCorners of [false, true]) {
      const { page, errors } = await fixture(browser, {
        admin: true, role: 'manager', order: base('returned'), width: 320, continuousCorners,
      });
      const notice = page.getByText('Этап завершён. Закрепление не требуется.', { exact: true });
      await notice.waitFor();
      const layout = await notice.evaluate(el => ({
        radius: getComputedStyle(el).borderTopLeftRadius,
        fits: el.scrollWidth <= el.clientWidth + 1,
        smooth: CSS.supports('corner-shape: squircle') ? getComputedStyle(el).cornerShape : null,
      }));
      assert.equal(layout.radius, '16px');
      assert.ok(layout.fits);
      if (layout.smooth !== null) assert.equal(layout.smooth, continuousCorners ? 'squircle' : 'round');
      await assertFits(page);
      assert.deepEqual(errors, []);
      await page.close();
    }
    for (const width of [320, 390, 1280]) {
      const { page, errors } = await fixture(browser, {
        admin: true, role: 'manager', order: base('pending'),
        width, isMobile: width < 700, continuousCorners: true,
      });
      for (const style of ['classic', 'studio', 'frame']) {
        await page.locator('html').evaluate((root, value) => { root.dataset.style = value; }, style);
        for (const colorScheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
          const card = page.locator('.request-card').first();
          assert.equal(await card.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '24px');
          const status = card.locator('.status-pill').first();
          assert.equal(await status.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
          const fitsLongStatus = await status.evaluate(el => {
            const original = el.textContent;
            el.textContent = 'Ожидает дополнительного подтверждения сотрудником';
            const fits = el.scrollHeight <= el.clientHeight + 1 &&
              el.getBoundingClientRect().right <= el.parentElement.getBoundingClientRect().right + 1;
            el.textContent = original;
            return fits;
          });
          assert.ok(fitsLongStatus, 'long status is readable inside the header');
          const action = card.locator('.request-primary-actions .workflow-next').first();
          await assertFullWidth(action);
          await page.locator('#tab-orders').click();
          const support = page.locator('#profile-support');
          if (width < 1024) await assertFullWidth(support);
          else {
            const button = await support.boundingBox();
            const entry = await page.locator('.profile-support-entry').boundingBox();
            assert.ok(Math.abs(button.x - entry.x) < 2 && button.width < entry.width && button.height >= 44);
          }
          await support.click();
          const dialog = page.locator('#support-dialog .dialog-card');
          await dialog.waitFor({ state: 'visible' });
          const cancel = dialog.locator('#support-close');
          const confirm = dialog.locator('button[type=submit]');
          assert.equal(await dialog.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '28px');
          assert.notEqual(await confirm.evaluate(el => getComputedStyle(el).flexBasis), '100%');
          await cancel.evaluate(el => { el.hidden = true; });
          await assertFullWidth(confirm);
          await cancel.evaluate(el => { el.hidden = false; });
          await cancel.click();
          await dialog.waitFor({ state: 'hidden' });
          await assertFits(page);
          await page.locator('#tab-admin').click();
          const toggle = page.locator('.request-toggle').first();
          if (!(await toggle.evaluate(el => el.parentElement.open))) await toggle.click();
        }
      }
      const item = {
        id: 1, name: 'Камера Sony с комплектом для продолжительной выездной съёмки',
        sku: 'CAM', category: 'generic', available: true, available_quantity: 3,
      };
      await page.route('**/api/miniapp/catalog?*', route => route.fulfill({
        json: { items: [item], selected_items: [item], page: 0, page_size: 20, total: 1 },
      }));
      await page.route('**/api/miniapp/cart', route => {
        if (route.request().method() === 'GET') return route.fallback();
        return route.fulfill({ json: { ...route.request().postDataJSON(), version: 1 } });
      });
      await page.locator('#tab-new').click();
      await page.locator('#client-categories .category-card').filter({ hasText: 'Оборудование' }).click();
      const catalogItem = page.locator('.item-card').first();
      await catalogItem.waitFor();
      await assertFits(page);
      await catalogItem.locator('.plus').click();
      assert.ok(await page.locator('#clear-cart').isVisible());
      await page.locator('#main-button').click();
      const cartItem = page.locator('#cart-items .cart-item').first();
      await cartItem.waitFor();
      assert.equal(await cartItem.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '24px');
      assert.ok(await page.locator('#clear-cart').isHidden());
      const mainButton = page.locator('#main-button');
      if (page.viewportSize().width < 1024) await assertFullWidth(mainButton);
      else {
        const button = await mainButton.boundingBox();
        const footer = await page.locator('#action-bar').boundingBox();
        assert.ok(button.width <= 280 && Math.abs(button.x + button.width - footer.x - footer.width) < 2);
      }
      await assertFits(page);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Acceptance corners: 18 viewport, style and theme combinations passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
