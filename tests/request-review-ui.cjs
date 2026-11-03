/* All HTTP requests are intercepted. This suite uses synthetic identities only
 * and requires no server, database, Telegram account or document uploads. */
const { chromium, webkit } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const assets = path.join(root, "app", "miniapp_static");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8").replaceAll("__APP_VERSION__", version);
const now = new Date("2026-10-26T10:00:00Z");
const order = (id, extra = {}) => ({
  id, status: "confirmed", identity_status: "submitted", customer_name: `QA client ${id}`,
  customer_contact: `@qa_${id}`, starts_at: "2026-11-02T10:00:00+03:00", ends_at: "2026-11-02T18:00:00+03:00",
  items: [{ name: "QA camera", quantity: 1 }], assets: [], lines: [], inspections: [],
  operation_lease: null, operation_lease_state: null, ...extra,
});
const masked = {
  full_name: "QA Synthetic Identity", passport: "****56", student_id: "******78", status: "submitted",
  review_comment: "", review_fields: [], documents: ["passport_main", "passport_registration", "student_front"],
  document_checks: {
    passport_main: { document: "unknown", student: "unknown", reason: "timeout", manual_review: true },
    student_front: { document: "not_document", student: "unknown", reason: "blank_image", manual_review: true },
  },
};
const full = {
  full_name: "QA Synthetic Identity", birth_date: "2000-01-01", passport_series: "0000", passport_number: "123456",
  passport_issued_at: "2020-01-01", passport_issuer: "QA synthetic issuer", passport_division_code: "000-000",
  registration_address: "QA synthetic registration", residential_address: "QA synthetic residence",
  student_id_number: "12345678", student_institution: "QA synthetic institution",
};
const card = (page, id) => page.locator(`.request-card[data-booking-id="${id}"]`);
const openCard = async (page, id) => {
  await card(page, id).locator(".request-toggle").click();
  await card(page, id).locator(".request-body").waitFor({ state: "visible" });
};
const assertHistory = async (page, id) => {
  const history=card(page,id).locator("details.request-history");
  if (!await history.evaluate(node=>node.open)) await history.locator("summary").click();
  const entries = card(page, id).locator(".request-history-list li");
  // Opening the accordion starts a separate fetch; visible request details do
  // not mean its asynchronously loaded audit history has rendered yet.
  await entries.nth(1).waitFor({ state: "visible" });
  assert.deepEqual(await entries.locator("strong").allTextContents(), ["Заявка подтверждена", "Анкета одобрена", "Анкета отправлена", "Клиент подтвердил получение", "Бумажная подпись при выдаче отмечена", "Клиент подтвердил сдачу", "Бумажная подпись при возврате отмечена"]);
  const actors = await entries.locator("span").allTextContents();
  assert.match(actors[0], /МСК · ID 100$/);
  assert.match(actors[1], /МСК · ID 200$/);
};
const waitUntil = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
};

