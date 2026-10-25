(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  const authorized = Boolean(tg?.initData);
  const keyboardMode = !authorized && !preview && Boolean(tg?.sendData) && Boolean(tg?.platform) && tg.platform !== "unknown";
  const nativeButtons = (authorized || keyboardMode) && Boolean(tg?.MainButton);
  const draftKey = "polyrental-booking-draft-v1";
  const $ = (id) => document.getElementById(id);
  const sections = ["step-dates", "step-items", "step-contact", "step-review"];
  const state = { step: 0, view: "flow", items: [], quantities: new Map(), requestId: null, busy: false, booking: null, role: null, identityBookingId: null, consent: null, adminMode: "orders" };
  const exampleItems = [
    { id: 1, sku: "CAM-FX3", name: "Камера Sony FX3", description: "Компактная кинокамера для съёмок в движении", rate: "1200.00", available_quantity: 3 },
    { id: 2, sku: "LENS-2470", name: "Объектив 24–70 мм", description: "Универсальный светосильный объектив", rate: "500.00", available_quantity: 4 },
    { id: 3, sku: "TRI-MANF", name: "Штатив Manfrotto", description: "Устойчивая опора для камеры", rate: "250.00", available_quantity: 2 },
  ];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function money(cents) { return `${new Intl.NumberFormat("ru-RU").format(cents / 100)} ₽`; }
  function cents(rate) { const [whole, fraction = ""] = String(rate).split("."); return Number(whole) * 100 + Number((fraction + "00").slice(0, 2)); }
  function minutes() { return Math.round((new Date(toIso($("end").value)) - new Date(toIso($("start").value))) / 60000); }
  function totalCents() {
    const hourly = state.items.reduce((sum, item) => {
      const quantity = state.quantities.get(item.id) || 0;
      const dependencies = (item.billable_dependencies || []).reduce((total, dependency) => total + cents(dependency.rate) * dependency.quantity, 0);
      return sum + (cents(item.rate) + dependencies) * quantity;
    }, 0);
    return Math.round(hourly * minutes() / 60);
  }
  function toIso(value) { return value ? `${value}:00+03:00` : ""; }
  function dateText(value) { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

  function clearError() { $("global-error").hidden = true; $("global-error").textContent = ""; }
  function showError(message) { $("global-error").textContent = message; $("global-error").hidden = false; $("global-error").scrollIntoView({ block: "nearest" }); }
  function fieldError(id, message) {
    const input = $(id); const error = $(`${id === "customer-name" ? "name" : id === "customer-contact" ? "contact" : id}-error`);
    input.setAttribute("aria-invalid", String(Boolean(message)));
    error.textContent = message || ""; error.hidden = !message;
    if (message) input.focus();
  }
  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ start: $("start").value, end: $("end").value, quantities: [...state.quantities] })); } catch (_) { /* storage can be disabled */ }
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || "{}");
      if (typeof draft.start === "string") $("start").value = draft.start;
      if (typeof draft.end === "string") $("end").value = draft.end;
      if (Array.isArray(draft.quantities)) state.quantities = new Map(draft.quantities.filter((row) => Array.isArray(row) && Number.isInteger(row[0]) && Number.isInteger(row[1])));
      return Boolean(draft.start || draft.end || draft.quantities?.length);
    } catch (_) { /* start with an empty form */ }
    return false;
  }
  function clearDraft() { try { localStorage.removeItem(draftKey); } catch (_) { /* no persistent draft */ } }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "X-Telegram-Init-Data": tg?.initData || "", ...((options.body && !(options.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store",
    });
    let body;
    try { body = await response.json(); } catch (_) { throw new Error("Сервер вернул неожиданный ответ. Попробуйте ещё раз."); }
    if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Не удалось выполнить запрос. Попробуйте ещё раз.");
    return body;
  }

  function render() {
    const done = state.step === 4;
    $("booking-flow").hidden = state.view !== "flow";
    $("orders-panel").hidden = state.view !== "orders";
    $("identity-panel").hidden = state.view !== "identity";
    $("admin-panel").hidden = state.view !== "admin";
    $("tab-new").classList.toggle("active", state.view === "flow");
    $("tab-orders").classList.toggle("active", state.view === "orders");
    $("tab-admin").classList.toggle("active", state.view === "admin");
    $("tab-new").setAttribute("aria-current", state.view === "flow" ? "page" : "false");
    $("tab-orders").setAttribute("aria-current", state.view === "orders" ? "page" : "false");
    $("page-title").textContent = state.view === "admin" ? "Управление арендой" : state.view === "identity" ? "Документы для договора" : state.view === "orders" ? "Ваши заявки" : done ? "Заявка оформлена" : "Найдём всё для вашей съёмки";
    $("page-intro").textContent = state.view === "admin" ? "Комплектация, проверки, возврат, каталог и ремонт." : state.view === "identity" ? "Защищённая передача данных напрямую в PolyRental." : state.view === "orders" ? "Здесь можно следить за статусом и отменить активную заявку." : done ? "Менеджер получил запрос и скоро ответит." : "Выберите сроки и оборудование. На оформление уйдёт пара минут.";
    $("steps").hidden = done || state.view !== "flow";
    [...$("steps").children].forEach((element, index) => {
      element.classList.toggle("current", index === state.step);
      element.classList.toggle("complete", index < state.step);
      if (index === state.step) element.setAttribute("aria-current", "step"); else element.removeAttribute("aria-current");
    });
    sections.forEach((id, index) => { $(id).hidden = state.view !== "flow" || state.step !== index; });
    $("step-done").hidden = state.view !== "flow" || !done;
    const showAction = state.view === "flow" && !done;
    $("action-bar").hidden = !showAction || nativeButtons;
    $("back-button").hidden = state.step === 0;
    const labels = ["Показать оборудование", "Продолжить", "Проверить заказ", "Подтвердить бронирование"];
    $("main-button").textContent = state.busy ? "Подождите…" : labels[state.step] || "Продолжить";
    $("main-button").disabled = state.busy || (!authorized && !keyboardMode && !preview);
    if (nativeButtons) {
      tg.MainButton.setText(state.busy ? "Подождите…" : labels[state.step] || "Продолжить");
      if (showAction) tg.MainButton.show(); else tg.MainButton.hide();
      if (state.busy) tg.MainButton.disable(); else tg.MainButton.enable();
      if (state.step > 0 && !done && state.view === "flow") tg.BackButton?.show(); else tg.BackButton?.hide();
      if (state.busy) tg.MainButton.showProgress(); else tg.MainButton.hideProgress();
    }
    if (tg && (authorized || keyboardMode)) {
      if (done) tg.disableClosingConfirmation?.(); else tg.enableClosingConfirmation?.();
    }
  }

  function validateDates() {
    clearError(); fieldError("start", ""); fieldError("end", "");
    if (!$("start").value) { fieldError("start", "Выберите дату и время выдачи."); return false; }
    if (!$("end").value) { fieldError("end", "Выберите дату и время возврата."); return false; }
    if (Number.isNaN(new Date(toIso($("start").value)).getTime()) || new Date(toIso($("start").value)) < new Date(Date.now() - 60000)) { fieldError("start", "Начало аренды должно быть в будущем."); return false; }
    if (minutes() <= 0) { fieldError("end", "Возврат должен быть позже выдачи."); return false; }
    return true;
  }
  function validateContacts() {
    fieldError("customer-name", ""); fieldError("customer-contact", "");
    if (!$("customer-name").value.trim()) { fieldError("customer-name", "Укажите имя для заявки и документов."); return false; }
    if (!$("customer-contact").value.trim()) { fieldError("customer-contact", "Укажите телефон или Telegram для связи."); return false; }
    return true;
  }

  async function loadItems() {
    state.items = [];
    $("items-grid").replaceChildren();
    $("items-status").hidden = false; $("items-status").textContent = "Проверяем доступность оборудования…";
    $("retry-items").hidden = true;
    $("period-label").textContent = `${dateText(toIso($("start").value))} — ${dateText(toIso($("end").value))} · МСК`;
    try {
      const data = preview ? { items: exampleItems, unavailable_count: 0, unavailable: [] } : await api(`/api/miniapp/availability?start=${encodeURIComponent(toIso($("start").value))}&end=${encodeURIComponent(toIso($("end").value))}`);
      state.items = data.items;
      const availableIds = new Set(state.items.map((item) => item.id));
      state.quantities = new Map([...state.quantities].filter(([id, quantity]) => availableIds.has(id) && quantity <= state.items.find((item) => item.id === id).available_quantity));
      if (state.items.length) {
        $("items-status").textContent = data.unavailable_count ? `${data.unavailable_count} экз. занято или недоступно в выбранный период. Показаны свободные.` : "Все показанные экземпляры свободны на выбранный срок.";
      } else {
        $("items-status").textContent = "На эти даты свободного оборудования нет. Вернитесь и выберите другой период.";
      }
      $("unavailable-details").hidden = !data.unavailable?.length;
      $("unavailable-list").replaceChildren();
      for (const item of data.unavailable || []) {
        const line = document.createElement("p");
        line.textContent = `${item.name} · ${item.sku}: нет свободных единиц на выбранный период`;
        $("unavailable-list").append(line);
      }
      renderItems(); saveDraft(); return true;
    } catch (error) {
      $("items-status").textContent = `Не удалось загрузить оборудование: ${error.message}`;
      $("retry-items").hidden = false;
      showError(error.message);
      return false;
    }
  }
  function renderItems() {
    $("items-grid").replaceChildren();
    for (const item of state.items) {
      const quantity = state.quantities.get(item.id) || 0;
      const selected = quantity > 0;
      const card = document.createElement("article");
      card.className = `item-card${selected ? " selected" : ""}`;
      const safeImage = item.image_url && /^https:\/\//i.test(item.image_url) ? `<img class="item-photo" src="${escapeHtml(item.image_url)}" alt="" loading="lazy">` : "";
      card.innerHTML = `<span>${safeImage}<span class="item-top"><span><span class="item-name">${escapeHtml(item.name)}</span><span class="item-number">Артикул ${escapeHtml(item.sku)}</span><span class="available-badge">Свободно: ${item.available_quantity}</span>${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}</span></span></span><span class="item-bottom"><small>${money(cents(item.rate))} / час</small><strong>${money(Math.round(cents(item.rate) * minutes() / 60))}</strong></span><span class="quantity-control"><button type="button" class="button ghost quantity-minus" aria-label="Уменьшить количество">−</button><strong>${quantity}</strong><button type="button" class="button secondary quantity-plus" aria-label="Увеличить количество" ${quantity >= item.available_quantity ? "disabled" : ""}>+</button></span>`;
      card.querySelector(".quantity-minus").disabled = quantity === 0;
      card.querySelector(".quantity-minus").addEventListener("click", () => { if (quantity <= 1) state.quantities.delete(item.id); else state.quantities.set(item.id, quantity - 1); state.requestId = null; renderItems(); saveDraft(); });
      card.querySelector(".quantity-plus").addEventListener("click", () => { state.quantities.set(item.id, quantity + 1); state.requestId = null; renderItems(); saveDraft(); });
      $("items-grid").append(card);
    }
    $("selected-count").textContent = [...state.quantities.values()].reduce((sum, value) => sum + value, 0);
    $("selected-total").textContent = money(totalCents());
  }
  function reviewRow(label, value, extraClass = "") { return `<div class="review-row"><span>${label}</span><strong class="${extraClass}">${escapeHtml(value)}</strong></div>`; }
  function renderReview() {
    const chosen = state.items.filter((item) => (state.quantities.get(item.id) || 0) > 0);
    $("review-content").innerHTML = `<div class="review-group">${reviewRow("Выдача", dateText(toIso($("start").value)) + " МСК")}${reviewRow("Возврат", dateText(toIso($("end").value)) + " МСК")}</div><div class="review-group">${chosen.map((item) => { const dependencyTotal = (item.billable_dependencies || []).reduce((sum, dependency) => sum + cents(dependency.rate) * dependency.quantity, 0); return reviewRow(`${item.name} × ${state.quantities.get(item.id)}`, money(Math.round((cents(item.rate) + dependencyTotal) * state.quantities.get(item.id) * minutes() / 60))); }).join("")}</div><div class="review-group">${reviewRow("Имя", $("customer-name").value.trim())}${reviewRow("Связь", $("customer-contact").value.trim())}</div><div class="review-group">${reviewRow("Итого за период", money(totalCents()), "review-total")}</div>`;
  }

  async function next() {
    if (state.busy || state.view !== "flow") return;
    clearError();
    if (!authorized && !keyboardMode && !preview) return showError("Откройте приложение кнопкой в чате с ботом Telegram.");
    if (state.step === 0) {
      if (!validateDates()) return;
      saveDraft(); state.step = 1; render(); await loadItems();
    } else if (state.step === 1) {
      if (![...state.quantities.values()].some((quantity) => quantity > 0)) return showError("Выберите хотя бы одну единицу оборудования.");
      state.step = 2; render(); $("customer-name").focus();
    } else if (state.step === 2) {
      if (!validateContacts()) return;
      state.busy = true; render();
      const loaded = await loadItems();
      state.busy = false;
      if (!loaded) { render(); return; }
      if (![...state.quantities.values()].some((quantity) => quantity > 0)) { state.step = 1; render(); return showError("Выбранного количества уже нет. Измените заказ или сроки."); }
      state.step = 3; renderReview(); render();
    } else if (state.step === 3) {
      await submit();
    }
  }
  function back() {
    clearError();
    if (state.view === "orders") { state.view = "flow"; render(); return; }
    if (state.step > 0 && state.step < 4) { state.step--; render(); }
  }
  async function submit() {
    if (preview) return showError("Это демонстрация интерфейса. Отправка заявки доступна из Telegram.");
    if (!state.requestId) state.requestId = crypto.randomUUID();
    const payload = { request_id: state.requestId, start: toIso($("start").value), end: toIso($("end").value), lines: [...state.quantities].map(([article_id, quantity]) => ({ article_id, quantity })), name: $("customer-name").value.trim(), contact: $("customer-contact").value.trim(), expected_total: (totalCents() / 100).toFixed(2) };
    if (keyboardMode) {
      state.busy = true; render();
      try { tg.sendData(JSON.stringify(payload)); }
      catch (_) { state.busy = false; render(); showError("Не удалось передать заявку боту. Попробуйте ещё раз."); }
      return;
    }
    state.busy = true; render();
    try {
      const booking = await api("/api/miniapp/bookings", { method: "POST", body: JSON.stringify(payload) });
      state.booking = booking; state.step = 4; clearDraft();
      $("done-title").textContent = `Заявка №${booking.id} создана`;
      $("done-description").textContent = `Оборудование удерживается до ${dateText(booking.hold_expires_at)} МСК. Менеджер подтвердит заявку в Telegram.`;
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch (error) {
      const changed = error.message.includes("Цена изменилась") || error.message.includes("занято") || error.message.includes("недоступно");
      if (changed) { state.requestId = null; state.step = 1; await loadItems(); }
      showError(changed ? `${error.message} Выберите оборудование и проверьте заказ снова.` : error.message);
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally { state.busy = false; render(); }
  }

  const statusNames = { pending: "Ждёт менеджера", confirmed: "Подтверждена", preparing: "Комплектуется", ready: "Готова", issued: "В аренде", return_inspection: "Проверяется", returned: "Завершена", cancelled: "Отменена", expired: "Удержание истекло" };
  async function showOrders() {
    clearError(); state.view = "orders"; render();
    $("orders-content").textContent = "Загружаем заявки…";
    if (preview) { $("orders-content").textContent = "В демонстрации заявок нет. Откройте Mini App через Telegram, чтобы увидеть свои заявки."; return; }
    if (keyboardMode) { $("orders-content").textContent = "Вернитесь в чат с ботом и нажмите «Мои заявки». Там же можно узнать статус и связаться с менеджером."; return; }
    if (!authorized) { $("orders-content").textContent = "Откройте приложение через Telegram."; return; }
    try {
      const result = await api("/api/miniapp/bookings");
      $("orders-content").replaceChildren();
      if (!result.items.length) { $("orders-content").textContent = "Заявок пока нет. Начните с выбора сроков аренды."; return; }
      for (const order of result.items) {
        const card = document.createElement("article"); card.className = "order-card";
        card.innerHTML = `<div class="order-head"><strong>Заявка №${order.id}</strong><span class="status-pill">${escapeHtml(statusNames[order.status] || order.status)}</span></div><p>${escapeHtml(dateText(order.starts_at))} — ${escapeHtml(dateText(order.ends_at))} МСК</p><p>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(", ")}</p><p><strong>${escapeHtml(order.total)} ₽</strong>${order.status === "pending" ? ` · удержание до ${escapeHtml(dateText(order.hold_expires_at))} МСК` : ""}</p>`;
        if (["required", "needs_changes"].includes(order.identity_status)) {
          const identity = document.createElement("button"); identity.className = "button primary"; identity.type = "button";
          identity.textContent = order.identity_status === "needs_changes" ? "Исправить данные" : "Заполнить документы";
          identity.addEventListener("click", () => openIdentity(order.id)); card.append(identity);
        } else if (["submitted", "verified"].includes(order.identity_status)) {
          const note = document.createElement("p"); note.textContent = order.identity_status === "verified" ? "Документы проверены" : "Документы на проверке"; card.append(note);
        }
        if (["pending", "confirmed"].includes(order.status)) {
          const cancel = document.createElement("button"); cancel.className = "button ghost"; cancel.type = "button"; cancel.textContent = "Отменить заявку";
          cancel.addEventListener("click", async () => {
            if (!await confirmCancel(order.id)) return;
            cancel.disabled = true;
            try { await api(`/api/miniapp/bookings/${order.id}/cancel`, { method: "POST" }); await showOrders(); }
            catch (error) { showError(error.message); cancel.disabled = false; }
          });
          card.append(cancel);
        }
        $("orders-content").append(card);
      }
    } catch (error) { $("orders-content").textContent = "Не удалось загрузить заявки. Попробуйте открыть раздел ещё раз."; showError(error.message); }
  }

  async function openIdentity(bookingId) {
    clearError(); state.identityBookingId = bookingId; state.view = "identity"; render();
    $("identity-status").hidden = true; $("identity-form").hidden = true; $("consent-step").hidden = false;
    $("consent-check").checked = false; $("consent-text").textContent = "Загружаем текст согласия…";
    try {
      state.consent = await api("/api/miniapp/privacy-consent");
      $("consent-text").textContent = state.consent.text;
    } catch (error) { $("consent-text").textContent = "Форма временно недоступна."; showError(error.message); }
  }

  async function submitIdentity(event) {
    event.preventDefault(); clearError();
    const form = event.currentTarget; const button = $("identity-submit");
    const data = new FormData(form); const fields = {};
    for (const name of ["full_name", "birth_date", "passport_series", "passport_number", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution", "student_valid_until"]) fields[name] = String(data.get(name) || "").trim();
    const upload = new FormData(); upload.set("payload", JSON.stringify(fields)); upload.set("policy_version", state.consent.version); upload.set("text_hash", state.consent.text_hash);
    for (const name of ["passport_main", "passport_registration", "student_front", "student_back"]) upload.set(name, data.get(name));
    button.disabled = true; button.textContent = "Шифруем и отправляем…";
    try {
      await api(`/api/miniapp/bookings/${state.identityBookingId}/identity`, { method: "POST", body: upload });
      form.reset(); $("identity-form").hidden = true; $("identity-status").hidden = false;
      $("identity-status").textContent = "Данные отправлены. Менеджер сверит реквизиты с фотографиями.";
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; button.textContent = "Отправить на проверку"; }
  }

  function actionButton(label, action, bookingId, className = "secondary") {
    const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = label;
    button.addEventListener("click", async () => { button.disabled = true; try { await action(); await showAdmin(state.adminMode); } catch (error) { showError(error.message); button.disabled = false; } });
    return button;
  }

  async function showAdmin(mode = "orders") {
    clearError(); state.view = "admin"; state.adminMode = mode; render();
    document.querySelectorAll(".admin-mode").forEach((button) => { button.className = `button ${button.dataset.mode === mode ? "secondary" : "ghost"} admin-mode`; });
    const content = $("admin-content"); content.textContent = "Загружаем…";
    try {
      if (mode === "catalog") return renderAdminCatalog(await api("/api/miniapp/admin/catalog"));
      if (mode === "repairs") return renderRepairs(await api("/api/miniapp/admin/repairs"));
      const result = await api("/api/miniapp/admin/bookings"); content.replaceChildren();
      if (!result.items.length) { content.textContent = "Заказов пока нет."; return; }
      for (const order of result.items) {
        const card = document.createElement("article"); card.className = "admin-card";
        card.innerHTML = `<div class="order-head"><h3>Заказ №${order.id}</h3><span class="status-pill">${escapeHtml(statusNames[order.status] || order.status)}</span></div><p>${order.items.map((line) => `${escapeHtml(line.name)} × ${line.quantity}`).join(", ")}</p><p>Анкета: ${escapeHtml(order.identity_status)}</p>${order.assets.length ? `<ul class="asset-list">${order.assets.map((asset) => `<li>${escapeHtml(asset.location || "Без ячейки")} · ${escapeHtml(asset.name)} · № ${escapeHtml(asset.serial)}</li>`).join("")}</ul>` : ""}`;
        const actions = document.createElement("div"); actions.className = "action-row";
        const transitionAction = (next) => () => api(`/api/miniapp/admin/bookings/${order.id}/transition`, { method: "POST", body: JSON.stringify({ action: next }) });
        if (order.status === "pending") actions.append(actionButton("Подтвердить", transitionAction("confirmed"), order.id, "primary"));
        if (order.status === "confirmed") actions.append(actionButton("Начать подготовку", transitionAction("preparing"), order.id, "primary"));
        if (order.status === "preparing") {
          actions.append(actionButton("Заменить экземпляры", () => manualAssign(order), order.id, "ghost"));
          for (const asset of order.assets) {
            const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "button secondary"; inspect.textContent = `Проверить: ${asset.serial}`;
            inspect.addEventListener("click", () => openInspection(order, asset, "pre_issue")); actions.append(inspect);
          }
          actions.append(actionButton("Заказ готов", transitionAction("ready"), order.id, "primary"));
        }
        if (state.role?.pii_admin && ["submitted", "needs_changes", "verified"].includes(order.identity_status)) {
          actions.append(actionButton("Проверить анкету", () => reviewIdentity(order.id), order.id));
          for (const kind of ["passport_main", "passport_registration", "student_front", "student_back"]) {
            actions.append(actionButton(`Скачать ${kind}`, () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/identity/documents/${kind}`, `${kind}-${order.id}.jpg`), order.id, "ghost"));
          }
        }
        if (order.status === "ready" && state.role?.pii_admin) {
          actions.append(actionButton("Скачать акт", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/issue`, `act-${order.id}.docx`), order.id));
          actions.append(actionButton("Сохранная расписка", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/receipt`, `receipt-${order.id}.docx`), order.id));
          actions.append(actionButton("Акт подписан", () => api(`/api/miniapp/admin/bookings/${order.id}/act-signed`, { method: "POST" }), order.id));
          actions.append(actionButton("Выдать", transitionAction("issued"), order.id, "primary"));
        }
        if (order.status === "issued") actions.append(actionButton("Начать возврат", transitionAction("return_inspection"), order.id, "primary"));
        if (order.status === "return_inspection") {
          for (const asset of order.assets) {
            const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "button secondary"; inspect.textContent = `Проверить возврат: ${asset.serial}`;
            inspect.addEventListener("click", () => openInspection(order, asset, "check_in")); actions.append(inspect);
          }
          actions.append(actionButton("Завершить возврат", transitionAction("returned"), order.id, "primary"));
        }
        card.append(actions); content.append(card);
      }
    } catch (error) { content.textContent = "Не удалось загрузить раздел."; showError(error.message); }
  }

  async function reviewIdentity(bookingId) {
    const masked = await api(`/api/miniapp/admin/bookings/${bookingId}/identity`);
    if (!window.confirm(`Анкета: ${masked.full_name}\nПаспорт: ${masked.passport}\nСтуденческий: ${masked.student_id}\n\nРаскрыть полные реквизиты? Действие будет записано в журнал.`)) return;
    const full = await api(`/api/miniapp/admin/bookings/${bookingId}/identity/reveal`, { method: "POST" });
    const approved = window.confirm(`ФИО: ${full.full_name}\nДата рождения: ${full.birth_date}\nПаспорт: ${full.passport_series} ${full.passport_number}\nВыдан: ${full.passport_issued_at}, ${full.passport_issuer}\nКод: ${full.passport_division_code}\nРегистрация: ${full.registration_address}\nПроживание: ${full.residential_address}\nСтуденческий: ${full.student_id_number}, ${full.student_institution}, до ${full.student_valid_until}\n\nПодтвердить после сверки фотографий?`);
    const comment = approved ? "" : (window.prompt("Укажите безопасный комментарий без реквизитов:", "Нужно заменить нечёткую фотографию") || "Нужны исправления");
    return api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved, comment }) });
  }

  async function downloadSecure(path, filename) {
    const response = await fetch(path, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (!response.ok) { let detail = "Не удалось скачать документ"; try { detail = (await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
  }

  function renderAdminCatalog(result, editor = null) {
    const content = $("admin-content"); content.replaceChildren();
    const toolbar = document.createElement("div"); toolbar.className = "action-row";
    for (const [label, type, className] of [["Новый артикул", "article", "primary"], ["Новый экземпляр", "equipment", "secondary"], ["Зависимость комплекта", "dependency", "ghost"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = label;
      button.addEventListener("click", () => renderAdminCatalog(result, { type })); toolbar.append(button);
    }
    content.append(toolbar);
    if (editor) content.append(catalogEditor(result, editor));

    if (result.dependencies.length) {
      const dependencies = document.createElement("article"); dependencies.className = "admin-card";
      dependencies.innerHTML = `<h3>Состав комплектов</h3><div class="dependency-list"></div>`;
      const list = dependencies.querySelector(".dependency-list");
      for (const item of result.dependencies) {
        const parent = result.articles.find((article) => article.id === item.parent_article_id);
        const child = result.articles.find((article) => article.id === item.child_article_id);
        const row = document.createElement("div"); row.className = "dependency-row";
        row.innerHTML = `<span><strong>${escapeHtml(parent?.name || item.parent_article_id)}</strong> → ${escapeHtml(child?.name || item.child_article_id)} × ${item.quantity} · ${item.billable ? "оплачивается отдельно" : "включено в цену"}</span>`;
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost compact danger"; remove.textContent = "Удалить";
        remove.addEventListener("click", async () => { try { await api(`/api/miniapp/admin/catalog/dependencies/${item.parent_article_id}/${item.child_article_id}`, { method: "DELETE" }); await showAdmin("catalog"); } catch (error) { showError(error.message); } });
        row.append(remove); list.append(row);
      }
      content.append(dependencies);
    }

    for (const article of result.articles) {
      const card = document.createElement("article"); card.className = `admin-card${article.active ? "" : " inactive"}`;
      card.innerHTML = `<div class="order-head"><h3>${escapeHtml(article.name)}</h3><span class="status-pill">${article.active ? "В каталоге" : "Скрыт"}</span></div><p>${escapeHtml(article.sku)} · ${escapeHtml(article.rate)} ₽/ч · буфер ${article.buffer_hours} ч · профиль ${escapeHtml(article.inspection_profile)}</p><p>${escapeHtml(article.description || "Без описания")}</p><div class="equipment-list"></div>`;
      const cardActions = document.createElement("div"); cardActions.className = "action-row";
      const editArticle = document.createElement("button"); editArticle.type = "button"; editArticle.className = "button ghost compact"; editArticle.textContent = "Изменить артикул";
      editArticle.addEventListener("click", () => renderAdminCatalog(result, { type: "article", value: article }));
      const addAsset = document.createElement("button"); addAsset.type = "button"; addAsset.className = "button secondary compact"; addAsset.textContent = "Добавить экземпляр";
      addAsset.addEventListener("click", () => renderAdminCatalog(result, { type: "equipment", value: { article_id: article.id, condition: "available" } }));
      cardActions.append(editArticle, addAsset); card.append(cardActions);
      const equipmentList = card.querySelector(".equipment-list");
      if (!article.equipment.length) equipmentList.textContent = "Экземпляров пока нет.";
      for (const asset of article.equipment) {
        const row = document.createElement("div"); row.className = "equipment-row";
        const battery = asset.health != null || asset.charge != null ? ` · здоровье ${asset.health ?? "—"}% · заряд ${asset.charge ?? "—"}%` : "";
        row.innerHTML = `<span><strong>№ ${escapeHtml(asset.serial)}</strong><small>${escapeHtml(asset.location || "Без ячейки")} · ${escapeHtml(asset.condition)}${battery}</small></span>`;
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "button ghost compact"; edit.textContent = "Изменить";
        edit.addEventListener("click", () => renderAdminCatalog(result, { type: "equipment", value: { ...asset, article_id: article.id } }));
        row.append(edit); equipmentList.append(row);
      }
      content.append(card);
    }
  }

  function catalogEditor(result, editor) {
    const wrapper = document.createElement("article"); wrapper.className = "admin-card editor-card";
    const value = editor.value || {}; const options = result.articles.map((article) => `<option value="${article.id}" ${Number(value.article_id) === article.id ? "selected" : ""}>${escapeHtml(article.sku)} · ${escapeHtml(article.name)}</option>`).join("");
    if (editor.type === "article") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить артикул" : "Новый артикул"}</h3><form class="catalog-form form-grid"><label class="field"><span>SKU / артикул</span><input name="sku" value="${escapeHtml(value.sku || "")}" maxlength="80" required></label><label class="field"><span>Название модели</span><input name="name" value="${escapeHtml(value.name || "")}" maxlength="200" required></label><label class="field wide"><span>Описание</span><textarea name="description" maxlength="4000">${escapeHtml(value.description || "")}</textarea></label><label class="field"><span>Ставка, ₽/час</span><input name="rate" type="number" min="0" step="0.01" value="${escapeHtml(value.rate ?? "0")}" required></label><label class="field"><span>Буфер после возврата, часов</span><input name="buffer_hours" type="number" min="0" max="168" value="${value.buffer_hours ?? 24}" required></label><label class="field"><span>Категория</span><select name="category">${selectOptions(["generic", "camera", "optics", "light", "battery", "accessory"], value.category || "generic")}</select></label><label class="field"><span>Профиль проверки</span><select name="inspection_profile">${selectOptions(["generic", "camera", "optics", "light", "battery"], value.inspection_profile || "generic")}</select></label><label class="field wide"><span>HTTPS-ссылка на фото</span><input name="image_url" type="url" value="${escapeHtml(value.image_url || "")}" maxlength="500" placeholder="https://…"></label><label class="check-row wide"><input name="active" type="checkbox" ${value.active !== false ? "checked" : ""}><span>Показывать клиентам в каталоге</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить артикул</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else if (editor.type === "equipment") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить экземпляр" : "Новый экземпляр"}</h3><form class="catalog-form form-grid"><label class="field wide"><span>Артикул</span><select name="article_id" required><option value="">Выберите артикул</option>${options}</select></label><label class="field"><span>Серийный номер</span><input name="serial" value="${escapeHtml(value.serial || "")}" maxlength="80" required></label><label class="field"><span>Складская ячейка</span><input name="location" value="${escapeHtml(value.location || "")}" maxlength="120" placeholder="A-01"></label><label class="field"><span>Состояние</span><select name="condition">${selectOptions(["available", "maintenance", "retired"], value.condition || "available")}</select></label><label class="field"><span>Здоровье аккумулятора, %</span><input name="health" type="number" min="0" max="100" value="${value.health ?? ""}" placeholder="Только для аккумулятора"></label><label class="field"><span>Заряд аккумулятора, %</span><input name="charge" type="number" min="0" max="100" value="${value.charge ?? ""}" placeholder="Только для аккумулятора"></label><div class="info-strip wide"><span class="info-icon">i</span><p>Серийный номер видят только сотрудники. Клиент получает его в подписываемом акте.</p></div><div class="action-row wide"><button class="button primary" type="submit">Сохранить экземпляр</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else {
      wrapper.innerHTML = `<h3>Зависимость комплекта</h3><form class="catalog-form form-grid"><label class="field"><span>Основной артикул</span><select name="parent_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Добавляемый артикул</span><select name="child_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Количество на единицу</span><input name="quantity" type="number" min="1" max="30" value="1" required></label><label class="check-row"><input name="billable" type="checkbox"><span>Оплачивается отдельно</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить зависимость</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    }
    wrapper.querySelector(".editor-cancel").addEventListener("click", () => renderAdminCatalog(result));
    wrapper.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        if (editor.type === "article") await api("/api/miniapp/admin/catalog/articles", { method: "POST", body: JSON.stringify({ id: value.id || null, sku: data.get("sku"), name: data.get("name"), description: data.get("description"), rate: data.get("rate"), buffer_hours: Number(data.get("buffer_hours")), category: data.get("category"), inspection_profile: data.get("inspection_profile"), image_url: data.get("image_url"), active: data.get("active") === "on" }) });
        else if (editor.type === "equipment") await api("/api/miniapp/admin/catalog/equipment", { method: "POST", body: JSON.stringify({ id: value.id || null, article_id: Number(data.get("article_id")), serial: data.get("serial"), location: data.get("location"), condition: data.get("condition"), health: data.get("health") === "" ? null : Number(data.get("health")), charge: data.get("charge") === "" ? null : Number(data.get("charge")) }) });
        else await api("/api/miniapp/admin/catalog/dependencies", { method: "PUT", body: JSON.stringify({ parent_article_id: Number(data.get("parent_article_id")), child_article_id: Number(data.get("child_article_id")), quantity: Number(data.get("quantity")), billable: data.get("billable") === "on" }) });
        await showAdmin("catalog");
      } catch (error) { showError(error.message); submit.disabled = false; }
    });
    return wrapper;
  }

  function selectOptions(values, selected) {
    const labels = { generic: "Общий", camera: "Камера", optics: "Оптика", light: "Свет", battery: "Аккумулятор", accessory: "Аксессуар", available: "На складе / доступен", maintenance: "В ремонте", retired: "Списан" };
    return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${labels[value] || value}</option>`).join("");
  }

  async function manualAssign(order) {
    const catalog = await api("/api/miniapp/admin/catalog"); const assignments = {};
    for (const line of order.lines) {
      const article = catalog.articles.find((item) => item.id === line.article_id);
      const choices = (article?.equipment || []).map((item) => `${item.id}: ${item.serial} (${item.location || "без ячейки"}, ${item.condition})`).join("\n");
      const raw = window.prompt(`${line.name}: укажите ${line.quantity} ID через запятую\n${choices}`);
      if (raw === null) throw new Error("Замена отменена");
      assignments[String(line.id)] = raw.split(",").map((value) => Number(value.trim())).filter(Boolean);
    }
    return api(`/api/miniapp/admin/bookings/${order.id}/assignments`, { method: "PUT", body: JSON.stringify({ assignments }) });
  }

  function inspectionChecklist(profile) {
    const fields = { generic: ["visual", "functional"], camera: ["sensor", "connectors", "recording"], optics: ["glass", "back_focus", "mechanics"], light: ["power", "color", "controls"], battery: ["visual", "health", "charge"] }[profile] || ["visual", "functional"];
    return Object.fromEntries(fields.map((field) => [field, true]));
  }

  function openInspection(order, asset, stage) {
    const content = $("admin-content");
    const card = document.createElement("article"); card.className = "admin-card inspection-editor";
    const fields = { generic: ["visual", "functional"], camera: ["sensor", "connectors", "recording"], optics: ["glass", "back_focus", "mechanics"], light: ["power", "color", "controls"], battery: ["visual", "health", "charge"] }[asset.inspection_profile] || ["visual", "functional"];
    const labels = { visual: "Внешний осмотр", functional: "Функциональная проверка", sensor: "Сенсор и битые пиксели", connectors: "Разъёмы и сигнал", recording: "Запись и носитель", glass: "Чистота линз", back_focus: "Бэк-фокус", mechanics: "Механика", power: "Питание", color: "Цветовая температура", controls: "Органы управления", health: "Здоровье аккумулятора", charge: "Заряд аккумулятора" };
    card.innerHTML = `<div class="order-head"><div><h3>${stage === "pre_issue" ? "Предвыдачная проверка" : "Проверка возврата"}</h3><p>${escapeHtml(asset.name)} · серийный № ${escapeHtml(asset.serial)}</p></div><button type="button" class="button ghost compact inspection-close">Закрыть</button></div><form class="inspection-form"><div class="form-grid"><label class="field"><span>Результат</span><select name="result"><option value="pass">Исправен</option><option value="fail">В ремонт</option></select></label><label class="field wide"><span>Заметки без персональных данных</span><textarea name="notes" maxlength="2000" placeholder="Что проверено и что обнаружено"></textarea></label>${fields.map((field) => `<label class="check-row"><input type="checkbox" name="check_${field}"><span>${labels[field] || field}</span></label>`).join("")}<label class="field"><span>Оценка ущерба, ₽</span><input name="estimated_cost" type="number" min="0" step="0.01" value="0"></label><label class="check-row"><input name="charge_customer" type="checkbox"><span>Выставить счёт за порчу</span></label><label class="field wide"><span>Дефект для ремонтного тикета</span><textarea name="defect" maxlength="4000" placeholder="Заполняется при результате «В ремонт»"></textarea></label></div><div class="action-row"><button class="button primary" type="submit">Сохранить результат</button></div></form>`;
    content.prepend(card); card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.querySelector(".inspection-close").addEventListener("click", () => card.remove());
    card.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = data.get("result");
      const checklist = Object.fromEntries(fields.map((field) => [field, data.get(`check_${field}`) === "on"]));
      if (result === "pass" && !fields.every((field) => checklist[field])) return showError("Отметьте каждый пункт проверки перед сохранением.");
      if (result === "fail" && !String(data.get("defect") || "").trim()) return showError("Опишите дефект для ремонтного тикета.");
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try { await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method: "POST", body: JSON.stringify({ equipment_id: asset.id, stage, result, checklist, notes: data.get("notes") || "", defect: data.get("defect") || "", estimated_cost: data.get("estimated_cost") || 0, charge_customer: data.get("charge_customer") === "on" }) }); await showAdmin("orders"); }
      catch (error) { showError(error.message); submit.disabled = false; }
    });
  }

  function renderRepairs(result) {
    const content = $("admin-content"); content.replaceChildren();
    if (!result.items.length) { content.textContent = "Открытых и завершённых ремонтов нет."; return; }
    for (const ticket of result.items) {
      const card = document.createElement("article"); card.className = "admin-card";
      card.innerHTML = `<h3>Ремонт №${ticket.id}</h3><p>Серийный № ${escapeHtml(ticket.serial)} · ${escapeHtml(ticket.status)}</p><p>${escapeHtml(ticket.defect)}</p>`;
      if (ticket.status !== "closed") card.append(actionButton("Закрыть ремонт", () => api(`/api/miniapp/admin/repairs/${ticket.id}/close`, { method: "POST" }), ticket.id, "primary"));
      content.append(card);
    }
  }
  function confirmCancel(id) {
    if (tg?.showPopup && authorized) {
      return new Promise((resolve) => tg.showPopup({ title: "Отменить заявку?", message: `Заявка №${id} будет отменена, оборудование снова станет доступным.`, buttons: [{ id: "cancel-order", type: "destructive", text: "Отменить заявку" }, { id: "keep-order", type: "cancel", text: "Оставить" }] }, (answer) => resolve(answer === "cancel-order")));
    }
    return Promise.resolve(window.confirm(`Отменить заявку №${id}?`));
  }

  $("main-button").addEventListener("click", next);
  $("retry-items").addEventListener("click", loadItems);
  $("back-button").addEventListener("click", back);
  $("tab-new").addEventListener("click", () => {
    clearError(); state.view = "flow";
    if (state.step === 4) { state.step = 0; state.quantities.clear(); state.items = []; state.requestId = null; $("start").value = ""; $("end").value = ""; $("customer-name").value = ""; $("customer-contact").value = ""; }
    render();
  });
  $("tab-orders").addEventListener("click", showOrders);
  $("tab-admin").addEventListener("click", () => showAdmin(state.adminMode));
  $("identity-close").addEventListener("click", showOrders);
  $("consent-next").addEventListener("click", () => {
    if (!state.consent) return showError("Текст согласия не загружен.");
    if (!$("consent-check").checked) return showError("Чтобы продолжить, подтвердите согласие.");
    clearError(); $("consent-step").hidden = true; $("identity-form").hidden = false;
  });
  $("identity-form").addEventListener("submit", submitIdentity);
  document.querySelectorAll(".admin-mode").forEach((button) => button.addEventListener("click", () => showAdmin(button.dataset.mode)));
  $("done-orders").addEventListener("click", showOrders);
  $("done-chat").addEventListener("click", () => tg?.close?.());
  for (const id of ["start", "end"]) $(id).addEventListener("change", () => { state.items = []; state.quantities.clear(); state.requestId = null; fieldError(id, ""); saveDraft(); });
  for (const id of ["customer-name", "customer-contact"]) $(id).addEventListener("input", () => { state.requestId = null; fieldError(id, ""); });

  const hasDraft = restoreDraft();
  const profile = tg?.initDataUnsafe?.user;
  if (authorized && profile && !$("customer-name").value) {
    $("customer-name").value = [profile.first_name, profile.last_name].filter(Boolean).join(" ").slice(0, 200);
    if ($("customer-name").value) $("step-contact").querySelector(".supporting").textContent = "Имя взято из профиля Telegram — его можно исправить. Менеджер использует контакт только для согласования аренды и документов.";
  }
  if (preview) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Демонстрация интерфейса: можно пройти шаги, но заявка не отправляется."; }
  else if (!authorized && !keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Чтобы оформить бронь, откройте Mini App через кнопку в Telegram-боте."; }
  else if (keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "После отправки приложение закроется, а бот пришлёт номер заявки и статус."; }
  else if (hasDraft) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Мы восстановили сроки и выбранное оборудование из черновика на этом устройстве."; }
  if (nativeButtons) { tg.MainButton.onClick(next); tg.BackButton?.onClick(back); tg.expand?.(); }
  if (authorized) api("/api/miniapp/me").then((role) => { state.role = role; $("tab-admin").hidden = !role.admin; }).catch(() => {});
  tg?.onEvent?.("activated", () => { if (state.view === "orders") showOrders(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "orders") showOrders(); });
  tg?.ready?.();
  render();
})();
