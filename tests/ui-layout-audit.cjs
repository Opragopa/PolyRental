/* Layout and repeated-control audit for the authenticated site and Telegram Mini App. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { base, fixture } = require('./completion-ui.cjs');

const viewports = [
  [320, 800, 'classic', 'light'],
  [390, 844, 'frame', 'dark'],
  [768, 900, 'studio', 'light'],
  [1024, 576, 'frame', 'light'],
  [1280, 720, 'frame', 'light'],
  [1920, 1080, 'frame', 'dark'],
];
const notice = {
  id: 's:4', title: 'Сообщение от клиента', kind: 'support', tone: 'support', staff: true,
  preview: 'Можно получить оборудование на час раньше?',
  summary: 'Обращение №42 · ТС260007', support_message_id: 4, support_thread_id: 42,
  date: '2026-10-29', created_at: '2026-10-29T09:55:00Z', unread: true,
};
const notices = [
  notice,
  {id:'b:5', kind:'booking', tone:'urgent', staff:false, booking_id:7, unread:true,
    title:'Пора вернуть оборудование', summary:'Заявка ТС260007', created_at:'2026-10-29T09:40:00Z'},
  {id:'b:6', kind:'booking', booking_id:7, title:'Заявка подтверждена', created_at:'2026-10-29T09:25:00Z'},
  {id:'n:7', kind:'notification', title:'Обновление приложения', created_at:'2026-10-29T09:10:00Z'},
];
const photo = 'UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoIAAYAAUAmJQBOl0AAjNAA/u52f4tikNzPDaqyWgAAAA==';
const model = {id:1, name:'Камера Sony FX3 с комплектом', title:'Камера Sony FX3 с комплектом',
  sku:'SONY-FX3', category:'camera', available:true, available_quantity:3, active:true, image_data:`data:image/webp;base64,${photo}`};
const activeControl = 'button, a[href], [role="button"], [role="tab"], summary';
const orderStates = ['pending','needs_changes','confirmed','preparing','ready','issued','return_inspection','returned','cancelled','expired'];
const selectProperties = ['appearance', 'background-color', 'background-image', 'background-position',
  'background-size', 'background-repeat', 'border-radius', 'border-top-color', 'border-top-width',
  'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'min-height',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end'];
const modalSelector = '[role="dialog"][aria-modal="true"]';

async function assertContrast(locator) {
  const samples = await locator.evaluateAll(nodes => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', {willReadFrequently:true});
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [r / 255, g / 255, b / 255, alpha / 255];
    };
    const over = ([r, g, b, a], [br, bg, bb, ba]) => {
      const alpha = a + ba * (1 - a);
      if (!alpha) return [0, 0, 0, 0];
      return [(r * a + br * ba * (1 - a)) / alpha, (g * a + bg * ba * (1 - a)) / alpha,
        (b * a + bb * ba * (1 - a)) / alpha, alpha];
    };
    const luminance = rgba => rgba.slice(0, 3)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    return nodes.map(node => {
      const style = getComputedStyle(node);
      let text = rgba(style.color);
      let surface = [0, 0, 0, 0];
      // These labels use solid backgrounds. A select's arrow sits outside the text area.
      // Composite both colors through ancestor backgrounds and group opacity.
      for (let element = node; element; element = element.parentElement) {
        const layer = getComputedStyle(element);
        const color = rgba(layer.backgroundColor);
        text = over(text, color);
        surface = over(surface, color);
        text[3] *= Number(layer.opacity);
        surface[3] *= Number(layer.opacity);
      }
      const backdrop = [1, 1, 1, 1];
      const a = luminance(over(text, backdrop));
      const b = luminance(over(surface, backdrop));
      const fontSize = parseFloat(style.fontSize);
      const large = fontSize >= 24 || (fontSize >= 56 / 3 && Number(style.fontWeight) >= 700);
      const label = node.getAttribute('aria-label') || node.selectedOptions?.[0]?.label || node.innerText.trim() || node.id;
      return {label, threshold:large ? 3 : 4.5,
        ratio:(Math.max(a, b) + .05) / (Math.min(a, b) + .05)};
    });
  });
  assert.ok(samples.length, 'contrast targets are present');
  for (const {label, threshold, ratio} of samples) {
    assert.ok(ratio >= threshold, `"${label}" contrast is ${ratio.toFixed(2)}:1, expected at least ${threshold}:1`);
  }
}

async function selectAppearance(locator) {
  await locator.first().waitFor();
  const selects = await locator.evaluateAll((nodes, properties) => nodes.map(node => {
    const style = getComputedStyle(node);
    return {id:node.id || node.name, height:node.getBoundingClientRect().height,
      style:Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))};
  }), selectProperties);
  for (const select of selects) {
    assert.ok(select.height >= 44, `select ${select.id} is only ${select.height}px tall`);
    assert.equal(select.style.appearance, 'none', `select ${select.id} uses the shared, styled indicator`);
    assert.notEqual(select.style['background-image'], 'none', `select ${select.id} displays an indicator`);
  }
  return selects;
}

function compareSelects([reference, ...selects]) {
  for (const select of selects) {
    assert.deepEqual(select.style, reference.style, `select ${select.id} and ${reference.id} use the same appearance`);
  }
}

async function assertModalBackdrop(locator) {
  await locator.waitFor();
  const backdrop = await locator.evaluate(node => {
    const style = getComputedStyle(node);
    const [r, g, b, alpha] = (() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data;
    })();
    const blur = style.backdropFilter || style.webkitBackdropFilter;
    return {color:style.backgroundColor, dim:alpha / 255 * (1 - Math.max(r, g, b) / 255),
      blur:Number(blur?.match(/blur\(([\d.]+)px\)/)?.[1] || 0)};
  });
  assert.ok(backdrop.dim >= .2 && backdrop.blur > 0,
    `overlay should dim and blur the page: ${JSON.stringify(backdrop)}`);
  return backdrop;
}

async function chevron(summary) {
  await summary.waitFor();
  const metrics = await summary.evaluate(node => {
    const style = getComputedStyle(node);
    const marker = getComputedStyle(node, '::after');
    const transform = marker.transform === 'none' ? new DOMMatrix() : new DOMMatrix(marker.transform);
    const containerTop = parseFloat(style.borderTopWidth);
    const height = node.getBoundingClientRect().height;
    const markerHeight = parseFloat(marker.height);
    const offset = value => parseFloat(value) * (value.endsWith('%') ? node.clientHeight / 100 : 1);
    const center = containerTop + (marker.top === 'auto'
      ? node.clientHeight - offset(marker.bottom) - markerHeight / 2
      : offset(marker.top) + markerHeight / 2) + transform.f;
    return {content:marker.content, center, height, angle:Math.atan2(transform.b, transform.a),
      transition:marker.transitionDuration, transitionProperty:marker.transitionProperty};
  });
  assert.ok(metrics.content && !['none', 'normal'].includes(metrics.content), 'disclosure displays a chevron');
  assert.ok(Math.abs(metrics.center - metrics.height / 2) <= 1,
    `chevron center ${metrics.center}px differs from summary center ${metrics.height / 2}px`);
  return metrics;
}

async function verifyChevronMotion(page, summary) {
  await page.emulateMedia({reducedMotion:'no-preference'});
  try {
    const {transition, transitionProperty} = await chevron(summary);
    const durations = transition.split(',').map(value => parseFloat(value));
    assert.ok(durations.some(duration => duration > 0) && /(^|[, ])(?:all|transform|rotate)(?:$|[, ])/.test(transitionProperty),
      'disclosure chevron animates its rotation');
  } finally {
    await page.emulateMedia({reducedMotion:'reduce'});
  }
}

function recordRepeats(entries, scope, report, where) {
  const groups = new Map();
  for (const item of entries) {
    const key = `${item.region}:${item.kind}:${item.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const same of groups.values()) {
    if (same.length < 2) continue;
    const [first] = same;
    // A control repeated for independent records is scoped to each record.
    const key = JSON.stringify([scope, first.label, first.kind, first.name, same.map(x => x.control)]);
    if (!report.has(key)) {
      report.set(key, {screen:scope, region:first.label, kind:first.kind, name:first.name, elements:same.map(x => x.control), seen:new Set()});
    }
    report.get(key).seen.add(where);
  }
}

async function capture(page, scope, expected, report, where) {
  for (const selector of expected) await page.locator(selector).first().waitFor();
  const result = await page.evaluate(({ expected, activeControl }) => {
    const visible = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility === 'visible' &&
      !node.closest('[hidden], [aria-hidden="true"], [inert]');
    const modal = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    const root = modal || document.querySelector('main');
    const labels = new WeakMap();
    const labelFor = scope => {
      if (!labels.has(scope)) {
        const text = scope.getAttribute('aria-label') || scope.id || scope.querySelector(':scope > :is(h2,h3,legend)')?.textContent.trim() ||
          [...scope.classList].slice(0, 2).join('.') || scope.tagName.toLowerCase();
        labels.set(scope, {label:text, region:++sequence});
      }
      return labels.get(scope);
    };
    const horizontal = [];
    const overlaps = [];
    function check(node, label) {
      if (!node || !visible(node)) return;
      const bounds = node.getBoundingClientRect();
      if (bounds.left < -2 || bounds.right > document.documentElement.clientWidth + 2 ||
          node.scrollWidth > node.clientWidth + 2) {
        const protruding = [...node.querySelectorAll('*')].filter(child => visible(child) &&
          (child.getBoundingClientRect().right > bounds.right + 2 || child.scrollWidth > node.clientWidth + 2))
          .slice(0, 6).map(child => ({node:child.id || child.className || child.tagName, width:child.clientWidth,
            contentWidth:child.scrollWidth, overflowX:getComputedStyle(child).overflowX}));
        horizontal.push({label, left:Math.round(bounds.left), right:Math.round(bounds.right),
          width:node.clientWidth, contentWidth:node.scrollWidth, protruding});
      }
    }
    let sequence = 0;
    const ids = new Map();
    for (const node of document.querySelectorAll('[id]')) {
      if (node.id) ids.set(node.id, (ids.get(node.id) || 0) + 1);
    }
    const entries = [];
    for (const node of root.querySelectorAll(`${activeControl}, h2, h3, h4, p`)) {
      if (!visible(node)) continue;
      const kind = node.matches(activeControl) ? 'control' : 'copy';
      const ariaLabelledBy = node.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
      const label = kind === 'control' ? node.getAttribute('aria-label') || ariaLabelledBy || node.innerText || node.title : node.innerText;
      const name = label?.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
      if (!name || kind === 'copy' && name.length < 8) continue;
      const scope = node.closest('form, article, fieldset, nav, [role="tablist"], .request-equipment-row, .inspection-row, [data-asset-id]')
        || node.closest('.action-bar, .action-row, .catalog-view-toolbar') || root;
      const control = node.id ? `#${node.id}` : node.getAttribute('href') || [...node.classList].slice(0, 3).join('.') || node.tagName.toLowerCase();
      entries.push({...labelFor(scope), kind, name, control});
    }
    expected.forEach(selector => check(document.querySelector(selector), selector));
    for (const group of ['.tabs > .tab, #action-bar button', '.notification-header > *']) {
      const siblings = [...document.querySelectorAll(group)].filter(visible);
      for (const [index,node] of siblings.entries()) {
        const first = node.getBoundingClientRect();
        for (const other of siblings.slice(index + 1)) {
          const second = other.getBoundingClientRect();
          if (first.left < second.right - 1 && first.right > second.left + 1 &&
              first.top < second.bottom - 1 && first.bottom > second.top + 1) {
            overlaps.push([group, node.id || node.tagName, other.id || other.tagName]);
          }
        }
      }
    }
    for (const head of [...document.querySelectorAll('.notification-item-head')].filter(visible)) {
      const content = head.querySelector('.notification-item-copy')?.getBoundingClientRect();
      const time = head.querySelector('time')?.getBoundingClientRect();
      if (content && time && content.right > time.left + 1) overlaps.push(['notification item','copy','time']);
    }
    const scrolling = document.scrollingElement;
    if (scrolling.scrollWidth > document.documentElement.clientWidth + 2) horizontal.push({label:'document', width:document.documentElement.clientWidth, contentWidth:scrolling.scrollWidth});
    return {horizontal, overlaps, entries, ids:[...ids].filter(([,count]) => count > 1)};
  }, {expected, activeControl});
  recordRepeats(result.entries, scope, report, where);
  assert.deepEqual(result.horizontal, [], `${where}/${scope}: horizontal overflow`);
  assert.deepEqual(result.overlaps, [], `${where}/${scope}: overlapping controls or text`);
  assert.deepEqual(result.ids, [], `${where}/${scope}: duplicate element IDs`);
}

async function activateWithKeyboard(control) {
  await control.waitFor();
  await control.press('Enter');
}

async function installRoutes(page) {
  const json = (pattern, body) => page.route(pattern, route => route.fulfill({json:body}));
  let cart = {start:'', end:'', lines:[], version:0};
  await page.route('**/api/miniapp/cart', route => {
    if (route.request().method() === 'PUT') cart = {...route.request().postDataJSON(), version:cart.version + 1};
    return route.fulfill({json:cart});
  });
  await json('**/api/miniapp/bookings', {id:9,human_number:'ТС000009'});
  await json('**/api/miniapp/catalog?*', {items:[model], total:1, page:0, page_size:20});
  await json('**/api/miniapp/availability?*', {items:[model], selected_items:[model], unavailable:[], unavailable_count:0});
  await json('**/api/miniapp/admin/catalog?*', {categories:[{code:'generic',name:'Оборудование'},{code:'camera',name:'Камера'}],
    articles:[{...model, equipment:[{id:21, asset_code:'CAM-21', condition:'available', location:'A1'}]}], dependencies:[],
    total:1, page:0, page_size:20});
  await json('**/api/miniapp/admin/notification-preferences', {quiet_start:'22:00', quiet_end:'08:00'});
  await json('**/api/miniapp/admin/calendar-feed', {url:'https://polyrental.test/calendar/test.ics'});
  await json('**/api/miniapp/admin/booking-settings', {rental_purpose_enabled:true});
  await json('**/api/miniapp/admin/handover-settings', {pickup_location:'Аудитория 301', pickup_instructions:'Назовите номер заявки.'});
  await json('**/api/miniapp/admin/bookings/7/identity', {full_name:'QA', documents:['student_front']});
  await page.route('**/api/miniapp/admin/bookings/7/identity/documents/student_front', route =>
    route.fulfill({contentType:'image/webp', body:Buffer.from(photo, 'base64')}));
  await json('**/api/miniapp/admin/support?*', {items:[{id:42, request_number:'ТС260007', status:'in_progress',
    owner_id:100, owner_name:'Оператор', created_at:notice.created_at}], eligible_owners:[100]});
  await json('**/api/miniapp/admin/support/42/messages', {customer_name:'Пользователь', screen:'profile',
    items:[{id:4, direction:'client', text:notice.preview}]});
  await json('**/api/miniapp/notifications/inbox?*', {items:notices, unread:true, unread_count:2, has_more:false});
  await json('**/api/miniapp/notifications/inbox/support/4', {text:notice.preview});
}

