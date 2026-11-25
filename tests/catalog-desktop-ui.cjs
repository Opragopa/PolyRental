const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { base } = require('./completion-ui.cjs');

const assets = path.resolve(__dirname, '../app/miniapp_static');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replaceAll('__APP_VERSION__', 'qa')
  .replace('</head>', '<link rel="stylesheet" href="/miniapp/static/acceptance-corners.css"></head>');
const categories = [{code: 'camera', name: 'Камеры', icon: 'camera'}];
const photo = 'data:image/webp;base64,UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoIAAYAAUAmJQBOl0AAjNAA/u52f4tikNzPDaqyWgAAAA==';
const products = Array.from({length: 11}, (_, i) => ({
  id: i + 1, sku: `CAM-${i + 1}`, category: 'camera',
  name: i ? `Камера ${i + 1}` : 'Кинокамера Sony FX3 с комплектом для длительной выездной съёмки',
  image_data: i % 2 ? '' : photo, available: true, available_quantity: 1, active: true,
  equipment: [{id: i + 1, condition: 'available', asset_code: `CAM-${i + 1}-01`,
    features: i ? [] : Array.from({length: 16}, (_, index) => ({id:index + 1, description:`Особенность комплекта ${index + 1}`}))}],
}));
const bookings = [base('pending'), {...base('pending'), id: 8, human_number: 'ТС260008'}];

async function catalogPage(browser, surface, {preview = false, fragment = "", role = "manager"} = {}) {
  const page = await browser.newPage({viewport: {width: 390, height: 900}, reducedMotion: 'reduce'});
  await page.route('**/*', route => {
    const {hostname, pathname} = new URL(route.request().url());
    if (hostname === 'telegram.org') return route.fulfill({contentType: 'text/javascript', body: surface === 'miniapp' && !preview
      ? 'window.Telegram={WebApp:{initData:"signed",initDataUnsafe:{user:{id:100}}}}' : ''});
    if (pathname.startsWith('/miniapp/static/')) {
      const name = path.basename(pathname);
      return route.fulfill({body: fs.readFileSync(path.join(assets, name)), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript'});
    }
    if (pathname === '/api/site/session' || pathname === '/api/miniapp/me') return route.fulfill({json: {id: 100, admin: true, staff_role: role}});
    if (pathname === '/api/miniapp/profile') return route.fulfill({json: {display_name: 'QA', onboarding_seen: true, start_screen: 'booking'}});
    if (pathname === '/api/miniapp/catalog/categories') return route.fulfill({json: {items: categories}});
    if (pathname === '/api/miniapp/catalog') return route.fulfill({json: {items: products, total: products.length, page: 0, page_size: 20}});
    if (pathname === '/api/miniapp/admin/catalog') return route.fulfill({json: {categories, articles: products, dependencies: [], total: products.length, page: 0, page_size: 20}});
    if (pathname === '/api/miniapp/admin/bookings' || pathname === '/api/miniapp/profile/history') return route.fulfill({json: {items: bookings, total: bookings.length}});
    if (pathname.startsWith('/api/')) return route.fulfill({json: {items: []}});
    return route.fulfill({body: html, contentType: 'text/html'});
  });
  await page.clock.install({time:new Date('2026-10-26T10:00:00Z')});
  await page.goto(`https://polyrental.test/${surface}${preview ? '?preview=1' : ''}${fragment}`);
  if (!preview && !fragment) await page.locator('#client-categories [data-category-code="camera"]').click();
  return page;
}

async function checkSiteNavigation(browser) {
  const page = await catalogPage(browser, 'site', {fragment: '#catalog-camera'});
  try {
    await page.locator('#items-grid .item-card').first().waitFor();
    assert.equal(await page.locator('#catalog-camera h2').textContent(), 'Камеры');
    await page.waitForFunction(() => history.scrollRestoration === 'manual');
    await page.evaluate(() => scrollTo(0, 540));
    await page.waitForFunction(() => Math.abs(scrollY - 540) < 2);
    const profile = page.locator('#tab-orders');
    assert.equal(await profile.getAttribute('href'), '#profile');
    await profile.press('Enter');
    await page.waitForURL('**/site#profile');
    await page.locator('#orders-content .customer-order-card').first().waitFor();
    await page.waitForFunction(() => document.activeElement.id === 'profile-name');
    const length = await page.evaluate(() => history.length);
    await profile.press('Enter');
    assert.equal(await page.evaluate(() => history.length), length);
    await page.goBack();
    await page.waitForURL('**/site#catalog-camera');
    await page.waitForFunction(() => Math.abs(scrollY - 540) < 2);
    await page.reload();
    await page.locator('#catalog-camera').waitFor();
    await page.waitForFunction(() => Math.abs(scrollY - 540) < 2);
    await page.goForward();
    await page.waitForURL('**/site#profile');
    await page.locator('#orders-content .customer-order-card').first().waitFor();
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id).filter(Boolean));
    assert.equal(new Set(ids).size, ids.length);
    await page.goto('https://polyrental.test/site#catalog-missing');
    await page.getByText('Категория больше недоступна. Открыт каталог.', {exact:true}).waitFor();
    const category = page.locator('#client-categories').getByRole('link', {name:'Камеры'});
    assert.equal(await category.getAttribute('href'), '#catalog-camera');
    await page.addStyleTag({content: '.topbar {position:fixed;inset:0 0 auto;height:64px;z-index:25}'});
    await page.waitForFunction(() => getComputedStyle(document.documentElement).scrollPaddingTop === '64px');
    await category.press('Enter');
    await page.waitForURL('**/site#catalog-camera');
    await page.waitForFunction(() => {
      const heading = document.querySelector('#catalog-camera h2');
      return document.activeElement === heading && heading.getBoundingClientRect().top >= 79;
    });
    await page.goto('https://polyrental.test/site#management-settings');
    await page.locator('#admin-settings').waitFor();
    assert.equal(await page.locator('#admin-heading').textContent(), 'Настройки');
  } finally { await page.close(); }
}

