const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assets = path.resolve(__dirname, '../app/miniapp_static');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'polyrental.test') return route.fulfill({ body: '', contentType: 'text/javascript' });
      const file = path.join(assets, url.pathname.startsWith('/miniapp/static/') ? path.basename(url.pathname) : 'index.html');
      const ext = path.extname(file);
      const body = ext === '.html' ? fs.readFileSync(file, 'utf8').replaceAll('__APP_VERSION__', 'QA') : fs.readFileSync(file);
      return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream' });
    });
    await page.goto('http://polyrental.test/miniapp?preview=1');
    if (await page.locator('#onboarding-skip').isVisible()) await page.locator('#onboarding-skip').click();
    assert.equal(await page.locator('html').getAttribute('data-style'), 'classic');
    await page.locator('#tab-orders').click();
    await page.locator('#profile-header > summary').click();
    await page.locator('label:has(input[name="visual-style"][value="studio"])').click();
    assert.equal(await page.locator('html').getAttribute('data-style'), 'studio');
    await page.locator('label:has(input[name="theme"][value="light"])').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-style'), 'studio');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('#tab-orders').click();
    if (!(await page.locator('input[name="visual-style"][value="classic"]').isVisible())) await page.locator('#profile-header > summary').click();
    await page.locator('label:has(input[name="visual-style"][value="classic"])').click();
    assert.equal(await page.locator('html').getAttribute('data-style'), 'classic');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    console.log('PASS style selection, theme independence, and persistence');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