async function checkTabButtons(page, where) {
  const boxes = await page.getByRole('tablist', {name:'Разделы настроек'}).getByRole('tab').evaluateAll(nodes =>
    nodes.map(node => {
      const box = node.getBoundingClientRect();
      return {label:node.textContent.trim(), x:box.x, y:box.y, width:box.width, height:box.height,
        clipped:node.scrollWidth > node.clientWidth + 1};
    }));
  assert.equal(boxes.length, 5, `${where}: all administrator settings tabs are available`);
  for (const [index, box] of boxes.entries()) {
    assert.ok(box.height >= 44 && !box.clipped, `${where}: clipped or small settings tab ${box.label}`);
    for (const other of boxes.slice(index + 1)) {
      const overlap = box.x < other.x + other.width - 1 && box.x + box.width > other.x + 1 &&
        box.y < other.y + other.height - 1 && box.y + box.height > other.y + 1;
      assert.ok(!overlap, `${where}: ${box.label} and ${other.label} overlap`);
    }
  }
}

async function settings(page, audit, where) {
  const geometry = () => page.locator('#admin-panel').evaluate(panel => {
    const bounds = selector => {
      const box = panel.querySelector(selector).getBoundingClientRect();
      return {x:box.x, y:box.y + scrollY, width:box.width, height:box.height};
    };
    return {heading:bounds('.admin-panel-heading'), back:bounds('#admin-back-button'),
      settings:bounds('#admin-settings'), navigation:bounds('.admin-tabs')};
  });
  const tabs = selector => page.locator(selector).evaluate(node => {
    const styles = (element, properties, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return properties.map(property => property === 'border-bottom-color' && style.borderBottomWidth === '0px'
        ? '' : style.getPropertyValue(property));
    };
    const selected = node.querySelector('[aria-selected="true"], [aria-pressed="true"], [aria-current="page"]');
    const idle = [...node.querySelectorAll(':is(button, a):not([hidden])')].find(control => control !== selected);
    const centerOffset = control => {
      const range = document.createRange();
      range.selectNodeContents(control);
      const label = range.getBoundingClientRect();
      const bounds = control.getBoundingClientRect();
      return Math.abs((label.left + label.right - bounds.left - bounds.right) / 2);
    };
    const properties = ['display', 'align-items', 'justify-items', 'text-align',
      'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'opacity',
      'min-height', 'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
      'background-color', 'border-radius', 'border-bottom-width', 'border-bottom-color'];
    const indicator = ['content', 'background-color', 'height', 'border-radius', 'bottom', 'inset-inline-start', 'inset-inline-end'];
    const {x, y, width} = node.getBoundingClientRect();
    return {x, y:y + scrollY, width, activeHeight:selected.getBoundingClientRect().height,
      labelOffset:Math.max(centerOffset(selected), centerOffset(idle)),
      layout:styles(node, ['display', 'column-gap', 'row-gap', 'padding-inline-start',
        'padding-inline-end', 'border-bottom-width', 'border-bottom-color']),
      selected:styles(selected, properties), indicator:styles(selected, indicator, '::after'),
      idle:styles(idle, properties), idleIndicator:styles(idle, indicator, '::after')};
  });
  const management = await geometry();
  await page.mouse.move(0, 0);
  const managementTabs = await tabs('.admin-tabs');
  await audit.design('management/navigation-text', () => assertContrast(page.locator('.admin-tabs .admin-mode:visible')));
  await activateWithKeyboard(page.locator('#admin-settings-open'));
  await audit('settings/notifications', ['#admin-settings', '.settings-tabs', '#operator-quiet-form']);
  await page.mouse.move(0, 0);
  const opened = await geometry();
  assert.deepEqual(opened.heading, management.heading, `${where}: settings use the management header geometry`);
  assert.ok(Math.abs(opened.settings.width - management.navigation.width) < 2, `${where}: settings use management width`);
  if (page.viewportSize().width >= 1280) assert.ok(opened.settings.width > 720, `${where}: no desktop width cap`);
  await audit.design('settings/navigation-style', async () => {
    const settingsTabs = await tabs('.settings-tabs');
    for (const property of ['x', 'y', 'width', 'activeHeight']) {
      assert.ok(Math.abs(settingsTabs[property] - managementTabs[property]) < 2,
        `tabs share ${property} (Settings ${settingsTabs[property]}, Management ${managementTabs[property]})`);
    }
    for (const property of ['layout', 'selected', 'idle', 'indicator']) {
      assert.deepEqual(settingsTabs[property], managementTabs[property], `tabs share ${property} styling`);
    }
    assert.ok(Math.max(settingsTabs.labelOffset, managementTabs.labelOffset) < 2,
      `tab labels are centered (Settings ${settingsTabs.labelOffset}px, Management ${managementTabs.labelOffset}px)`);
    assert.notDeepEqual([settingsTabs.selected, settingsTabs.indicator], [settingsTabs.idle, settingsTabs.idleIndicator],
      'selected tab has distinct styling');
  });
  await audit.design('settings/notification-text', () => assertContrast(page.locator(
    '.settings-tabs button:visible, #settings-notifications p:not(:empty), #operator-quiet-form button')));
  await checkTabButtons(page, where);
  await page.locator('#settings-tab-notifications').press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-tab-calendar',
    `${where}: arrow key moves focus to the next settings tab`);
  assert.equal(await page.locator('#settings-tab-calendar').getAttribute('aria-selected'), 'true');
  for (const tab of ['calendar', 'booking', 'handover', 'staff']) {
    await page.locator(`#settings-tab-${tab}`).click();
    await audit(`settings/${tab}`, ['#admin-settings', '.settings-tabs', `#settings-${tab}`]);
    const switched = await geometry();
    assert.deepEqual(switched.heading, opened.heading, `${where}: stable header when switching to ${tab}`);
    assert.deepEqual(switched.back, opened.back, `${where}: stable back control when switching to ${tab}`);
    if (tab === 'booking') await audit.design('settings/booking-text', async () => {
      await page.locator('#settings-booking .button.primary:enabled').waitFor();
      await assertContrast(page.locator('#settings-booking .button.primary, #settings-booking .supporting'));
    });
  }
  await page.locator('#admin-back-button').click();
  await page.locator('#admin-settings').waitFor({state:'hidden'});
  await audit.design('settings/back-focus', () => page.waitForFunction(() =>
    ['admin-settings-open', 'admin-heading'].includes(document.activeElement.id)));
}