async function checkTextFragment(browser) {
  const page = await catalogPage(browser, 'site', {fragment:'#catalog'});
  try {
    const text = encodeURIComponent('Каталог оборудования');
    await page.route('https://polyrental.test/text-links', route => route.fulfill({
      contentType:'text/html',
      body:`<a href="/site#:~:text=${text}">Text</a><a href="/site#catalog:~:text=${text}">Anchor and text</a>`,
    }));
    for (const label of ['Text', 'Anchor and text']) {
      await page.goto('https://polyrental.test/text-links');
      await page.getByRole('link', {name:label, exact:true}).click();
      await page.waitForFunction(() => document.querySelector(':target')?.id === 'catalog-page-title');
      const colors = await page.locator('#catalog-page-title').evaluate(heading => {
        const color = () => getComputedStyle(heading, '::target-text').backgroundColor;
        const light = color();
        document.documentElement.dataset.theme = 'dark';
        return [light, color()];
      });
      assert.deepEqual(colors, ['rgb(49, 87, 213)', 'rgb(144, 173, 255)']);
    }
  } finally { await page.close(); }
}

async function checkSettingsLayout(browser) {
  const page = await catalogPage(browser, 'site', {fragment:'#management-settings', role:'admin'});
  try {
    await page.locator('#settings-notifications').waitFor();
    const tabs = page.getByRole('tablist', {name:'Разделы настроек'});
    for (const [width,height] of [[320,800],[390,844],[1280,720],[1920,1080]]) {
      await page.setViewportSize({width,height});
      const geometry = () => page.locator('#admin-settings').evaluate(section => {
        const panel = section.parentElement;
        const nav = section.querySelector('.settings-tabs').getBoundingClientRect();
        const header = panel.querySelector('.admin-panel-heading').getBoundingClientRect();
        const back = panel.querySelector('#admin-back-button').getBoundingClientRect();
        return {nav:nav.top + scrollY, header:header.top + scrollY, back:back.left, settingsWidth:section.clientWidth,
                overflow:section.scrollWidth > section.clientWidth, buttons:[...section.querySelectorAll('[role=tab]')].length};
      });
      await tabs.getByRole('tab', {name:'Уведомления'}).click();
      const before = await geometry();
      assert.equal(before.buttons,5);
      assert.equal(before.overflow,false);
      if (width>=1280) assert.ok(before.settingsWidth>720);
      await tabs.getByRole('tab', {name:'Календарь'}).click();
      const after = await geometry();
      assert.deepEqual(after,before);
      await tabs.getByRole('tab', {name:'Календарь'}).press('End');
      await page.locator('#settings-staff').waitFor();
    }
  } finally { await page.close(); }
}

