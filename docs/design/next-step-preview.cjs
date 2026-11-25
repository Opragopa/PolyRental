// Local-only preview of the prototype inside both application entry points.
// Run from any directory with: node docs/design/next-step-preview.cjs
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const assets = path.resolve(__dirname, '../../app/miniapp_static');
const prototypeFile = path.join(__dirname, 'next-step-prototype.html');
const bookingId = 7;
const port = Number(process.env.NEXT_STEP_PREVIEW_PORT || 4178);
const equipment = [
  { id: 14, serial: '014', name: 'Sony FX3' },
  { id: 21, serial: '021', name: 'Объектив 24–70 мм' },
];
const order = {
  id: bookingId, human_number: 'ТС260007', status: 'preparing', identity_status: 'verified',
  starts_at: '2026-12-02T10:00:00+03:00', ends_at: '2026-12-02T18:00:00+03:00',
  customer_name: 'Тестовый клиент', assignee_id: 100, assignee_name: 'Тестовый оператор',
  items: equipment.map(entry => ({ id: entry.id, name: entry.name, quantity: 1 })),
  lines: equipment.map(entry => ({ id: entry.id, article_id: entry.id, name: entry.name, quantity: 1 })),
  assets: equipment.map(entry => ({ ...entry, article_id: entry.id, inspection_profile: 'generic' })),
  inspections: [],
};

function installFixture(bookingId) {
  const pageUrl = new URL(location.href);
  const role = pageUrl.searchParams.get('role') === 'management' ? 'management' : 'customer';
  if (!pageUrl.searchParams.has('booking')) {
    pageUrl.searchParams.set('booking', bookingId);
    history.replaceState(history.state, '', pageUrl);
  }
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (resource, options) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return fetchOriginal(resource, options);
    const headers = new Headers(options?.headers);
    headers.set('X-Next-Step-Role', role);
    return fetchOriginal(resource, { ...options, headers });
  };
}