async function operator(page, audit, where, profileSelects) {
  await audit('management/orders', ['#admin-panel', '.admin-tabs', '#admin-content']);
  const summary = page.locator('.request-toggle').first();
  let closedChevron;
  await audit.design('management/order-chevron-closed', async () => { closedChevron = await chevron(summary); });
  await summary.click();
  await audit('management/order-details', ['#admin-panel', '.request-card[open], .request-card:has(details[open])']);
  await audit.design('management/order-chevron-open', async () => {
    const openedChevron = await chevron(summary);
    if (closedChevron) {
      assert.equal(openedChevron.content, closedChevron.content, 'opening rotates the same marker');
      assert.ok(Math.abs(openedChevron.angle - closedChevron.angle) > 1, 'opening rotates the disclosure chevron');
    }
  });
  const filters = page.locator('.admin-filters > summary');
  await filters.click();
  let managementSelects = [];
  await audit.design('management/selects', async () => {
    const controls = page.locator('#admin-queue, #admin-request-filter, #admin-status, #admin-sort').filter({visible:true});
    managementSelects = await selectAppearance(controls);
    assert.ok(managementSelects.length >= 3, 'management queue and filters are available');
    compareSelects([...managementSelects, ...(profileSelects || [])]);
    await assertContrast(controls);
  });
  await filters.click();
  await audit.design('management/document-viewer-backdrop', async () => {
    await activateWithKeyboard(page.getByRole('button', {name:'Посмотреть анкету', exact:true}));
    await activateWithKeyboard(page.getByRole('button', {name:'Просмотр документов', exact:true}));
    try {
      await assertModalBackdrop(page.locator(`#document-viewer${modalSelector}`));
    } finally {
      await page.locator('#document-viewer-close').click();
    }
  });
  await settings(page, audit, where);
  await page.locator('[data-mode="catalog"]').click();
  await audit('management/catalog', ['#admin-content', '.catalog-heading-row', '.admin-categories']);
  const catalogBack = page.locator('#admin-back-button:visible, .catalog-heading-row .catalog-search-back:visible');
  assert.equal(await catalogBack.count(), 0, `${where}: catalog root has no usable back destination`);
  await page.locator('.admin-categories [data-category-code="camera"]').click();
  await page.locator('.article-card:not(.loading-skeleton)').first().waitFor();
  await audit('management/catalog-category', ['#admin-content', '.admin-catalog-items', '.article-card']);
  assert.equal(await catalogBack.count(), 1, `${where}: the catalog category has one back control`);
  assert.ok(await catalogBack.isEnabled(), `${where}: category back control is enabled`);
  await page.locator('.article-card .article-toggle').first().click();
  await page.locator('[data-edit-asset-id]').first().click();
  await audit('management/equipment-editor', ['#admin-content', '.instance-editor']);
  await audit.design('management/equipment-editor-select', async () => {
    const selects = await selectAppearance(page.locator('#instance-data select[name="article_id"]'));
    if (managementSelects.length) compareSelects([...managementSelects.slice(0, 1), ...selects]);
  });
  await page.locator('.instance-editor-back').click();
  await page.locator('.instance-editor').waitFor({state:'hidden'});
  const articleEdit = page.locator('[data-edit-article-id]').first();
  if (!await articleEdit.isVisible()) await page.locator('.article-card .article-toggle').first().click();
  await articleEdit.click();
  await audit('management/article-editor', ['#admin-content', '.article-editor']);
  await page.locator('.instance-editor-back').click();
  await page.locator('.article-editor').waitFor({state:'hidden'});
  await catalogBack.click();
  await page.locator('.admin-categories [data-category-code="camera"]').waitFor();
  assert.equal(await catalogBack.count(), 0, `${where}: back restores the catalog root`);
  await page.locator('[data-mode="repairs"]').click();
  await audit('management/repairs', ['#admin-panel', '#admin-content']);
  await page.locator('[data-mode="support"]').click();
  await audit('management/support', ['#admin-content', '[data-support-thread-id="42"]']);
  await page.getByRole('button', {name:'Открыть сообщения'}).click();
  await audit('management/support-dialog', ['#admin-content', '.support-message']);
  await audit.design('management/support-text', () => assertContrast(page.locator(
    '.support-message, .support-message strong, [data-support-thread-id] .button.primary')));
}