async function fixture(browser, { pii = true, width = 390, dark = false, orders = [order(7), order(8)], delayIdentity, delayReveal, inspectionFailEquipment } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, colorScheme: dark ? "dark" : "light" });
  const errors = [], requests = [], reviews = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.clock.install({ time: now });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname, method: route.request().method() });
    if (url.hostname === "telegram.org") return route.fulfill({ contentType: "text/javascript", body: `window.Telegram={WebApp:{initData:"signed-qa",initDataUnsafe:{user:{id:200}},colorScheme:"${dark ? "dark" : "light"}"}}` });
    if (url.pathname.startsWith("/miniapp/static/")) {
      const file = path.join(assets, path.basename(url.pathname));
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith("css") ? "text/css" : "text/javascript" });
    }
    if (url.pathname === "/api/miniapp/me") return route.fulfill({ json: { id: 200, admin: true, staff_role: "admin", pii_admin: pii } });
    if (url.pathname === "/api/miniapp/admin/bookings") return route.fulfill({ json: { items: orders } });
    const bookingId = Number(url.pathname.match(/\/bookings\/(\d+)/)?.[1]);
    if (url.pathname.endsWith("/rework")) {
      const payload = route.request().postDataJSON();
      orders.find(item => item.id === bookingId).status = payload.target;
      return route.fulfill({json: {status: payload.target}});
    }
    if (url.pathname.endsWith("/inspection")) {
      const payload = route.request().postDataJSON();
      if (payload.equipment_id === inspectionFailEquipment) return route.fulfill({ status: 409, json: { detail: "QA inspection conflict" } });
      const selected = orders.find(item => item.id === bookingId);
      selected.inspections.push(payload);
      const lease = { stage: selected.status, actor_id: 200, actor_name: "QA self", expires_at: "2026-10-26T10:10:00Z", expired: false };
      selected.operation_lease = selected.operation_lease_state = lease;
      return route.fulfill({ json: { status: "saved" } });
    }
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { items: [
      { id: "audit:1", action: "confirmed", actor_id: 100, created_at: "2026-10-26T09:00:00Z", category: "status" },
      { id: "pii:1", action: "verified", actor_id: 200, created_at: "2026-10-26T09:01:00Z", category: "identity" },
      ...["submitted", "customer_received", "paper_issue_signed", "customer_returning", "paper_return_signed"].map((action, index) => ({ id: `qa:${index}`, action, actor_id: 42, created_at: "2026-10-26T09:02:00Z", category: "operation" })),
    ] } });
    if (url.pathname.endsWith("/identity/review")) {
      const payload = route.request().postDataJSON(); reviews.push({ bookingId, payload });
      orders.find(item => item.id === bookingId).identity_status = payload.approved ? "verified" : "needs_changes";
      return route.fulfill({ json: { status: payload.approved ? "verified" : "needs_changes" } });
    }
    if (url.pathname.endsWith("/identity/reveal")) {
      if (delayReveal) await delayReveal;
      return route.fulfill({ json: full });
    }
    if (url.pathname.endsWith("/identity")) {
      if (delayIdentity) await delayIdentity;
      return route.fulfill({ json: masked });
    }
    if (url.pathname.includes("/identity/documents/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="gray"/></svg>' });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ body: html, contentType: "text/html" });
  });
  await page.goto("http://polyrental.test/miniapp");
  await card(page, orders[0].id).waitFor();
  return { page, errors, requests, reviews, orders };
}