function installPreview(prototypeMarkup, prototypeStyles, mountNextStep, bookingId) {
  const pageRoot = document.documentElement;
  const role = new URL(location.href).searchParams.get('role') === 'management' ? 'management' : 'customer';
  const surface = location.pathname;
  const toolbar = document.getElementById('next-step-preview-controls');
  toolbar.querySelector('[name="surface"]').value = surface;
  toolbar.querySelector('[name="role"]').value = role;
  toolbar.querySelector('[name="theme"]').value = pageRoot.dataset.theme;
  toolbar.querySelector('[name="style"]').value = pageRoot.dataset.style;
  toolbar.addEventListener('change', event => {
    const { name, value } = event.target;
    if (name === 'theme' || name === 'style') {
      const input = document.querySelector(`.${name}-switch input[value="${value}"]`);
      input.checked = true;
      input.dispatchEvent(new Event('change'));
    } else {
      const url = new URL(location.href);
      url.pathname = toolbar.querySelector('[name="surface"]').value;
      url.search = new URLSearchParams({ role: toolbar.querySelector('[name="role"]').value, booking: bookingId });
      url.hash = '';
      location.assign(url);
    }
  });

  const isStaff = role === 'management';
  const cardSelector = `.${isStaff ? 'request-card' : 'customer-order-card'}[data-booking-id="${bookingId}"]`;
  let framePending = false;
  let host;
  const syncAppearance = () => {
    if (host) host.dataset.theme = pageRoot.dataset.theme || 'light';
    toolbar.querySelector('[name="theme"]').value = pageRoot.dataset.theme;
    toolbar.querySelector('[name="style"]').value = pageRoot.dataset.style;
  };
  const themeObserver = new MutationObserver(syncAppearance);
  themeObserver.observe(pageRoot, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });

  function placePreview() {
    framePending = false;
    if (pageRoot.classList.contains('role-pending')) return;
    const card = document.querySelector(cardSelector);
    const section = card?.querySelector('.request-next-overview');
    if (!section || section.querySelector('[data-next-step-preview]')) return;
    host = document.createElement('div');
    host.dataset.nextStepPreview = role;
    const duplicateSelectors = isStaff
      ? '.request-next-head h4, .request-next-step, .request-primary-actions, :scope > .next-step'
      : '.customer-status-detail, :scope > .next-step';
    section.querySelectorAll(duplicateSelectors).forEach(element => element.remove());
    if (isStaff) {
      const buttons = section.querySelectorAll('.request-more-actions button');
      for (const button of buttons) {
        if (button.textContent.trim() === 'Заменить экземпляры') button.remove();
      }
    } else card.querySelector('.request-equipment-section')?.remove();
    const before = section.querySelector('.request-more-actions');
    section.insertBefore(host, before);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${prototypeStyles}</style>${prototypeMarkup}`;
    syncAppearance();
    mountNextStep(shadow, host, role);
  }
  function queuePlacement() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(placePreview);
  }
  new MutationObserver(queuePlacement).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(queuePlacement).observe(pageRoot, { attributes: true, attributeFilter: ['class'] });
  queuePlacement();
}

const previewControls = `
  <aside class="next-step-preview-controls" id="next-step-preview-controls" aria-label="Параметры макета">
    <strong>Демонстрационная заявка</strong>
    <label>Приложение <select name="surface"><option value="/site">Сайт</option><option value="/miniapp">Mini App</option></select></label>
    <label>Сценарий <select name="role"><option value="customer">Профиль клиента</option><option value="management">Управление</option></select></label>
    <label>Тема <select name="theme"><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
    <label>Стиль <select name="style"><option value="classic">Классический</option><option value="studio">Медиастудия</option><option value="frame">Кадр</option></select></label>
  </aside>`;

const shellStyles = `
  .next-step-preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--line, #7c8da3); color: var(--text); font-size: 13px; }
  .next-step-preview-controls label { display: flex; align-items: center; gap: 5px; }
  .next-step-preview-controls select { min-height: 44px; width: auto; font-size: inherit; }
  @media (max-width: 600px) {
    .next-step-preview-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .next-step-preview-controls strong { grid-column: 1 / -1; }
    .next-step-preview-controls label { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .next-step-preview-controls select { width: 100%; min-width: 0; }
  }
  .request-next-overview:has(> [data-next-step-preview]) { padding: 0; border: 0; background: transparent; min-width: 0; }
  .request-next-overview:has(> [data-next-step-preview]) > .request-next-head:empty { display: none; }
`;

const embeddedStyles = `
  :host { display: block; min-width: 0; color: var(--ink); --paper: var(--surface); --shadow: none; }
  :host([data-theme="dark"]) { --paper: var(--surface); --shadow: none; }
  .page { width: auto; margin: 0; padding: 0; }
  .masthead { display: none; }
  :host([data-next-step-preview="management"]) .masthead { display: flex; justify-content: flex-end; margin: 0 0 8px; }
  .masthead > div:first-child, .controls .field:nth-child(2), .role, .mobile-tabs { display: none; }
  .controls { display: flex; flex-wrap: nowrap; justify-content: flex-end; width: max-content; max-width: 100%; }
  .controls .field:first-child { width: 176px; min-width: 0; }
  .mockups { display: block; }
  .card { border-radius: var(--card-radius, 14px); }
  .card-head { padding: 14px 12px 0; }
  .body { padding: 14px 12px; }
  .status { grid-template-columns: 28px minmax(0, 1fr); gap: 7px; padding-inline: 8px; }
  .status:has(.icon-button) { grid-template-columns: 28px minmax(0, 1fr) auto; }
  .item-head, .row-toggle { padding-inline: 0; gap: 4px; }
  .item-head { grid-template-columns: 27px minmax(0, 1fr) 44px 44px; }
  .row-toggle { grid-template-columns: 27px minmax(0, 1fr) 33px 28px; }
  .details { margin-left: 31px; }
  .dialog { margin: auto; }
  @media (max-width: 360px) { .dialog .item-head { grid-template-columns: 27px minmax(0, 1fr) 44px; } }
`;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.wasm': 'application/wasm' };
function send(response, content, type, status = 200) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(content);
}

function json(response, body, status) {
  send(response, JSON.stringify(body), 'application/json', status);
}

function fixtureResponse(request, response, endpoint) {
  const admin = request.headers['x-next-step-role'] === 'management';
  const id = admin ? 100 : 42;
  if (request.method !== 'GET') return json(response, { detail: 'Это демонстрация. Изменения заявки доступны в макете.' }, 405);
  switch (endpoint) {
    case '/api/site/session': return json(response, { id, first_name: 'Тестовый пользователь' });
    case '/api/miniapp/me': return json(response, { id, admin, staff_role: admin ? 'manager' : null, pii_admin: false });
    case '/api/miniapp/profile': return json(response, { display_name: admin ? 'Тестовый оператор' : 'Тестовый клиент', onboarding_seen: true, client_allowed: true, start_screen: admin ? 'management' : 'booking' });
    case '/api/miniapp/operator/last-section': return json(response, { section: 'orders' });
    case '/api/miniapp/admin/bookings': return admin ? json(response, { items: [order], total: 1 }) : json(response, { detail: 'Доступ запрещён' }, 403);
    case '/api/miniapp/profile/history': return json(response, { items: [order], total: 1 });
    case '/api/miniapp/bookings/7': return json(response, order);
    case '/api/miniapp/cart': return json(response, { version: 0, start: '', end: '', lines: [] });
    default: return json(response, endpoint.endsWith('/changes') ? null : { items: [] });
  }
}

async function handleRequest(request, response) {
  try {
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    if (pathname.startsWith('/api/')) return fixtureResponse(request, response, pathname);
    if (request.method !== 'GET') return send(response, '', 'text/plain', 405);
    if (pathname === '/telegram-demo.js') {
      const telegram = 'window.Telegram={WebApp:{initData:"synthetic",initDataUnsafe:{user:{id:42}},ready(){},expand(){},close(){},BackButton:{show(){},hide(){},onClick(){}}}};';
      return send(response, telegram, 'text/javascript');
    }
    if (pathname === '/fixture.js') {
      return send(response, `(${installFixture})(${bookingId});`, 'text/javascript');
    }
    if (pathname === '/preview-mount.js') {
      const prototype = await readFile(prototypeFile, 'utf8');
      const styles = prototype.match(/<style>([\s\S]+)<\/style>/)[1]
        .replaceAll(':root[data-theme="dark"]', ':host([data-theme="dark"])')
        .replaceAll(':root', ':host')
        .replaceAll('../../app/miniapp_static/', '/miniapp/static/');
      const markup = prototype.match(/<body>([\s\S]+?)<script>/)[1].trim()
        .replace('<main class="page">', '<div class="page">').replace('</main>', '</div>');
      const mount = prototype.match(/(function mountNextStep[\s\S]+?)\s+mountNextStep\(document, document.documentElement\);/)[1];
      const script = `document.addEventListener('DOMContentLoaded', () => {
        ${mount}
        (${installPreview})(${JSON.stringify(markup)}, ${JSON.stringify(styles + embeddedStyles)}, mountNextStep, ${bookingId});
      });`;
      return send(response, script, 'text/javascript');
    }
    if (pathname === '/site' || pathname === '/miniapp' || pathname === '/') {
      if (pathname === '/') {
        response.writeHead(302, { Location: `/site?role=management&booking=${bookingId}` });
        return response.end();
      }
      const html = (await readFile(path.join(assets, 'index.html'), 'utf8')).replaceAll('__APP_VERSION__', 'preview')
        .replace('https://telegram.org/js/telegram-web-app.js?64', pathname === '/site' ? '/empty-sdk.js' : '/telegram-demo.js')
        .replace('</head>', `<script src="/fixture.js"></script><script defer src="/preview-mount.js"></script><style>${shellStyles}</style></head>`)
        .replace('<body class="dates-view">', `<body class="dates-view">${previewControls}`);
      return send(response, html, 'text/html; charset=utf-8');
    }
    if (pathname === '/empty-sdk.js') return send(response, '', 'text/javascript');
    const assetName = pathname.match(/^\/miniapp\/static\/([a-zA-Z0-9_.-]+)$/)?.[1];
    if (assetName && assetName !== '.' && assetName !== '..') {
      const file = await readFile(path.join(assets, assetName));
      return send(response, file, types[path.extname(assetName)] || 'application/octet-stream');
    }
    return send(response, 'Страница не найдена', 'text/plain; charset=utf-8', 404);
  } catch (error) {
    const missing = error.code === 'ENOENT';
    if (!missing) console.error(error);
    return send(response, '', 'text/plain', missing ? 404 : 500);
  }
}

module.exports = { handleRequest };
if (require.main === module) {
  createServer(handleRequest).listen(port, '127.0.0.1', () => {
    console.log(`PolyRental next-step preview: http://127.0.0.1:${port}/site?role=management`);
  });
}