async function customer(page, audit, surface) {
  await audit('booking/catalog', ['#step-items', '#client-categories']);
  assert.equal(await page.locator('#clear-cart').isVisible(), false, 'empty selection has no clear action');
  if (await page.evaluate(() => matchMedia('(min-width:769px) and (pointer:fine)').matches)) {
    assert.equal(await page.locator('#client-search-hide-keyboard').isVisible(), false);
  }
  await page.locator('.catalog-search > .notification-bell').click();
  await audit('notifications', ['#notification-dialog .dialog-card', '.notification-header',
    ...['support', 'urgent', 'booking', 'notification'].map(tone => `.notification-item[data-tone="${tone}"]`)]);
  const noticeSummary = page.locator('.notification-item[data-tone="support"] > summary');
  await audit.design('notifications/backdrop', () => assertModalBackdrop(page.locator(`#notification-dialog${modalSelector}`)));
  await audit.design('notifications/chevron-closed', () => chevron(noticeSummary));
  await audit.design('notifications/text', () => assertContrast(page.locator(
    '.notification-item-meta > span, .notification-item-copy > strong, .notification-item-copy > p, .notification-item-head > time')));
  await noticeSummary.click();
  await audit('notifications/expanded', ['#notification-dialog .dialog-card', '.notification-item-message']);
  await audit.design('notifications/chevron-open', () => chevron(noticeSummary));
  await page.keyboard.press('Escape');
  await page.locator('#notification-dialog').waitFor({state:'hidden'});
  await page.locator('#client-categories [data-category-code="camera"]').click();
  await audit('booking/product-list', ['#step-items', '#items-grid .item-card']);
  await audit.design('booking/photo-backdrop', async () => {
    await page.getByRole('button', {name:`Открыть фото: ${model.name}`, exact:true}).click();
    const photoDialog = page.locator(`.catalog-photo-dialog-view${modalSelector}`);
    try {
      await photoDialog.waitFor();
      assert.equal(await photoDialog.getByRole('button', {name:'Скачать фото'}).count(), 0,
        'customers may view photos without receiving the operator download action');
      await assertModalBackdrop(photoDialog);
    } finally {
      await photoDialog.getByRole('button', {name:'Закрыть', exact:true}).click();
    }
  });
  await page.locator('#items-grid .item-card .plus').first().click();
  assert.ok(await page.locator('#clear-cart').isVisible(), 'the clear action remains available for a selection');
  await audit.design('booking/action-text', () => assertContrast(page.locator('#main-button, #clear-cart')));
  await page.locator('#main-button').click();
  await audit('booking/cart', ['#step-contact', '#cart-items']);
  await page.locator('#main-button').click();
  await audit('booking/dates', ['#step-dates', '#range-calendar']);
  await page.locator('[data-date="2026-10-30"]').click();
  await page.locator('[data-date="2026-11-02"]').click();
  await page.locator('#start-time').fill('10:00');
  await page.locator('#end-time').fill('18:00');
  await page.locator('#main-button').click();
  await audit('booking/review', ['#step-review', '#review-content']);
  await page.locator('#main-button').click();
  await audit('booking/done', ['#step-done', '#done-orders']);
  assert.equal(await page.locator('#done-chat').isVisible(), surface === 'miniapp',
    'only the Telegram surface exposes the return-to-chat action');
  await page.locator('#tab-orders').click();
  // Support is intentionally full-bleed on mobile. Check it against the
  // viewport and examine the profile regions rather than its padded shell.
  await audit('profile', ['.profile-overview', '.profile-support-entry', '#orders-content .customer-order-card']);
  const profileSelects = await audit.design('profile/selects', async () => {
    const controls = page.locator('#profile-filter, #profile-sort');
    const selects = await selectAppearance(controls);
    compareSelects(selects);
    await assertContrast(controls);
    return selects;
  });
  await audit.design('profile/chevron', () => chevron(page.locator('#profile-disclosure > summary')));
  const summary = page.locator('#orders-content .customer-order-toggle').first();
  for (const selector of ['.status-pill', '.customer-order-period', '.customer-order-items']) {
    await summary.locator(selector).waitFor();
  }
  await audit.design('profile/order-chevron-motion', () => verifyChevronMotion(page, summary));
  await summary.click();
  await audit('profile/order-details', ['.profile-toolbar', '.customer-order-card:has(details[open])']);
  await audit.design('profile/order-chevron-open', () => chevron(summary));
  const order = page.locator('.customer-order-card:has(details[open])').first();
  assert.equal(await order.locator('.status-pill:visible, .customer-status-panel > strong:visible').count(), 1,
    'expanded order shows one primary status');
  assert.equal(await order.locator('.customer-order-period:visible, .customer-order-body .rental-period:visible').count(), 1,
    'expanded order shows one rental period');
  assert.equal(await order.locator('.customer-order-items:visible, .customer-order-body .request-equipment-row:visible').count(), 1,
    'expanded single-item order shows its equipment once');
  await order.getByRole('button',{name:'Сдать оборудование',exact:true}).waitFor();
  await page.locator('#profile-support').click();
  await audit('profile/support', ['#support-dialog .dialog-card', '#support-form']);
  await audit.design('profile/support-backdrop', () => assertModalBackdrop(page.locator(`#support-dialog${modalSelector}`)));
  await audit.design('profile/support-text', () => assertContrast(page.locator('#support-question-label, #support-close, #support-submit')));
  return profileSelects;
}