async function checkWorkspace(page) {
  await page.setViewportSize({width: 1280, height: 900});
  await page.locator('#tab-orders').press('Enter');
  await page.locator('#orders-content .customer-order-card').nth(1).waitFor();
  assert.equal(await page.locator('#tab-orders').getAttribute('aria-current'), 'page');
  const positions = await page.locator('#orders-content .customer-order-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON()));
  assert.ok(positions[0].right < positions[1].left && Math.abs(positions[0].top - positions[1].top) < 1, JSON.stringify(positions));
  const support = page.locator('#profile-support');
  await support.press('Enter');
  const dialog = page.getByRole('dialog', {name: 'Поддержка'});
  const box = await dialog.locator('.dialog-card').boundingBox();
  const backdrop = await dialog.boundingBox();
  assert.ok(box.width >= 500 && box.width <= 700 && Math.abs(box.x + box.width / 2 - backdrop.x - backdrop.width / 2) < 2, JSON.stringify(box));
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  assert.ok(await support.evaluate(button => button === document.activeElement));

  await page.locator('#tab-admin').press('Enter');
  await page.locator('#admin-content .request-card').nth(1).waitFor();
  await page.locator('.admin-filters summary').press('Enter');
  const filterPositions = await page.locator('.admin-filter-fields select').evaluateAll(fields => fields.map(field => field.getBoundingClientRect().toJSON()));
  assert.ok(filterPositions[0].right < filterPositions[1].left && filterPositions[1].right < filterPositions[2].left);
  const requestFilter = page.locator('#admin-request-filter');
  await requestFilter.selectOption('mine');
  await page.getByText('Нет заявок для выбранного фильтра.', {exact:true}).waitFor();
  await requestFilter.selectOption('all');
  const request = page.locator('#admin-content .request-card').first();
  await request.waitFor();
  const collapsed = await request.boundingBox();
  await request.locator('summary.request-toggle').press('Enter');
  assert.ok((await request.boundingBox()).width > collapsed.width * 1.5);
  const requestBody = await request.locator('.request-body').evaluate(node => {
    const style = getComputedStyle(node);
    return {width:node.getBoundingClientRect().width, lineHeight:parseFloat(style.lineHeight) / parseFloat(style.fontSize)};
  });
  assert.ok(requestBody.width <= 760 && requestBody.lineHeight >= 1.49, JSON.stringify(requestBody));

  await page.locator('[data-mode="catalog"]').press('Enter');
  const importButton = page.locator('#catalog-import-open');
  await importButton.press('Enter');
  const workflow = page.locator('.workflow-dialog');
  await workflow.waitFor();
  await page.keyboard.press('Escape');
  await workflow.waitFor({state: 'detached'});
  await page.waitForFunction(() => document.activeElement.id === 'catalog-import-open');
}

async function checkDesktopHighlights(page, surface) {
  await page.locator('#tab-orders').press('Enter');
  await page.locator('#orders-content .customer-order-card').first().waitFor();
  const active = page.locator('#tab-orders');
  const idle = page.locator('#tab-new');
  for (const width of [769, 1440]) {
    await page.setViewportSize({width,height:810});
    for (const theme of ['light','dark']) {
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      await idle.hover();
      assert.equal(await idle.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
      const geometry = await active.evaluate(el=>{
        const tab=el.getBoundingClientRect(), rail=el.parentElement.getBoundingClientRect();
        return {
          leftGap:tab.left-rail.left, rightGap:rail.right-tab.right,
          marker:getComputedStyle(el,'::after').content, active:getComputedStyle(el).backgroundColor,
          idle:getComputedStyle(el.parentElement.querySelector('.tab:not(.active):not([hidden])')).backgroundColor
        };
      });
      assert(geometry.leftGap>=4 && geometry.rightGap>=4,JSON.stringify(geometry));
      assert.equal(geometry.marker,'none');
      assert.notEqual(geometry.active,geometry.idle);
      await page.keyboard.press('Tab');
      for (const control of [active, page.locator('#profile-filter'),page.locator('.customer-order-toggle').first()]) {
        await control.focus();
        const outline=await control.evaluate(el=>{
          const style=getComputedStyle(el);
          return {width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset),style:style.outlineStyle};
        });
        assert(outline.style==='solid' && outline.width>=2 && outline.offset+outline.width<=0,JSON.stringify(outline));
      }
      if (process.env.QA_SCREENSHOTS && width===1440) {
        fs.mkdirSync('artifacts/desktop-highlights',{recursive:true});
        await active.focus();
        await page.screenshot({path:`artifacts/desktop-highlights/${surface}-${theme}.png`});
      }
    }
  }
  await page.locator('#profile-support').press('Enter');
  const close=page.locator('#support-close');
  await close.focus();
  assert(await close.evaluate(el=>{
    const style=getComputedStyle(el);
    return style.outlineStyle==='solid' && parseFloat(style.outlineOffset)+parseFloat(style.outlineWidth)<=0;
  }));
  await page.keyboard.press('Escape');
  await page.locator('#support-dialog').waitFor({state:'hidden'});
}

async function checkCatalog(page, {grid, picker, card, media, control}) {
  const region = page.locator(grid);
  await region.locator(card).first().waitFor();
  await region.locator(`${media}[data-photo-state="loaded"]`).first().waitFor();
  assert.ok(await region.locator(`${media}[data-photo-state="empty"]`).count());
  const layout = page.locator(picker);
  const measure = () => region.evaluate((node, selectors) => {
    const cards = [...node.querySelectorAll(selectors.card)];
    const first = cards[0].getBoundingClientRect();
    const picture = cards[0].querySelector(selectors.media).getBoundingClientRect();
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      columns: cards.filter(card => Math.abs(card.getBoundingClientRect().top - first.top) < 1).length,
      equalWidth: Math.abs(first.width - cards.at(-1).getBoundingClientRect().width) < 1,
      ratio: picture.width / picture.height, photo: picture.width,
      main: box('.workspace-content'), shell: box('.shell'), tabs: box('.tabs'), action: box('.action-bar'),
      rail: getComputedStyle(document.querySelector('.tabs')).flexDirection === 'column',
      navPosition: getComputedStyle(document.querySelector('.tabs')).position,
      gridAreas: getComputedStyle(document.querySelector('.shell')).gridTemplateAreas,
      header: box('.topbar'), search: box('.catalog-search'), grid: node.getBoundingClientRect().toJSON(),
      body: box('body'),
      tileWidth: first.width, padding: parseFloat(getComputedStyle(cards[0]).paddingTop),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      fits: cards.every(card => card.scrollWidth <= card.clientWidth + 1),
    };
  }, {card, media});

  const desktop = [];
  for (const width of [375, 768, 1023, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({width, height: 900});
    await layout.getByRole('button', {name: 'Плитка'}).click();
    const tiles = await measure();
    const info = JSON.stringify({width, grid, tiles});
    assert.ok(!tiles.overflow && tiles.fits, info);
    if (width >= 1024) {
      assert.ok(tiles.rail && tiles.navPosition === 'sticky' && tiles.tabs.right < tiles.main.left, info);
      assert.ok(tiles.tabs.width >= 260 && tiles.tabs.width <= 280 && tiles.tabs.height === 900, info);
      assert.ok(tiles.gridAreas.includes('rail') && tiles.shell.width <= 1600, info);
      assert.equal(tiles.columns, width < 1280 ? 2 : width < 1760 ? 3 : 4, info);
      assert.ok(tiles.tileWidth >= 260 && tiles.padding === 16, info);
      assert.ok(tiles.equalWidth && Math.abs(tiles.ratio - 4 / 3) < .02, info);
      assert.ok(Math.abs(tiles.header.left - tiles.main.left) < 2 && Math.abs(tiles.header.right - tiles.main.right) < 2, info);
      if (grid === '#items-grid') {
        assert.ok(Math.abs(tiles.search.left - tiles.grid.left) < 2 && Math.abs(tiles.search.right - tiles.grid.right) < 2, info);
        assert.ok(Math.abs(tiles.action.left - tiles.main.left) < 2 && Math.abs(tiles.action.right - tiles.main.right) < 2, info);
      }
      if (width >= 1920) assert.ok(Math.abs(tiles.shell.left - tiles.body.left - (tiles.body.width - tiles.shell.width) / 2) < 2 && tiles.columns === 4, info);
    } else if (width < 769) {
      assert.ok(!tiles.rail && tiles.navPosition === 'fixed' && Math.abs(tiles.tabs.bottom - 900) < 2, info);
    } else {
      assert.ok(tiles.rail && tiles.navPosition === 'fixed' && tiles.gridAreas === 'none', info);
    }
    const lastControl = region.locator(card).last().locator(control);
    await lastControl.focus();
    assert.ok(await lastControl.evaluate(node => node === document.activeElement));
    if (grid === '#items-grid' && width >= 1024) {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const footer = await page.locator('#action-bar').boundingBox();
      const end = await lastControl.boundingBox();
      assert.ok(end.y >= 0 && end.y + end.height <= footer.y, JSON.stringify({width, footer, end}));
    }
    if (width === 1280) {
      await page.evaluate(() => scrollTo(0, 400));
      assert.ok(Math.abs((await page.locator('.tabs').boundingBox()).y) < 2, 'Sidebar stays at the viewport top during scrolling');
    }
    await layout.getByRole('button', {name: 'Список'}).click();
    const list = await measure();
    assert.ok(list.columns === 1 && !list.overflow && list.fits, JSON.stringify({width, grid, list}));
    if (width >= 1024) desktop.push(tiles.columns);
  }
  assert.ok(desktop.at(-1) > desktop[0], `${grid}: ${desktop}`);
}

async function checkCalendar(browser) {
  const page = await catalogPage(browser, 'miniapp', {preview:true});
  try {
    await page.locator('.item-card .plus').first().click();
    await page.locator('#main-button').click();
    assert.ok(await page.locator('#step-contact').isVisible());
    await page.locator('#main-button').click();
    await page.locator('#range-calendar').waitFor();
    for (const [width, height] of [[375,900], [768,900], [1023,900], [1024,576], [1280,720], [1366,768], [1440,900], [1920,1080], [1023,900], [1024,900]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(desktop => Boolean(document.querySelector(`${desktop ? '.booking-summary-column' : '.booking-calendar-column'} #calendar-availability-status`)) === true, width >= 1024);
      const result = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {calendar:box('#range-calendar'), dates:box('.date-grid'), summary:box('.booking-summary-column'),
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth + 1};
      });
      assert.ok(!result.overflow, JSON.stringify({width,result}));
      if (width >= 1024) assert.ok(result.calendar.width <= 520 && result.calendar.width >= 320 &&
        result.calendar.right < result.summary.left && Math.abs(result.calendar.top - result.dates.top) < 2, JSON.stringify({width,result}));
      else assert.ok(result.calendar.top >= result.dates.bottom, JSON.stringify({width,result}));
    }
    await page.locator('[data-date="2026-10-30"]').click();
    await page.locator('[data-date="2026-11-02"]').click();
    await page.locator('#start-time').fill('10:00');
    await page.locator('#end-time').fill('18:00');
    assert.match(await page.locator('#period-summary').innerText(), /10:00.*18:00.*МСК/);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const legend = await page.locator('.calendar-legend-note').boundingBox();
    const action = await page.locator('#action-bar').boundingBox();
    assert.ok(legend.y + legend.height <= action.y, JSON.stringify({legend, action}));
    await page.locator('#main-button').click();
    await page.locator('#step-review').waitFor();
    assert.ok((await page.locator('#step-review').boundingBox()).width <= 720);
  } finally { await page.close(); }
}