(async () => {
  const engineName = process.env.PLAYWRIGHT_BROWSER || "chromium";
  assert.ok(["chromium", "webkit"].includes(engineName), "Unsupported browser engine");
  const engine = engineName === "webkit" ? webkit : chromium;
  const browser = await engine.launch({ headless: true, ...(engineName === "chromium" && process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const passed = [];
  try {
    for (const [width, dark] of [[320, false], [390, true], [1024, false]]) {
      const { page, errors, requests, reviews } = await fixture(browser, { width, dark });
      assert.equal(await page.locator(".request-accordion[open]").count(), 0, "The initial list stays compact");
      if (width === 320 && !dark) {
        for (const name of ["Заказы", "Каталог", "Ремонт", "Поддержка"]) {
          const tab = page.locator(".admin-tabs").getByRole("button", {name, exact:true});
          assert.equal(await tab.isVisible(), true);
          assert.ok(await tab.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.height >= 44; }), `${name} fits and is tappable`);
        }
        await page.locator("#admin-settings > summary").click();
        assert.equal(await page.locator("#operator-notification-settings").isVisible(), true);
        assert.equal(await page.getByRole("button", {name:"Сотрудники", exact:true}).isVisible(), true);
        await page.locator("#admin-settings > summary").click();
      }
      if (process.env.QA_SCREENSHOTS && width === 320 && !dark) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, "staff-list-320.png") });
      }
      assert.equal(await page.locator(".identity-check-review").count(), 0);
      assert.equal(requests.filter(request => request.path.endsWith("/identity")).length, 0, "PII is fetched on demand");
      await openCard(page, 8);
      assert.equal(await page.locator(".request-accordion[open]").count(), 1);
      await card(page, 8).getByRole("button", { name: /^Проверить анкету/ }).click();
      const review = card(page, 8).locator(".identity-check-review");
      await review.waitFor();
      assert.equal(await page.locator("#admin-content > .identity-check-review").count(), 0, "Review belongs to its request");
      for (const section of [".review-personal-data", ".review-document-data", ".review-document-checks", ".review-decision"]) assert.equal(await review.locator(section).count(), 1, section);
      assert.ok(await review.locator("dt").count() >= 3, "Data has readable field labels");
      assert.match(await review.innerText(), /не документ.*однотонное фото/s);
      assert.match(await review.innerText(), /Время проверки истекло|таймаут/i, "Automatic failure retains its manual fallback reason");
      await review.getByRole("button", { name: "Раскрыть реквизиты", exact: true }).click();
      await waitUntil(async () => (await review.innerText()).includes(full.registration_address), "Full reveal did not render");
      assert.ok(await review.locator("dd").count() >= 8, "Revealed data stays structured");
      const previewButton = review.getByRole("button", { name: "Открыть фото · Паспорт: фото", exact: true });
      await previewButton.click();
      await page.locator("#document-viewer-image[src]").waitFor();
      assert.equal(await page.locator("#document-viewer").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#document-viewer").isHidden(), true);
      assert.equal(await page.locator("#document-viewer-image").getAttribute("src"), null, "Closing the preview releases the image");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `No horizontal overflow at ${width}px`);
      const touch = await review.getByRole("button").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height > 0).every(button => { const box = button.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }));
      assert.equal(touch, true, "Review touch targets are at least 44px");
      await assertHistory(page, 8);
      if (process.env.QA_SCREENSHOTS) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, `v0.3.1-review-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
      }
      await review.getByRole("button", { name: "Подтвердить документы", exact: true }).click();
      await waitUntil(async () => reviews.length === 1 && await card(page, 8).getByRole("button", { name: /^Начать подготовку/ }).isVisible(), "Approval did not refresh the selected request");
      assert.equal(await card(page, 8).locator(".request-accordion").getAttribute("open") !== null, true);
      assert.equal(await page.locator(".request-accordion[open]").count(), 1);
      assert.deepEqual(reviews[0], { bookingId: 8, payload: { approved: true, comment: "", fields: [] } });
      await card(page, 8).getByRole("button", { name: /^Проверить анкету/ }).click();
      await card(page, 8).getByRole("button", { name: "Отклонить / исправить", exact: true }).click();
      await page.locator('#identity-review-form input[value="student_front"]').check();
      await page.locator("#identity-review-form textarea").fill("QA replace synthetic photo");
      await page.locator("#identity-review-submit").click();
      await waitUntil(async () => reviews.length === 2 && await page.locator("#identity-review-dialog").isHidden(), "Correction request was not saved");
      assert.deepEqual(reviews[1].payload, { approved: false, comment: "QA replace synthetic photo", fields: ["student_front"] });
      await openCard(page, 7);
      await waitUntil(async () => await card(page, 8).locator(".request-accordion").getAttribute("open") === null, "Previous request did not close after its animation");
      assert.equal(await page.locator(".identity-check-review").count(), 0, "Closing a request removes sensitive review data");
      assert.deepEqual(errors, []);
      passed.push(`review ${width}px ${dark ? "dark" : "light"}`);
      await page.close();
    }

    {
      const { page, errors, reviews } = await fixture(browser, { orders: Array.from({ length: 20 }, (_, index) => order(index + 7)) });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const selected = card(page, 15);
      await selected.locator(".request-toggle").focus();
      const summaryBounds = await selected.locator(".request-toggle").boundingBox();
      assert.ok(summaryBounds.width >= 44 && summaryBounds.height >= 44);
      assert.notEqual(await selected.locator(".request-toggle").evaluate(node => getComputedStyle(node).outlineStyle), "none", "Keyboard focus is visible");
      await page.keyboard.press("Enter");
      await selected.locator(".request-body").waitFor({ state: "visible" });
      await selected.getByRole("button", { name: /^Проверить анкету/ }).click();
      const approve = selected.getByRole("button", { name: "Подтвердить документы", exact: true });
      await approve.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      await approve.click();
      await waitUntil(async () => reviews.length === 1 && await selected.getByRole("button", { name: /^Начать подготовку/ }).isVisible(), "Context-preserving refresh did not finish");
      const after = await page.evaluate(() => scrollY);
      assert.ok(Math.abs(after - before) <= 3, `Refresh jumped from ${before}px to ${after}px`);
      assert.equal(await selected.locator(".request-accordion").getAttribute("open") !== null, true);
      assert.equal(await page.locator(".request-card").count(), 20, "The surrounding list stays visible");
      assert.deepEqual(errors, []); passed.push("keyboard accordion and scroll context after action"); await page.close();
    }

    {
      const { page, errors, requests } = await fixture(browser, { pii: false });
      await openCard(page, 7);
      assert.equal(await page.getByRole("button", { name: /^Проверить анкету|Раскрыть реквизиты|Подтвердить документы|Отклонить \/ исправить/ }).count(), 0);
      assert.equal(await page.locator(".identity-check-review").count(), 0);
      assert.equal(requests.filter(request => request.path.includes("/identity")).length, 0, "An ordinary operator never fetches PII or verdicts");
      await assertHistory(page, 7);
      assert.match(await card(page, 7).locator(".request-next-step").innerText(), /сотрудником с доступом к персональным данным/);
      assert.deepEqual(errors, []); passed.push("operator PII boundary"); await page.close();
    }

    for (const phase of ["identity", "reveal"]) {
      let release;
      const delayed = new Promise(resolve => { release = resolve; });
      const { page, errors } = await fixture(browser, phase === "identity" ? { delayIdentity: delayed } : { delayReveal: delayed });
      await openCard(page, 7);
      await card(page, 7).getByRole("button", { name: /^Проверить анкету/ }).click();
      if (phase === "reveal") {
        await card(page, 7).locator(".identity-check-review").waitFor();
        await card(page, 7).getByRole("button", { name: "Раскрыть реквизиты", exact: true }).click();
      }
      await openCard(page, 8);
      release();
      await page.waitForResponse(response => response.url().endsWith(phase === "identity" ? "/identity" : "/identity/reveal"));
      // Flush pending fetch continuations without relying on animation timing.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator(".identity-check-review").count(), 0, "A delayed response cannot reinsert a closed review");
      assert.equal((await page.locator("body").innerText()).includes(full.registration_address), false);
      assert.equal(await card(page, 8).locator(".request-accordion").getAttribute("open") !== null, true);
      assert.deepEqual(errors, []); passed.push(`stale ${phase} response`); await page.close();
    }

    {
      const lease = { stage: "preparing", actor_id: 100, actor_name: "QA operator", expires_at: "2026-10-26T10:00:02Z", expired: false };
      const { page, errors } = await fixture(browser, { orders: [order(7, { status: "preparing", identity_status: "verified", operation_lease: lease, operation_lease_state: lease })] });
      await openCard(page, 7);
      const selected = card(page, 7);
      const replacement = selected.getByRole("button", { name: "Заменить экземпляры", exact: true });
      const ready = selected.getByRole("button", { name: /^Подтвердить готовность к выдаче/ });
      assert.equal(await replacement.isDisabled(), true);
      assert.equal(await ready.isDisabled(), true);
      assert.match(await selected.locator(".stage-lock").innerText(), /QA operator/);
      await page.clock.fastForward(3500);
      await waitUntil(async () => await replacement.isEnabled(), "The locally expired stage lock did not release its UI controls");
      assert.match(await selected.locator(".stage-lock").innerText(), /ист[её]к|истекла/i);
      assert.equal(await ready.isDisabled(), true, "Lock expiry must preserve unmet inspection prerequisites");
      assert.deepEqual(errors, []); passed.push("stage-lock expiry preserves workflow guard"); await page.close();
    }
    {
      const { page, errors, requests, orders } = await fixture(browser, { orders: [order(7)] });
      await openCard(page, 7);
      await card(page, 7).getByRole("button", {name:"Вернуть на доработку", exact:true}).click();
      const dialog = page.locator("#rework-dialog");
      assert.match(await dialog.innerText(), /Ожидает проверки/);
      await dialog.locator("textarea").fill("  Проверить данные  ");
      await dialog.getByRole("button", {name:"Вернуть на доработку"}).click();
      await waitUntil(() => orders[0].status === "pending", "Rework transition did not run");
      assert.equal(requests.filter(request => request.path.endsWith("/rework")).length, 1);
      assert.deepEqual(errors, []); passed.push("rework dialog and transition"); await page.close();
    }
    {
      const { page, errors, orders } = await fixture(browser, { orders: [order(7, {status:"ready", identity_status:"verified"})] });
      await openCard(page, 7);
      await card(page, 7).getByRole("button", {name:"Проверить анкету"}).click();
      assert.equal(await card(page, 7).getByRole("button", {name:"Отклонить / исправить"}).count(), 0);
      assert.equal(await card(page, 7).getByRole("button", {name:"Подписал: выдача"}).count(), 0);
      await card(page, 7).getByRole("button", {name:"Вернуть в подготовку"}).click();
      await page.locator("#rework-dialog textarea").fill("Исправить анкету");
      await page.locator("#rework-dialog").getByRole("button", {name:"Вернуть на доработку"}).click();
      await waitUntil(async () => orders[0].status === "preparing" && await card(page, 7).getByRole("button", {name:"Отклонить / исправить"}).count() === 1, "Review did not reopen after rework");
      assert.equal(await card(page, 7).getByRole("button", {name:"Отклонить / исправить"}).evaluate(el => el === document.activeElement), true);
      assert.deepEqual(errors, []); passed.push("ready identity rework and signer boundary"); await page.close();
    }
    {
      const { page, errors } = await fixture(browser, { orders: [order(7, { assignee_id: 200, starts_at: "2026-10-25T10:00:00Z", ends_at: "2026-10-26T09:00:00Z" })] });
      const selected = card(page, 7);
      assert.match(await selected.locator(".request-assignee").innerText(), /Ответственный: вы/);
      await openCard(page, 7);
      assert.match(await selected.locator(".request-summary").innerText(), /Ответственный/);
      assert.equal(await selected.locator(".rental-overdue").innerText(), "Просрочено");
      assert.equal(await selected.locator(".rental-progress").count(), 0);
      assert.deepEqual(errors, []); passed.push("assignee and overdue rental period"); await page.close();
    }
    {
      const tracked = order(7, { starts_at: "2026-10-26T09:00:00Z", ends_at: "2026-10-26T10:00:04Z" });
      const { page, errors } = await fixture(browser, { orders: [tracked] });
      await openCard(page, 7);
      assert.equal(await card(page, 7).locator(".rental-progress").count(), 1);
      await page.clock.runFor(5100);
      await waitUntil(async () => (await card(page, 7).locator(".rental-overdue").count()) === 1, "Rental overdue state did not refresh");
      assert.deepEqual(errors, []); passed.push("rental overdue refreshes request list"); await page.close();
    }
    for (const partialFailure of [false, true]) {
      const assets = [{ id: 11, name: "QA camera", serial: "QA-11" }, { id: 12, name: "QA camera", serial: null, asset_code: "QA-12" }];
      const { page, errors, requests } = await fixture(browser, { orders: [order(7, { status: "preparing", identity_status: "verified", assets })], inspectionFailEquipment: partialFailure ? 12 : undefined });
      await openCard(page, 7);
      const selected = card(page, 7);
      assert.match(await selected.locator('.inspection-row[data-equipment-id="12"]').innerText(), /QA-12/);
      assert.doesNotMatch(await selected.locator('.inspection-row[data-equipment-id="12"]').innerText(), /undefined|null/);
      assert.match(await selected.locator(".stage-lock").innerText(), /Ожидает сотрудника/);
      await selected.getByRole("button", { name: "Все исправны", exact: true }).click();
      await waitUntil(async () => (await selected.locator(".stage-lock").innerText()).includes("QA self"), "Bulk inspection did not refresh the lock holder");
      assert.match(await selected.locator(".stage-lock").innerText(), /Вы обрабатываете/);
      assert.match(await selected.locator(".inspection-progress").innerText(), partialFailure ? /Проверено 1 из 2/ : /Проверено 2 из 2/);
      assert.equal(await selected.getByRole("button", { name: /^Подтвердить готовность к выдаче/ }).isDisabled(), partialFailure);
      assert.equal(requests.filter(request => request.path.endsWith("/inspection")).length, 2);
      if (partialFailure) assert.match(await page.locator("#global-error").innerText(), /QA inspection conflict/);
      assert.deepEqual(errors, []); passed.push(`bulk inspection lock refresh${partialFailure ? " after partial failure" : ""}`); await page.close();
    }
    console.log(JSON.stringify({ engine: engineName, passed: passed.length, cases: passed }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