async function restrictedSettings(browser, surface, report) {
  for (const [role,piiOnly] of [['operator',false],['manager',false],['pii',true]]) {
    const where = `${surface}/390x844/${role}`;
    const {page,errors} = await fixture(browser, {surface,admin:true,role,piiOnly,piiAdmin:piiOnly,openOrder:false});
    try {
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.locator('.request-card').first().waitFor({timeout:6000});
      if (surface === 'site') await page.waitForFunction(() => history.scrollRestoration === 'manual');
      assert.equal(await page.locator('#admin-settings-open').isVisible(), !piiOnly, where);
      if (piiOnly) {
        assert.equal(await page.locator('.admin-tabs .admin-mode:visible').count(), 1, where);
        await capture(page, 'management/orders-pii', ['#admin-panel','#admin-content'], report, where);
      } else {
        await page.locator('#admin-settings-open').click();
        await capture(page, 'settings/restricted', ['#admin-settings','.settings-tabs'], report, where);
        assert.equal(await page.getByRole('tablist', {name:'Разделы настроек'}).getByRole('tab').count(), 2, where);
      }
      assert.deepEqual(errors, [], where);
    } finally { await page.close(); }
  }
}

async function customerCardStates(browser, surface, report) {
  const where = `${surface}/390x844/customer-card-states`;
  const {page,errors} = await fixture(browser, {surface,openOrder:false});
  try {
    const items = orderStates.map((status, index) => ({
      ...base(status), id:101 + index, human_number:`ТС260${101 + index}`,
      identity_status: ['confirmed','preparing','ready'].includes(status) ? 'required' : 'verified',
      next_action:{description:'Подробности по этому этапу доступны в заявке.'},
    }));
    await page.route('**/api/miniapp/profile/history?*', route => route.fulfill({json:{items,total:items.length}}));
    await page.emulateMedia({reducedMotion:'reduce'});
    if (surface === 'site') await page.waitForFunction(() => history.scrollRestoration === 'manual');
    await page.locator('#tab-orders').click();
    for (const order of items) {
      const selector = `.customer-order-card[data-booking-id="${order.id}"]`;
      const card = page.locator(selector), summary = card.locator('summary.customer-order-toggle');
      await summary.click();
      await capture(page, `profile/order-${order.status}`, [selector, `${selector} .customer-order-body`], report, where);
      assert.equal(await card.locator('.status-pill:visible, .customer-status-panel > strong:visible').count(), 1, order.status);
      assert.equal(await card.locator('.customer-order-period:visible, .rental-period:visible').count(), 1, order.status);
      assert.equal(await card.locator('.customer-order-items:visible, .request-equipment-row:visible').count(), 1, order.status);
      assert.equal(await card.getByText('Частичная выдача', {exact:true}).count(), 1, order.status);
      await summary.click();
    }
    assert.deepEqual(errors, [], where);
  } finally { await page.close(); }
}