async function checkLandscapeCatalog(page) {
  const layout = page.locator('#admin-catalog-level .product-layout');
  const card = page.locator('.admin-catalog-items .article-card').first();
  const button = card.locator('.article-toggle');
  const edit = card.locator('.article-edit');
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const top = () => page.evaluate(() => scrollTo(0, 0));
  function inViewport(box, height) { return box && box.y >= 0 && box.y + box.height <= height + 1; }

  for (const [width, height] of [[1024, 576], [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({width, height});
    await layout.getByRole('button', {name:'Список'}).click();
    await top();
    const toolbar = await page.locator('.catalog-toolbar > button').evaluateAll(buttons => buttons.map(node => node.getBoundingClientRect().top));
    assert.ok(toolbar.every(y => Math.abs(y - toolbar[0]) < 1), `Catalog actions should share a row at ${width}×${height}`);
    const listButton = await button.boundingBox();
    const noOverflow = await fits();
    assert.ok(noOverflow && inViewport(listButton, height), JSON.stringify({width,height,noOverflow,listButton}));
    const heading = await page.locator('#admin-catalog-level .catalog-heading-row').boundingBox();
    const picker = await layout.boundingBox();
    assert.ok(picker.x > heading.x && picker.y < heading.y + heading.height, `Heading and view switch should share a row at ${width}×${height}`);
    await layout.getByRole('button', {name:'Плитка'}).click();
    await top();
    const tilePhoto = await card.locator('.article-media').boundingBox();
    const tileFits = await fits();
    assert.ok(tileFits && inViewport(tilePhoto, height), JSON.stringify({width,height,tileFits,tilePhoto}));
    await edit.click();
    const editor = page.locator('.article-editor');
    await editor.getByRole('tab', {name:'Фото'}).click();
    await top();
    const photo = await editor.locator('.article-editor-photo-preview').boundingBox();
    const link = await editor.locator('input[name="image_url"]').boundingBox();
    assert.ok(link.x > photo.x + photo.width && inViewport(await editor.getByRole('button', {name:'Сохранить артикул'}).boundingBox(), height) && await fits(),
      `Photo preview, controls and save fit at ${width}×${height}`);
    await editor.getByRole('button', {name:'Назад',exact:true}).click();
    assert.ok(await edit.evaluate(node => node === document.activeElement));
  }

  await page.setViewportSize({width:1280, height:720});
  await button.click();
  await card.locator('[data-edit-asset-id]').first().click();
  const notes = page.locator('#instance-notes');
  await page.getByRole('tab', {name:'Особенности'}).click();
  await top();
  const list = await notes.locator('.equipment-feature-list').boundingBox();
  const add = await notes.getByRole('button', {name:'Добавить особенность'}).boundingBox();
  assert.ok(add.x > list.x + list.width && inViewport(add, 720) && await fits(), 'The editor stays visible beside a long feature list');
  await notes.locator('.equipment-feature-list li').last().scrollIntoViewIfNeeded();
  assert.ok(inViewport(await notes.getByRole('button', {name:'Добавить особенность'}).boundingBox(), 720), 'Feature actions stay visible while reading the list');
  await page.locator('.catalog-editor-back').click();
}

async function checkLayoutMotion(browser) {
  const page = await catalogPage(browser, 'miniapp');
  try {
    await page.setViewportSize({width: 1440, height: 900});
    await page.emulateMedia({reducedMotion: 'no-preference'});
    const picker = page.locator('#client-product-layout');
    const tile = picker.getByRole('button', {name: 'Плитка'});
    const list = picker.getByRole('button', {name: 'Список'});
    await tile.focus();
    await tile.press('Enter');
    await list.press('Enter');
    await tile.press('Enter');
    assert.equal(await tile.getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({width: 1023, height: 900});
    await page.waitForFunction(() => document.querySelector('#items-grid').getAnimations().length === 0);
    assert.ok(await tile.evaluate(button => document.activeElement === button));
    assert.equal(await tile.getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({width: 1440, height: 900});
    await page.emulateMedia({reducedMotion: 'reduce'});
    await list.press('Enter');
    assert.equal(await list.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#items-grid').evaluate(grid => grid.getAnimations().length), 0);
  } finally { await page.close(); }
}

async function checkCatalogSkeleton(browser, surface) {
  const page = await catalogPage(browser, surface, {fragment:'#catalog'});
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  try {
    await page.setViewportSize({width:1920,height:1080});
    await page.evaluate(() => localStorage.setItem('polyrental-client-product-layout','grid'));
    await page.route('**/api/miniapp/catalog?*', async route => {
      await waiting;
      return route.fulfill({json:{items:products,total:products.length,page:0,page_size:20}});
    });
    await page.locator('#client-categories [data-category-code="camera"]').click();
    const grid = page.locator('#items-grid');
    const placeholders = grid.locator('.catalog-skeleton-card:visible');
    await placeholders.first().waitFor();
    const geometry = locator => locator.evaluateAll(cards => cards.map(card => {
      const image = card.querySelector('.item-media').getBoundingClientRect();
      return [image.x,image.width,image.height];
    }));
    const before = await geometry(placeholders);
    assert.equal(before.length,4);
    assert.equal(new Set(before.map(card=>card[0])).size,4,'desktop skeleton shares the four tile columns');
    assert.equal(await grid.locator('[role="status"]').count(),1);
    assert.equal(await grid.locator('.loading-spinner').count(),0);
    assert.equal(await placeholders.first().locator('.skeleton-block').first().evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.setViewportSize({width:440,height:956});
    assert.equal(await placeholders.count(),2);
    assert.ok((await placeholders.first().locator('.catalog-skeleton-lines > i').first().boundingBox()).width>30);
    await page.setViewportSize({width:1920,height:1080});
    release();
    await grid.locator('.item-card:not(.loading-skeleton)').first().waitFor();
    assert.deepEqual(await geometry(grid.locator('.item-card').and(grid.locator(':nth-of-type(-n+4)'))),before);
    assert.equal(await placeholders.count(),0);
    await page.locator('#tab-admin').click();
    await page.locator('[data-mode="catalog"]').click();
    await page.evaluate(() => localStorage.setItem('polyrental-admin-product-layout','grid'));
    let attempts=0;
    await page.route(url=>url.pathname==='/api/miniapp/admin/catalog'&&url.searchParams.get('category')==='camera',route=>{
      if (++attempts===1) return route.fulfill({status:503,json:{detail:'Синтетическая ошибка загрузки'}});
      return route.fulfill({json:{categories,articles:products,dependencies:[],total:products.length,page:0,page_size:20}});
    });
    await page.locator('.admin-categories [data-category-code="camera"]').click();
    const adminContent=page.locator('#admin-content');
    const adminGrid=adminContent.locator('.admin-catalog-items');
    const retry=adminContent.getByRole('button',{name:/^Повторить/});
    await retry.waitFor();
    assert.equal(await adminContent.locator('.catalog-skeleton-card, .loading-status').count(),0);
    await retry.click();
    await adminGrid.locator('.article-card:not(.loading-skeleton)').first().waitFor();
    assert.equal(attempts,2);
  } finally {
    release();
    await page.close();
  }
}

(async () => {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    for (const surface of ['miniapp', 'site']) {
      await checkCatalogSkeleton(browser, surface);
      const page = await catalogPage(browser, surface);
      await checkCatalog(page, {grid: '#items-grid', picker: '#client-product-layout', card: '.item-card', media: '.item-media', control: '.plus'});
      await page.locator('#tab-admin').click();
      await page.locator('[data-mode="catalog"]').click();
      await page.locator('.admin-categories [data-category-code="camera"]').click();
      await checkCatalog(page, {grid: '.admin-catalog-items', picker: '#admin-catalog-level .product-layout', card: '.article-card', media: '.article-media', control: '.article-toggle'});
      await checkLandscapeCatalog(page);
      await page.locator('[data-mode="orders"]').click();
      await checkWorkspace(page);
      await checkDesktopHighlights(page, surface);
      await page.close();
    }
    await checkCalendar(browser);
    await checkLayoutMotion(browser);
    await checkSiteNavigation(browser);
    await checkTextFragment(browser);
    await checkSettingsLayout(browser);
    console.log('Desktop shell, both catalogs, 16:9 layouts, two surfaces and calendar: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
