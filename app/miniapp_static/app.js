(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  const authorized = Boolean(tg?.initData);
  const keyboardMode = !authorized && !preview && Boolean(tg?.sendData) && Boolean(tg?.platform) && tg.platform !== "unknown";
  const nativeButtons = (authorized || keyboardMode) && Boolean(tg?.MainButton);
  const draftKey = "polyrental-booking-draft-v1";
  const contactKey = `polyrental-booking-contact-v1:${tg?.initDataUnsafe?.user?.id || "local"}`;
  const $ = (id) => document.getElementById(id);
  const sections = ["step-dates", "step-items", "step-contact", "step-review"];
  const state = { step: 0, view: "flow", items: [], quantities: new Map(), requestId: null, busy: false, booking: null, role: null, identityBookingId: null, identityNeedsChanges: false, identityRequiredPhotos: [], identityReusableDocuments: [], identityLegacyInstitution: null, universities: [], consent: null, adminMode: "orders" };
  let addressSuggestTimer = null;
  let addressSuggestController = null;
  let addressSuggestSequence = 0;
  let contactEdited = false;
  const identityPhotoDrafts = new Map();
  const photoDraftLifetime = 24 * 60 * 60 * 1000;
  const exampleItems = [
    { id: 1, sku: "CAM-FX3", name: "Камера Sony FX3", description: "Компактная кинокамера для съёмок в движении", available_quantity: 3 },
    { id: 2, sku: "LENS-2470", name: "Объектив 24–70 мм", description: "Универсальный светосильный объектив", available_quantity: 4 },
    { id: 3, sku: "TRI-MANF", name: "Штатив Manfrotto", description: "Устойчивая опора для камеры", available_quantity: 2 },
  ];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function minutes() { return Math.round((new Date(toIso($("end").value)) - new Date(toIso($("start").value))) / 60000); }
  function toIso(value) {
    const text = String(value || "").trim();
    let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+03:00`;
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return match ? `${text}:00+03:00` : "";
  }
  function pickerText(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : "";
  }
  function syncDateTime(id) {
    const date = $(`${id}-date`).value; const time = $(`${id}-time`).value;
    $(id).value = date && time ? `${date}T${time}` : "";
  }
  function syncDateFields(id) {
    const match = String($(id).value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (match) { $(`${id}-date`).value = match[1]; $(`${id}-time`).value = match[2]; }
    else { $(`${id}-date`).value = ""; $(`${id}-time`).value = ""; }
  }
  function moscowDateIso(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function addIsoDays(value, days) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  function applyDuration(days) {
    if (!Number.isInteger(days) || days < 1 || days > 365) { fieldError("end", "Укажите срок от 1 до 365 суток."); return; }
    if (!$("start-date").value || !$("start-time").value) { fieldError("start", "Сначала выберите дату и время выдачи."); return; }
    $("end-date").value = addIsoDays($("start-date").value, days);
    $("end-time").value = $("start-time").value;
    syncDateTime("end"); applyBookingDateLimits();
    state.items = []; state.quantities.clear(); state.requestId = null;
    fieldError("start", ""); fieldError("end", ""); saveDraft();
  }
  function bookingDateLabel(value) {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })
      .format(new Date(`${value}T12:00:00Z`));
  }
  function minimumBookingDate() { return addIsoDays(moscowDateIso(), 4); }
  function applyBookingDateLimits() {
    const min = minimumBookingDate();
    $("start-date").min = min;
    $("end-date").min = $("start-date").value >= min ? $("start-date").value : min;
    $("start-hint").textContent = `Доступно с ${bookingDateLabel(min)}; даты ближайших трёх дней закрыты.`;
    $("end-hint").textContent = `Возврат — позже выдачи, не раньше ${bookingDateLabel($("end-date").min)}.`;
  }
  function dateText(value) { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  function reviewDateTime(value) { return `${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))} МСК`; }

  function clearError() { $("global-error").hidden = true; $("global-error").textContent = ""; }
  function showError(message) { $("global-error").textContent = message; $("global-error").hidden = false; $("global-error").scrollIntoView({ block: "nearest" }); }
  function showIdentityFieldError(name, message) {
    const input = document.querySelector(`#identity-form [name="${name}"]`);
    const field = input?.closest(".field");
    if (!input || !field) { showError(message); return; }
    let error = field.querySelector(".identity-field-error");
    if (!error) { error = document.createElement("small"); error.className = "field-error identity-field-error"; error.setAttribute("role", "alert"); field.append(error); }
    error.textContent = message; input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id || (error.id = `identity-error-${name}`));
    field.scrollIntoView({ behavior: "smooth", block: "center" }); input.focus({ preventScroll: true });
  }
  function clearIdentityFieldError(input) {
    input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby");
    const error = input.closest(".field")?.querySelector(".identity-field-error"); if (error) error.remove();
  }
  function showIdentityError(error) {
    if (error?.field) { showIdentityFieldError(error.field, error.message); return; }
    showError(error?.message || "Не удалось сохранить анкету. Проверьте введённые данные и попробуйте ещё раз.");
  }
  function fieldError(id, message) {
    const input = $(id); const focusTarget = $(`${id}-date`) || input; const error = $(`${id === "customer-name" ? "name" : id === "customer-contact" ? "contact" : id}-error`);
    focusTarget.setAttribute("aria-invalid", String(Boolean(message)));
    error.textContent = message || ""; error.hidden = !message;
    if (message) focusTarget.focus();
  }
  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ start: $("start").value, end: $("end").value, quantities: [...state.quantities] })); } catch (_) { /* storage can be disabled */ }
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || "{}");
      if (typeof draft.start === "string") $("start").value = draft.start;
      if (typeof draft.end === "string") $("end").value = draft.end;
      if (Array.isArray(draft.quantities)) state.quantities = new Map(draft.quantities.filter((row) => Array.isArray(row) && Number.isInteger(row[0]) && row[0] > 0 && Number.isInteger(row[1]) && row[1] > 0 && row[1] <= 30));
      return Boolean(draft.start || draft.end || draft.quantities?.length);
    } catch (_) { /* start with an empty form */ }
    return false;
  }
  function clearDraft() { try { localStorage.removeItem(draftKey); } catch (_) { /* no persistent draft */ } }
  function saveContact() {
    try {
      localStorage.setItem(contactKey, JSON.stringify({ name: $("customer-name").value.trim(), contact: $("customer-contact").value.trim() }));
    } catch (_) { /* storage can be disabled */ }
  }
  function restoreContact() {
    try {
      const saved = JSON.parse(localStorage.getItem(contactKey) || "null");
      if (!saved || typeof saved.name !== "string" || typeof saved.contact !== "string") return false;
      $("customer-name").value = saved.name.slice(0, 200);
      $("customer-contact").value = saved.contact.slice(0, 200);
      return Boolean(saved.name || saved.contact);
    } catch (_) { return false; }
  }
  async function restoreLastBookingContact(hasSavedContact) {
    if (!authorized || hasSavedContact) return;
    try {
      const result = await api("/api/miniapp/bookings");
      const recent = result.items?.[0];
      if (!recent || contactEdited) return;
      if (recent.customer_name) $("customer-name").value = recent.customer_name;
      if (recent.customer_contact) $("customer-contact").value = recent.customer_contact;
      saveContact();
    } catch (_) { /* Telegram profile remains available as a fallback */ }
  }

  function openPhotoDraftDb() {
    if (!window.indexedDB) return Promise.reject(new Error("Хранилище временных фото недоступно"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("polyrental-private-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("photos");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function photoDraftTransaction(mode, action) {
    const db = await openPhotoDraftDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("photos", mode); const result = action(transaction.objectStore("photos"));
      transaction.oncomplete = () => { db.close(); resolve(result?.result); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  }
  function identityPhotoKey(kind) {
    const userId = tg?.initDataUnsafe?.user?.id || "user";
    return `${userId}:${state.identityBookingId}:${kind}`;
  }
  async function saveIdentityPhoto(kind, file) {
    const key = identityPhotoKey(kind);
    if (!file) { identityPhotoDrafts.delete(key); try { await photoDraftTransaction("readwrite", (store) => store.delete(key)); } catch (_) {} return; }
    const entry = { blob: file, name: file.name || "document", type: file.type || "application/octet-stream", savedAt: Date.now() };
    identityPhotoDrafts.set(key, entry);
    try { await photoDraftTransaction("readwrite", (store) => store.put(entry, key)); }
    catch (_) { /* current form still keeps the selected file */ }
  }
  async function restoreIdentityPhotos(savedDocuments = []) {
    const inputs = [...document.querySelectorAll('#identity-form input[type="file"]')];
    for (const input of inputs) {
      const key = identityPhotoKey(input.name); let entry = identityPhotoDrafts.get(key);
      if (!entry) {
        try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; }
      }
      if (entry && Date.now() - entry.savedAt <= photoDraftLifetime) identityPhotoDrafts.set(key, entry);
      else { identityPhotoDrafts.delete(key); entry = null; try { await photoDraftTransaction("readwrite", (store) => store.delete(key)); } catch (_) {} }
      const status = input.closest(".field")?.querySelector(".file-draft-status");
      if (status) status.textContent = entry ? `Черновик сохранён на этом устройстве: ${entry.name}`
        : savedDocuments.includes(input.name) ? "Фото уже сохранено в заявке — повторно загружать не нужно."
        : "";
    }
  }
  async function restoreReusableIdentityPhotos() {
    for (const kind of state.identityReusableDocuments) {
      const key = identityPhotoKey(kind);
      let entry = identityPhotoDrafts.get(key);
      if (!entry) {
        try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; }
      }
      if (entry && Date.now() - entry.savedAt <= photoDraftLifetime) {
        identityPhotoDrafts.set(key, entry);
        continue;
      }
      const input = document.querySelector(`#identity-form [name="${kind}"]`);
      const status = input?.closest(".field")?.querySelector(".file-draft-status");
      try {
        const response = await fetch(`/api/miniapp/bookings/${state.identityBookingId}/identity/reusable-profile/documents/${kind}`, {
          headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store",
        });
        if (!response.ok) throw new Error("download failed");
        const blob = await response.blob();
        await saveIdentityPhoto(kind, new File([blob], `previous-${kind}.jpg`, { type: blob.type || "image/jpeg" }));
        if (status) status.textContent = "Фото из предыдущей анкеты прикреплено. Новое фото заменит его.";
      } catch (_) {
        if (status) status.textContent = "Не удалось перенести фото автоматически. Прикрепите его вручную.";
      }
    }
  }
  async function clearIdentityPhotoDrafts(bookingId) {
    const userId = tg?.initDataUnsafe?.user?.id || "user";
    for (const kind of ["passport_main", "passport_registration", "student_front"]) {
      const key = `${userId}:${bookingId}:${kind}`; identityPhotoDrafts.delete(key);
      try { await photoDraftTransaction("readwrite", (store) => store.delete(key)); } catch (_) {}
    }
  }
  async function pruneExpiredIdentityPhotos() {
    try {
      const db = await openPhotoDraftDb();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("photos", "readwrite"); const cursor = transaction.objectStore("photos").openCursor();
        cursor.onsuccess = () => { const current = cursor.result; if (!current) return; if (!current.value?.savedAt || Date.now() - current.value.savedAt > photoDraftLifetime) current.delete(); current.continue(); };
        transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    } catch (_) { /* the form remains usable if local storage is unavailable */ }
  }

  function newRequestId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // Telegram's test server permits HTTP on LAN addresses, where randomUUID
    // is unavailable. getRandomValues also works outside secure contexts.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "X-Telegram-Init-Data": tg?.initData || "", ...((options.body && !(options.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store",
    });
    let body;
    try { body = await response.json(); } catch (_) { throw new Error("Сервер вернул неожиданный ответ. Попробуйте ещё раз."); }
    if (!response.ok) {
      const detail = typeof body.detail === "string" ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((item) => item.msg || item.message || "").filter(Boolean).join("; ")
        : "";
      const structured = body.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail : null;
      const error = new Error(structured?.message || detail || "Не удалось выполнить запрос. Попробуйте ещё раз.");
      const formFields = new Set(["full_name", "birth_date", "passport_combined", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution", "passport_main", "passport_registration", "student_front"]);
      const invalidField = Array.isArray(body.detail) ? body.detail.map((item) => item.loc?.at(-1)).find((field) => formFields.has(field)) : null;
      if (typeof structured?.field === "string") error.field = structured.field;
      else if (invalidField) error.field = invalidField;
      throw error;
    }
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
      const button = element.querySelector(".step-button");
      button.disabled = state.busy || index >= state.step;
      if (index === state.step) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
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
      if (state.busy) tg.MainButton.showProgress?.(); else tg.MainButton.hideProgress?.();
    }
    if (tg && (authorized || keyboardMode)) {
      if (done) tg.disableClosingConfirmation?.(); else tg.enableClosingConfirmation?.();
    }
  }

  function validateDates() {
    clearError(); fieldError("start", ""); fieldError("end", "");
    if (!$("start").value) { fieldError("start", "Выберите дату и время выдачи."); return false; }
    if (!$("end").value) { fieldError("end", "Выберите дату и время возврата."); return false; }
    const startIso = toIso($("start").value); const endIso = toIso($("end").value);
    if (!startIso) { fieldError("start", "Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ."); return false; }
    if (!endIso) { fieldError("end", "Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ."); return false; }
    const minDate = minimumBookingDate();
    if ($("start-date").value < minDate) { fieldError("start", `Выберите дату выдачи не раньше ${bookingDateLabel(minDate)}.`); return false; }
    if ($("end-date").value < minDate) { fieldError("end", `Выберите дату возврата не раньше ${bookingDateLabel(minDate)}.`); return false; }
    if (new Date(startIso) < new Date(Date.now() - 60000)) { fieldError("start", "Начало аренды должно быть в будущем."); return false; }
    if (minutes() <= 0) { fieldError("end", "Возврат должен быть позже выдачи."); return false; }
    return true;
  }
  function validateContacts() {
    fieldError("customer-name", ""); fieldError("customer-contact", "");
    if (!$("customer-name").value.trim()) { fieldError("customer-name", "Укажите имя для заявки и документов."); return false; }
    const contact = $("customer-contact").value.trim();
    const digits = (contact.match(/[0-9]/g) || []).length;
    const phone = /^\+?[0-9](?:[0-9 ()-]*[0-9])?$/.test(contact) && digits >= 10 && digits <= 15;
    const username = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact);
    if (!phone && !username) { fieldError("customer-contact", "Укажите телефон (10–15 цифр) или Telegram username (5–32 символа: латиница, цифры, _)."); return false; }
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
        $("items-status").textContent = data.unavailable_count ? `${data.unavailable_count} позиций недоступно в выбранный период. Показаны свободные.` : "Все показанные экземпляры свободны на выбранный срок.";
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
      const safeImage = item.image_url && /^https:\/\//i.test(item.image_url) ? `<img class="item-photo" src="${escapeHtml(item.image_url)}" alt="Фото: ${escapeHtml(item.name)}" loading="lazy">` : "";
      card.innerHTML = `<span>${safeImage}<span class="item-top"><span><span class="item-name">${escapeHtml(item.name)}</span><span class="item-number">Артикул ${escapeHtml(item.sku)}</span><span class="available-badge">Свободно: ${item.available_quantity}</span>${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}</span></span></span><span class="quantity-control"><button type="button" class="button ghost quantity-minus" aria-label="Уменьшить количество">−</button><strong>${quantity}</strong><button type="button" class="button secondary quantity-plus" aria-label="Увеличить количество" ${quantity >= item.available_quantity ? "disabled" : ""}>+</button></span>`;
      card.querySelector(".quantity-minus").disabled = quantity === 0;
      card.querySelector(".quantity-plus").disabled = quantity >= Math.min(30, item.available_quantity);
      card.querySelector(".quantity-minus").addEventListener("click", () => { if (quantity <= 1) state.quantities.delete(item.id); else state.quantities.set(item.id, quantity - 1); state.requestId = null; renderItems(); saveDraft(); });
      card.querySelector(".quantity-plus").addEventListener("click", () => { state.quantities.set(item.id, quantity + 1); state.requestId = null; renderItems(); saveDraft(); });
      $("items-grid").append(card);
    }
    $("selected-count").textContent = [...state.quantities.values()].reduce((sum, value) => sum + value, 0);
  }
  function reviewRow(label, value, extraClass = "") { return `<div class="review-row"><span>${escapeHtml(label)}</span><strong class="${extraClass}">${escapeHtml(value)}</strong></div>`; }
  function renderReview() {
    const chosen = state.items.filter((item) => (state.quantities.get(item.id) || 0) > 0);
    const itemCount = chosen.reduce((sum, item) => sum + state.quantities.get(item.id), 0);
    $("review-content").innerHTML = `<section class="review-group"><h3 class="review-heading">Срок аренды</h3>${reviewRow("Получение", reviewDateTime(toIso($("start").value)))}${reviewRow("Возврат", reviewDateTime(toIso($("end").value)))}</section><section class="review-group"><h3 class="review-heading">Оборудование · ${itemCount} шт.</h3><ul class="review-items">${chosen.map((item) => `<li><span>${escapeHtml(item.name)}</span><strong>${state.quantities.get(item.id)} шт.</strong></li>`).join("")}</ul></section><section class="review-group"><h3 class="review-heading">Контакт для связи</h3>${reviewRow("Имя", $("customer-name").value.trim())}${reviewRow("Телефон или Telegram", $("customer-contact").value.trim())}</section>`;
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

  $("steps").addEventListener("click", (event) => {
    const button = event.target.closest(".step-button");
    if (!button || state.busy) return;
    const target = Number(button.dataset.step);
    if (!Number.isInteger(target) || target < 0 || target >= state.step) return;
    clearError(); state.step = target; render();
  });
  async function submit() {
    if (preview) return showError("Это демонстрация интерфейса. Отправка заявки доступна из Telegram.");
    if (!state.requestId) state.requestId = newRequestId();
    const payload = { request_id: state.requestId, start: toIso($("start").value), end: toIso($("end").value), lines: [...state.quantities].map(([article_id, quantity]) => ({ article_id, quantity })), name: $("customer-name").value.trim(), contact: $("customer-contact").value.trim() };
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
      $("done-description").textContent = "Заявка будет ждать решения оператора без ограничения по времени. Статус придёт в Telegram.";
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch (error) {
      const changed = error.message.includes("Цена изменилась") || error.message.includes("занято") || error.message.includes("недоступно");
      if (changed) { state.requestId = null; state.step = 1; await loadItems(); }
      showError(changed ? `${error.message} Выберите оборудование и проверьте заказ снова.` : error.message);
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally { state.busy = false; render(); }
  }

  const statusNames = { pending: "Ждёт менеджера", confirmed: "Подтверждена", preparing: "Комплектуется", ready: "Готова", issued: "В аренде", return_inspection: "Проверяется", returned: "Завершена", cancelled: "Отменена", expired: "Удержание истекло" };
  const identityStatusNames = { required: "Не заполнена", submitted: "На проверке", needs_changes: "Нужны исправления", verified: "Проверена", not_required: "Не требуется", deleted: "Удалена", blocked: "Заблокирована" };
  function appendPendingContactEditor(card, order) {
    const toggle = document.createElement("button"); toggle.className = "button ghost"; toggle.type = "button";
    toggle.textContent = "Изменить имя или телефон"; toggle.setAttribute("aria-expanded", "false");
    const form = document.createElement("form"); form.className = "contact-editor"; form.hidden = true;
    form.innerHTML = `<label class="field"><span>Имя</span><input name="name" value="${escapeHtml(order.customer_name || "")}" maxlength="200" required></label><label class="field"><span>Телефон или Telegram</span><input name="contact" value="${escapeHtml(order.customer_contact || "")}" maxlength="200" autocomplete="tel" required></label><button class="button primary" type="submit">Сохранить изменения</button>`;
    toggle.addEventListener("click", () => { form.hidden = !form.hidden; toggle.setAttribute("aria-expanded", String(!form.hidden)); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        const data = new FormData(form);
        await api(`/api/miniapp/bookings/${order.id}/contact`, { method: "PATCH", body: JSON.stringify({ name: data.get("name"), contact: data.get("contact") }) });
        $("customer-name").value = String(data.get("name") || "").trim();
        $("customer-contact").value = String(data.get("contact") || "").trim();
        saveContact();
        await showOrders();
      } catch (error) { showError(error.message); button.disabled = false; }
    });
    card.append(toggle, form);
  }

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
        card.innerHTML = `<div class="order-head"><strong>Заявка №${order.id}</strong><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></div><p>${escapeHtml(dateText(order.starts_at))} — ${escapeHtml(dateText(order.ends_at))} МСК</p><p>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(", ")}</p>${order.status === "pending" ? "<p>Ожидает решения оператора без ограничения по времени.</p>" : ""}`;
        if (order.status === "pending") appendPendingContactEditor(card, order);
        if (!(["cancelled", "expired"].includes(order.status)) && ["required", "needs_changes"].includes(order.identity_status)) {
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

  function renderUniversityOptions() {
    const list = $("university-options"); list.replaceChildren();
    for (const name of state.universities) { const option = document.createElement("option"); option.value = name; list.append(option); }
  }

  function closeAddressSuggestions() {
    clearTimeout(addressSuggestTimer); addressSuggestSequence += 1;
    if (addressSuggestController) addressSuggestController.abort();
    $("address-suggestions").hidden = true; $("registration_address").setAttribute("aria-expanded", "false");
  }

  async function searchAddressSuggestions(query, sequence) {
    if (addressSuggestController) addressSuggestController.abort();
    addressSuggestController = new AbortController();
    const list = $("address-suggestions"); list.replaceChildren();
    try {
      const result = await api("/api/miniapp/address-suggestions", {
        method: "POST", signal: addressSuggestController.signal,
        body: JSON.stringify({ query }),
      });
      if (sequence !== addressSuggestSequence || $("registration_address").value.trim() !== query) return;
      for (const item of result.items || []) {
        const option = document.createElement("button"); option.type = "button"; option.className = "address-suggestion"; option.setAttribute("role", "option"); option.textContent = item.value;
        option.addEventListener("click", () => {
          clearTimeout(addressSuggestTimer); addressSuggestSequence += 1;
          if (addressSuggestController) addressSuggestController.abort();
          $("registration_address").value = item.address || item.value;
          clearIdentityFieldError($("registration_address")); closeAddressSuggestions();
        });
        list.append(option);
      }
      if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "address-suggestion-status"; empty.textContent = "Подходящий адрес не найден. Продолжите ввод вручную."; list.append(empty); }
      list.hidden = false; $("registration_address").setAttribute("aria-expanded", "true");
    } catch (error) {
      if (error.name === "AbortError" || sequence !== addressSuggestSequence) return;
      const status = document.createElement("p"); status.className = "address-suggestion-status"; status.textContent = "Подсказки временно недоступны. Адрес можно ввести вручную."; list.replaceChildren(status);
      list.hidden = false; $("registration_address").setAttribute("aria-expanded", "true");
    }
  }

  function scheduleAddressSuggestions(value) {
    clearTimeout(addressSuggestTimer); addressSuggestSequence += 1;
    if (addressSuggestController) addressSuggestController.abort();
    const query = value.trim();
    if (query.length < 3) { closeAddressSuggestions(); return; }
    const sequence = addressSuggestSequence;
    addressSuggestTimer = setTimeout(() => searchAddressSuggestions(query, sequence), 350);
  }

  async function openIdentity(bookingId) {
    clearError(); state.identityBookingId = bookingId; state.view = "identity"; render();
    state.consent = null; state.identityRequiredPhotos = []; state.identityReusableDocuments = [];
    $("identity-form").reset();
    document.querySelectorAll('#identity-form .needs-fix').forEach((field) => field.classList.remove("needs-fix"));
    document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => { input.required = false; });
    document.querySelector('[name="residential_address"]').readOnly = false;
    $("identity-status").hidden = true; $("identity-form").hidden = true; $("identity-feedback").hidden = true; $("consent-step").hidden = false;
    $("consent-check").checked = false; $("consent-text").textContent = "Загружаем текст согласия…";
    try {
      const current = await api(`/api/miniapp/bookings/${bookingId}/identity`);
      state.identityNeedsChanges = current.status === "needs_changes";
      const universityResult = await api("/api/miniapp/universities");
      state.universities = universityResult.items || []; renderUniversityOptions();
      await restoreIdentityPhotos(current.documents || []);
      const fields = current.fields || {};
      if (!state.identityNeedsChanges && !Object.values(fields).some((value) => Boolean(value))) {
        const saved = await api(`/api/miniapp/bookings/${bookingId}/identity/reusable-profile`);
        if (saved.reusable) {
          Object.assign(fields, saved.fields || {});
          state.identityReusableDocuments = saved.documents || [];
          const feedback = $("identity-feedback");
          feedback.textContent = "Данные и фотографии из предыдущей анкеты будут подставлены после согласия. Проверьте реквизиты; новое фото заменит сохранённое. Анкета и фотографии хранятся до 90 дней после возврата оборудования.";
          feedback.hidden = false;
        }
      }
      state.identityLegacyInstitution = !state.universities.includes(fields.student_institution)
        ? (fields.student_institution || null) : null;
      const combined = `${fields.passport_series || ""}${fields.passport_number || ""}`;
      if (combined) fields.passport_combined = `${combined.slice(0, 4)} ${combined.slice(4)}`;
      for (const [name, value] of Object.entries(fields)) { const input = document.querySelector(`[name="${name}"]`); if (input) input.value = value || ""; }
      const feedback = $("identity-feedback");
      if (current.status === "needs_changes") {
        state.identityRequiredPhotos = (current.review_fields || []).filter((field) => ["passport_main", "passport_registration", "student_front"].includes(field));
        for (const name of state.identityRequiredPhotos) {
          const input = document.querySelector(`#identity-form [name="${name}"]`);
          const status = input?.closest(".field")?.querySelector(".file-draft-status");
          if (status) status.textContent = "Оператор запросил новое фото — загрузите замену.";
        }
        const labels = { full_name: "ФИО", birth_date: "дата рождения", passport_combined: "серия и номер паспорта", passport_issued_at: "дата выдачи", passport_issuer: "кем выдан паспорт", passport_division_code: "код подразделения", registration_address: "адрес регистрации", residential_address: "адрес проживания", student_id_number: "номер студенческого", student_institution: "учебное заведение", passport_main: "фото паспорта", passport_registration: "страница регистрации", student_front: "лицевая сторона студенческого" };
        feedback.innerHTML = `<strong>Нужно исправить:</strong> ${(current.review_fields || []).map((field) => escapeHtml(labels[field] || field)).join(", ") || "проверьте данные по комментарию оператора"}.<br>${escapeHtml(current.review_comment || "")}`;
        feedback.hidden = false; $("consent-step").hidden = true; $("identity-form").hidden = false;
        for (const field of current.review_fields || []) { const input = document.querySelector(`[name="${field}"]`); input?.closest(".field")?.classList.add("needs-fix"); }
        document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => { input.required = false; });
        return;
      }
      state.consent = await api("/api/miniapp/privacy-consent");
      $("consent-text").textContent = state.consent.text;
    } catch (error) { $("consent-text").textContent = "Форма временно недоступна."; showError(error.message); }
  }

  async function jpegFile(file) {
    if (!file || file.type === "image/jpeg") return file;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .9));
    if (!blob) throw new Error("Не удалось преобразовать изображение в JPEG");
    return new File([blob], `${(file.name || "document").replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  }

  async function submitIdentity(event) {
    event.preventDefault(); clearError();
    const form = event.currentTarget; const button = $("identity-submit");
    const data = new FormData(form); const fields = {};
    const textFields = ["full_name", "birth_date", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution"];
    for (const name of textFields) {
      const value = String(data.get(name) || ""); fields[name] = name === "student_id_number" ? value : value.trim();
    }
    const labels = { full_name: "ФИО", birth_date: "дату рождения", passport_issued_at: "дату выдачи паспорта", passport_issuer: "кем выдан паспорт", passport_division_code: "код подразделения", registration_address: "адрес регистрации", residential_address: "адрес проживания", student_id_number: "номер студенческого", student_institution: "вуз" };
    for (const name of textFields) if (!fields[name]) { showIdentityFieldError(name, `Укажите ${labels[name]}.`); return; }
    const passportCombined = String(data.get("passport_combined") || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(passportCombined)) { showIdentityFieldError("passport_combined", "Введите 4 цифры серии паспорта и 6 цифр номера."); return; }
    fields.passport_series = passportCombined.slice(0, 4); fields.passport_number = passportCombined.slice(4);
    const dateToday = new Date().toISOString().slice(0, 10);
    if (!/^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z .'-]{1,199}$/.test(fields.full_name) || fields.full_name.split(/\s+/).length < 2) { showIdentityFieldError("full_name", "Укажите ФИО минимум из двух слов."); return; }
    if (!/^\d{3}-\d{3}$/.test(fields.passport_division_code)) { showIdentityFieldError("passport_division_code", "Введите код в формате 000-000."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.birth_date) || fields.birth_date > dateToday) { showIdentityFieldError("birth_date", "Проверьте дату рождения."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.passport_issued_at) || fields.passport_issued_at > dateToday || fields.passport_issued_at < fields.birth_date) { showIdentityFieldError("passport_issued_at", "Проверьте дату выдачи паспорта."); return; }
    if (!/^\d{8}$/.test(fields.student_id_number)) { showIdentityFieldError("student_id_number", "Номер студенческого должен содержать ровно 8 цифр."); return; }
    if (!state.universities.includes(fields.student_institution) && fields.student_institution !== state.identityLegacyInstitution) { showIdentityFieldError("student_institution", "Выберите вуз из списка Санкт-Петербурга."); return; }
    const upload = new FormData(); upload.set("payload", JSON.stringify(fields));
    if (state.consent) { upload.set("policy_version", state.consent.version); upload.set("text_hash", state.consent.text_hash); }
    button.disabled = true; button.textContent = "Шифруем и отправляем…";
    try {
      for (const name of ["passport_main", "passport_registration", "student_front"]) {
        const selected = data.get(name); const key = identityPhotoKey(name);
        let entry = identityPhotoDrafts.get(key);
        if (!entry) { try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; } }
        const freshFile = selected?.size ? selected : null;
        if (state.identityRequiredPhotos.includes(name) && !freshFile) { const photoError = new Error(`Загрузите новое фото: ${name === "passport_main" ? "паспорт — страница с фото" : name === "passport_registration" ? "паспорт — страница регистрации" : "студенческий — лицевая сторона"}.`); photoError.field = name; throw photoError; }
        const file = freshFile || (entry && Date.now() - entry.savedAt <= photoDraftLifetime ? new File([entry.blob], entry.name, { type: entry.type }) : null);
        if (file?.size) upload.set(name, await jpegFile(file));
      }
      const missingPhoto = !state.identityNeedsChanges && ["passport_main", "passport_registration", "student_front"].find((name) => !upload.get(name));
      if (missingPhoto) { const photoError = new Error(`Добавьте фото: ${missingPhoto === "passport_main" ? "паспорт — страница с фото" : missingPhoto === "passport_registration" ? "паспорт — страница регистрации" : "студенческий — лицевая сторона"}.`); photoError.field = missingPhoto; throw photoError; }
      await api(`/api/miniapp/bookings/${state.identityBookingId}/identity`, { method: "POST", body: upload });
      await clearIdentityPhotoDrafts(state.identityBookingId);
      form.reset(); $("identity-form").hidden = true; $("identity-status").hidden = false;
      $("identity-status").textContent = "Анкета отправлена и находится на проверке. Статус обновлён в разделе «Мои заявки».";
    } catch (error) { showIdentityError(error); }
    finally { button.disabled = false; button.textContent = "Отправить на проверку"; }
  }

  function actionButton(label, action, bookingId, className = "secondary", refresh = true) {
    const button = document.createElement("button"); button.type = "button"; button.className = `button compact ${className}`; button.textContent = label;
    button.addEventListener("click", async () => { const scrollTop = window.scrollY; button.disabled = true; try { await action(); if (refresh) { await showAdmin(state.adminMode); window.scrollTo(0, scrollTop); } } catch (error) { showError(error.message); } finally { button.disabled = false; } });
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
        card.innerHTML = `<div class="order-head"><h3>Заказ №${order.id}</h3><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></div><p>${order.items.map((line) => `${escapeHtml(line.name)} × ${line.quantity}`).join(", ")}</p><p>Анкета: ${escapeHtml(identityStatusNames[order.identity_status] || order.identity_status)}</p>${order.assets.length ? `<ul class="asset-list">${order.assets.map((asset) => `<li>${escapeHtml(asset.location || "Без ячейки")} · ${escapeHtml(asset.name)} · № ${escapeHtml(asset.serial)}</li>`).join("")}</ul>` : ""}`;
        const actions = document.createElement("div"); actions.className = "action-row";
        const summary = document.createElement("p");
        summary.textContent = `${dateText(order.starts_at)} — ${dateText(order.ends_at)} МСК · ${order.customer_name} · ${order.customer_contact}`;
        card.append(summary);
        const transitionAction = (next) => () => api(`/api/miniapp/admin/bookings/${order.id}/transition`, { method: "POST", body: JSON.stringify({ action: next }) });
        if (order.status === "pending") actions.append(actionButton("Подтвердить заявку", transitionAction("confirmed"), order.id, "primary workflow-next"));
        if (order.status === "confirmed") {
          if (order.identity_status === "verified") actions.append(actionButton("Начать подготовку", transitionAction("preparing"), order.id, "primary workflow-next"));
          else { const note = document.createElement("p"); note.className = "workflow-hint"; note.textContent = "Комплектацию можно начать после заполнения документов клиентом и проверки оператором."; actions.append(note); }
        }
        if (order.status === "preparing") {
          actions.append(actionButton("Заменить экземпляры", () => manualAssign(order), order.id, "ghost", false));
          const ready = actionButton("Подтвердить готовность к выдаче", transitionAction("ready"), order.id, "primary workflow-next");
          const canConfirm = () => order.assets.length > 0 && order.assets.every((asset) => inspectionFor(order, asset, "pre_issue")?.result === "pass");
          const readinessHint = document.createElement("p"); readinessHint.className = "workflow-hint";
          const updateReadinessHint = () => {
            const failedCount = order.assets.filter((asset) => inspectionFor(order, asset, "pre_issue")?.result === "fail").length;
            readinessHint.textContent = failedCount
              ? `Неисправность отмечена у ${failedCount} экземпляр(а). Замените неисправную технику, затем повторите проверку.`
              : "Проверьте все экземпляры. После успешной проверки нажмите «Далее», чтобы подтвердить готовность заказа.";
            readinessHint.hidden = canConfirm();
          };
          ready.disabled = !canConfirm();
          ready.title = ready.disabled ? "Сначала проверьте все назначенные экземпляры" : "Подтвердить готовность заказа к выдаче";
          appendInspectionGroup(actions, order, "pre_issue", () => {
            ready.disabled = !canConfirm();
            ready.title = ready.disabled ? "Сначала проверьте все назначенные экземпляры" : "Подтвердить готовность заказа к выдаче";
            updateReadinessHint();
          });
          updateReadinessHint(); actions.append(readinessHint);
          actions.append(ready);
        }
        if (state.role?.pii_admin && ["submitted", "needs_changes", "verified"].includes(order.identity_status)) {
          actions.append(actionButton("Проверить анкету", () => reviewIdentity(order.id), order.id,
            order.identity_status === "verified" ? "secondary lock-exempt" : "primary workflow-next lock-exempt"));
          const documents = document.createElement("details"); documents.className = "document-actions";
          documents.innerHTML = `<summary>Документы анкеты</summary><span class="document-group-caption">Паспорт: 2 страницы · студенческий: лицевая сторона</span>`;
          const passport = document.createElement("div"); passport.className = "document-group";
          passport.append(actionButton("Паспорт — страница с фото", () => openDocumentViewer(order.id, "passport_main"), order.id, "ghost document-button"));
          passport.append(actionButton("Паспорт — регистрация", () => openDocumentViewer(order.id, "passport_registration"), order.id, "ghost document-button"));
          const student = document.createElement("div"); student.className = "document-group";
          student.append(actionButton("Студенческий — лицевая сторона", () => openDocumentViewer(order.id, "student_front"), order.id, "ghost document-button"));
          documents.append(passport, student); actions.append(documents);
        }
        const canSeeDocuments = ["confirmed", "preparing", "ready", "issued", "return_inspection", "returned"].includes(order.status)
          || (order.status === "cancelled" && (order.archived_documents || []).length > 0);
        if (canSeeDocuments && state.role?.pii_admin) {
          const canGenerateDocuments = order.identity_status === "verified" && order.assets.length > 0;
          const archivedDocuments = new Set(order.archived_documents || []);
          const actButton = actionButton("Сформировать / скачать акт", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/issue`, `act-${order.id}.docx`), order.id, "secondary lock-exempt", false);
          const receiptButton = actionButton("Сформировать / скачать расписку", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/receipt`, `receipt-${order.id}.docx`), order.id, "secondary lock-exempt", false);
          const documents = document.createElement("details"); documents.className = "document-actions generated-documents";
          const documentSummary = document.createElement("summary"); documentSummary.textContent = "Акт и сохранная расписка"; documents.append(documentSummary);
          actButton.disabled = !(archivedDocuments.has("issue") || canGenerateDocuments);
          receiptButton.disabled = !(archivedDocuments.has("receipt") || canGenerateDocuments);
          if (actButton.disabled || receiptButton.disabled) {
            const note = document.createElement("p"); note.className = "workflow-hint";
            note.textContent = order.identity_status !== "verified"
              ? "Акт и расписка станут доступны после проверки анкеты клиента."
              : "Акт и расписка станут доступны после назначения конкретных экземпляров при комплектации.";
            documents.append(note);
          }
          const documentButtons = document.createElement("div"); documentButtons.className = "document-group";
          documentButtons.append(actButton, receiptButton); documents.append(documentButtons); actions.append(documents);
        }
        if (order.status === "ready" && state.role?.pii_admin && order.identity_status === "verified" && !order.act_signed_at) {
          actions.append(actionButton("Отметить подписание акта", () => api(`/api/miniapp/admin/bookings/${order.id}/act-signed`, { method: "POST" }), order.id, "primary workflow-next lock-exempt"));
        }
        if (order.status === "ready" && order.act_signed_at) actions.append(actionButton("Выдать оборудование", transitionAction("issued"), order.id, "primary workflow-next"));
        if (order.status === "ready" && !order.act_signed_at) { const note = document.createElement("p"); note.textContent = "Оператор должен отметить подписание акта перед выдачей."; actions.append(note); }
        if (["pending", "confirmed", "preparing", "ready", "returned"].includes(order.status)) actions.append(actionButton("Отменить заказ", async () => { if (await confirmCancel(order.id, order.status === "returned")) await transitionAction("cancelled")(); }, order.id, "ghost danger"));
        if (order.status === "issued") actions.append(actionButton("Начать приём оборудования", transitionAction("return_inspection"), order.id, "primary workflow-next"));
        if (order.status === "return_inspection") {
          const finishReturn = actionButton("Завершить возврат", transitionAction("returned"), order.id, "primary workflow-next");
          const canFinishReturn = () => order.assets.length > 0 && order.assets.every((asset) => Boolean(inspectionFor(order, asset, "check_in")));
          const returnHint = document.createElement("p"); returnHint.className = "workflow-hint";
          const updateReturnHint = () => {
            const unchecked = order.assets.filter((asset) => !inspectionFor(order, asset, "check_in")).length;
            returnHint.textContent = unchecked
              ? `Проверьте каждый экземпляр при возврате: осталось ${unchecked}. Затем нажмите «Далее», чтобы завершить возврат.`
              : "Проверка завершена. Нажмите «Далее», чтобы закрыть возврат.";
            returnHint.hidden = canFinishReturn();
          };
          finishReturn.disabled = !canFinishReturn();
          finishReturn.title = finishReturn.disabled ? "Сначала проверьте каждый возвращённый экземпляр" : "Завершить возврат";
          appendInspectionGroup(actions, order, "check_in", () => {
            finishReturn.disabled = !canFinishReturn();
            finishReturn.title = finishReturn.disabled ? "Сначала проверьте каждый возвращённый экземпляр" : "Завершить возврат";
            updateReturnHint();
          });
          updateReturnHint(); actions.append(returnHint, finishReturn);
        }
        if (["pending", "confirmed", "preparing", "ready", "issued", "return_inspection"].includes(order.status)) {
          const lease = order.operation_lease;
          const mine = lease?.actor_id === state.role?.id;
          if (lease) {
            const ownership = document.createElement("p"); ownership.className = "workflow-hint";
            ownership.textContent = `${mine ? "Вы обрабатываете" : "Обрабатывает"}: ${lease.actor_name}. До ${dateText(lease.expires_at)} МСК.`;
            card.append(ownership);
            if (!mine) actions.querySelectorAll("button:not(.document-button):not(.lock-exempt)").forEach((button) => { button.disabled = true; });
          }
        }
        card.append(actions);
        if (state.role?.admin) {
          const maintenance = document.createElement("details"); maintenance.className = "booking-maintenance";
          const summary = document.createElement("summary"); summary.textContent = "Дополнительные действия";
          const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact";
          remove.textContent = "Удалить тестовую заявку";
          remove.addEventListener("click", async () => {
            if (!await confirmPermanentBookingDelete(order.id)) return;
            remove.disabled = true;
            try {
              await api(`/api/miniapp/admin/bookings/${order.id}`, { method: "DELETE" });
              card.remove();
              if (!content.querySelector(".admin-card")) content.textContent = "Заказов пока нет.";
            } catch (error) { showError(error.message); remove.disabled = false; }
          });
          maintenance.append(summary, remove); card.append(maintenance);
        }
        content.append(card);
      }
    } catch (error) { content.textContent = "Не удалось загрузить раздел."; showError(error.message); }
  }

  function inspectionFor(order, asset, stage) {
    return (order.inspections || []).find((item) => item.equipment_id === asset.id && item.stage === stage);
  }

  function appendInspectionGroup(actions, order, stage, onInspectionChange = () => {}) {
    if (!order.assets?.length) return;
    const group = document.createElement("section"); group.className = "inspection-group";
    const title = document.createElement("h4"); title.className = "inspection-group-title";
    title.textContent = stage === "pre_issue" ? "Проверка перед выдачей" : "Проверка при возврате";
    const progress = document.createElement("p"); progress.className = "inspection-progress";
    const pending = () => order.assets.filter((asset) => !inspectionFor(order, asset, stage));
    const updateProgress = () => {
      const checked = order.assets.length - pending().length;
      progress.textContent = `Проверено ${checked} из ${order.assets.length}`;
    };
    group.append(title, progress);
    updateProgress();
    for (const asset of order.assets) {
      const saved = inspectionFor(order, asset, stage);
      const row = document.createElement("div"); row.className = "inspection-row"; row.dataset.equipmentId = String(asset.id);
      const details = document.createElement("div"); details.className = "inspection-unit";
      const name = document.createElement("strong"); name.className = "inspection-unit-name";
      name.textContent = `${asset.name} · № ${asset.serial}`;
      const status = document.createElement("span"); status.className = `inspection-state${saved ? " checked" : ""}`;
      status.textContent = saved ? (saved.result === "pass" ? "Исправно" : "Зафиксирована неисправность") : "Ожидает проверки";
      details.append(name, status);
      row.append(details);
      const defect = document.createElement("button"); defect.type = "button"; defect.className = "button ghost compact";
      defect.textContent = saved?.result === "fail" ? "Изменить" : "Неисправность";
      defect.addEventListener("click", () => openInspection(order, asset, stage, saved));
      row.append(defect);
      group.append(row);
    }
    const markAll = document.createElement("button"); markAll.type = "button"; markAll.className = "button secondary inspection-all-pass";
    const updateButton = () => {
      const left = pending().length;
      markAll.hidden = left === 0;
      markAll.textContent = left === order.assets.length ? "Все исправны" : `Остальные исправны (${left})`;
    };
    updateButton();
    markAll.addEventListener("click", async () => {
      const toMark = pending();
      if (!toMark.length) return;
      markAll.disabled = true;
      try {
        for (const asset of toMark) {
          await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method: "POST", body: JSON.stringify({ equipment_id: asset.id, stage, result: "pass", checklist: {}, notes: "", defect: "", estimated_cost: 0, charge_customer: false }) });
          order.inspections ||= [];
          order.inspections.push({ equipment_id: asset.id, stage, result: "pass" });
          const row = group.querySelector(`[data-equipment-id="${asset.id}"]`);
          const status = row?.querySelector(".inspection-state");
          if (status) { status.textContent = "Исправно"; status.classList.add("checked"); }
        }
        updateProgress(); updateButton(); onInspectionChange();
      } catch (error) {
        updateProgress(); updateButton(); onInspectionChange(); showError(error.message);
      } finally { markAll.disabled = false; }
    });
    group.append(markAll); actions.append(group);
  }

  async function reviewIdentity(bookingId) {
    const masked = await api(`/api/miniapp/admin/bookings/${bookingId}/identity`);
    if (!window.confirm(`Анкета: ${masked.full_name}\nПаспорт: ${masked.passport}\nСтуденческий: ${masked.student_id}\n\nРаскрыть полные реквизиты? Действие будет записано в журнал.`)) return;
    const full = await api(`/api/miniapp/admin/bookings/${bookingId}/identity/reveal`, { method: "POST" });
    const approved = window.confirm(`ФИО: ${full.full_name}\nДата рождения: ${full.birth_date}\nПаспорт: ${full.passport_series} ${full.passport_number}\nВыдан: ${full.passport_issued_at}, ${full.passport_issuer}\nКод: ${full.passport_division_code}\nРегистрация: ${full.registration_address}\nПроживание: ${full.residential_address}\nСтуденческий: ${full.student_id_number}, ${full.student_institution}\n\nПодтвердить после сверки фотографий?`);
    if (approved) return api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved: true, comment: "", fields: [] }) });
    return requestIdentityChanges(bookingId);
  }

  function requestIdentityChanges(bookingId) {
    const dialog = $("identity-review-dialog");
    const form = $("identity-review-form");
    const fields = [
      ["full_name", "ФИО"], ["birth_date", "Дата рождения"], ["passport_combined", "Серия и номер паспорта"],
      ["passport_issued_at", "Дата выдачи паспорта"], ["passport_issuer", "Кем выдан паспорт"],
      ["passport_division_code", "Код подразделения"], ["registration_address", "Адрес регистрации"],
      ["residential_address", "Адрес проживания"], ["student_id_number", "Номер студенческого"],
      ["student_institution", "Учебное заведение"], ["passport_main", "Паспорт — страница с фото"],
      ["passport_registration", "Паспорт — страница регистрации"], ["student_front", "Студенческий — лицевая сторона"],
    ];
    const choices = $("identity-review-fields"); choices.replaceChildren();
    for (const [value, label] of fields) {
      const row = document.createElement("label"); row.className = "check-row review-field-option";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = "fields"; checkbox.value = value;
      const text = document.createElement("span"); text.textContent = label;
      row.append(checkbox, text); choices.append(row);
    }
    form.reset(); dialog.hidden = false; dialog.querySelector("input")?.focus();
    return new Promise((resolve, reject) => {
      const finish = () => { dialog.hidden = true; form.removeEventListener("submit", submit); $("identity-review-cancel").removeEventListener("click", cancel); };
      const cancel = () => { finish(); resolve(); };
      const submit = async (event) => {
        event.preventDefault();
        const button = $("identity-review-submit"); button.disabled = true;
        const selected = [...form.querySelectorAll('input[name="fields"]:checked')].map((input) => input.value);
        const comment = String(new FormData(form).get("comment") || "").trim();
        if (!selected.length && !comment) { showError("Выберите поля для исправления или добавьте комментарий."); button.disabled = false; return; }
        try {
          const result = await api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved: false, comment: comment || "Нужны исправления", fields: selected }) });
          finish(); resolve(result);
        } catch (error) { showError(error.message); button.disabled = false; }
      };
      form.addEventListener("submit", submit); $("identity-review-cancel").addEventListener("click", cancel);
    });
  }

  async function downloadSecure(path, filename) {
    const version = String(tg?.version || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const supportsNativeDownload = typeof tg?.downloadFile === "function" && (version[0] > 8 || (version[0] === 8 && version[1] >= 0));
    if (supportsNativeDownload) {
      const ticket = await api(`${path}/download-link`, { method: "POST" });
      try {
        tg.downloadFile({ url: ticket.url, file_name: ticket.file_name || filename });
        return;
      } catch (_) { /* Older or customized clients may expose but not implement downloadFile. */ }
    }
    const response = await fetch(path, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (!response.ok) { let detail = "Не удалось скачать документ"; try { detail = (await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
    link.href = url; link.download = filename; link.style.display = "none"; document.body.append(link); link.click(); link.remove();
    // iOS Telegram may start reading the file after the click handler returns.
    // Revoking immediately can leave its document preview on a black screen.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  let documentViewerUrl = "";
  let documentViewerItems = [];
  let documentViewerIndex = 0;
  let documentViewerBookingId = null;
  async function openDocumentViewer(bookingId, kind) {
    documentViewerBookingId = bookingId;
    documentViewerItems = ["passport_main", "passport_registration", "student_front"];
    documentViewerIndex = Math.max(0, documentViewerItems.indexOf(kind));
    const viewer = $("document-viewer"); viewer.hidden = false;
    $("document-viewer-close").focus();
    await loadDocumentViewerImage(bookingId);
  }
  async function loadDocumentViewerImage(bookingId) {
    const kind = documentViewerItems[documentViewerIndex];
    const labels = { passport_main: "Паспорт — страница с фото", passport_registration: "Паспорт — регистрация", student_front: "Студенческий — лицевая сторона" };
    const response = await fetch(`/api/miniapp/admin/bookings/${bookingId}/identity/documents/${kind}`, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (!response.ok) { closeDocumentViewer(); throw new Error("Не удалось открыть фотографию"); }
    if (documentViewerUrl) URL.revokeObjectURL(documentViewerUrl);
    documentViewerUrl = URL.createObjectURL(await response.blob()); $("document-viewer-image").src = documentViewerUrl; $("document-viewer-title").textContent = labels[kind] || "Документ";
    $("document-viewer-image").alt = labels[kind] || "Документ";
    $("document-viewer-prev").disabled = documentViewerIndex === 0;
    $("document-viewer-next").disabled = documentViewerIndex === documentViewerItems.length - 1;
  }
  function closeDocumentViewer() { $("document-viewer").hidden = true; $("document-viewer-image").removeAttribute("src"); if (documentViewerUrl) URL.revokeObjectURL(documentViewerUrl); documentViewerUrl = ""; }

  function renderAdminCatalog(result, editor = null) {
    const content = $("admin-content"); content.replaceChildren();
    const dependencyNote = document.createElement("p");
    dependencyNote.textContent = "Зависимости комплектов хранятся справочно. Автоматическое добавление отключено: клиент выбирает и оплачивает каждую позицию отдельно.";
    content.append(dependencyNote);
    const toolbar = document.createElement("div"); toolbar.className = "action-row";
    for (const [label, type, className] of [["Новый артикул", "article", "primary"], ["Новый экземпляр", "equipment", "secondary"], ["Зависимость комплекта", "dependency", "ghost"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = label;
      button.addEventListener("click", () => renderAdminCatalog(result, { type })); toolbar.append(button);
    }
    content.append(toolbar);
    const importer = document.createElement("details"); importer.className = "catalog-import";
    importer.innerHTML = `<summary>Добавить оборудование из CSV</summary><p>CSV в UTF-8 с разделителем «;» или «,». Обязательные колонки: <code>sku</code>, <code>name</code>, <code>serial</code>. Для существующего артикула можно добавить новые экземпляры; серийные номера не должны повторяться. Файл импортируется целиком или не импортируется вовсе.</p><a href="/miniapp/static/equipment-import-template.csv" download="equipment-import-template.csv">Скачать шаблон CSV</a><form class="catalog-import-form"><label class="field"><span>CSV-файл, не больше 1 МБ и 500 экземпляров</span><input name="file" type="file" accept=".csv,text/csv" required></label><button class="button primary" type="submit">Добавить из CSV</button></form>`;
    importer.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        const result = await api("/api/miniapp/admin/catalog/import-csv", { method: "POST", body: new FormData(form) });
        await showAdmin("catalog");
        const notice = document.createElement("p"); notice.className = "notice"; notice.setAttribute("role", "status");
        notice.textContent = `Добавлено моделей: ${result.articles_created}; экземпляров: ${result.equipment_created}.`;
        $("admin-content").prepend(notice);
      } catch (error) { showError(error.message); button.disabled = false; }
    });
    content.append(importer);
    if (editor) content.append(catalogEditor(result, editor));

    if (result.dependencies.length) {
      const dependencies = document.createElement("article"); dependencies.className = "admin-card";
      dependencies.innerHTML = `<h3>Состав комплектов</h3><div class="dependency-list"></div>`;
      const list = dependencies.querySelector(".dependency-list");
      for (const item of result.dependencies) {
        const parent = result.articles.find((article) => article.id === item.parent_article_id);
        const child = result.articles.find((article) => article.id === item.child_article_id);
        const row = document.createElement("div"); row.className = "dependency-row";
        row.innerHTML = `<span><strong>${escapeHtml(parent?.name || item.parent_article_id)}</strong> → ${escapeHtml(child?.name || item.child_article_id)} × ${item.quantity} · справочная связь</span>`;
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost compact danger"; remove.textContent = "Удалить";
        remove.addEventListener("click", async () => { try { await api(`/api/miniapp/admin/catalog/dependencies/${item.parent_article_id}/${item.child_article_id}`, { method: "DELETE" }); await showAdmin("catalog"); } catch (error) { showError(error.message); } });
        row.append(remove); list.append(row);
      }
      content.append(dependencies);
    }

    for (const article of result.articles) {
      const card = document.createElement("article"); card.className = `admin-card${article.active ? "" : " inactive"}`;
      card.innerHTML = `<div class="order-head"><h3>${escapeHtml(article.name)}</h3><span class="status-pill">${article.active ? "В каталоге" : "Скрыт"}</span></div><p>${escapeHtml(article.sku)} · буфер ${article.buffer_hours} ч · профиль ${escapeHtml(article.inspection_profile)}</p><p>${escapeHtml(article.description || "Без описания")}</p><p><strong>Комплектация для расписки:</strong> ${escapeHtml(article.composition || "не указана")}</p><div class="equipment-list"></div>`;
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
      wrapper.innerHTML = `<h3>${value.id ? "Изменить артикул" : "Новый артикул"}</h3><form class="catalog-form form-grid"><label class="field"><span>SKU / артикул</span><input name="sku" value="${escapeHtml(value.sku || "")}" maxlength="80" required></label><label class="field"><span>Название модели</span><input name="name" value="${escapeHtml(value.name || "")}" maxlength="200" required></label><label class="field wide"><span>Описание</span><textarea name="description" maxlength="4000">${escapeHtml(value.description || "")}</textarea></label><label class="field wide"><span>Комплектация для расписки</span><textarea name="composition" maxlength="4000" placeholder="Оставьте пустым, пока состав комплекта не определён">${escapeHtml(value.composition || "")}</textarea><small>Сохраняется для модели и редактируется в карточке артикула.</small></label><label class="field"><span>Буфер после возврата, часов</span><input name="buffer_hours" type="number" min="0" max="168" value="${value.buffer_hours ?? 24}" required></label><label class="field"><span>Категория</span><select name="category">${selectOptions(["generic", "camera", "optics", "light", "battery", "accessory"], value.category || "generic")}</select></label><label class="field"><span>Профиль проверки</span><select name="inspection_profile">${selectOptions(["generic", "camera", "optics", "light", "battery"], value.inspection_profile || "generic")}</select></label><label class="field wide"><span>HTTPS-ссылка на фото</span><input name="image_url" type="url" value="${escapeHtml(value.image_url || "")}" maxlength="500" placeholder="https://…"></label><label class="check-row wide"><input name="active" type="checkbox" ${value.active !== false ? "checked" : ""}><span>Показывать клиентам в каталоге</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить артикул</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else if (editor.type === "equipment") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить экземпляр" : "Новый экземпляр"}</h3><form class="catalog-form form-grid"><label class="field wide"><span>Артикул</span><select name="article_id" required><option value="">Выберите артикул</option>${options}</select></label><label class="field"><span>Серийный номер</span><input name="serial" value="${escapeHtml(value.serial || "")}" maxlength="80" required></label><label class="field"><span>Складская ячейка</span><input name="location" value="${escapeHtml(value.location || "")}" maxlength="120" placeholder="A-01"></label><label class="field"><span>Состояние</span><select name="condition">${selectOptions(["available", "maintenance", "retired"], value.condition || "available")}</select></label><label class="field"><span>Здоровье аккумулятора, %</span><input name="health" type="number" min="0" max="100" value="${value.health ?? ""}" placeholder="Только для аккумулятора"></label><label class="field"><span>Заряд аккумулятора, %</span><input name="charge" type="number" min="0" max="100" value="${value.charge ?? ""}" placeholder="Только для аккумулятора"></label><div class="info-strip wide"><span class="info-icon">i</span><p>Серийный номер видят только сотрудники. Клиент получает его в подписываемом акте.</p></div><div class="action-row wide"><button class="button primary" type="submit">Сохранить экземпляр</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else {
      wrapper.innerHTML = `<h3>Зависимость комплекта</h3><form class="catalog-form form-grid"><label class="field"><span>Основной артикул</span><select name="parent_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Добавляемый артикул</span><select name="child_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Количество на единицу</span><input name="quantity" type="number" min="1" max="30" value="1" required></label><label class="check-row"><input name="billable" type="checkbox"><span>Оплачивается отдельно</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить зависимость</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    }
    wrapper.querySelector(".editor-cancel").addEventListener("click", () => renderAdminCatalog(result));
    wrapper.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        if (editor.type === "article") await api("/api/miniapp/admin/catalog/articles", { method: "POST", body: JSON.stringify({ id: value.id || null, sku: data.get("sku"), name: data.get("name"), description: data.get("description"), composition: data.get("composition"), rate: "0", buffer_hours: Number(data.get("buffer_hours")), category: data.get("category"), inspection_profile: data.get("inspection_profile"), image_url: data.get("image_url"), active: data.get("active") === "on" }) });
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
    const catalog = await api("/api/miniapp/admin/catalog");
    const editor = document.createElement("article"); editor.className = "admin-card assignment-editor";
    editor.innerHTML = `<div class="order-head"><div><h3>Замена экземпляров</h3><p>Выберите конкретную технику для каждой позиции заказа.</p></div><button type="button" class="button ghost compact assignment-close">Закрыть</button></div><form class="assignment-form"></form>`;
    const form = editor.querySelector("form");
    for (const line of order.lines) {
      const article = catalog.articles.find((item) => item.id === line.article_id);
      const current = order.assets.filter((asset) => asset.article_id === line.article_id).map((asset) => asset.id);
      const group = document.createElement("fieldset"); group.className = "assignment-group";
      group.innerHTML = `<legend>${escapeHtml(line.name)} × ${line.quantity}</legend>`;
      for (let index = 0; index < line.quantity; index += 1) {
        const slot = document.createElement("label"); slot.className = "assignment-slot";
        slot.innerHTML = `<span>Экземпляр ${index + 1}</span>`;
        const select = document.createElement("select"); select.name = `line-${line.id}`; select.required = true;
        select.innerHTML = `<option value="">Экземпляр ${index + 1}</option>`;
        for (const item of article?.equipment || []) {
          if (item.condition !== "available" && !current.includes(item.id)) continue;
          const option = document.createElement("option"); option.value = item.id; option.textContent = `№ ${item.serial} · ${item.location || "без ячейки"} · ${item.condition === "available" ? "доступен" : item.condition}`; option.selected = current[index] === item.id; select.append(option);
        }
        slot.append(select); group.append(slot);
      }
      form.append(group);
    }
    const buttons = document.createElement("div"); buttons.className = "action-row"; buttons.innerHTML = `<button class="button primary" type="submit">Сохранить замену</button>`; form.append(buttons);
    $("admin-content").prepend(editor); editor.scrollIntoView({ behavior: "smooth", block: "start" });
    editor.querySelector(".assignment-close").addEventListener("click", () => editor.remove());
    const refreshAssignmentOptions = () => {
      const selects = [...form.querySelectorAll("select")];
      const selected = new Set(selects.map((select) => select.value).filter(Boolean));
      for (const select of selects) {
        for (const option of select.options) {
          option.disabled = Boolean(option.value && selected.has(option.value) && option.value !== select.value);
        }
      }
    };
    form.querySelectorAll("select").forEach((select) => select.addEventListener("change", refreshAssignmentOptions));
    refreshAssignmentOptions();
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const assignments = {};
      for (const line of order.lines) assignments[String(line.id)] = [...form.querySelectorAll(`[name="line-${line.id}"]`)].map((select) => Number(select.value));
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try { await api(`/api/miniapp/admin/bookings/${order.id}/assignments`, { method: "PUT", body: JSON.stringify({ assignments }) }); await showAdmin("orders"); }
      catch (error) { showError(error.message); submit.disabled = false; }
    });
  }

  function openInspection(order, asset, stage, saved = null) {
    const content = $("admin-content");
    const card = document.createElement("article"); card.className = "admin-card inspection-editor";
    card.innerHTML = `<div class="order-head"><div><h3>${stage === "pre_issue" ? "Неисправность перед выдачей" : "Неисправность при возврате"}</h3><p>${escapeHtml(asset.name)} · серийный № ${escapeHtml(asset.serial)}</p></div><button type="button" class="button ghost compact inspection-close">Закрыть</button></div><form class="inspection-form"><div class="form-grid"><label class="field wide"><span>Что произошло</span><textarea name="defect" maxlength="4000" required placeholder="Опишите неисправность"></textarea></label><label class="field wide"><span>Комментарий</span><textarea name="notes" maxlength="2000" placeholder="Дополнительная информация"></textarea></label>${stage === "check_in" ? '<label class="field wide"><span>Фото повреждения для приложения к расписке</span><input name="damage_photo" type="file" accept="image/*" capture="environment" required><small>Фото можно сделать камерой телефона. Новое фото заменит предыдущее.</small></label>' : ""}<label class="field"><span>Оценка ущерба, ₽</span><input name="estimated_cost" type="number" min="0" step="0.01" value="0"></label><label class="check-row"><input name="charge_customer" type="checkbox"><span>Выставить счёт за порчу</span></label></div><div class="action-row"><button class="button primary" type="submit">Сохранить неисправность</button></div></form>`;
    card.querySelector('[name="defect"]').value = saved?.defect || ""; card.querySelector('[name="notes"]').value = saved?.notes || ""; card.querySelector('[name="estimated_cost"]').value = saved?.estimated_cost || "0"; card.querySelector('[name="charge_customer"]').checked = Boolean(saved?.charge_customer);
    content.prepend(card); card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.querySelector(".inspection-close").addEventListener("click", () => card.remove());
    card.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      if (!String(data.get("defect") || "").trim()) return showError("Опишите неисправность.");
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      const scrollTop = window.scrollY;
      try {
        const photo = data.get("damage_photo");
        if (stage === "check_in" && (!(photo instanceof File) || !photo.size)) throw new Error("Для приложения к расписке добавьте фото повреждения.");
        await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method: "POST", body: JSON.stringify({ equipment_id: asset.id, stage, result: "fail", checklist: {}, notes: data.get("notes") || "", defect: data.get("defect") || "", estimated_cost: data.get("estimated_cost") || 0, charge_customer: data.get("charge_customer") === "on" }) });
        if (photo instanceof File && photo.size) { const upload = new FormData(); upload.append("equipment_id", String(asset.id)); upload.append("photo", photo); await api(`/api/miniapp/admin/bookings/${order.id}/inspection-photo`, { method: "POST", body: upload }); }
        await showAdmin("orders"); window.scrollTo(0, scrollTop);
      }
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
  function confirmCancel(id, alreadyReturned = false) {
    const description = alreadyReturned
      ? `Заявка №${id} будет помечена отменённой. Факт возврата, документы и история сохранятся.`
      : `Заявка №${id} будет отменена, оборудование снова станет доступным.`;
    if (tg?.showPopup && authorized) {
      return new Promise((resolve) => tg.showPopup({ title: "Отменить заявку?", message: description, buttons: [{ id: "cancel-order", type: "destructive", text: "Отменить заявку" }, { id: "keep-order", type: "cancel", text: "Оставить" }] }, (answer) => resolve(answer === "cancel-order")));
    }
    return Promise.resolve(window.confirm(`${description}\nПродолжить?`));
  }

  function confirmPermanentBookingDelete(id) {
    const details = `Будут безвозвратно удалены заявка №${id}, анкета и фото клиента, согласия, проверки и связанные тикеты ремонта. Экземпляры, помеченные неисправными только этой заявкой, станут доступными, если по ним нет других открытых ремонтов. Останется только техническая запись об удалении без данных клиента.`;
    const entered = window.prompt(`${details}\n\nЧтобы продолжить, введите номер заявки:`);
    if (entered === null || entered.trim() !== String(id)) {
      if (entered !== null) showError("Номер заявки не совпал. Удаление отменено.");
      return Promise.resolve(false);
    }
    return Promise.resolve(window.confirm(`Удалить заявку №${id} полностью? Это действие нельзя отменить.`));
  }

  $("calendar-feed-load").addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true;
    const status = $("calendar-feed-status"); status.textContent = "Формируем защищённую ссылку…";
    try {
      const result = await api("/api/miniapp/admin/calendar-feed");
      const input = $("calendar-feed-url"); input.value = result.url; $("calendar-feed-field").hidden = false;
      $("calendar-feed-copy").hidden = false;
      status.textContent = "Вставьте эту ссылку в Google Calendar: Другие календари → Добавить по URL. Ссылка даёт доступ к расписанию; не пересылайте её посторонним.";
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });

  $("calendar-feed-copy").addEventListener("click", async () => {
    const input = $("calendar-feed-url");
    try {
      await navigator.clipboard.writeText(input.value);
      $("calendar-feed-status").textContent = "Ссылка скопирована. Добавьте её в Google Calendar через «Другие календари → Добавить по URL».";
    } catch (_) {
      input.focus(); input.select();
      $("calendar-feed-status").textContent = "Ссылка выделена. Скопируйте её и вставьте в Google Calendar через «Другие календари → Добавить по URL».";
    }
  });

  $("main-button").addEventListener("click", next);
  $("retry-items").addEventListener("click", loadItems);
  $("back-button").addEventListener("click", back);
  $("tab-new").addEventListener("click", () => {
    clearError(); state.view = "flow";
    if (state.step === 4) { state.step = 0; state.quantities.clear(); state.items = []; state.requestId = null; $("start").value = ""; $("end").value = ""; }
    syncDateFields("start"); syncDateFields("end");
    render();
  });
  $("tab-orders").addEventListener("click", showOrders);
  $("tab-admin").addEventListener("click", () => showAdmin(state.adminMode));
  $("identity-close").addEventListener("click", () => { $("identity-form").reset(); state.consent = null; state.identityBookingId = null; showOrders(); });
  $("document-viewer-close").addEventListener("click", closeDocumentViewer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("document-viewer").hidden) closeDocumentViewer(); });
  $("document-viewer-prev").addEventListener("click", async () => { if (documentViewerIndex > 0) { documentViewerIndex -= 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("document-viewer-next").addEventListener("click", async () => { if (documentViewerIndex < documentViewerItems.length - 1) { documentViewerIndex += 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("consent-next").addEventListener("click", async () => {
    if (!state.consent) return showError("Текст согласия не загружен.");
    if (!$("consent-check").checked) return showError("Чтобы продолжить, подтвердите согласие.");
    clearError(); const button = $("consent-next"); button.disabled = true;
    try {
      await restoreReusableIdentityPhotos();
      $("consent-step").hidden = true; $("identity-form").hidden = false;
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });
  $("identity-form").addEventListener("submit", submitIdentity);
  document.querySelectorAll('#identity-form input:not([type="file"]), #identity-form textarea').forEach((input) => input.addEventListener("input", () => clearIdentityFieldError(input)));
  $("registration_address").addEventListener("input", (event) => scheduleAddressSuggestions(event.currentTarget.value));
  $("registration_address").addEventListener("keydown", (event) => { if (event.key === "Escape") closeAddressSuggestions(); });
  document.addEventListener("click", (event) => { if (!event.target.closest(".address-search")) closeAddressSuggestions(); });
  document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => input.addEventListener("change", async () => {
    const file = input.files?.[0] || null; await saveIdentityPhoto(input.name, file);
    const status = input.closest(".field")?.querySelector(".file-draft-status");
    if (status) status.textContent = file ? `Сохранено на этом устройстве: ${file.name}` : "";
    clearIdentityFieldError(input);
  }));
  document.querySelectorAll(".admin-mode").forEach((button) => button.addEventListener("click", () => showAdmin(button.dataset.mode)));
  $("done-orders").addEventListener("click", showOrders);
  $("done-chat").addEventListener("click", () => tg?.close?.());
  for (const id of ["start", "end"]) {
    for (const part of ["date", "time"]) $(`${id}-${part}`).addEventListener("input", () => { syncDateTime(id); applyBookingDateLimits(); state.items = []; state.quantities.clear(); state.requestId = null; fieldError(id, ""); saveDraft(); });
  }
  document.querySelectorAll(".duration-option").forEach((button) => button.addEventListener("click", () => applyDuration(Number(button.dataset.days))));
  $("duration-apply").addEventListener("click", () => applyDuration(Number($("duration-days").value)));
  for (const id of ["customer-name", "customer-contact"]) $(id).addEventListener("input", () => { state.requestId = null; contactEdited = true; fieldError(id, ""); saveContact(); });
  const passportCombinedInput = document.querySelector('[name="passport_combined"]');
  passportCombinedInput?.addEventListener("input", () => { const digits = passportCombinedInput.value.replace(/\D/g, "").slice(0, 10); passportCombinedInput.value = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits; });
  const divisionInput = document.querySelector('[name="passport_division_code"]');
  divisionInput?.addEventListener("input", () => { const digits = divisionInput.value.replace(/\D/g, "").slice(0, 6); divisionInput.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits; });
  const sameAddressInput = document.querySelector('[name="same_address"]');
  const registrationInput = document.querySelector('[name="registration_address"]');
  const residentialInput = document.querySelector('[name="residential_address"]');
  sameAddressInput?.addEventListener("change", () => { residentialInput.readOnly = sameAddressInput.checked; if (sameAddressInput.checked) residentialInput.value = registrationInput.value; });
  registrationInput?.addEventListener("input", () => { if (sameAddressInput?.checked) residentialInput.value = registrationInput.value; });

  const hasDraft = restoreDraft();
  const hasSavedContact = restoreContact();
  void pruneExpiredIdentityPhotos();
  syncDateFields("start"); syncDateFields("end"); applyBookingDateLimits();
  const profile = tg?.initDataUnsafe?.user;
  if (authorized && profile && !$("customer-name").value) {
    $("customer-name").value = [profile.first_name, profile.last_name].filter(Boolean).join(" ").slice(0, 200);
  }
  void restoreLastBookingContact(hasSavedContact);
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