async function staffCardStates(browser, surface, report) {
  const where = `${surface}/390x844/staff-card-states`;
  const items = orderStates.map((status, index) => ({
    ...base(status), id:101 + index, human_number:`ТС260${101 + index}`, assignee_id:100,
  }));
  const {page,errors} = await fixture(browser, {surface,admin:true,role:'manager',openOrder:false,order:items[0]});
  try {
    await page.route('**/api/miniapp/admin/bookings?*', route => route.fulfill({json:{items,total:items.length}}));
    await page.emulateMedia({reducedMotion:'reduce'});
    if (surface === 'site') await page.waitForFunction(() => history.scrollRestoration === 'manual');
    await page.locator('#tab-orders').click();
    await page.locator('#tab-admin').click();
    for (const order of items) {
      const selector = `.request-card[data-booking-id="${order.id}"]`;
      const card = page.locator(selector), summary = card.locator('summary.request-toggle');
      await summary.click();
      const more = card.locator('.request-more-actions > summary');
      if (await more.isVisible()) await more.click();
      await capture(page, `management/order-${order.status}`, [selector, `${selector} .request-body`], report, where);
      assert.equal(await card.locator('.request-period:visible, .rental-period:visible').count(), 1, order.status);
      assert.equal(await card.locator('.order-head .status-pill:visible').count(), 1, order.status);
      if (['returned','cancelled','expired'].includes(order.status)) {
        assert.equal(await card.locator('.request-next-step:visible').count(), 0, order.status);
      }
      await summary.click();
    }
    assert.deepEqual(errors, [], where);
  } finally { await page.close(); }
}

async function run() {
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true, ...(engine === chromium && process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  const surfaces = process.env.AUDIT_SURFACE ? [process.env.AUDIT_SURFACE] : ['site', 'miniapp'];
  const requestedWidths = process.env.AUDIT_WIDTH ? viewports.filter(([width]) => width === Number(process.env.AUDIT_WIDTH)) : viewports;
  const sizes = requestedWidths.flatMap(([width, height, style, theme]) =>
    [320, 390, 768, 1920].includes(width) ? [[width,height,style,theme], [width,height,style,theme === 'light' ? 'dark' : 'light']]
      : [[width,height,style,theme]]);
  assert.ok(surfaces.every(surface => ['site','miniapp'].includes(surface)) && sizes.length, 'Use AUDIT_SURFACE=site|miniapp and an AUDIT_WIDTH from the audit matrix');
  const report = new Map();
  const comparableSelects = new Map();
  const failed = [];
  let checkpoints = 0;
  try {
    for (const surface of surfaces) for (const [width,height,style,theme] of sizes) for (const admin of [false,true]) {
      const configuration = `${surface}/${width}x${height}/${style}/${theme}`;
      const where = `${configuration}/${admin ? 'admin' : 'customer'}`;
      let configurationFailed = false;
      let page;
      try {
        const test = await fixture(browser, {surface, width, height, admin, role:admin ? 'admin' : 'operator',
          piiAdmin:admin, isMobile:width<600, openOrder:false, order:base('issued')});
        page = test.page;
        page.setDefaultTimeout(6000);
        await page.emulateMedia({reducedMotion:'reduce'});
        await page.evaluate(({style,theme}) => {document.documentElement.dataset.style=style;document.documentElement.dataset.theme=theme;}, {style,theme});
        await installRoutes(page);
        if (surface === 'site') await page.waitForFunction(() => history.scrollRestoration === 'manual');
        async function design(scope, verify) {
          try {
            const result = await verify();
            checkpoints++;
            return result;
          } catch (error) {
            configurationFailed = true;
            console.error(`FAIL ${where}/${scope}\n${error.stack}`);
          }
        }
        const audit = (scope, selectors) => design(scope, () => capture(page, scope, selectors, report, where));
        audit.design = design;
        if (admin) await operator(page, audit, where, comparableSelects.get(configuration));
        else comparableSelects.set(configuration, await customer(page, audit, surface));
        assert.deepEqual(test.errors, [], `${where}: runtime errors`);
        if (!configurationFailed) console.log(`PASS ${where}`);
      } catch (error) {
        configurationFailed = true;
        console.error(`FAIL ${where}\n${error.stack}`);
      } finally {
        if (configurationFailed) failed.push(where);
        await page?.close();
      }
    }
    if (!process.env.AUDIT_WIDTH || Number(process.env.AUDIT_WIDTH) === 390) {
      for (const surface of surfaces) {
        await restrictedSettings(browser, surface, report);
        await customerCardStates(browser, surface, report);
        await staffCardStates(browser, surface, report);
        checkpoints += 3 + 2 * orderStates.length;
      }
    }
  } finally {
    await browser.close();
    for (const entry of report.values()) console.log('REPEAT', JSON.stringify({...entry, seen:[...entry.seen]}));
    console.log(`Layout audit: ${engine.name()}, ${checkpoints} checkpoints, ${report.size} repeat groups, ${failed.length} failed configurations`);
  }
  if (failed.length || report.size) process.exitCode = 1;
}

run().catch(error => {console.error(error); process.exitCode = 1;});
