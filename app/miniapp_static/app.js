(async () => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  window.polyRentalApplyTheme?.();
  tg?.onEvent?.("themeChanged", () => window.polyRentalApplyTheme?.());
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  let siteProfile = null;
  if (!tg?.initData && location.pathname === "/site") {
    try { const response = await fetch("/api/site/session", {cache:"no-store"}); if (response.ok) siteProfile = await response.json(); else { location.replace("/site/login"); return; } }
    catch (_) { document.body.textContent = "Не удалось проверить вход. Обновите страницу."; return; }
  }
  const authorized = Boolean(tg?.initData || siteProfile);
  const keyboardMode = !authorized && !preview && Boolean(tg?.sendData) && Boolean(tg?.platform) && tg.platform !== "unknown";
  const draftKey = `polyrental-booking-draft-v2:${tg?.initDataUnsafe?.user?.id || siteProfile?.id || "local"}`;
  const contactKey = `polyrental-booking-contact-v1:${tg?.initDataUnsafe?.user?.id || siteProfile?.id || "local"}`;
  const $ = (id) => document.getElementById(id);
  const sections = ["step-dates", "step-items", "step-contact", "step-review"];
  const state = { step: 0, view: "flow", items: [], quantities: new Map(), requestId: null, busy: false, booking: null, role: null, identityBookingId: null, identityNeedsChanges: false, identityRequiredPhotos: [], identityReusableDocuments: [], identityLegacyInstitution: null, universities: [], consent: null, adminMode: "orders", profile: null, onboardingLoading: false, onboardingPending: false, profileFilter: "active", profilePage: 0, profileNumber: "", adminRequestFilter: "all", cartVersion: null };
  const catalogView = { query: "", status: "all", expanded: new Set() };
  let selectedRequestId = null;
  let selectedCustomerOrderId = null;
  let pendingDeletion = null;
  let deleteUndoSeconds = 5;
  let adminRenderSequence = 0;
  let profileLoadSequence = 0;
  let availabilitySequence = 0;
  let leaseRefreshTimer = null;
  let adminOrdersSnapshot = null, customerOrdersSnapshot = null, workflowRefreshBusy = false;
  let addressSuggestTimer = null;
  let addressSuggestController = null;
  let addressSuggestSequence = 0;
  let contactEdited = false;
  let rangeCalendar = null;
  let schedulePolicy = null;
  let availabilityFresh = true;
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
  const categoryMeta = {
    camera: ["Камера", "camera"], optics: ["Оптика", "lens"], light: ["Свет", "light"],
    battery: ["Питание", "battery"], accessory: ["Аксессуар", "accessory"], generic: ["Оборудование", "equipment"],
  };
  function setCategories(categories) {
    for (const category of categories) categoryMeta[category.code] = [category.name, categoryMeta[category.code]?.[1] || "equipment"];
  }
  function categoryOptions(selected) {
    return Object.entries(categoryMeta).map(([code, meta]) => `<option value="${escapeHtml(code)}" ${code === selected ? "selected" : ""}>${escapeHtml(meta[0])}</option>`).join("");
  }
  async function createCategoryDialog() {
    let created = null;
    const data = await workflowDialog("Создать категорию", '<label class="field"><span>Название категории</span><input name="name" maxlength="100" required></label>', "Создать", null,
      async values => { created = await api("/api/miniapp/admin/catalog/categories", {method:"POST", body:JSON.stringify({name:values.get("name")})}); });
    if (!data) return null;
    setCategories([created]);
    return created;
  }
  function categoryLabel(category) { return categoryMeta[category]?.[0] || categoryMeta.generic[0]; }
  function catalogType(item) {
    return item.category && item.category !== "generic" ? categoryLabel(item.category) : (item.description || categoryLabel(item.category));
  }
  function catalogTitle(item) {
    return item.name || item.title || catalogType(item);
  }
  function catalogMedia(item, className) {
    if(item.image_data && /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(item.image_data))return `<img class="${className}-photo" src="${escapeHtml(item.image_data)}" alt="Фото: ${escapeHtml(item.name)}" loading="lazy">`;
    if (item.image_url && /^https:\/\//i.test(item.image_url)) return `<img class="${className}-photo" src="${escapeHtml(item.image_url)}" alt="Фото: ${escapeHtml(item.name)}" loading="lazy">`;
    const meta = categoryMeta[item.category] || categoryMeta.generic;
    return `<div class="${className}-placeholder" aria-label="${escapeHtml(meta[0])}"><svg class="placeholder-icon icon" aria-hidden="true"><use href="#icon-${meta[1]}"></use></svg><small>${escapeHtml(meta[0])}</small></div>`;
  }
  function conditionLabel(condition) { return ({ available: "Доступен", maintenance: "На ремонте", retired: "Выведен из эксплуатации" })[condition] || condition; }
  function toIso(value) {
    const text = String(value || "").trim();
    let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+03:00`;
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return match ? `${text}:00+03:00` : "";
  }
  function datePickerText(value) {
    return value ? new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC", day: "numeric", month: "short"}).format(new Date(`${value}T12:00:00Z`)) : "дата";
  }
  function syncDateTime(id) {
    const date = $(`${id}-date`).value, time = $(`${id}-time`).value;
    $(id).value = date && time ? `${date}T${time}` : "";
  }
  function syncDateFields(id) {
    const match = String($(id).value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    $(`${id}-date`).value = match?.[1] || "";
    $(`${id}-time`).value = match?.[2] || "12:00";
  }
  function moscowDateIso(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const addIsoDays = window.PolyRentalCalendar.addDays;
  function minimumBookingDate() { return moscowDateIso(); }
  function bookingDateLabel(value) {
    return new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC", day: "numeric", month: "long"}).format(new Date(`${value}T12:00:00Z`));
  }
  function dateValidationMessage() {
    return window.PolyRentalCalendar.periodError($("start").value, $("end").value, minimumBookingDate()) || schedulePeriodError();
  }
  function scheduleDayDisabled(day) {
    if (!schedulePolicy?.enforced) return false;
    if (schedulePolicy.working_dates.includes(day)) return false;
    const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
    return weekday===0||weekday===6||schedulePolicy.closed_dates.includes(day)||schedulePolicy.annual_holidays.includes(day.slice(5));
  }
  function schedulePeriodError() {
    if (!schedulePolicy?.enforced) return "";
    for (const id of ["start","end"]) {
      const value=$(id).value; if (!value) continue;
      const month=Number(value.slice(5,7)),hours=month>=6&&month<=8?schedulePolicy.summer:schedulePolicy.normal;
      if (scheduleDayDisabled(value.slice(0,10))||value.slice(11,16)<hours.start||value.slice(11,16)>hours.end) return `Выдача и приём доступны в рабочие дни, ${hours.start}–${hours.end} по Москве.`;
    }
    return "";
  }
  function applyBookingDateLimits() {
    $("start-hint").textContent = `Выдача с ${bookingDateLabel(minimumBookingDate())}. Время по Москве.`;
    for (const id of ["start", "end"]) {
      if (schedulePolicy?.enforced) {
        const month=Number($(`${id}-date`).value.slice(5,7)),hours=month>=6&&month<=8?schedulePolicy.summer:schedulePolicy.normal;
        $(`${id}-time`).min=hours.start; $(`${id}-time`).max=hours.end;
      }
      $(`${id}-time-label`).textContent = `${id === "start" ? "Получение" : "Возврат"} · ${$(`${id}-date`).value ? datePickerText($(`${id}-date`).value) : "выберите дату"}`;
      $(`${id}-time`).disabled = !$("end-date").value;
    }
    const start = $("start").value, end = $("end").value;
    $("period-summary").textContent = start && end ? `${datePickerText($("start-date").value)}, ${$("start-time").value} — ${datePickerText($("end-date").value)}, ${$("end-time").value} · МСК` : $("start-date").value ? `${datePickerText($("start-date").value)} — выберите конец` : "Выберите начало и конец";
    $("period-error").textContent = dateValidationMessage();
  }
  function periodChanged() {
    syncDateTime("start"); syncDateTime("end"); applyBookingDateLimits();
    state.requestId = null;
    fieldError("start", ""); fieldError("end", ""); saveDraft(); render();
  }
  function ensureBookingPeriod() {
    if ($("start-date").value && $("start-date").value < minimumBookingDate()) {
      $("start").value = ""; $("end").value = ""; syncDateFields("start"); syncDateFields("end"); return false;
    }
    return Boolean($("start-date").value && $("end-date").value);
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
    const input = $(id); const focusTarget = $(`${id}-time`) || input; const error = $(`${id === "customer-name" ? "name" : id === "customer-contact" ? "contact" : id}-error`);
    focusTarget.setAttribute("aria-invalid", String(Boolean(message)));
    error.textContent = message || ""; error.hidden = !message;
    if (message) focusTarget.focus();
  }
  let cartDirty = false, cartTimer = null, cartSaving = null;
  function cartPayload() {
    return { start: $("start").value, end: $("end").value,
      lines: [...state.quantities].map(([article_id, quantity]) => ({ article_id, quantity })), version: state.cartVersion };
  }
  async function flushCart() {
    if (cartTimer) { clearTimeout(cartTimer); cartTimer = null; }
    if (cartSaving) { await cartSaving; if (cartDirty) return flushCart(); return; }
    if (!cartDirty || !Number.isInteger(state.cartVersion)) return;
    cartDirty = false;
    cartSaving = api("/api/miniapp/cart", { method: "PUT", body: JSON.stringify(cartPayload()) });
    try { const result = await cartSaving; state.cartVersion = result.version; }
    catch (error) { cartDirty = true; throw error; }
    finally { cartSaving = null; }
    if (cartDirty) return flushCart();
  }
  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ start: $("start").value, end: $("end").value, quantities: [...state.quantities] })); } catch (_) { /* storage can be disabled */ }
    if (authorized && Number.isInteger(state.cartVersion)) {
      cartDirty = true; clearTimeout(cartTimer);
      cartTimer = setTimeout(() => { void flushCart().catch((error) => { $("mode-banner").hidden = false; $("mode-banner").textContent = `Не удалось синхронизировать подборку: ${error.message}`; }); }, 300);
    }
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
  function identityPhotoKey(kind, bookingId = state.identityBookingId) {
    const userId = tg?.initDataUnsafe?.user?.id || siteProfile?.id || "user";
    return `${userId}:${bookingId}:${kind}`;
  }
  async function saveIdentityPhoto(kind, file, bookingId = state.identityBookingId) {
    const key = identityPhotoKey(kind, bookingId);
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
      if (status) status.textContent = entry ? `Загружено ✓ · ${entry.name}`
        : savedDocuments.includes(input.name) ? "Загружено ✓ · сохранено в заявке"
        : "";
    }
  }
  async function restoreReusableIdentityPhotos(bookingId, documents = state.identityReusableDocuments) {
    await Promise.all(documents.map(async (kind) => {
      const key = identityPhotoKey(kind, bookingId);
      let entry = identityPhotoDrafts.get(key);
      if (!entry) {
        try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; }
      }
      if (entry && Date.now() - entry.savedAt <= photoDraftLifetime) {
        identityPhotoDrafts.set(key, entry);
        return;
      }
      const input = document.querySelector(`#identity-form [name="${kind}"]`);
      const status = input?.closest(".field")?.querySelector(".file-draft-status");
      try {
        const response = await fetch(`/api/miniapp/bookings/${bookingId}/identity/reusable-profile/documents/${kind}`, {
          headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store",
        });
        if (!response.ok) throw new Error("download failed");
        const blob = await response.blob();
        if (state.identityBookingId !== bookingId) return;
        await saveIdentityPhoto(kind, new File([blob], `previous-${kind}.jpg`, { type: blob.type || "image/jpeg" }), bookingId);
        if (status) status.textContent = "Фото из предыдущей анкеты прикреплено. Новое фото заменит его.";
      } catch (_) {
        if (status) status.textContent = "Не удалось перенести фото автоматически. Прикрепите его вручную.";
      }
    }));
  }
  async function clearIdentityPhotoDrafts(bookingId) {
    const userId = tg?.initDataUnsafe?.user?.id || siteProfile?.id || "user";
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
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.body instanceof FormData?120000:20000);
    let response;
    try { response = await fetch(path, {
      ...options,
      signal:options.signal || controller.signal,
      headers: { "X-Telegram-Init-Data": tg?.initData || "", ...((options.body && !(options.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store",
    }); } catch(error) { if(error.name==="AbortError")throw new Error("Сервер не ответил вовремя. Повторите попытку.");throw error; } finally {clearTimeout(timer);}
    let body;
    try { body = await response.json(); } catch (_) { throw new Error("Сервер вернул неожиданный ответ. Попробуйте ещё раз."); }
    if (!response.ok) {
      const detail = typeof body.detail === "string" ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((item) => item.msg || item.message || "").filter(Boolean).join("; ")
        : "";
      const structured = body.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail : null;
      const error = new Error(structured?.message || detail || "Не удалось выполнить запрос. Попробуйте ещё раз.");
      error.status = response.status;
      const formFields = new Set(["full_name", "birth_date", "passport_combined", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution", "passport_main", "passport_registration", "student_front"]);
      const invalidField = Array.isArray(body.detail) ? body.detail.map((item) => item.loc?.at(-1)).find((field) => formFields.has(field)) : null;
      if (typeof structured?.field === "string") error.field = structured.field;
      else if (invalidField) error.field = invalidField;
      throw error;
    }
    return body;
  }

  function render() {
    if (state.view !== "admin") document.querySelectorAll(".request-card").forEach(clearRequestReview);
    document.body.classList.toggle("dates-view", state.view === "flow" && state.step === 0);
    const done = state.step === 4;
    $("booking-flow").hidden = state.view !== "flow";
    $("booking-blocked").hidden = state.view !== "blocked";
    $("orders-panel").hidden = state.view !== "orders";
    $("identity-panel").hidden = state.view !== "identity";
    $("admin-panel").hidden = state.view !== "admin";
    $("tab-new").classList.toggle("active", state.view === "flow");
    $("tab-orders").classList.toggle("active", state.view === "orders");
    $("tab-admin").classList.toggle("active", state.view === "admin");
    $("tab-new").setAttribute("aria-current", state.view === "flow" ? "page" : "false");
    $("tab-orders").setAttribute("aria-current", state.view === "orders" ? "page" : "false");
    $("page-title").textContent = state.view === "admin" ? "Управление арендой" : state.view === "identity" ? "Документы для договора" : state.view === "orders" ? "Профиль" : done ? "Заявка оформлена" : "Найдём всё для вашей съёмки";
    $("page-intro").textContent = state.view === "admin" ? "Комплектация, проверки, возврат, каталог и ремонт." : state.view === "identity" ? "Защищённая передача данных напрямую в ПолиРентал." : state.view === "orders" ? "Здесь можно следить за статусом и отменить активную заявку." : done ? "Менеджер получил запрос и скоро ответит." : "Выберите сроки и оборудование. На оформление уйдёт пара минут.";
    sections.forEach((id, index) => { $(id).hidden = state.view !== "flow" || state.step !== index; });
    $("step-done").hidden = state.view !== "flow" || !done;
    const showAction = state.view === "flow" && !done && $("onboarding-dialog").hidden && $("support-dialog").hidden;
    $("action-bar").hidden = !showAction;
    $("back-button").hidden = state.step === 0;
    const labels = ["Далее к каталогу", "К подборке", "Проверить заявку", "Отправить заявку"];
    $("main-button").textContent = state.busy ? "Подождите…" : labels[state.step] || "Продолжить";
    $("main-button").disabled = state.busy || (state.step === 0 && Boolean(dateValidationMessage())) || (!authorized && !keyboardMode && !preview);
    // A previously displayed native control can survive a Mini App reopen.
    // Always remove it before rendering the in-app action bar.
    tg?.MainButton?.hide();
    tg?.BackButton?.hide();
    if (tg && (authorized || keyboardMode)) {
      if (done) tg.disableClosingConfirmation?.(); else tg.enableClosingConfirmation?.();
    }
  }

  function validateDates() {
    clearError(); applyBookingDateLimits();
    if (dateValidationMessage()) { render(); return false; }
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
    const sequence = ++availabilitySequence;
    const periodStart = $("start").value, periodEnd = $("end").value;
    const previousItems = state.items;
    state.items = [];
    $("items-grid").replaceChildren();
    $("items-status").hidden = false; $("items-status").textContent = "Проверяем доступность оборудования…";
    $("retry-items").hidden = true;
    $("period-label").textContent = `${dateText(toIso($("start").value))} — ${dateText(toIso($("end").value))} · МСК`;
    try {
      const data = preview ? { items: exampleItems, unavailable_count: 0, unavailable: [] } : await api(`/api/miniapp/availability?start=${encodeURIComponent(toIso($("start").value))}&end=${encodeURIComponent(toIso($("end").value))}`);
      if (sequence !== availabilitySequence || periodStart !== $("start").value || periodEnd !== $("end").value) return false;
      state.items = data.all_items || data.items;
      availabilityFresh=true;
      for (const [id] of state.quantities) {
        if (!state.items.some((item) => item.id === id)) {
          const previous = previousItems.find((item) => item.id === id);
          state.items.push({ ...(previous || { id, name: "Позиция больше недоступна", description: "" }), available_quantity: 0 });
        }
      }
      if (state.items.length) {
        $("items-status").textContent = data.unavailable_count ? `${data.unavailable_count} позиций недоступно в выбранный период.` : "Все показанные экземпляры свободны на выбранный срок.";
        $("items-status").hidden = !data.unavailable_count;
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
      renderItems(); return true;
    } catch (error) {
      $("items-status").textContent = `Не удалось загрузить оборудование: ${error.message}`;
      $("retry-items").hidden = false;
      showError(error.message);
      return false;
    }
  }
  function markAvailabilityStale(message="Доступность проверяется…") {
    availabilityFresh=false;
    document.querySelectorAll("#items-grid .available-badge").forEach(node=>node.textContent=message);
    document.querySelectorAll("#items-grid .quantity-control .plus").forEach(button=>button.disabled=true);
    $("items-status").textContent=message;$("items-status").hidden=false;$("retry-items").hidden=false;
  }
  async function refreshAvailability(invalidated = false) {
    if (!authorized || state.view !== "flow" || state.step !== 1 || state.busy || document.hidden) return;
    const sequence = ++availabilitySequence, start = $("start").value, end = $("end").value;
    if(invalidated===true)markAvailabilityStale();
    try {
      const data = await api(`/api/miniapp/availability?start=${encodeURIComponent(toIso(start))}&end=${encodeURIComponent(toIso(end))}`);
      if (sequence !== availabilitySequence || state.view !== "flow" || state.step !== 1 || start !== $("start").value || end !== $("end").value) return;
      const next = data.all_items || data.items;
      for (const [id] of state.quantities) if (!next.some((item) => item.id === id)) {
        const previous = state.items.find((item) => item.id === id);
        next.push({...(previous || {id, name:"Позиция больше недоступна", description:""}), available_quantity:0});
      }
      const wasStale = !availabilityFresh;
      const key = (items) => JSON.stringify(items.map((item) => [item.id, item.available_quantity, item.next_available_start, item.title, item.name]));
      if (key(next) !== key(state.items)) {
        const offset = window.scrollY; state.items = next; availabilityFresh=true; renderItems(); window.scrollTo(window.scrollX, offset);
        $("items-status").textContent = "Доступность обновлена с учётом других заявок.";
        $("items-status").hidden = false;
      }
      if(!availabilityFresh){availabilityFresh=true;state.items=next;renderItems();}
      if(wasStale){$("items-status").textContent="Доступность обновлена.";$("items-status").hidden=false;}
      $("retry-items").hidden=true;
    } catch (_) { if(sequence===availabilitySequence)markAvailabilityStale("Нет свежих данных. Повторите проверку доступности."); }
  }
  setInterval(refreshAvailability, 5000);
  async function followAvailabilityEvents() {
    if (!authorized || typeof TextDecoder !== "function") return;
    while (true) {
      try {
        const response = await fetch("/api/miniapp/availability/events", {headers:{"X-Telegram-Init-Data":tg?.initData || ""}, cache:"no-store"});
        if (!response.ok || !response.body?.getReader) throw new Error("events unavailable");
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream:true});
          const parts = buffer.split("\n\n"); buffer = parts.pop();
          if (parts.some((part) => part.includes("data: changed"))) void refreshAvailability(true);
        }
      } catch (_) { /* Periodic refresh remains available while reconnecting. */ }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  void followAvailabilityEvents();
  function renderItems() {
    $("items-grid").replaceChildren();
    const query = $("client-catalog-search").value.trim().toLocaleLowerCase("ru-RU");
    for (const item of state.items) {
      if (query && ![item.title, item.name, item.description, item.brand, item.kind, item.key_spec, item.sku].join(" ").toLocaleLowerCase("ru-RU").includes(query)) continue;
      const quantity = state.quantities.get(item.id) || 0;
      const selected = quantity > 0;
      const unavailable = item.available_quantity < 1;
      const card = document.createElement("article");
      card.className = `item-card${selected ? " selected" : ""}${unavailable ? " unavailable" : ""}`;
      const media = catalogMedia(item, "item");
      const typeNote = item.description && item.description !== catalogType(item) ? `<span class="item-type">${escapeHtml(item.description)}</span>` : "";
      card.innerHTML = `${media}<div class="item-main"><div class="item-top"><div>${typeNote}<h3 class="item-name">${escapeHtml(catalogTitle(item))}</h3><span class="available-badge">${unavailable ? "Нет в наличии на выбранные даты" : `Доступно: ${item.available_quantity} шт.`}</span>${unavailable && item.next_available_start ? `<p>Ближайшее доступное окно: с ${escapeHtml(dateText(item.next_available_start))} МСК</p>` : ""}${quantity > item.available_quantity ? `<p role="status">Осталось ${item.available_quantity} шт. Уменьшите количество.</p>` : ""}<div class="item-notes"></div></div></div><div class="quantity-control"><button type="button" class="button ghost minus" aria-label="Уменьшить количество: ${escapeHtml(catalogTitle(item))}" ${quantity === 0 ? "disabled" : ""}>−</button><strong aria-live="polite">${quantity}</strong><button type="button" class="button ghost plus" aria-label="Увеличить количество: ${escapeHtml(catalogTitle(item))}" ${quantity >= Math.min(30, item.available_quantity) || !availabilityFresh ? "disabled" : ""}>+</button></div></div>`;
      const changeQuantity = (next) => { if (next > 0) state.quantities.set(item.id, next); else state.quantities.delete(item.id); state.requestId = null; renderItems(); saveDraft(); };
      card.querySelector(".minus").addEventListener("click", () => changeQuantity(quantity - 1));
      card.querySelector(".plus").addEventListener("click", () => changeQuantity(quantity + 1));
      if (!availabilityFresh) card.querySelector(".available-badge").textContent = "Нужна свежая проверка";
      const notes = card.querySelector(".item-notes");
      if (item.name && item.name !== catalogTitle(item)) { const full = document.createElement("p"); full.textContent = item.name; notes.append(full); }
      if (item.owners?.length) { const owner = document.createElement("p"); owner.textContent=`Владелец: ${item.owners.join(", ")}`; notes.append(owner); }
      for (const block of item.unavailability || []) { const note=document.createElement("p"); note.textContent=`Занято вне сервиса: ${block.reason}, до ${dateText(block.end)} МСК`; notes.append(note); }
      $("items-grid").append(card);
    }
    $("selected-count").textContent = [...state.quantities.values()].reduce((sum, value) => sum + value, 0);
  }
  function renderCart() {
    const container = $("cart-items"); container.replaceChildren();
    for (const [id, quantity] of state.quantities) {
      const item = state.items.find((row) => row.id === id) || {id, name:"Позиция недоступна", available_quantity:0};
      const row = document.createElement("article"); row.className = "order-card";
      const title = document.createElement("h3"); title.textContent = catalogTitle(item); row.append(title);
      if (quantity > item.available_quantity) { const warning = document.createElement("p"); warning.setAttribute("role", "status"); warning.textContent = `Осталось ${item.available_quantity} шт. Уменьшите количество или удалите позицию.`; row.append(warning); }
      const controls = document.createElement("div"); controls.className = "quantity-control";
      controls.innerHTML = `<button type="button" class="button ghost minus" aria-label="Уменьшить количество">−</button><strong>${quantity}</strong><button type="button" class="button secondary plus" aria-label="Увеличить количество" ${quantity >= Math.min(30, item.available_quantity) ? "disabled" : ""}>+</button>`;
      controls.querySelector(".minus").addEventListener("click", () => { if (quantity <= 1) state.quantities.delete(id); else state.quantities.set(id, quantity - 1); state.requestId = null; renderCart(); saveDraft(); });
      controls.querySelector(".plus").addEventListener("click", () => { state.quantities.set(id, quantity + 1); state.requestId = null; renderCart(); saveDraft(); });
      row.append(controls); container.append(row);
    }
    const total = [...state.quantities.values()].reduce((sum, quantity) => sum + quantity, 0);
    $("cart-total").textContent = total ? `Всего: ${total} шт.` : "Подборка пуста. Вернитесь в каталог, чтобы добавить оборудование.";
  }
  function reviewRow(label, value, extraClass = "") { return `<div class="review-row"><span>${escapeHtml(label)}</span><strong class="${extraClass}">${escapeHtml(value)}</strong></div>`; }
  function renderReview() {
    const chosen = state.items.filter((item) => (state.quantities.get(item.id) || 0) > 0);
    const itemCount = chosen.reduce((sum, item) => sum + state.quantities.get(item.id), 0);
    $("review-content").innerHTML = `<section class="review-group"><h3 class="review-heading">Срок аренды</h3>${reviewRow("Получение", reviewDateTime(toIso($("start").value)))}${reviewRow("Возврат", reviewDateTime(toIso($("end").value)))}</section><section class="review-group"><h3 class="review-heading">Оборудование · ${itemCount} шт.</h3><ul class="review-items">${chosen.map((item) => `<li>${catalogMedia(item, "review")}<div class="review-item-main"><strong>${escapeHtml(catalogTitle(item))}</strong><span>${state.quantities.get(item.id)} шт. в заявке</span><div class="quantity-control"><button type="button" class="button ghost review-minus" data-id="${item.id}" aria-label="Уменьшить количество: ${escapeHtml(catalogTitle(item))}" ${itemCount === 1 ? "disabled" : ""}>−</button><strong>${state.quantities.get(item.id)}</strong><button type="button" class="button ghost review-plus" data-id="${item.id}" aria-label="Увеличить количество: ${escapeHtml(catalogTitle(item))}" ${state.quantities.get(item.id) >= Math.min(30, item.available_quantity) ? "disabled" : ""}>+</button></div></div></li>`).join("")}</ul></section><section class="review-group"><h3 class="review-heading">Контакт для связи</h3>${reviewRow("Имя", $("customer-name").value.trim())}${reviewRow("Телефон или Telegram", $("customer-contact").value.trim())}</section>`;
    $("review-content").querySelectorAll(".review-minus, .review-plus").forEach((button) => button.addEventListener("click", () => {
      const id = Number(button.dataset.id), quantity = state.quantities.get(id) || 0;
      const nextQuantity = quantity + (button.classList.contains("review-plus") ? 1 : -1);
      if (nextQuantity > 0) state.quantities.set(id, nextQuantity); else state.quantities.delete(id);
      state.requestId = null; saveDraft(); renderCart(); renderReview();
      $("review-content").querySelector(`.${button.classList.contains("review-plus") ? "review-plus" : "review-minus"}[data-id="${id}"]`)?.focus();
    }));
  }

  async function next() {
    if (state.busy || state.view !== "flow") return;
    clearError();
    if (!authorized && !keyboardMode && !preview) return showError("Откройте приложение кнопкой в чате с ботом Telegram.");
    if (state.step === 0) {
      if (!validateDates()) return;
      saveDraft(); state.step = 1; render(); await loadItems();
    } else if (state.step === 1) {
      if(!availabilityFresh)return showError("Сначала повторите проверку доступности.");
      if (![...state.quantities.values()].some((quantity) => quantity > 0)) return showError("Выберите хотя бы одну единицу оборудования.");
      state.step = 2; renderCart(); render(); $("customer-name").focus();
    } else if (state.step === 2) {
      if (![...state.quantities.values()].some((quantity) => quantity > 0)) return showError("Подборка пуста. Добавьте оборудование в каталоге.");
      if (!validateContacts()) return;
      state.busy = true; render();
      const loaded = await loadItems();
      state.busy = false;
      if (!loaded) { render(); return; }
      if ([...state.quantities].some(([id, quantity]) => quantity > (state.items.find((item) => item.id === id)?.available_quantity || 0))) { state.step = 1; render(); return showError("Выбранного количества уже нет. Уменьшите количество или замените позиции."); }
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
    if (authorized && (cartDirty || cartSaving)) { try { await flushCart(); } catch (error) { return showError(`Не удалось сохранить подборку: ${error.message}`); } }
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
      if (Number.isInteger(state.cartVersion)) {
        try { const result = await api("/api/miniapp/cart", { method: "PUT", body: JSON.stringify({start:"", end:"", lines:[], version:state.cartVersion}) }); state.cartVersion = result.version; cartDirty = false; }
        catch (_) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Заявка отправлена, но очистить подборку на сервере не удалось."; }
      }
      $("done-title").textContent = `Заявка ${booking.human_number || `№${booking.id}`} создана`;
      $("done-description").textContent = "Заявка будет ждать решения оператора без ограничения по времени. Статус доступен в профиле.";
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch (error) {
      const changed = error.message.includes("Цена изменилась") || error.message.includes("занято") || error.message.includes("недоступно") || error.message.includes("Недостаточно свободных единиц");
      if (changed) { state.requestId = null; state.step = 1; await loadItems(); }
      showError(changed ? `${error.message} Выберите оборудование и проверьте заказ снова.` : error.message);
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally { state.busy = false; render(); }
  }

  const statusNames = { needs_changes: "Нужно исправить", pending: "Ожидает проверки", confirmed: "Подтверждена", preparing: "Комплектуется", ready: "Готова", issued: "В аренде", return_inspection: "Проверяется", returned: "Завершена", cancelled: "Отменена", expired: "Удержание истекло" };
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
    const sequence = ++profileLoadSequence;
    clearError(); state.view = "orders"; render();
    $("profile-name").textContent = state.profile?.display_name || "Профиль Telegram";
    $("profile-contact").textContent = state.profile?.contact || "";
    $("reminders-enabled").checked = state.profile?.reminders_enabled !== false;
    $("reminders-enabled").disabled = !authorized || !state.profile || typeof state.profile.reminders_enabled !== "boolean";
    $("profile-since").textContent = state.profile?.member_since ? `С нами с ${new Date(state.profile.member_since).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}` : "";
    $("orders-content").textContent = "Загружаем заявки…";
    if (authorized) api("/api/miniapp/support/threads").then((result) => { if (sequence === profileLoadSequence && state.view === "orders") $("profile-support-status").textContent = (result.items || []).map((thread) => `${thread.request_number || "Общее обращение"}: ${thread.status}`).join(" · "); }).catch(() => {});
    if (preview) { $("orders-content").textContent = "В демонстрации заявок нет. Откройте Mini App через Telegram, чтобы увидеть свои заявки."; return; }
    if (keyboardMode) { $("orders-content").textContent = "Вернитесь в чат с ботом и нажмите «Мои заявки». Там же можно узнать статус и связаться с менеджером."; return; }
    if (!authorized) { $("orders-content").textContent = "Откройте приложение через Telegram."; return; }
    try {
      const result = await api(`/api/miniapp/profile/history?category=${encodeURIComponent(state.profileFilter)}&page=${state.profilePage}&number=${encodeURIComponent(state.profileNumber)}${state.profileTargetId ? `&booking_id=${state.profileTargetId}` : ""}`);
      if (sequence !== profileLoadSequence || state.view !== "orders") return;
      $("orders-content").replaceChildren();
      customerOrdersSnapshot = workflowSnapshot(result);
      const filtered = result.items;
      const pages = Math.max(1, Math.ceil((result.total ?? filtered.length) / 10));
      if (state.profilePage >= pages) { state.profilePage = pages - 1; return showOrders(); }
      $("profile-pagination").hidden = pages <= 1;
      $("profile-prev").disabled = state.profilePage === 0; $("profile-next").disabled = state.profilePage >= pages - 1;
      $("profile-page").textContent = `${state.profilePage + 1} / ${pages}`;
      if (!filtered.length) { $("orders-content").textContent = "В этой категории заявок пока нет."; return; }
      for (const order of filtered) {
        const outer = document.createElement("article"); outer.className = "order-card customer-order-card"; outer.dataset.bookingId = String(order.id);
        const accordion = document.createElement("details"); accordion.className = "customer-order-accordion"; accordion.open = selectedCustomerOrderId === order.id;
        const toggle = document.createElement("summary"); toggle.className = "customer-order-toggle";
        toggle.innerHTML = `<span class="order-head"><strong>Заявка ${escapeHtml(order.human_number || `№${order.id}`)}</strong><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></span><span class="customer-order-period">${escapeHtml(dateText(order.starts_at))} — ${escapeHtml(dateText(order.ends_at))} МСК</span><span class="customer-order-items">${order.items.map((item) => `${escapeHtml(item.title || item.name)} × ${item.quantity}`).join(", ")}</span>`;
        const card = document.createElement("div"); card.className = "customer-order-body";
        if (order.estimated_until) { const estimate = document.createElement("p"); estimate.textContent = `В обработке, ориентировочно до ${dateText(order.estimated_until)} МСК`; card.append(estimate); }
        const help = document.createElement("button"); help.type = "button"; help.className = "button secondary"; help.textContent = "Поддержка";
        help.addEventListener("click", () => openSupport("request", order.id)); card.append(help);
        if (order.receipt_available) {
          const receipt = document.createElement("button"); receipt.type = "button"; receipt.className = "button secondary"; receipt.textContent = "Скачать расписку";
          receipt.addEventListener("click", async () => {
            receipt.disabled = true;
            try { await downloadSecure(`/api/miniapp/bookings/${order.id}/receipt`, `receipt-${(order.human_number || "request").replace("ТС", "TS")}.docx`); }
            catch (error) { showError(error.message); } finally { receipt.disabled = false; }
          });
          card.append(receipt);
        }
        const repeat = document.createElement("button"); repeat.type = "button"; repeat.className = "button secondary"; repeat.textContent = "Повторить заявку";
        repeat.addEventListener("click", () => {
          clearError();
          state.quantities = new Map(order.items.map((item) => [item.id, item.quantity]));
          state.items = order.items.map((item) => ({ ...item, available_quantity: 0 }));
          state.requestId = null; state.booking = null; state.view = "flow"; state.step = 0;
          $("start").value = ""; $("end").value = "";
          syncDateFields("start"); syncDateFields("end");
          rangeCalendar.setRange("", ""); applyBookingDateLimits(); saveDraft(); render();
          $("mode-banner").textContent = "Выберите новый период, чтобы проверить доступность позиций повторной заявки.";
          $("mode-banner").hidden = false;
        });
        card.append(repeat);
        appendCustomerWorkflow(card, order);
        if (order.status === "pending") appendPendingContactEditor(card, order);
        if (["confirmed", "preparing", "ready"].includes(order.status) && ["required", "needs_changes"].includes(order.identity_status)) {
          const identity = document.createElement("button"); identity.className = "button primary"; identity.type = "button";
          identity.textContent = order.identity_status === "needs_changes" ? "Исправить данные" : "Заполнить документы";
          identity.addEventListener("click", () => openIdentity(order.id)); card.append(identity);
        } else if (order.status === "pending" && ["required", "needs_changes"].includes(order.identity_status)) {
          const note = document.createElement("p"); note.textContent = "Анкету можно заполнить после подтверждения заявки менеджером."; card.append(note);
        } else if (["submitted", "verified"].includes(order.identity_status)) {
          const note = document.createElement("p"); note.textContent = order.identity_status === "verified" ? "Документы проверены" : "Документы на проверке"; card.append(note);
        }
        if (["pending", "needs_changes", "confirmed"].includes(order.status)) {
          const cancel = document.createElement("button"); cancel.className = "button ghost"; cancel.type = "button"; cancel.textContent = "Отменить заявку";
          cancel.addEventListener("click", async () => {
            if (!await confirmCancel(order.human_number || "")) return;
            cancel.disabled = true;
            try { await api(`/api/miniapp/bookings/${order.id}/cancel`, { method: "POST" }); await showOrders(); }
            catch (error) { showError(error.message); cancel.disabled = false; }
          });
          card.append(cancel);
        }
        accordion.append(toggle, card); outer.append(accordion); $("orders-content").append(outer);
        toggle.addEventListener("click", event => {
          event.preventDefault(); const opening = !accordion.open;
          if (opening) for (const other of $("orders-content").querySelectorAll(".customer-order-accordion")) if (other !== accordion) other.open = false;
          accordion.open = opening; selectedCustomerOrderId = opening ? order.id : null;
          if (opening) showStageNotice(order);
        });
      }
    } catch (error) { if (sequence === profileLoadSequence && state.view === "orders") { $("orders-content").textContent = "Не удалось загрузить заявки. Попробуйте открыть раздел ещё раз."; showError(error.message); } }
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
    for (const name of textFields) if (!["student_id_number", "student_institution"].includes(name) && !fields[name]) { showIdentityFieldError(name, `Укажите ${labels[name]}.`); return; }
    const passportCombined = String(data.get("passport_combined") || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(passportCombined)) { showIdentityFieldError("passport_combined", "Введите 4 цифры серии паспорта и 6 цифр номера."); return; }
    fields.passport_series = passportCombined.slice(0, 4); fields.passport_number = passportCombined.slice(4);
    const dateToday = moscowDateIso();
    if (!/^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z .'-]{1,199}$/.test(fields.full_name) || fields.full_name.split(/\s+/).length < 2) { showIdentityFieldError("full_name", "Укажите ФИО минимум из двух слов."); return; }
    if (!/^\d{3}-\d{3}$/.test(fields.passport_division_code)) { showIdentityFieldError("passport_division_code", "Введите код в формате 000-000."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.birth_date) || fields.birth_date > dateToday) { showIdentityFieldError("birth_date", "Проверьте дату рождения."); return; }
    const birth = fields.birth_date;
    const birthday = (years) => { const year = Number(birth.slice(0, 4)) + years; const suffix = birth.slice(4); return `${year}${suffix === "-02-29" && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? "-02-28" : suffix}`; };
    if (birthday(16) > dateToday) { showIdentityFieldError("birth_date", "Минимальный возраст — 16 лет."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.passport_issued_at) || fields.passport_issued_at > dateToday || fields.passport_issued_at < birthday(14)) { showIdentityFieldError("passport_issued_at", "Проверьте дату выдачи паспорта."); return; }
    if (fields.student_id_number.trim().length > 8) { showIdentityFieldError("student_id_number", "Номер студенческого должен содержать не более 8 символов."); return; }
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
      $("identity-status").textContent = "Анкета заполнена, ждите ответа оператора";
    } catch (error) { showIdentityError(error); }
    finally { button.disabled = false; button.textContent = "Отправить на проверку"; }
  }

  function actionButton(label, action, bookingId, className = "secondary", refresh = true) {
    const button = document.createElement("button"); button.type = "button"; button.className = `button compact ${className}`; button.textContent = label;
    button.setAttribute("aria-label",label);
    button.addEventListener("click", async () => {
      const mode = state.adminMode; const scrollTop = window.scrollY; button.disabled = true; button.dataset.actionPending = "true";
      try {
        await action();
        if (refresh && state.view === "admin" && state.adminMode === mode) {
          await showAdmin(mode);
          if (mode !== "orders" && state.adminMode === mode) window.scrollTo(0, scrollTop);
        }
      } catch (error) { showError(error.message); } finally { delete button.dataset.actionPending; button.disabled = false; }
    });
    return button;
  }

  function reviewSection(title, className = "") {
    const section = document.createElement("section"); section.className = `request-section ${className}`.trim();
    const heading = document.createElement("h4"); heading.textContent = title; section.append(heading); return section;
  }

  function labelledValues(values) {
    const list = document.createElement("dl"); list.className = "request-fields";
    for (const [label, value] of values) {
      const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd");
      term.textContent = label; detail.textContent = value || "Не указано"; row.append(term, detail); list.append(row);
    }
    return list;
  }

  function clearRequestReview(card) {
    card.querySelector(".identity-check-review")?.remove();
    const host = card.querySelector(".request-form-host");
    if (host) { host.dataset.reviewSequence = String(Number(host.dataset.reviewSequence || 0) + 1); host.querySelector(".review-loading")?.remove(); }
    if (documentViewerBookingId === Number(card.dataset.bookingId)) closeDocumentViewer();
  }

  async function loadRequestHistory(order, card) {
    const history = card.querySelector(".request-history"); const body = history.querySelector(".request-history-body");
    const sequence = String(Number(history.dataset.sequence || 0) + 1); history.dataset.sequence = sequence;
    body.textContent = "Загружаем историю…";
    try {
      const result = await api(`/api/miniapp/admin/bookings/${order.id}/history`);
      if (!card.isConnected || !card.querySelector(".request-accordion").open || history.dataset.sequence !== sequence) return;
      body.replaceChildren();
      const names = { pending: "Заявка возвращена на проверку", subject_request: "Данные удалены по запросу клиента", delete_failed: "Не удалось удалить", customer_received: "Клиент подтвердил получение", customer_returning: "Клиент подтвердил сдачу", paper_issue_signed: "Бумажная подпись при выдаче отмечена", paper_return_signed: "Бумажная подпись при возврате отмечена", assignee_cleared: "Закрепление снято", request_changes_proposed: "Предложены изменения заявки", request_changes_disputed: "Клиент оспорил изменения", request_changes_unanswered: "Клиент не ответил на изменения", request_updated: "Заявка изменена", request_rejected: "Заявка отклонена", returned_for_rework: "Заявка возвращена на доработку", return_finding_existing: "Отмечена прежняя особенность", return_finding_damage: "Зафиксировано повреждение", return_finding_lost: "Зафиксирована утеря", legacy_receipt_migrated: "Подготовлена расписка старой выдачи", test_hidden: "Тестовая заявка скрыта", test_unhidden: "Тестовая заявка возвращена", test_flag_on: "Заявка отмечена как тестовая", test_flag_off: "Тестовая отметка снята", support_created: "Создано обращение", support_reopened: "Обращение открыто повторно", support_claimed: "Обращение взято в работу", support_resolved: "Обращение закрыто", support_client_message: "Получено сообщение клиента", support_operator_reply: "Подготовлен ответ оператора", support_routed_to_assignee: "Обращение передано владельцу заявки", created: "Заявка создана", confirmed: "Заявка подтверждена", preparing: "Начата подготовка", ready: "Готово к выдаче", issued: "Оборудование выдано", return_inspection: "Начата проверка возврата", returned: "Возврат завершён", cancelled: "Заявка отменена", expired: "Заявка истекла", submitted: "Анкета отправлена", verified: "Анкета одобрена", changes_requested: "Запрошены исправления анкеты", act_signed: "Отмечено подписание акта", contact_updated: "Контакт обновлён", repair_closed: "Ремонт закрыт", blocked: "Анкета заблокирована", unblocked: "Анкета разблокирована", manual_delete: "Анкета удалена", retention_purge: "Анкета удалена по сроку хранения" };
      if (!result.items?.length) { body.textContent = "Записей пока нет."; return; }
      const list = document.createElement("ol"); list.className = "request-history-list";
      for (const event of result.items) {
        const item = document.createElement("li"); const label = document.createElement("strong"); const meta = document.createElement("span");
        label.textContent = names[event.action] || (event.action.startsWith("support_owner:") ? `Обращение передано сотруднику ID ${event.action.split(":")[1]}` : event.action.startsWith("assignee:") ? `Назначен владелец ID ${event.action.split(":")[1]}` : event.action.startsWith("asset_deleted:") ? `Экземпляр ${event.action.split(":")[1]} удалён` : event.action.startsWith("asset_restored:") ? `Экземпляр ${event.action.split(":")[1]} восстановлен` : event.action.startsWith("line_deleted:") ? `Позиция ${event.action.split(":")[1]} удалена` : event.action.startsWith("line_restored:") ? `Позиция ${event.action.split(":")[1]} восстановлена` : event.action.startsWith("sla_") ? "Уведомление о сроке обработки" : event.action.includes("_delete_intent") ? "Запрошено удаление" : event.action.includes("_delete_undo") ? "Удаление отменено" : event.action === "request_deleted" ? "Заявка удалена" : event.action === "request_restored" ? "Заявка восстановлена" : "Служебное действие");
        meta.textContent = `${dateText(event.created_at)} МСК · ${event.actor_id ? `ID ${event.actor_id}` : "Система"}`;
        item.append(label, meta); list.append(item);
      }
      body.append(list);
    } catch (_) {
      if (card.isConnected && history.dataset.sequence === sequence) {
        body.textContent = "История временно недоступна. ";
        body.append(actionButton("Повторить", () => loadRequestHistory(order, card), order.id, "ghost lock-exempt", false));
      }
    }
  }

  function updateRequestLease(order, card) {
    const lease = order.operation_lease_state || order.operation_lease;
    const activeStage = ["pending", "confirmed", "preparing", "ready", "issued", "return_inspection"].includes(order.status);
    const ownership = card.querySelector(".stage-lock");
    if(order.status==="needs_changes"){ownership.textContent="Ждём ответа клиента";return;}
    if (!activeStage) { ownership.textContent = "Этап завершён. Закрепление не требуется."; return; }
    const expired = lease && (lease.expired || new Date(lease.expires_at).getTime() <= Date.now());
    const mine = lease?.actor_id === state.role?.id;
    const hardStage=["preparing","ready","issued","return_inspection"].includes(order.status)&&order.assignee_id;
    const otherOwner=hardStage&&order.assignee_id!==state.role?.id;
    ownership.classList.toggle("stage-lock-expired", Boolean(expired));
    ownership.textContent = !lease ? (order.assignee_id === state.role?.id ? "Закреплено за вами" : order.assignee_id ? "Закреплено за сотрудником" : "Ожидает сотрудника")
      : expired ? `Закрепление истекло: ${lease.actor_name || `ID ${lease.actor_id}`}, до ${dateText(lease.expires_at)} МСК. Этап доступен для обработки.`
      : `${mine ? "Вы обрабатываете" : "Обрабатывает"}: ${lease.actor_name || `ID ${lease.actor_id}`}. Закрепление до ${dateText(lease.expires_at)} МСК.`;
    if (hardStage) ownership.textContent=`${otherOwner?"Закреплено за сотрудником":"Закреплено за вами"}. ${lease ? (expired?"Мягкая блокировка истекла.":ownership.textContent) : ""}`;
    for (const button of card.querySelectorAll(".request-actions button:not(.document-button):not(.lock-exempt)")) {
      if ((otherOwner && !button.classList.contains("handover-action")) || (lease && !expired && !mine)) {
        if (!button.dataset.lockBlocked) button.dataset.lockWasDisabled = String(button.disabled);
        button.dataset.lockBlocked = "true"; button.disabled = true;
      } else if (button.dataset.lockBlocked) {
        button.disabled = button.dataset.lockWasDisabled === "true" || button.dataset.actionPending === "true"; delete button.dataset.lockBlocked; delete button.dataset.lockWasDisabled;
      }
    }
  }

  async function showAdmin(mode = "orders") {
    $("admin-panel").classList.remove("catalog-editing");
    $("admin-settings").hidden = Boolean(state.role?.pii_only);
    if (state.role?.pii_only) {mode = "orders";document.querySelectorAll("#admin-panel .calendar-sync").forEach(node=>node.hidden=true);}
    document.querySelectorAll(".admin-tabs .admin-mode").forEach((button) => { if (state.role?.pii_only && button.dataset.mode !== "orders") button.hidden = true; });
    if (state.role?.staff_role === "admin" && !$("staff-settings-button")) {
      const settings = plainButton("Сотрудники", async () => {
        const result = await api("/api/miniapp/admin/staff");
        if (!result.items?.length) throw new Error("Нет сотрудников для настройки. Обратитесь к администратору.");
        const data = await workflowDialog("Сотрудники", `<label class="field"><span>Сотрудник</span><select name="staff">${result.items.map((item) => `<option value="${item.telegram_id}">${escapeHtml(item.full_name || String(item.telegram_id))}</option>`).join("")}</select></label><label class="field"><span>Роль</span><select name="role"><option value="operator">Оператор</option><option value="manager">Менеджер</option><option value="admin">Администратор</option></select></label><p class="workflow-hint">Доступ к персональным данным назначается отдельно.</p>`, "Сохранить", (dialog) => {
          const populate = () => { const item = result.items.find(row => row.telegram_id === Number(dialog.querySelector('[name="staff"]').value)); dialog.querySelector('[name="role"]').value = item?.role || "operator"; };
          dialog.querySelector('[name="staff"]').addEventListener("change", populate); populate();
        }, async data => {
          const id = data.get("staff");
          const original = result.items.find(item => item.telegram_id === Number(id));
          const role = data.get("role");
          if (role !== original?.role) {
            await api(`/api/miniapp/admin/staff/${id}/role`, {method:"PUT", body:JSON.stringify({role})});
            if (original) original.role = role;
            if (Number(id) === state.role?.id) state.role = await api("/api/miniapp/me");
          }
        });
        if(data)await showAdmin(mode);
      }); settings.id="staff-settings-button"; $("admin-settings").append(settings);
    }
    const sequence = ++adminRenderSequence;
    const anchoredRequestId = selectedRequestId;
    const previousCard = document.querySelector(`.request-card[data-booking-id="${selectedRequestId}"]`);
    const previousTop = previousCard?.querySelector(".request-toggle")?.getBoundingClientRect().top;
    const focused = previousCard?.contains(document.activeElement) ? document.activeElement.textContent : null;
    if (leaseRefreshTimer) clearInterval(leaseRefreshTimer);
    closeDocumentViewer();
    clearError(); state.view = "admin"; state.adminMode = mode;
    $("admin-request-filter-field").hidden = mode !== "orders";
    if (state.role?.id) { try { localStorage.setItem(`polyrental-admin-tab:${state.role.id}`, mode); } catch (_) {} }
    if (state.role?.staff_role) void api("/api/miniapp/operator/last-section",{method:"PUT",body:JSON.stringify({section:mode})}).catch(()=>{});
    render();
    $("admin-panel").querySelector("h2").textContent = ({orders:"Заявки",catalog:"Управление · Каталог",repairs:"Ремонт",support:"Обращения",hidden_tests:"Тестовые заявки"})[mode] || "Управление";
    document.querySelectorAll(".admin-mode").forEach((button) => { const active = button.dataset.mode === mode; button.className = `button ${active ? "secondary" : "ghost"} admin-mode`; button.setAttribute("aria-pressed", String(active)); });
    const content = $("admin-content");
    content.querySelectorAll(".request-card").forEach(clearRequestReview);
    if (!content.querySelector(".request-card") || mode !== "orders") content.textContent = "Загружаем…";
    try {
      if (mode === "hidden_tests") {
        const result = await api("/api/miniapp/admin/hidden-test-bookings");
        if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
        content.replaceChildren();
        if (!result.items.length) { content.textContent = "Скрытых тестовых заявок нет."; return; }
        for (const order of result.items) { const card = document.createElement("article"); card.className = "admin-card"; const title = document.createElement("h3"); title.textContent = order.human_number || "Тестовая заявка"; const restore = document.createElement("button"); restore.type="button"; restore.className="button secondary"; restore.textContent="Вернуть в списки"; restore.addEventListener("click", async () => { try { await api(`/api/miniapp/admin/bookings/${order.id}/restore`, {method:"POST"}); await showAdmin("hidden_tests"); } catch(error) { showError(error.message); } }); card.append(title,restore); content.append(card); }
        return;
      }
      if (mode === "support") {
        const result = await api("/api/miniapp/admin/support");
        if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
        return renderSupportThreads(result);
      }
      if (mode === "catalog" || mode === "repairs") {
        const result = await api(mode === "catalog" ? "/api/miniapp/admin/catalog" : "/api/miniapp/admin/repairs");
        if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
        return mode === "catalog" ? renderAdminCatalog(result) : renderRepairs(result);
      }
      const result = await api("/api/miniapp/admin/bookings");
      if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
      adminOrdersSnapshot = workflowSnapshot(result);
      content.replaceChildren();
      if (!result.items.length) { content.textContent = "Заказов пока нет."; return; }
      deleteUndoSeconds = Number.isInteger(result.undo_seconds) ? Math.max(1, Math.min(30, result.undo_seconds)) : 5;
      const visibleOrders = result.items.filter((order) => {
        const filter = state.adminRequestFilter;
        return filter === "all" || (filter === "mine" && order.assignee_id === state.role?.id) || (filter === "unassigned" && !order.assignee_id && order.sla?.stage !== "closed") || (filter === "overdue" && order.sla?.breached) || (filter === "soon" && order.sla?.soon && !order.sla?.breached);
      });
      if (!visibleOrders.length) { content.textContent = "Нет заявок для выбранного фильтра."; return; }
      for (const order of visibleOrders) {
        if (pendingDeletion?.bookingId === order.id && !pendingDeletion.lineId && !pendingDeletion.assetId) continue;
        const card = document.createElement("article"); card.className = "admin-card request-card"; card.dataset.bookingId = String(order.id);
        const accordion = document.createElement("details"); accordion.className = "request-accordion";
        const toggle = document.createElement("summary"); toggle.className = "request-toggle";
        toggle.innerHTML = `<span class="order-head"><strong>Заявка ${escapeHtml(order.human_number || `№${order.id}`)}</strong><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></span><span class="request-client">${escapeHtml(order.customer_name)}</span><span class="request-period">${escapeHtml(dateText(order.starts_at))} — ${escapeHtml(dateText(order.ends_at))} МСК</span>`;
        const owner = document.createElement("span"); owner.className = "request-assignee";
        owner.textContent = order.assignee_id ? (order.assignee_id === state.role?.id ? "Ответственный: вы" : `Ответственный: ID ${order.assignee_id}`) : "Ответственный не назначен";
        toggle.append(owner);
        if (order.sla?.deadline && order.sla?.stage !== "closed") {
          const sla = document.createElement("span"); sla.className = "request-sla";
          if (order.sla.breached) sla.classList.add("request-sla-overdue");
          sla.textContent = `${order.sla.breached ? "Просрочено · " : ""}Срок обработки: ${dateText(order.sla.deadline)} МСК`;
          toggle.append(sla);
        }
        const body = document.createElement("div"); body.className = "request-body";
        const summary = reviewSection("Сроки и техника", "request-summary");
        if (order.actionable_count) { const count = document.createElement("p"); count.textContent = `Требуют действия: ${order.actionable_count}`; summary.append(count); }
        summary.append(labelledValues([["Ответственный", order.assignee_id ? `ID ${order.assignee_id}` : "Не назначен"], ["Период аренды · МСК", `${dateText(order.starts_at)} — ${dateText(order.ends_at)}`]]));
        if (order.sla?.deadline) {
          const deadline = document.createElement("p"); deadline.textContent = `${order.sla.breached ? "Просрочено · " : ""}Дедлайн: ${dateText(order.sla.deadline)} МСК`; summary.append(deadline);
          const progress = document.createElement("progress"); progress.max = 1; progress.value = order.sla.progress; progress.setAttribute("aria-label", "Прошедшая часть срока обработки"); summary.append(progress);
        }
        if (state.profile?.system_admin) {
          const flag = document.createElement("label"); flag.className = "check-row"; const checkbox = document.createElement("input"); checkbox.type="checkbox"; checkbox.checked = Boolean(order.is_test); const text = document.createElement("span"); text.textContent="Тестовая заявка"; flag.append(checkbox,text); summary.append(flag);
          checkbox.addEventListener("change", async () => { checkbox.disabled=true; try { await api(`/api/miniapp/admin/bookings/${order.id}/test-flag`, {method:"PUT",body:JSON.stringify({is_test:checkbox.checked})}); } catch(error) { checkbox.checked=!checkbox.checked; showError(error.message); } finally { checkbox.disabled=false; } });
        }
        const equipment = document.createElement("div"); equipment.className = "request-equipment";
        for (const line of order.lines) {
          if (pendingDeletion?.bookingId === order.id && pendingDeletion.lineId === line.id) continue;
          const row = document.createElement("div"); row.className = "request-equipment-row"; row.dataset.lineId = String(line.id);
          const label = document.createElement("span"); label.textContent = `${line.title || line.name} × ${line.quantity}`; row.append(label);
          if (line.title && line.title !== line.name) { const full = document.createElement("small"); full.className = "request-equipment-full"; full.textContent = line.name; row.append(full); }
          if (order.status === "pending") {
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact";
            remove.textContent = "Удалить"; remove.setAttribute("aria-label", `Удалить позицию ${line.title || line.name}`);
            remove.addEventListener("click", () => beginRequestDeletion(order, row, line.id)); row.append(remove);
          }
          equipment.append(row);
        }
        const emptyEquipment = document.createElement("p"); emptyEquipment.className = "request-equipment-empty"; emptyEquipment.textContent = "В заявке пока нет оборудования.";
        emptyEquipment.hidden = Boolean(equipment.querySelector(".request-equipment-row")); equipment.append(emptyEquipment);
        summary.append(equipment);
        if (order.assets.length) {
          const assets = document.createElement("ul"); assets.className = "asset-list";
          for (const asset of order.assets) {
            if (pendingDeletion?.bookingId === order.id && pendingDeletion.assetId === asset.id) continue;
            const row = document.createElement("li"); const label = document.createElement("span"); label.textContent = `${asset.location || "Без ячейки"} · ${asset.name} · № ${asset.serial}`; row.append(label);
            if (order.status === "preparing" && !state.role?.pii_only) { const remove = document.createElement("button"); remove.type="button"; remove.className="button ghost danger compact"; remove.textContent="Удалить"; remove.setAttribute("aria-label", `Удалить экземпляр ${asset.name}`); remove.addEventListener("click", () => beginRequestDeletion(order, row, null, asset.id)); row.append(remove); }
            assets.append(row);
          }
          summary.append(assets);
        }
        const formHost = reviewSection("Анкета клиента", "request-form-host");
        formHost.append(labelledValues([["Имя в заявке", order.customer_name], ["Контакт", order.customer_contact]]));
        const formHint = document.createElement("p"); formHint.textContent = `Анкета: ${identityStatusNames[order.identity_status] || order.identity_status}. ${state.role?.pii_admin ? "Раскройте проверку, чтобы сверить документы и реквизиты." : "Документы и решение по анкете доступны администратору ПД."}`; formHost.append(formHint);
        const actions = document.createElement("div"); actions.className = "action-row";
        const processing = reviewSection("Действия по заявке", "request-actions");
        const ownership = document.createElement("p"); ownership.className = "stage-lock"; ownership.setAttribute("role", "status"); processing.append(ownership);
        const nextStep = document.createElement("p"); nextStep.className = "request-next-step";
        nextStep.textContent = ({pending: "Следующий шаг: подтвердить заявку.", needs_changes: "Ждём ответа клиента.", confirmed: "Следующий шаг: проверить анкету и начать подготовку.", preparing: "Следующий шаг: проверить экземпляры и подтвердить готовность.", ready: "Дождитесь отметки клиента «Получил», затем оформите выдачу.", issued: "Ждём отметку клиента «Сдаю оборудование».", return_inspection: "Проверьте возвращённое оборудование и завершите заявку.", returned: "Заявка завершена"})[order.status] || "Обработка заявки завершена.";
        if (order.status === "confirmed" && order.identity_status !== "verified") {
          nextStep.textContent = order.identity_status === "submitted"
            ? (state.role?.pii_admin ? "Следующий шаг: проверьте анкету клиента." : "Ждём проверку анкеты сотрудником с доступом к персональным данным.")
            : (order.identity_status === "needs_changes" ? "Ждём исправленную анкету клиента." : "Ждём заполненную анкету клиента.");
        }

        const nextOverview = document.createElement("section"); nextOverview.className = "request-next-overview";
        const nextHeading = document.createElement("h4"); nextHeading.textContent = "Следующий шаг";
        nextOverview.append(nextHeading, nextStep);
        const jump = plainButton("К действиям ↓", () => { processing.tabIndex = -1; processing.focus({preventScroll:true}); processing.scrollIntoView({block:"start"}); }, "ghost compact");
        nextOverview.append(jump);
        appendHandoverProgress(processing, order, true);
        body.append(nextOverview, processing, summary, formHost); accordion.append(toggle, body); card.append(accordion);
        const transitionAction = (next) => () => api(`/api/miniapp/admin/bookings/${order.id}/transition`, { method: "POST", body: JSON.stringify({ action: next }) });
        const reworkTargets = { confirmed: ["pending", "Ожидает проверки"], preparing: ["confirmed", "Подтверждена"], ready: ["preparing", "Подготовка"], return_inspection: ["issued", "Выдана"] };
        if (reworkTargets[order.status] && (order.status !== "confirmed" || ["manager","admin"].includes(state.role?.staff_role))) {
          const [target, label] = reworkTargets[order.status];
          actions.append(actionButton("Вернуть на доработку", async () => {
            const comment = await requestReworkComment(label);
            if (comment === null) return;
            await api(`/api/miniapp/admin/bookings/${order.id}/rework`, {method:"POST", body:JSON.stringify({target, comment})});
          }, order.id, ["manager","admin"].includes(state.role?.staff_role)?"secondary lock-exempt":"secondary"));
        }
        if (order.status === "pending") actions.append(actionButton("Подтвердить заявку", transitionAction("confirmed"), order.id, "primary workflow-next"));
        if (order.status === "confirmed") {
          if (order.identity_status === "verified") actions.append(actionButton("Начать подготовку", transitionAction("preparing"), order.id, "primary workflow-next"));
          else { const note = document.createElement("p"); note.className = "workflow-hint"; note.textContent = state.role?.pii_admin ? "Дождитесь заполнения анкеты клиентом и проверьте документы. Затем начните подготовку." : "Дождитесь заполнения анкеты клиентом и проверки сотрудником с доступом к персональным данным. Затем начните подготовку."; actions.append(note); }
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
              : "Проверьте все экземпляры, затем нажмите «Подтвердить готовность к выдаче».";
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
          formHost.append(actionButton("Проверить анкету", () => reviewIdentity(order, card), order.id, "secondary lock-exempt", false));
        }
        if (["pending", "needs_changes", "confirmed", "preparing", "ready", "returned"].includes(order.status)) actions.append(actionButton("Отменить заявку", async () => { if (await confirmCancel(order.human_number || "", order.status === "returned")) await transitionAction("cancelled")(); }, order.id, "ghost danger"));

        if (order.status === "return_inspection") {
          const finishReturn = actionButton("Завершить заявку", async () => { if (await workflowDialog("Завершить заявку", "<p>Оборудование проверено. Подтвердите завершение.</p>")) await transitionAction("returned")(); }, order.id, "primary workflow-next");
          finishReturn.classList.add("handover-action");
          const canFinishReturn = () => order.assets.length > 0 && order.assets.every((asset) => Boolean(inspectionFor(order, asset, "check_in")));
          const returnHint = document.createElement("p"); returnHint.className = "workflow-hint";
          const updateReturnHint = () => {
            const unchecked = order.assets.filter((asset) => !inspectionFor(order, asset, "check_in")).length;
            const missing = [];
            if (unchecked) missing.push(`проверьте экземпляры: осталось ${unchecked}`);
            if (!order.assets.length) missing.push("нет назначенных экземпляров");
            returnHint.textContent = missing.length ? `Для завершения: ${missing.join("; ")}.` : "Все условия выполнены. Нажмите «Завершить заявку».";
            finishReturn.title = returnHint.textContent;
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
        appendAdminWorkflow(actions, order);
        processing.append(actions); updateRequestLease(order, card);
        card.requestOrder = order;
        if (!state.role?.pii_only && ["pending", "cancelled", "expired"].includes(order.status)) {
          const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact";
          remove.textContent = "×"; remove.title = "Удалить заявку"; remove.setAttribute("aria-label", `Удалить заявку ${order.human_number || ""}`);
          remove.addEventListener("click", () => beginRequestDeletion(order, card));
          processing.append(remove);
        }
        const history = document.createElement("details"); history.className="request-section request-history";
        const historyTitle=document.createElement("summary"); historyTitle.textContent="История действий"; history.append(historyTitle);
        const historyBody = document.createElement("div"); historyBody.className = "request-history-body"; history.append(historyBody); body.append(history);
        const setOpen = (open) => {
          accordion.open = open;
          if (open) { selectedRequestId = order.id; loadRequestHistory(order, card); }
          else { clearRequestReview(card); history.dataset.sequence = String(Number(history.dataset.sequence || 0) + 1); if (selectedRequestId === order.id) selectedRequestId = null; }
        };
        toggle.addEventListener("click", (event) => {
          event.preventDefault(); const top = toggle.getBoundingClientRect().top; const opening = !accordion.open;
          if (opening) for (const other of content.querySelectorAll(".request-card")) {
            if (other === card) continue;
            other.querySelector(".request-accordion").open = false; clearRequestReview(other);
          }
          setOpen(opening); window.scrollBy(0, toggle.getBoundingClientRect().top - top);
        });
        accordion.addEventListener("toggle", () => {
          if (!accordion.open) { clearRequestReview(card); if (selectedRequestId === order.id) selectedRequestId = null; }
        });
        content.append(card);
        if (selectedRequestId === order.id) setOpen(true);
      }
      leaseRefreshTimer = setInterval(() => {
        if (state.view !== "admin" || state.adminMode !== "orders") { clearInterval(leaseRefreshTimer); return; }
        content.querySelectorAll(".request-card").forEach((card) => updateRequestLease(card.requestOrder, card));
      }, 1000);
      const selectedCard = content.querySelector(`.request-card[data-booking-id="${selectedRequestId}"]`);
      const selectedToggle = selectedCard?.querySelector(".request-toggle");
      if (anchoredRequestId === selectedRequestId && previousTop != null && selectedToggle) window.scrollTo(0, window.scrollY + selectedToggle.getBoundingClientRect().top - previousTop);
      if (anchoredRequestId === selectedRequestId && focused && selectedCard) ([...selectedCard.querySelectorAll("button, summary")].find((node) => node.textContent === focused) || selectedToggle)?.focus({ preventScroll: true });
    } catch (error) {
      if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
      content.textContent = "Не удалось загрузить раздел."; showError(error.message);
    }
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
      const assetIdentifier = asset.asset_code || asset.inventory_code || asset.serial;
      name.textContent = assetIdentifier ? `${asset.name} · № ${assetIdentifier}` : `${asset.name} · без номера`;
      const status = document.createElement("span"); status.className = `inspection-state${saved ? " checked" : ""}`;
      status.textContent = saved ? (saved.result === "pass" ? "Исправно" : "Зафиксирована неисправность") : "Ожидает проверки";
      details.append(name, status);
      if (asset.components?.length) {
        const list=document.createElement("ul");
        for (const component of asset.components) { const item=document.createElement("li"); item.textContent=(component.replacement_name || component.name)+(component.state==="missing"||component.state==="faulty"?" · не выдано":component.state==="replacement"?" · замена":""); list.append(item); }
        details.append(list);
      }
      row.append(details);
      const defect = document.createElement("button"); defect.type = "button"; defect.className = "button ghost compact";
      if (stage === "check_in") defect.classList.add("handover-action");
      defect.textContent = saved?.result === "fail" ? "Изменить" : "Неисправность";
      defect.addEventListener("click", () => openInspection(order, asset, stage, saved));
      row.append(defect);
      group.append(row);
    }
    const markAll = document.createElement("button"); markAll.type = "button"; markAll.className = "button secondary inspection-all-pass";
    if (stage === "check_in") markAll.classList.add("handover-action");
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
      let savedAny = false; let failure = null;
      try {
        for (const asset of toMark) {
          const checklist=Object.fromEntries((asset.components || []).flatMap((item,index)=>["missing","faulty"].includes(item.state)?[]:[[ `component:${index}`,true ]]));
          await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method: "POST", body: JSON.stringify({ equipment_id: asset.id, stage, result: "pass", checklist, notes: "", defect: "", estimated_cost: 0, charge_customer: false }) });
          order.inspections ||= [];
          order.inspections.push({ equipment_id: asset.id, stage, result: "pass" });
          savedAny = true;
          const row = group.querySelector(`[data-equipment-id="${asset.id}"]`);
          const status = row?.querySelector(".inspection-state");
          if (status) { status.textContent = "Исправно"; status.classList.add("checked"); }
        }
        updateProgress(); updateButton(); onInspectionChange();
      } catch (error) {
        updateProgress(); updateButton(); onInspectionChange(); failure = error.message;
      } finally {
        markAll.disabled = false;
        if (savedAny && state.view === "admin" && state.adminMode === "orders") await showAdmin("orders");
        if (failure) showError(failure);
      }
    });
    group.append(markAll); actions.append(group);
  }

  async function reviewIdentity(order, requestCard) {
    if (!state.role?.pii_admin) return;
    const bookingId = order.id;
    const host = requestCard.querySelector(".request-form-host");
    const sequence = String(Number(host.dataset.reviewSequence || 0) + 1); host.dataset.reviewSequence = sequence;
    host.querySelector(".identity-check-review")?.remove();
    const loading = document.createElement("p"); loading.className = "review-loading"; loading.setAttribute("role", "status"); loading.textContent = "Загружаем защищённую анкету…"; host.append(loading);
    const isCurrent = () => requestCard.isConnected && requestCard.querySelector(".request-accordion").open && host.dataset.reviewSequence === sequence && state.view === "admin" && state.adminMode === "orders";
    let masked;
    try { masked = await api(`/api/miniapp/admin/bookings/${bookingId}/identity`); }
    finally { loading.remove(); }
    if (!isCurrent()) return;
    const reasons = {
      manual_review: "Нужна ручная проверка", student_text: "Найдены признаки студенческого билета",
      other_document: "Найдены признаки другого документа", blank_image: "Признаки документа не обнаружены: однотонное фото",
      uncertain: "Недостаточно признаков: возможны блики или нечёткое фото",
      unavailable: "Локальная проверка недоступна", timeout: "Время проверки истекло",
    };
    const labels = {passport_main: "Паспорт: фото", passport_registration: "Паспорт: регистрация", student_front: "Студенческий"};
    const card = document.createElement("div"); card.className = "identity-check-review";
    card.setAttribute("aria-label", "Результаты проверки документов");
    const personal = reviewSection("Личные данные", "review-personal-data");
    personal.append(labelledValues([["ФИО", masked.full_name || order.customer_name], ["Контакт", order.customer_contact]]));
    const documentSection = reviewSection("Документ", "review-document-data");
    documentSection.append(labelledValues([["Тип документа", "Паспорт РФ и студенческий билет"], ["Номер паспорта · скрыт", masked.passport || "Скрыт до раскрытия реквизитов"], ["Номер студенческого · скрыт", masked.student_id || "Скрыт до раскрытия реквизитов"]]));
    const reveal = actionButton("Раскрыть реквизиты", async () => {
      const full = await api(`/api/miniapp/admin/bookings/${bookingId}/identity/reveal`, { method: "POST" });
      if (!isCurrent() || !card.isConnected) return;
      personal.querySelector("dl")?.remove(); documentSection.querySelector("dl")?.remove();
      personal.append(labelledValues([["ФИО", full.full_name], ["Контакт", order.customer_contact], ["Дата рождения", full.birth_date], ["Адрес регистрации", full.registration_address], ["Адрес проживания", full.residential_address]]));
      const values = labelledValues([["Тип документа", "Паспорт РФ"], ["Серия и номер", `${full.passport_series || ""} ${full.passport_number || ""}`.trim()], ["Дата выдачи", full.passport_issued_at], ["Кем выдан", full.passport_issuer], ["Код подразделения", full.passport_division_code], ["Номер студенческого", full.student_id_number], ["Учебное заведение", full.student_institution]]);
      values.classList.add("identity-revealed"); documentSection.insertBefore(values, reveal);
      reveal.hidden = true;
    }, bookingId, "secondary lock-exempt", false);
    documentSection.append(reveal);
    const checks = reviewSection("Результат проверки документов", "review-document-checks");
    const documentKinds = [...new Set([...(masked.documents || []), ...Object.keys(masked.document_checks || {})])];
    if (!documentKinds.length) { const note = document.createElement("p"); note.textContent = "Автоматическая проверка отсутствует. Требуется ручная проверка документов."; checks.append(note); }
    for (const kind of documentKinds) {
      const check = masked.document_checks?.[kind] || {};
      const group = document.createElement("div"); group.className = "document-verdict";
      const title = document.createElement("h5"); title.textContent = labels[kind] || "Документ"; group.append(title);
      group.append(labelledValues([["Автоматический результат", `${check.document === "document" ? "документ" : check.document === "not_document" ? "не документ" : "не определено"}, ${check.student === "student" ? "студенческий" : check.student === "other" ? "другой документ" : "тип не определён"}`], ["Причина / ручная проверка", reasons[check.reason] || reasons.manual_review]]));
      if ((masked.documents || documentKinds).includes(kind)) group.append(actionButton(`Открыть фото · ${labels[kind] || "документ"}`, () => openDocumentViewer(bookingId, kind), bookingId, "ghost document-button lock-exempt", false));
      checks.append(group);
    }
    const notice = document.createElement("p"); notice.className = "review-advisory"; notice.textContent = "Предварительный результат. Сверьте фотографии и реквизиты перед ручным решением. Сбой или таймаут автоматической проверки допускает ручное решение."; checks.append(notice);
    const decision = reviewSection("Решение по анкете", "review-decision");
    if (masked.review_comment) { const comment = document.createElement("p"); comment.textContent = `Комментарий к исправлениям: ${masked.review_comment}`; decision.append(comment); }
    const actions = document.createElement("div"); actions.className = "action-row";
    const approve = actionButton("Подтвердить документы", async () => {
      if (!window.confirm("Фотографии и реквизиты сверены? Подтвердить документы?")) return;
      await api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved: true, comment: "", fields: [] }) });
    }, bookingId, "primary lock-exempt");
    const changes = actionButton("Отклонить / исправить", () => requestIdentityChanges(bookingId), bookingId, "ghost lock-exempt");
    const canReview = ["confirmed", "preparing", "ready"].includes(order.status) && ["submitted", "needs_changes", "verified"].includes(order.identity_status);
    approve.disabled = changes.disabled = !canReview;
    actions.append(approve);
    if (order.status === "ready") {
      const note = document.createElement("p"); note.textContent = "Получатель расписки зафиксирован. Верните заявку в подготовку для исправления анкеты; после проверки потребуется новая расписка."; decision.append(note);
      actions.append(actionButton("Вернуть в подготовку", async () => {
        const comment = await requestReworkComment("Подготовка");
        if (comment === null) return;
        await api(`/api/miniapp/admin/bookings/${bookingId}/rework`, {method:"POST", body:JSON.stringify({target:"preparing", comment})});
        await showAdmin("orders");
        const refreshed = document.querySelector(`.request-card[data-booking-id="${bookingId}"]`);
        if (refreshed) {
          await reviewIdentity({...order, status:"preparing"}, refreshed);
          const note = document.createElement("p"); note.setAttribute("role", "status"); note.textContent = "Заявка возвращена в подготовку. После проверки потребуется новая расписка.";
          refreshed.querySelector(".review-decision")?.prepend(note);
          refreshed.querySelector('.review-decision button[aria-label="Отклонить / исправить"]')?.focus({preventScroll:true});
        }
      }, bookingId, "secondary lock-exempt", false));
    } else actions.append(changes);
    if (!canReview) { const note = document.createElement("p"); note.textContent = "Решение по анкете доступно на этапах подтверждения, подготовки и готовности к выдаче."; decision.append(note); }
    const close = document.createElement("button"); close.className = "button ghost"; close.type = "button"; close.textContent = "Закрыть";
    close.addEventListener("click", () => { clearRequestReview(requestCard); [...host.querySelectorAll("button")].find((button) => button.textContent === "Проверить анкету")?.focus({ preventScroll: true }); });
    actions.append(close); decision.append(actions); card.append(personal, documentSection, checks, decision); host.append(card);
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
    const returnFocus = document.activeElement;
    form.reset(); $("identity-review-submit").disabled = false; dialog.hidden = false; dialog.querySelector("input")?.focus();
    return new Promise((resolve, reject) => {
      let submitting = false;
      const keydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
        if (event.key === "Tab") trapDialogFocus(event, dialog);
      };
      const finish = () => { dialog.hidden = true; form.reset(); $("identity-review-cancel").disabled = false; form.removeEventListener("submit", submit); dialog.removeEventListener("keydown", keydown); $("identity-review-cancel").removeEventListener("click", cancel); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
      const cancel = () => { if (submitting) return; finish(); resolve(); };
      const submit = async (event) => {
        event.preventDefault();
        if (submitting) return;
        const button = $("identity-review-submit"); button.disabled = true;
        const selected = [...form.querySelectorAll('input[name="fields"]:checked')].map((input) => input.value);
        const comment = String(new FormData(form).get("comment") || "").trim();
        if (!selected.length && !comment) { showError("Выберите поля для исправления или добавьте комментарий."); button.disabled = false; return; }
        submitting = true; $("identity-review-cancel").disabled = true;
        try {
          const result = await api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved: false, comment: comment || "Нужны исправления", fields: selected }) });
          finish(); resolve(result);
        } catch (error) { showError(error.message); submitting = false; $("identity-review-cancel").disabled = false; button.disabled = false; }
      };
      form.addEventListener("submit", submit); dialog.addEventListener("keydown", keydown); $("identity-review-cancel").addEventListener("click", cancel);
    });
  }

  async function downloadSecure(path, filename) {
    const version = String(tg?.version || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const supportsNativeDownload = typeof tg?.downloadFile === "function" && (version[0] > 8 || (version[0] === 8 && version[1] >= 0));
    if (supportsNativeDownload) {
      try {
        const ticket = await api(`${path}/download-link`, { method: "POST" });
        tg.downloadFile({ url: ticket.url, file_name: ticket.file_name || filename });
        return;
      } catch (_) { /* Older or customized clients may expose but not implement downloadFile. */ }
    }
    const response = await fetch(path, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (!response.ok) { let detail = "Не удалось скачать документ"; try { detail = (await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    const disposition = response.headers.get("Content-Disposition") || "";
    filename = /filename="([^"]+)"/.exec(disposition)?.[1] || filename;
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
    link.href = url; link.download = filename; link.style.display = "none"; document.body.append(link); link.click(); link.remove();
    // iOS Telegram may start reading the file after the click handler returns.
    // Revoking immediately can leave its document preview on a black screen.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function downloadCatalogTemplate() {
    const path = "/miniapp/static/equipment-import-template.csv";
    const filename = "equipment-import-template.csv";
    const version = String(tg?.version || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const supportsNativeDownload = typeof tg?.downloadFile === "function" && (version[0] > 8 || (version[0] === 8 && version[1] >= 0));
    if (supportsNativeDownload) {
      try {
        tg.downloadFile({ url: new URL(path, location.origin).href, file_name: filename });
        return;
      } catch (_) { /* Fall back to a browser download below. */ }
    }
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось скачать шаблон CSV");
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
    link.href = url; link.download = filename; link.style.display = "none"; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  let documentViewerUrl = "";
  let documentViewerItems = [];
  let documentViewerIndex = 0;
  let documentViewerBookingId = null;
  let documentViewerSequence = 0;
  let documentViewerReturnFocus = null;
  function trapDialogFocus(event, dialog) {
    const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']")].filter((node) => !node.hidden && node.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  function requestReworkComment(target) {
    const dialog = $("rework-dialog"), form = $("rework-form"), cancel = $("rework-cancel");
    const comment = form.elements.comment, returnFocus = document.activeElement;
    form.reset(); $("rework-target").textContent = `Заявка вернётся на этап «${target}».`;
    dialog.hidden = false; comment.focus();
    return new Promise((resolve) => {
      const finish = (value) => {
        dialog.hidden = true; form.reset(); form.removeEventListener("submit", submit);
        cancel.removeEventListener("click", cancelHandler); dialog.removeEventListener("keydown", keydown);
        if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); resolve(value);
      };
      const submit = (event) => { event.preventDefault(); const value = comment.value.trim(); if (value) finish(value); else comment.focus(); };
      const cancelHandler = () => finish(null);
      const keydown = (event) => { if (event.key === "Escape") { event.preventDefault(); finish(null); } else if (event.key === "Tab") trapDialogFocus(event, dialog); };
      form.addEventListener("submit", submit); cancel.addEventListener("click", cancelHandler); dialog.addEventListener("keydown", keydown);
    });
  }
  async function openDocumentViewer(bookingId, kind) {
    if (!state.role?.pii_admin) return;
    documentViewerReturnFocus = document.activeElement;
    documentViewerBookingId = bookingId;
    documentViewerItems = ["passport_main", "passport_registration", "student_front"];
    documentViewerIndex = Math.max(0, documentViewerItems.indexOf(kind));
    const viewer = $("document-viewer"); viewer.hidden = false;
    $("document-viewer-close").focus();
    await loadDocumentViewerImage(bookingId);
  }
  async function loadDocumentViewerImage(bookingId) {
    const sequence = ++documentViewerSequence;
    const kind = documentViewerItems[documentViewerIndex];
    const labels = { passport_main: "Паспорт — страница с фото", passport_registration: "Паспорт — регистрация", student_front: "Студенческий — лицевая сторона" };
    const response = await fetch(`/api/miniapp/admin/bookings/${bookingId}/identity/documents/${kind}`, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (sequence !== documentViewerSequence || $("document-viewer").hidden || documentViewerBookingId !== bookingId) return;
    if (!response.ok) { closeDocumentViewer(); throw new Error("Не удалось открыть фотографию"); }
    const blob = await response.blob();
    if (sequence !== documentViewerSequence || $("document-viewer").hidden || documentViewerBookingId !== bookingId) return;
    if (documentViewerUrl) URL.revokeObjectURL(documentViewerUrl);
    documentViewerUrl = URL.createObjectURL(blob); $("document-viewer-image").src = documentViewerUrl; $("document-viewer-title").textContent = labels[kind] || "Документ";
    $("document-viewer-image").alt = labels[kind] || "Документ";
    $("document-viewer-prev").disabled = documentViewerIndex === 0;
    $("document-viewer-next").disabled = documentViewerIndex === documentViewerItems.length - 1;
  }
  function closeDocumentViewer() {
    const wasOpen = !$("document-viewer").hidden;
    documentViewerSequence += 1; documentViewerBookingId = null; $("document-viewer").hidden = true; $("document-viewer-image").removeAttribute("src"); if (documentViewerUrl) URL.revokeObjectURL(documentViewerUrl); documentViewerUrl = "";
    if (wasOpen && documentViewerReturnFocus?.isConnected) documentViewerReturnFocus.focus({ preventScroll: true });
    documentViewerReturnFocus = null;
  }

  function renderAdminCatalog(result, editor = null) {
    setCategories(result.categories || []);
    $("admin-panel").classList.toggle("catalog-editing", Boolean(editor));
    const content = $("admin-content"); content.replaceChildren();
    if (editor) {
      const form = catalogEditor(result, editor);
      content.append(form);
      const heading = form.querySelector("h3"); heading.tabIndex = -1;
      heading.focus({preventScroll:true}); form.scrollIntoView({block:"start"});
      return;
    }
    const operations = document.createElement("details"); operations.className = "catalog-operations";
    const operationsTitle = document.createElement("summary"); operationsTitle.textContent = "Импорт и настройка комплектов";
    operations.append(operationsTitle);
    const dependencyNote = document.createElement("p");
    dependencyNote.textContent = "Зависимости комплектов хранятся справочно. Автоматическое добавление отключено: клиент выбирает каждую позицию отдельно. Аренда бесплатная.";
    operations.append(dependencyNote);
    const toolbar = document.createElement("div"); toolbar.className = "action-row catalog-toolbar";
    for (const [label, type, className] of [["Новый артикул", "article", "primary"], ["Новый экземпляр", "equipment", "secondary"], ["Зависимость комплекта", "dependency", "ghost"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = label;
      button.addEventListener("click", () => renderAdminCatalog(result, { type })); (type === "dependency" ? operations : toolbar).append(button);
    }
    toolbar.append(plainButton("Создать категорию", async () => {
      const category = await createCategoryDialog(); if (!category) return;
      result.categories = await api("/api/miniapp/catalog/categories").then(data => data.items);
      const select = content.querySelector('.catalog-form [name="category"]');
      if (select) select.innerHTML = categoryOptions(category.code);
      else renderAdminCatalog(result, editor);
    }, "ghost"));
    content.append(toolbar);
    const controls = document.createElement("div"); controls.className = "catalog-controls";
    controls.innerHTML = `<label><span class="sr-only">Поиск в каталоге</span><input type="search" placeholder="Поиск: модель, SKU, S/N, инвентарный код" value="${escapeHtml(catalogView.query)}"></label><label><span class="sr-only">Состояние экземпляра</span><select><option value="all">Все состояния</option><option value="available">Доступен</option><option value="maintenance">На ремонте</option><option value="retired">Выведен из эксплуатации</option></select></label>`;
    const [search, status] = controls.querySelectorAll("input, select"); status.value = catalogView.status;
    search.addEventListener("input", () => {
      const selection = { start: search.selectionStart, end: search.selectionEnd, direction: search.selectionDirection };
      catalogView.query = search.value;
      renderAdminCatalog(result, editor);
      const refreshedSearch = $("admin-content").querySelector(".catalog-controls input");
      refreshedSearch?.focus({ preventScroll: true });
      if (selection.start != null && selection.end != null) refreshedSearch?.setSelectionRange(selection.start, selection.end, selection.direction || "none");
    });
    status.addEventListener("change", () => { catalogView.status = status.value; renderAdminCatalog(result, editor); });
    content.prepend(controls);
    const importer = document.createElement("details"); importer.className = "catalog-import";
    importer.innerHTML = `<summary>Добавить оборудование из CSV</summary><p>Поддерживаются технический CSV в UTF-8 (<code>sku</code>, <code>name</code>, необязательные <code>serial</code> и <code>inventory_code</code>) и опись с колонками «Наименование», «Модель», «S/N», «Инвентаризационный номер/ Код ОС». Пустой или «-» S/N не создаёт значение; повторные S/N допустимы, а инвентарный код уникален. Файл импортируется целиком или не импортируется вовсе.</p><button class="button secondary catalog-template-download" type="button">Скачать шаблон CSV</button><form class="catalog-import-form"><label class="field"><span>CSV-файл, не больше 1 МБ и 500 экземпляров</span><input name="file" type="file" accept=".csv,text/csv" required></label><button class="button primary" type="submit">Добавить из CSV</button></form>`;
    importer.querySelector(".catalog-template-download").addEventListener("click", async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try { await downloadCatalogTemplate(); } catch (error) { showError(error.message); } finally { button.disabled = false; }
    });
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
    operations.append(importer);

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
      operations.append(dependencies);
    }

    const query = catalogView.query.trim().toLocaleLowerCase("ru-RU");
    const visibleArticles = result.articles.filter((article) => {
      const searchText = [article.title, article.name, article.kind, article.brand, article.key_spec, article.description, article.sku, ...article.equipment.flatMap((asset) => [asset.serial, asset.inventory_code, asset.asset_code, asset.location])].join(" ").toLocaleLowerCase("ru-RU");
      return (!query || searchText.includes(query)) && (catalogView.status === "all" || article.equipment.some((asset) => asset.condition === catalogView.status));
    });
    const summary = document.createElement("p"); summary.className = "catalog-summary"; summary.textContent = `Показано моделей: ${visibleArticles.length} из ${result.articles.length}`; content.append(summary);
    for (const article of visibleArticles) {
      const card = document.createElement("article"); card.className = `admin-card article-card${article.active ? "" : " inactive"}`;
      const availableCount = article.equipment.filter((asset) => asset.condition === "available").length;
      card.innerHTML = `<div class="article-card-head">${catalogMedia(article, "article")}<div class="article-main"><div class="order-head"><div><p class="article-type">${escapeHtml(article.description || categoryLabel(article.category))}</p><h3>${escapeHtml(catalogTitle(article))}</h3></div><span class="status-pill">${article.active ? "В каталоге" : "Скрыт"}</span></div><p class="article-meta">${escapeHtml(article.sku)} · ${article.equipment.length} шт. · доступно ${availableCount}</p></div></div><details class="article-details"><summary>Параметры модели и комплектация</summary><p><strong>Полное название:</strong> ${escapeHtml(article.name)}</p><p>Профиль проверки: ${escapeHtml(({generic:"Общая проверка",camera:"Камера",optics:"Оптика",light:"Свет",battery:"Аккумулятор"})[article.inspection_profile] || "Общая проверка")}</p><p><strong>Комплектация для расписки:</strong> ${escapeHtml(article.composition || "не указана")}</p></details><div class="equipment-list"></div>`;
      const cardActions = document.createElement("div"); cardActions.className = "action-row";
      const editArticle = document.createElement("button"); editArticle.type = "button"; editArticle.className = "button ghost compact"; editArticle.textContent = "Изменить артикул";
      editArticle.addEventListener("click", () => renderAdminCatalog(result, { type: "article", value: article }));
      const addAsset = document.createElement("button"); addAsset.type = "button"; addAsset.className = "button secondary compact"; addAsset.textContent = "Добавить экземпляр";
      addAsset.addEventListener("click", () => renderAdminCatalog(result, { type: "equipment", value: { article_id: article.id, condition: "available" } }));
      const photo=plainButton(article.image_data ? "Заменить фото модели" : "Загрузить фото модели",async()=>{
        const data=await workflowDialog("Фото модели оборудования",'<label class="field"><span>JPEG, PNG или WebP, до 8 МБ</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>',"Сохранить",null,async data=>api(`/api/miniapp/admin/catalog/articles/${article.id}/photo`,{method:"PUT",body:data}));
        if(data)await showAdmin("catalog");
      });
      cardActions.append(editArticle,addAsset,photo);
      if(article.image_data)cardActions.append(plainButton("Удалить фото модели",async()=>{
        if(await workflowDialog("Удалить фото модели",'<p>Удалить загруженное фото этой модели?</p>',"Удалить",null,async()=>api(`/api/miniapp/admin/catalog/articles/${article.id}/photo`,{method:"DELETE"})))await showAdmin("catalog");
      }));
      card.append(cardActions);
      const equipmentList = card.querySelector(".equipment-list");
      const matchingAssets = catalogView.status === "all" ? article.equipment : article.equipment.filter((asset) => asset.condition === catalogView.status);
      const expanded = catalogView.expanded.has(article.id); const shownAssets = expanded ? matchingAssets : matchingAssets.slice(0, 3);
      if (!matchingAssets.length) equipmentList.textContent = "Нет экземпляров с выбранным состоянием.";
      for (const asset of shownAssets) {
        const row = document.createElement("div"); row.className = `equipment-row condition-${asset.condition}`;
        const identifiers = [asset.serial ? `S/N ${asset.serial}` : "", asset.inventory_code ? `Инв. ${asset.inventory_code}` : "", `Код ${asset.asset_code}`].filter(Boolean).join(" · ");
        row.innerHTML = `<span><span class="condition-pill">${escapeHtml(conditionLabel(asset.condition))}</span><strong>${escapeHtml(identifiers)}</strong><small>${escapeHtml(asset.location || "Без ячейки")}</small></span>`;
        if(asset.owner){const owner=document.createElement("small");owner.textContent=`Владелец: ${asset.owner}${asset.owner_contact?` · ${asset.owner_contact}`:""}`;row.querySelector("span").append(owner);}
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "button ghost compact"; edit.textContent = "Изменить";
        edit.addEventListener("click", () => renderAdminCatalog(result, { type: "equipment", value: { ...asset, article_id: article.id } }));
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost compact danger"; remove.textContent = "Удалить";
        remove.addEventListener("click", async () => { if (!window.confirm("Удалить этот экземпляр? Если он последний и не имеет истории, артикул также будет удалён.")) return; try { await api(`/api/miniapp/admin/catalog/equipment/${asset.id}`, { method: "DELETE" }); await showAdmin("catalog"); } catch (error) { showError(error.message); } });
        const features = plainButton("Особенности", async () => {
          const details = await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/features`);
          const data = await workflowDialog(`${article.title || article.name} #${asset.asset_code}`, `<ul>${details.features.map((feature) => `<li>${escapeHtml(feature.description)}${feature.source === "found_on_return" ? " (выявлено при возврате)" : ""}</li>`).join("")}</ul>${state.role?.staff_role === "admin" ? `<label class="field"><span>Действие</span><select name="operation"><option value="add">Добавить запись</option>${details.features.map((feature) => `<option value="edit:${feature.id}">Исправить: ${escapeHtml(feature.description)}</option><option value="delete:${feature.id}">Удалить: ${escapeHtml(feature.description)}</option>`).join("")}</select></label>` : ""}<label class="field"><span>Описание</span><textarea name="description" maxlength="2000" required></textarea></label>`,"Подтвердить",(dialog) => { dialog.querySelector("select")?.addEventListener("change", (event) => { dialog.querySelector("textarea").required = !event.target.value.startsWith("delete:"); }); },async data=>{
            const [operation,id]=String(data.get("operation") || "add").split(":");
            await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/features${id ? `/${id}` : ""}`,{method:operation === "delete" ? "DELETE" : id ? "PUT" : "POST", ...(operation !== "delete" ? {body:JSON.stringify({description:data.get("description")})} : {})});
          });
          if(data)await showAdmin("catalog");
        });
        row.append(features);
        if (["manager","admin"].includes(state.role?.staff_role)) row.append(plainButton("Занятость вне сервиса",async () => {
          const result=await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/blocks`);
          const data=await workflowDialog("Занятость оборудования",`<label class="field"><span>Действие</span><select name="operation"><option value="new">Отметить занятость</option>${result.items.map((item)=>`<option value="${item.id}">Освободить: ${escapeHtml(item.reason.slice(0,120))} · до ${escapeHtml(dateText(item.end))}</option>`).join("")}</select></label><label class="field"><span>С</span><input name="start" type="datetime-local" value="${moscowInput(new Date().toISOString())}" required></label><label class="field"><span>До</span><input name="end" type="datetime-local" required></label><label class="field"><span>Причина (видна клиентам)</span><textarea name="reason" maxlength="2000" required></textarea></label>`,"Подтвердить",(dialog)=>{dialog.querySelector("select").addEventListener("change",event=>{dialog.querySelectorAll("input,textarea").forEach(input=>{input.required=event.target.value==="new";input.disabled=event.target.value!=="new";});});},async data=>{
            if(data.get("operation")==="new")await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/blocks`,{method:"POST",body:JSON.stringify({start:`${data.get("start")}:00+03:00`,end:`${data.get("end")}:00+03:00`,reason:data.get("reason")})});
            else await api(`/api/miniapp/admin/catalog/blocks/${data.get("operation")}`,{method:"DELETE"});
          });
          if(data)await showAdmin("catalog");
        }));
        if (["manager","admin"].includes(state.role?.staff_role)) row.append(plainButton(asset.owner ? `Владелец: ${asset.owner}` : "Указать владельца",async () => {
          const data = await workflowDialog("Владелец оборудования",`<label class="field"><span>Имя или организация (необязательно)</span><input name="name" maxlength="200" value="${escapeHtml(asset.owner || "")}"></label><label class="field"><span>Контакт (необязательно)</span><input name="contact" maxlength="300" value="${escapeHtml(asset.owner_contact || "")}"></label>`,"Подтвердить",null,async data=>api(`/api/miniapp/admin/catalog/equipment/${asset.id}/owner`,{method:"PUT",body:JSON.stringify({name:data.get("name"),contact:data.get("contact")})}));
          if(data)await showAdmin("catalog");
        }));
        const moreActions = document.createElement("details"); moreActions.className = "equipment-actions";
        const moreTitle = document.createElement("summary"); moreTitle.textContent = "Другие действия";
        moreActions.append(moreTitle);
        const extra = document.createElement("div"); extra.className = "action-row";
        for (const button of [...row.querySelectorAll(":scope > button")]) extra.append(button);
        extra.append(remove); moreActions.append(extra);
        row.append(edit, moreActions); equipmentList.append(row);
      }
      if (matchingAssets.length > 3) {
        const more = document.createElement("button"); more.type = "button"; more.className = "button ghost compact catalog-more";
        more.textContent = expanded ? "Скрыть экземпляры" : `Показать ещё ${matchingAssets.length - 3}`;
        more.addEventListener("click", () => { if (expanded) catalogView.expanded.delete(article.id); else catalogView.expanded.add(article.id); renderAdminCatalog(result); });
        equipmentList.append(more);
      }
      content.append(card);
    }
    content.append(toolbar, operations);
  }

  function catalogEditor(result, editor) {
    const wrapper = document.createElement("article"); wrapper.className = "admin-card editor-card";
    const value = editor.value || {}; const options = result.articles.map((article) => {
      const type = article.description || categoryLabel(article.category);
      return `<option value="${article.id}" ${Number(value.article_id) === article.id ? "selected" : ""}>${escapeHtml(article.name)} · ${escapeHtml(type)} · SKU: ${escapeHtml(article.sku)}</option>`;
    }).join("");
    if (editor.type === "article") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить артикул" : "Новый артикул"}</h3><form class="catalog-form form-grid"><label class="field"><span>SKU / артикул</span><input name="sku" value="${escapeHtml(value.sku || "")}" maxlength="80" required></label><label class="field"><span>Полное название</span><input name="name" value="${escapeHtml(value.name || "")}" maxlength="200" required></label><label class="field"><span>Вид (например, camera или Карта памяти)</span><input name="kind" value="${escapeHtml(value.kind || "")}" maxlength="80"></label><label class="field"><span>Бренд</span><input name="brand" value="${escapeHtml(value.brand || "")}" maxlength="100"></label><label class="field"><span>Основная характеристика</span><input name="key_spec" value="${escapeHtml(value.key_spec || "")}" maxlength="120"></label><label class="field wide"><span>Описание</span><textarea name="description" maxlength="4000">${escapeHtml(value.description || "")}</textarea></label><label class="field wide"><span>Комплектация для расписки</span><textarea name="composition" maxlength="4000" placeholder="Оставьте пустым, пока состав комплекта не определён">${escapeHtml(value.composition || "")}</textarea><small>Один элемент на строке. Состав сохраняется для модели и проверяется поэлементно.</small></label><label class="field"><span>Категория</span><select name="category">${categoryOptions(value.category || "generic")}</select><button type="button" class="button ghost create-category">Создать категорию</button></label><label class="field"><span>Профиль проверки</span><select name="inspection_profile">${selectOptions(["generic", "camera", "optics", "light", "battery"], value.inspection_profile || "generic")}</select></label><label class="field wide"><span>HTTPS-ссылка на фото</span><input name="image_url" type="url" value="${escapeHtml(value.image_url || "")}" maxlength="500" placeholder="https://…"></label><label class="check-row wide"><input name="active" type="checkbox" ${value.active !== false ? "checked" : ""}><span>Показывать клиентам в каталоге</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить артикул</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else if (editor.type === "equipment") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить экземпляр" : "Новый экземпляр"}</h3><form class="catalog-form form-grid"><label class="field wide"><span>Артикул</span><select name="article_id" required><option value="">Выберите артикул</option>${options}</select></label><label class="field"><span>S/N</span><input name="serial" value="${escapeHtml(value.serial || "")}" maxlength="80"></label><label class="field"><span>Инвентарный код</span><input name="inventory_code" value="${escapeHtml(value.inventory_code || "")}" maxlength="80"></label><label class="field"><span>Складская ячейка</span><input name="location" value="${escapeHtml(value.location || "")}" maxlength="120" placeholder="A-01"></label><label class="field"><span>Состояние</span><select name="condition">${selectOptions(["available", "maintenance", "retired"], value.condition || "available")}</select></label><div class="info-strip wide"><span class="info-icon">i</span><p>S/N может отсутствовать или повторяться. Инвентарный код, если указан, уникален.</p></div><div class="action-row wide"><button class="button primary" type="submit">Сохранить экземпляр</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else {
      wrapper.innerHTML = `<h3>Зависимость комплекта</h3><form class="catalog-form form-grid"><label class="field"><span>Основной артикул</span><select name="parent_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Добавляемый артикул</span><select name="child_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Количество на единицу</span><input name="quantity" type="number" min="1" max="30" value="1" required></label><label class="check-row"><input name="billable" type="checkbox"><span>Оплачивается отдельно</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить зависимость</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    }
    if (editor.type === "article") {
      const form = wrapper.querySelector("form");
      for (const name of ["inspection_profile", "category", "name", "sku"]) form.prepend(form.querySelector(`[name="${name}"]`).closest("label"));
    }
    if (editor.type === "article" && value.id && state.profile?.system_admin) {
      const flag = document.createElement("label"); flag.className = "check-row wide";
      const checkbox = document.createElement("input"); checkbox.type="checkbox"; checkbox.name="is_test"; checkbox.checked=Boolean(value.is_test);
      const label = document.createElement("span"); label.textContent="Тестовый артикул"; flag.append(checkbox,label); wrapper.querySelector("form").prepend(flag);
    }
    wrapper.querySelector(".editor-cancel").addEventListener("click", () => renderAdminCatalog(result));
    wrapper.querySelector(".create-category")?.addEventListener("click", async () => {
      try {
        const category = await createCategoryDialog();
        if (category) wrapper.querySelector('[name="category"]').innerHTML = categoryOptions(category.code);
      } catch (error) { showError(error.message); }
    });
    wrapper.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        if (editor.type === "article") {
          const saved = await api("/api/miniapp/admin/catalog/articles", { method: "POST", body: JSON.stringify({ id: value.id || null, sku: data.get("sku"), name: data.get("name"), kind: data.get("kind"), brand: data.get("brand"), key_spec: data.get("key_spec"), description: data.get("description"), composition: data.get("composition"), rate: "0", buffer_hours: value.buffer_hours ?? 24, category: data.get("category"), inspection_profile: data.get("inspection_profile"), image_url: data.get("image_url"), active: data.get("active") === "on" }) });
          if (value.id && state.profile?.system_admin && (data.get("is_test") === "on") !== Boolean(value.is_test)) await api(`/api/miniapp/admin/catalog/articles/${saved.id}/test-flag`, { method:"PUT", body:JSON.stringify({is_test:data.get("is_test") === "on"}) });
        }
        else if (editor.type === "equipment") await api("/api/miniapp/admin/catalog/equipment", { method: "POST", body: JSON.stringify({ id: value.id || null, article_id: Number(data.get("article_id")), serial: data.get("serial"), inventory_code: data.get("inventory_code"), location: data.get("location"), condition: data.get("condition"), health: value.health ?? null, charge: value.charge ?? null }) });
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

  function workflowDialog(title, content, submitLabel = "Подтвердить", setup = null, onSubmit = null) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const dialog = document.createElement("section"); dialog.className = "dialog-backdrop workflow-dialog";
      dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", title);
      dialog.innerHTML = `<form class="dialog-card"><h2>${escapeHtml(title)}</h2>${content}<div class="action-row"><button type="button" class="button ghost workflow-cancel">Отмена</button><button type="submit" class="button primary">${escapeHtml(submitLabel)}</button></div></form>`;
      let pending=false;
      const finish = (value) => { if(pending)return; dialog.remove(); if (previous?.isConnected) previous.focus({preventScroll:true}); resolve(value); };
      dialog.querySelector(".workflow-cancel").addEventListener("click", () => finish(null));
      dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); if (event.key === "Tab") trapDialogFocus(event, dialog); });
      dialog.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();if(pending)return;
        const form=event.currentTarget,data=new FormData(form);
        if (!onSubmit) { finish(data);return; }
        pending=true;const buttons=[...form.querySelectorAll("button")];buttons.forEach(button=>button.disabled=true);
        try { await onSubmit(data);pending=false;finish(data); }
        catch(error) {pending=false;buttons.forEach(button=>button.disabled=false);let message=form.querySelector(".workflow-error");if(!message){message=document.createElement("p");message.className="workflow-error field-error";message.setAttribute("role","alert");form.append(message);}message.textContent=error.message;}
      });
      document.body.append(dialog); if (setup) setup(dialog);
      (dialog.querySelector("input, textarea, select") || dialog.querySelector("button")).focus();
    });
  }

  async function chooseAssignee(order) {
    const result = await api("/api/miniapp/admin/assignees");
    const items = (result.items || []).filter(item => Number.isInteger(item.id) && item.id > 0);
    if (!items.length) throw new Error("Нет доступных сотрудников для назначения. Обратитесь к администратору.");
    const options = items.map(item => `<option value="${item.id}" ${item.id === order.assignee_id ? "selected" : ""}>${escapeHtml(item.name || `ID ${item.id}`)}</option>`).join("");
    await workflowDialog("Назначить ответственного", `<label class="field"><span>Сотрудник</span><select name="assignee" required><option value="">Выберите сотрудника</option>${options}</select></label>`, "Подтвердить", null, async data => api(`/api/miniapp/admin/bookings/${order.id}/assignee`, {method:"PUT", body:JSON.stringify({assignee_id:Number(data.get("assignee"))})}));
  }

  function appendHandoverProgress(parent, order, admin) {
    const status = order.status, handover = order.handover || {};
    if (!["ready", "issued", "return_inspection", "returned"].includes(status)) return;
    const section = document.createElement("section"); section.className = "handover-progress";
    const heading = document.createElement("strong"); heading.textContent = status === "ready" ? "Выдача: что уже сделано" : "Возврат: что уже сделано"; section.append(heading);
    const list = document.createElement("ul");
    const isDone = status === "returned";
    let steps;
    if (status === "ready") steps = [[Boolean(handover.received_at), "Клиент подтвердил получение"], [false, "Сотрудник подтверждает выдачу"]];
    else {
      steps = [[Boolean(handover.returning_at) || isDone, "Клиент отметил сдачу оборудования"]];
      if (admin) {
        const assets = order.assets || [];
        const checked = assets.length > 0 && assets.every(asset => Boolean(inspectionFor(order, asset, "check_in")));
        steps.push([checked || isDone, "Сотрудник проверил оборудование"]);
      }
      steps.push([isDone, "Сотрудник завершил возврат"]);
    }
    for (const [done, label] of steps) { const li = document.createElement("li"); li.textContent = `${done ? "✓" : "○"} ${label} — ${done ? "готово" : "ожидается"}`; list.append(li); }
    section.append(list); parent.append(section);
  }

  function workflowSnapshot(result) {
    return JSON.stringify({total: result.total, items: (result.items || []).map(order => ({id: order.id, status: order.status, identity_status: order.identity_status, change_status: order.change_status, assignee_id: order.assignee_id, starts_at: order.starts_at, ends_at: order.ends_at, items: order.items, assets: order.assets, inspections: order.inspections, handover: order.handover, receipt_available: order.receipt_available, receipt_preview_available: order.receipt_preview_available, sla: order.sla ? {stage: order.sla.stage, deadline: order.sla.deadline, breached: order.sla.breached, soon: order.sla.soon} : null}))});
  }

  function workflowRefreshSafe() {
    const active = document.activeElement;
    return !document.hidden && !state.busy && !pendingDeletion && !document.querySelector('.workflow-dialog, .identity-check-review, .review-loading, .assignment-editor, .inspection-editor, .inspection-all-pass:disabled, [data-action-pending="true"]') && $("document-viewer").hidden && $("support-dialog").hidden && $("onboarding-dialog").hidden && $("rework-dialog").hidden && $("identity-review-dialog").hidden && !(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) && ![...document.querySelectorAll(".request-summary input:not([type=checkbox])")].some(input => input.value.trim());
  }

  async function refreshWorkflow() {
    if (!authorized || workflowRefreshBusy || !workflowRefreshSafe()) return;
    const view = state.view, mode = state.adminMode;
    if (view !== "orders" && !(view === "admin" && mode === "orders")) return;
    const baseline = view === "orders" ? customerOrdersSnapshot : adminOrdersSnapshot;
    if (baseline === null) return;
    const sequence = view === "orders" ? profileLoadSequence : adminRenderSequence;
    const path = view === "orders" ? `/api/miniapp/profile/history?category=${encodeURIComponent(state.profileFilter)}&page=${state.profilePage}&number=${encodeURIComponent(state.profileNumber)}${state.profileTargetId ? `&booking_id=${state.profileTargetId}` : ""}` : "/api/miniapp/admin/bookings";
    workflowRefreshBusy = true;
    try {
      const result = await api(path);
      if (state.view !== view || (view === "admin" && state.adminMode !== mode) || sequence !== (view === "orders" ? profileLoadSequence : adminRenderSequence) || !workflowRefreshSafe()) return;
      if (workflowSnapshot(result) !== baseline) {
        const scroll = window.scrollY;
        if (view === "orders") { await showOrders(); window.scrollTo(window.scrollX, scroll); }
        else await showAdmin("orders");
      }
    } catch (_) { /* Keep the current view; retry on the next interval. */ }
    finally { workflowRefreshBusy = false; }
  }
  setInterval(refreshWorkflow, 5000);

  function workflowNotice(order) {
    return ({pending:"Заявка отправлена, ждите проверки", confirmed:"Заявка подтверждена", ready:"Готово к выдаче", issued:`Выдано, вернуть до ${dateText(order.ends_at)} МСК`, return_inspection:"Оборудование на приёмке", returned:"Заявка завершена"})[order.status] || "";
  }

  function receiptSummary(order) {
    const handover = order.handover || {};
    const snapshot = handover.snapshot || [];
    const items = snapshot.map(item => `<li>${escapeHtml(item.name)}${item.code ? ` #${escapeHtml(item.code)}` : ""}</li>`).join("");
    const features = snapshot.flatMap(item => (item.features || []).map(feature => `<li><strong>${escapeHtml(item.name)}</strong>: ${escapeHtml(feature.description)}</li>`)).join("");
    const exceptions = (handover.exceptions || []).map(item => `<li>${escapeHtml(item.name)}${item.component ? ` / ${escapeHtml(item.component)}` : ""}: ${escapeHtml(({missing:"Не выдано: отсутствует",faulty:"Не выдано: неисправность",replacement:"Заменено"})[item.reason] || item.reason || "")}${item.replacement_name ? ` → ${escapeHtml(item.replacement_name)}` : ""} ${escapeHtml(item.note || "")}</li>`).join("");
    return `<div class="receipt-summary"><section class="receipt-section"><h3>Состав выдачи</h3>${items ? `<ul>${items}</ul>` : "<p>Состав указан в сохранённом документе.</p>"}</section><section class="receipt-section"><h3>Особенности</h3>${features ? `<ul>${features}</ul>` : "<p>Не отмечены</p>"}</section>${exceptions ? `<section class="receipt-section"><h3>Частичная выдача · исключения</h3><ul>${exceptions}</ul></section>` : ""}</div>`;
  }

  let stageNoticesBusy = false;
  function showStageNotice() { void claimStageNotices(); }
  async function claimStageNotices() {
    if (!authorized || stageNoticesBusy || document.hidden) return;
    stageNoticesBusy = true;
    try {
      const result = await api("/api/miniapp/notifications/claim", {method:"POST", body:"{}"});
      for (const item of result.items || []) {
        const notice = document.createElement("div"); notice.className = "stage-toast"; notice.setAttribute("role", "status");
        const copy = document.createElement("span"); copy.textContent = `Заявка №${item.booking_id}: ${item.message}`;
        const close = plainButton("×", () => notice.remove(), "ghost"); close.setAttribute("aria-label", "Закрыть уведомление");
        notice.append(copy, close); document.body.append(notice); setTimeout(() => notice.remove(), 8000);
      }
    } catch (_) { /* The next poll retries without replaying server-claimed events. */ }
    finally { stageNoticesBusy = false; }
  }
  setInterval(() => { void claimStageNotices(); }, 5000);

  async function previewReceipt(order, admin = false) {
    const path = admin ? `/api/miniapp/admin/bookings/${order.id}/documents/receipt` : `/api/miniapp/bookings/${order.id}/receipt`;
    const response = await fetch(path,{headers:{"X-Telegram-Init-Data":tg?.initData || ""},cache:"no-store"});
    if (!response.ok) {
      let detail = "Не удалось открыть сохранённую расписку";
      try { const error = await response.json(); if (typeof error.detail === "string") detail = error.detail; } catch (_) {}
      throw new Error(detail);
    }
    if (!response.headers.get("Content-Type")?.includes("application/pdf")) {
      await workflowDialog("Сохранная расписка DOCX", receiptSummary(order) + '<button type="button" class="button primary receipt-download">Скачать DOCX</button>', "Закрыть", dialog => {
        dialog.querySelector(".workflow-cancel").textContent = "Назад к заявке";
        dialog.querySelector('[type="submit"]').hidden = true;
        const button = dialog.querySelector(".receipt-download");
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await downloadSecure(path, `receipt-${order.id}.docx`); }
          catch (error) { let message = dialog.querySelector(".receipt-error"); if (!message) { message = document.createElement("p"); message.className = "receipt-error"; message.setAttribute("role", "alert"); button.after(message); } message.textContent = error.message; }
          finally { button.disabled = false; }
        });
      }); return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let renderer = null;
    try {
      await workflowDialog("Предпросмотр расписки", '<div class="receipt-pdf-preview"><p class="receipt-preview-status" role="status">Загрузка страниц…</p><div class="receipt-pages"></div><button type="button" class="button primary receipt-download">Скачать PDF</button></div>', "Закрыть", dialog => {
        dialog.querySelector(".workflow-cancel").textContent = "Назад к заявке";
        dialog.querySelector('[type="submit"]').hidden = true;
        const host = dialog.querySelector(".receipt-pdf-preview");
        const button = host.querySelector(".receipt-download");
        button.addEventListener("click", async () => { button.disabled = true; try { await downloadSecure(path, `receipt-${order.id}.pdf`); } catch (error) { host.querySelector(".receipt-preview-status").textContent = error.message; } finally { button.disabled = false; } });
        void import("/miniapp/static/receipt-preview.js").then(module => {
          if (dialog.isConnected) renderer = module.renderReceiptPdf(host, bytes);
        }).catch(() => { if (dialog.isConnected) host.querySelector(".receipt-preview-status").textContent = "Не удалось загрузить просмотрщик. Скачайте PDF, чтобы открыть его на устройстве."; });
      });
    } finally { renderer?.close(); }
  }

  function plainButton(title, handler, className = "secondary") {
    const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = title;
    button.addEventListener("click", async () => { button.disabled = true; try { await handler(); } catch (error) { showError(error.message); } finally { button.disabled = false; } });
    return button;
  }

  function moscowInput(value) { return new Date(new Date(value).getTime() + 3*3600000).toISOString().slice(0,16); }

  async function editRequestDialog(order, manager = false, change = null) {
    const values = change?.after || {start:order.starts_at,end:order.ends_at,lines:order.items.map(item=>({article_id:item.id,quantity:item.quantity,name:item.title||item.name}))};
    const content=`<p>Время по МСК. Начало — с текущего дня, в рабочее время.</p><label class="field"><span>Начало</span><input name="start" type="datetime-local" min="${minimumBookingDate()}T00:00" value="${moscowInput(values.start)}" required></label><label class="field"><span>Возврат</span><input name="end" type="datetime-local" value="${moscowInput(values.end)}" required></label><div class="request-edit-lines">${values.lines.map(line=>`<label class="field"><span>${escapeHtml(line.name||order.items.find(item=>item.id===line.article_id)?.name||String(line.article_id))}</span><input name="quantity-${line.article_id}" type="number" min="0" max="30" value="${line.quantity}" required></label>`).join("")}</div><button type="button" class="button ghost request-add-position">Добавить позицию</button><div class="request-add-options"></div>${manager?'<label class="field"><span>Комментарий для клиента</span><textarea name="comment" maxlength="2000" required></textarea></label><p>Клиенту придёт уведомление. На подтверждение — 24 часа.</p>':""}`;
    const data=await workflowDialog(manager?"Изменить заявку":"Исправить заявку",content,manager?"Подтвердить":"Подтверждаю",dialog=>{
      const add=dialog.querySelector(".request-add-position");
      add.addEventListener("click",async()=>{
        const start=dialog.querySelector('[name="start"]').value, end=dialog.querySelector('[name="end"]').value;
        if (!start || !end) { showError("Сначала укажите сроки аренды."); return; }
        const existing = new Set([...dialog.querySelectorAll('[name^="quantity-"]')].map(input => Number(input.name.slice(9))));
        const selected = new Map(); let items = [];
        await workflowDialog("Добавить оборудование", `<p>Доступность на сроки заявки. Выберите позиции и количество.</p><label class="field"><span>Поиск в каталоге</span><input type="search" class="request-catalog-search" placeholder="Название, модель или артикул"></label><p class="request-catalog-status" role="status">Загружаем каталог…</p><div class="request-catalog-results"></div><p class="request-catalog-total" role="status">Ничего не выбрано</p><button type="button" class="button secondary request-catalog-retry" hidden>Повторить загрузку</button>`, "Добавить выбранное", picker => {
          const search=picker.querySelector('.request-catalog-search'), host=picker.querySelector('.request-catalog-results'), status=picker.querySelector('.request-catalog-status'), total=picker.querySelector('.request-catalog-total'), retry=picker.querySelector('.request-catalog-retry'), submit=picker.querySelector('[type="submit"]');
          const render=()=>{
            host.replaceChildren(); const query=search.value.trim().toLocaleLowerCase('ru-RU');
            const found=items.filter(item=>![...existing].includes(Number(item.id)) && [item.title,item.name,item.description,item.brand,item.kind,item.key_spec,item.sku].join(' ').toLocaleLowerCase('ru-RU').includes(query));
            status.textContent=found.length ? 'Доступно на даты заявки' : 'Ничего не найдено. Измените запрос или вернитесь к заявке.';
            for(const item of found){
              const count=selected.get(item.id)||0, available=Math.max(0,Number(item.available_quantity)||0);
              const row=document.createElement('article'); row.className='request-catalog-card';
              const heading=document.createElement('strong'); heading.textContent=item.title||item.name;
              const hint=document.createElement('span'); hint.textContent=available ? `Доступно: ${available} шт.` : 'Нет в наличии на эти даты';
              const controls=document.createElement('div'); controls.className='request-catalog-controls';
              const minus=document.createElement('button'); minus.type='button'; minus.className='button ghost'; minus.textContent='−'; minus.setAttribute('aria-label',`Уменьшить количество: ${item.title||item.name}`); minus.disabled=!count;
              const value=document.createElement('strong'); value.textContent=String(count); value.setAttribute('aria-live','polite');
              const plus=document.createElement('button'); plus.type='button'; plus.className='button ghost'; plus.textContent='+'; plus.setAttribute('aria-label',`Добавить: ${item.title||item.name}`); plus.disabled=count>=Math.min(30,available);
              minus.addEventListener('click',()=>{ if(count===1) selected.delete(item.id); else selected.set(item.id,count-1); render(); });
              plus.addEventListener('click',()=>{ selected.set(item.id,count+1); render(); });
              controls.append(minus,value,plus);row.append(heading,hint,controls);host.append(row);
            }
            const quantity=[...selected.values()].reduce((a,b)=>a+b,0);total.textContent=quantity ? `Выбрано: ${quantity} шт.` : 'Ничего не выбрано'; submit.disabled=!quantity;
          };
          const load=async()=>{retry.hidden=true;status.textContent='Загружаем каталог…';submit.disabled=true;try {const result=await api(`/api/miniapp/availability?${new URLSearchParams({start:start+":00+03:00",end:end+":00+03:00"})}`);items=result.all_items||result.items||[];render();}catch(error){status.textContent=`Не удалось загрузить каталог: ${error.message}`;retry.hidden=false;}};
          search.addEventListener('input',render);retry.addEventListener('click',load);void load();
        },async()=>{
          for(const [id,quantityValue] of selected){
            const item=items.find(entry=>entry.id===id);if(!item)continue;
            const label=document.createElement('label');label.className='field';
            const name=document.createElement('span');name.textContent=item.title||item.name;
            const quantity=document.createElement('input');quantity.name=`quantity-${id}`;quantity.type='number';quantity.min='0';quantity.max='30';quantity.value=String(quantityValue);quantity.required=true;
            label.append(name,quantity);dialog.querySelector('.request-edit-lines').append(label);
          }
        });
      });
    },async data=>{
      const proposed={start:`${data.get("start")}:00+03:00`,end:`${data.get("end")}:00+03:00`,lines:[...data].filter(([key])=>key.startsWith("quantity-")).map(([key,value])=>({article_id:Number(key.slice(9)),quantity:Number(value)})).filter(line=>line.quantity>0)};
      if(manager)await api(`/api/miniapp/admin/bookings/${order.id}/changes`,{method:"POST",body:JSON.stringify({change_type:"manager_edit",comment:data.get("comment"),proposed})});
      else if(change)await api(`/api/miniapp/bookings/${order.id}/changes/respond`,{method:"POST",body:JSON.stringify({change_id:change.id,accept:true,corrected:proposed})});
      else await api(`/api/miniapp/bookings/${order.id}`,{method:"PUT",body:JSON.stringify(proposed)});
    });
    if(data) {if(manager)await showAdmin("orders");else await showOrders();}
  }

  function appendCustomerWorkflow(card, order) {
    const notice = workflowNotice(order);
    if (notice) { const strip = document.createElement("p"); strip.className = "notice stage-notice"; strip.setAttribute("role","status"); strip.textContent = notice; card.append(strip); }
    if (order.status === "pending") card.append(plainButton("Изменить заявку", () => editRequestDialog(order)));
    if(order.rework_available)card.append(plainButton("Комментарий доработки",async()=>{const reason=await api(`/api/miniapp/bookings/${order.id}/rework-reason`);await workflowDialog("Вернули на доработку",`<p>${escapeHtml(reason.comment)}</p>`,"Закрыть");}));
    if (order.change_status === "rejected") card.append(plainButton("Причина отклонения",async () => {
      const change=await api(`/api/miniapp/bookings/${order.id}/changes`);
      await workflowDialog("Заявка отклонена",`<p>${escapeHtml(change?.comment || "")}</p>`,"Закрыть");
    }));
    if (order.status === "needs_changes" || order.change_status === "unanswered") {
      card.append(plainButton(order.change_status === "unanswered" ? "Клиент не ответил: решение у менеджера" : "Посмотреть изменения", async () => {
        const change = await api(`/api/miniapp/bookings/${order.id}/changes`);
        if (!change) return;
        if (change.change_type === "client_fix") { const data = await workflowDialog("Нужно исправить", `<p>${escapeHtml(change.comment)}</p>`, "Перейти к исправлению"); if (data) await editRequestDialog(order,false,change); return; }
        const diff = `<p>${escapeHtml(change.comment)}</p><p>Было: ${escapeHtml(dateText(change.before.start))} — ${escapeHtml(dateText(change.before.end))}</p><p>Стало: ${escapeHtml(dateText(change.after.start))} — ${escapeHtml(dateText(change.after.end))}</p><ul>${[...new Set([...change.before.lines,...change.after.lines].map(line=>line.article_id))].map(id=>`<li>${escapeHtml(change.after.lines.find(item=>item.article_id===id)?.name || change.before.lines.find(item=>item.article_id===id)?.name || order.items.find(item=>item.id===id)?.name || String(id))}: ${change.before.lines.find(item=>item.article_id===id)?.quantity || 0} → ${change.after.lines.find(item=>item.article_id===id)?.quantity || 0}</li>`).join("")}</ul><p>${change.deadline ? `Ответить до ${escapeHtml(dateText(change.deadline))} МСК` : ""}</p>`;
        const response = await workflowDialog("Изменения заявки", `${diff}<label class="field"><span>Решение</span><select name="decision"><option value="accept">Подтверждаю</option><option value="dispute">Оспорить</option></select></label><label class="field"><span>Комментарий при оспаривании</span><textarea name="comment" maxlength="2000"></textarea></label>`, "Подтверждаю", (dialog) => { dialog.querySelector("select").addEventListener("change", (event) => { dialog.querySelector("textarea").required = event.target.value === "dispute"; }); }, async data=>api(`/api/miniapp/bookings/${order.id}/changes/respond`,{method:"POST",body:JSON.stringify({change_id:change.id,accept:data.get("decision")==="accept",comment:data.get("comment")})}));
        if (!response) return;
        await showOrders();
      }));
    }
    appendHandoverProgress(card, order, false);
    if (order.partial_issue) { const badge = document.createElement("span"); badge.className="status-pill"; badge.textContent="Частичная выдача"; card.append(badge); }
    if (order.receipt_available || order.receipt_preview_available) card.append(plainButton("Предпросмотр расписки",()=>previewReceipt(order)));
    if (order.receipt_preview_available && !order.receipt_available) card.append(plainButton("Скачать для подписи",()=>downloadSecure(`/api/miniapp/bookings/${order.id}/receipt`,`receipt-${order.id}.docx`)));
    if (order.status === "ready" && !order.handover?.received_at) card.append(plainButton("Получил", async () => {
      const data = await workflowDialog("Получение оборудования", receiptSummary(order) + (order.partial_issue ? '<label class="check-row"><input name="acknowledged" type="checkbox" required><span>С перечнем ознакомлен</span></label>' : ""), "Подтверждаю",null,async data=>api(`/api/miniapp/bookings/${order.id}/attest`,{method:"POST",body:JSON.stringify({action:"received",acknowledged:data.get("acknowledged")==="on"})}));
      if (data) await showOrders();
    },"primary"));
    if ((order.status === "issued" || (order.status === "return_inspection" && order.handover?.legacy_issue)) && !order.handover?.returning_at) card.append(plainButton("Сдаю оборудование", async () => {
      if (await workflowDialog("Сдаю оборудование", receiptSummary(order), "Подтверждаю",null,async()=>api(`/api/miniapp/bookings/${order.id}/attest`,{method:"POST",body:JSON.stringify({action:"returning"})}))) await showOrders();
    },"primary"));
  }

  function appendAdminWorkflow(actions, order) {
    showStageNotice(order,true);
    const role = state.role?.staff_role || "operator";
    const manager = ["manager","admin"].includes(role);
    if (manager && ["pending","needs_changes","confirmed","preparing","ready","issued","return_inspection"].includes(order.status)) actions.append(actionButton(order.assignee_id ? "Передать заявку" : "Назначить ответственного", () => chooseAssignee(order), order.id, "secondary lock-exempt"));
    if (order.partial_issue) { const badge = document.createElement("span"); badge.className="status-pill"; badge.textContent="Частичная выдача"; actions.append(badge); }
    if (manager && ["pending","confirmed"].includes(order.status)) {
      actions.append(actionButton("Изменить заявку", () => editRequestDialog(order,true), order.id,"secondary",false));
      actions.append(actionButton("Запросить исправление заявки", async () => {
        const data = await workflowDialog("Нужно исправить", '<label class="field"><span>Комментарий для клиента</span><textarea name="comment" maxlength="2000" required></textarea></label>',"Подтвердить",null,async data=>api(`/api/miniapp/admin/bookings/${order.id}/changes`,{method:"POST",body:JSON.stringify({change_type:"client_fix",comment:data.get("comment")})}));
      }, order.id,"secondary"));
    }
    if (manager && ["pending","needs_changes","confirmed"].includes(order.status)) actions.append(actionButton("Отклонить",async () => {
      const data=await workflowDialog("Отклонить заявку",'<label class="field"><span>Причина для клиента</span><textarea name="comment" maxlength="2000" required></textarea></label>',"Подтвердить",null,async data=>api(`/api/miniapp/admin/bookings/${order.id}/decline`,{method:"POST",body:JSON.stringify({comment:data.get("comment")})}));
    },order.id,"ghost danger"));
    if (order.change_status === "unanswered") { const note = document.createElement("p"); note.className="notice"; note.textContent="Клиент не ответил на изменения. Решение принимает менеджер."; actions.append(note); }
    if (order.handover?.snapshot && state.role?.pii_admin) actions.append(actionButton("Скачать расписку", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/receipt`,`receipt-${order.id}.docx`),order.id,"secondary lock-exempt",false));
    if (order.handover?.snapshot && state.role?.pii_admin) actions.append(actionButton("Предпросмотр расписки",()=>previewReceipt(order,true),order.id,"secondary lock-exempt",false));
    if (state.role?.pii_admin && order.archived_documents?.includes("issue")) actions.append(actionButton("Архивный акт (устаревший)", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/issue`,`act-${order.id}.docx`),order.id,"ghost lock-exempt",false));
    for(const kind of ["receipt","return","contract"])if(state.role?.pii_admin&&order.archived_documents?.includes(kind))actions.append(actionButton(({receipt:"Архивная расписка DOCX",return:"Архивный акт возврата",contract:"Архивный договор"})[kind],()=>downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/${kind==="receipt"?"legacy_receipt":kind}`,`archive-${kind}-${order.id}.docx`),order.id,"ghost lock-exempt",false));
    if (state.role?.pii_admin && ["issued","return_inspection"].includes(order.status) && !order.handover?.snapshot?.length) actions.append(actionButton("Подготовить расписку старой выдачи", async () => {
      if (await workflowDialog("Перенос старой выдачи", "<p>Будет подготовлена PDF-расписка по проверенной анкете. Исторические документы сохранятся. Особенности на момент выдачи неизвестны; при возврате нужна ручная сверка.</p>")) await api(`/api/miniapp/admin/bookings/${order.id}/migrate-receipt`,{method:"POST"});
    },order.id,"secondary lock-exempt"));
    if (order.handover?.issued_by) { const note = document.createElement("p"); note.textContent = `Выдал: ${order.handover.issued_by_name || `сотрудник ID ${order.handover.issued_by}`}`; actions.append(note); }
    if (order.handover?.returned_by) { const note = document.createElement("p"); note.textContent = `Принял: ${order.handover.returned_by_name || `сотрудник ID ${order.handover.returned_by}`}`; actions.append(note); }
    if (order.status === "ready" && order.handover?.received_at) actions.append(actionButton("Выдать оборудование", () => api(`/api/miniapp/admin/bookings/${order.id}/transition`,{method:"POST",body:JSON.stringify({action:"issued"})}),order.id,"primary workflow-next handover-action"));
    if (order.status === "return_inspection") for (const asset of order.assets) actions.append(actionButton(`Особенности при возврате: ${asset.name}`, async () => {
      const original = order.handover?.snapshot?.find((item) => item.id === asset.id);
      const data = await workflowDialog("Сравнение особенностей", `<p>При выдаче: ${escapeHtml(original?.features?.map((item) => item.description).join("; ") || (order.handover?.legacy_snapshot_unknown ? "снимок отсутствовал" : "особенностей нет"))}</p><label class="field"><span>Результат</span><select name="kind"><option value="existing">Старая черта, выявлено при возврате</option><option value="damage">Новое повреждение</option><option value="lost">Утеря</option></select></label><label class="field"><span>Описание</span><textarea name="description" maxlength="2000" required></textarea></label>`,"Подтвердить",null,async data=>api(`/api/miniapp/admin/bookings/${order.id}/return-finding`,{method:"POST",body:JSON.stringify({equipment_id:asset.id,kind:data.get("kind"),description:data.get("description")})}));
    },order.id,"secondary handover-action"));
    if (!manager) actions.querySelectorAll("button").forEach((button) => { if (["Изменить заявку"].includes(button.textContent)) button.hidden = true; });
    if (state.role?.pii_only) actions.querySelectorAll("button:not(.lock-exempt)").forEach((button) => { button.hidden=true; });
  }

  async function manualAssign(order) {
    const catalog = await api("/api/miniapp/admin/catalog");
    const editor = document.createElement("article"); editor.className = "admin-card assignment-editor";
    editor.innerHTML = `<div class="order-head"><div><h3>Замена экземпляров</h3><p>Выберите конкретную технику для каждой позиции заказа.</p></div><button type="button" class="button ghost compact assignment-close">Закрыть</button></div><form class="assignment-form"></form>`;
    const form = editor.querySelector("form");
    for (const line of order.lines) {
      const article = catalog.articles.find((item) => item.id === line.article_id);
      const current = order.assets.filter((asset) => asset.line_id === line.id || (!asset.line_id && asset.article_id === line.article_id)).map((asset) => asset.id);
      const group = document.createElement("fieldset"); group.className = "assignment-group";
      group.innerHTML = `<legend>${escapeHtml(line.name)} × ${line.quantity}</legend>`;
      for (let index = 0; index < line.quantity; index += 1) {
        const slot = document.createElement("label"); slot.className = "assignment-slot";
        slot.innerHTML = `<span>${escapeHtml(line.title || line.name)} · ${index + 1}</span>`;
        const select = document.createElement("select"); select.name = `line-${line.id}`; select.required = true;
        select.innerHTML = '<option value="">Выберите технику</option><option value="missing">Не выдано: отсутствует</option><option value="faulty">Не выдано: неисправность</option>';
        for (const item of article?.equipment || []) {
          if (item.condition !== "available" && !current.includes(item.id)) continue;
          const option = document.createElement("option"); option.value = item.id; option.textContent = `${article.title || article.name} #${item.asset_code} · ${item.location || "без ячейки"}`; option.selected = current[index] === item.id; select.append(option);
        }
        const note = document.createElement("input"); note.name = `note-${line.id}-${index}`; note.placeholder="Комментарий к исключению (необязательно)"; note.maxLength=2000;
        const replacement = document.createElement("details"); replacement.innerHTML='<summary>Выбрать замену</summary>';
        const candidates = catalog.articles.flatMap((model) => model.equipment.filter((item) => item.condition === "available").map((item) => ({...item,label:`${model.title || model.name} #${item.asset_code}`})));
        const results = document.createElement("div"); results.className="replacement-list";
        const draw = (query="") => {
          results.replaceChildren();
          const filtered = candidates.filter((item) => `${item.id} ${item.label}`.toLocaleLowerCase("ru-RU").includes(query.toLocaleLowerCase("ru-RU"))).slice(0,10);
          for (const item of filtered) results.append(plainButton(item.label, () => {
            let option = [...select.options].find((entry) => entry.value === String(item.id));
            if (!option) { option = new Option(item.label,String(item.id)); select.append(option); }
            option.dataset.replacement="true"; select.value=String(item.id); select.dispatchEvent(new Event("change")); replacement.open=false;
          },"ghost"));
        };
        if (candidates.length > 10) { const search=document.createElement("input"); search.type="search"; search.placeholder="Поиск по ID или названию"; search.setAttribute("aria-label","Поиск замены по ID или названию"); search.addEventListener("input",()=>draw(search.value)); replacement.append(search); }
        draw(); replacement.append(results);
        if (current[index] && ![...select.options].some(option=>option.value===String(current[index]))) {
          const model=catalog.articles.find(model=>model.equipment.some(item=>item.id===current[index]));
          const asset=model?.equipment.find(item=>item.id===current[index]);
          if (asset) {const option=new Option(`${model.title||model.name} #${asset.asset_code}`,String(asset.id),true,true); option.dataset.replacement="true"; select.append(option);}
        }
        const components=document.createElement("div"); components.className="component-slots";
        const drawComponents=()=>{
          components.replaceChildren();
          const model=catalog.articles.find(model=>model.equipment.some(item=>item.id===Number(select.value)));
          for (const component of [...new Set((model?.composition || "").split(/[\n;]+/).map(value=>value.trim()).filter(Boolean))]) {
            const saved=order.handover?.exceptions?.find(item=>item.equipment_id===Number(select.value)&&item.component===component);
            const row=document.createElement("div"); row.className="component-slot"; row.dataset.component=component;
            row.innerHTML=`<label class="field"><span>${escapeHtml(component)}</span><select class="component-state"><option value="issued">Выдано</option><option value="missing">Не выдано: отсутствует</option><option value="faulty">Не выдано: неисправность</option><option value="replacement">Заменено</option></select></label><input class="component-replacement" maxlength="200" placeholder="Что выдано взамен" aria-label="Замена элемента комплектации">`;
            const stateSelect=row.querySelector("select"),input=row.querySelector("input"); stateSelect.value=saved?.reason || "issued"; input.value=saved?.replacement_name || "";
            const update=()=>{input.hidden=stateSelect.value!=="replacement";input.required=stateSelect.value==="replacement";}; stateSelect.addEventListener("change",update);update();components.append(row);
          }
        };
        select.addEventListener("change",drawComponents);drawComponents();
        slot.append(select, note, replacement,components); group.append(slot);
      }
      form.append(group);
    }
    const buttons = document.createElement("div"); buttons.className = "action-row"; buttons.innerHTML = `<button class="button primary" type="submit">Сохранить замену</button>`; form.append(buttons);
    $("admin-content").prepend(editor); editor.scrollIntoView({ behavior: "smooth", block: "start" });
    editor.querySelector(".assignment-close").addEventListener("click", () => editor.remove());
    const refreshAssignmentOptions = () => {
      const selects = [...form.querySelectorAll('select[name^="line-"]')];
      const selected = new Set(selects.map((select) => select.value).filter((value) => /^\d+$/.test(value)));
      for (const select of selects) {
        for (const option of select.options) {
          option.disabled = Boolean(option.value && selected.has(option.value) && option.value !== select.value);
        }
      }
    };
    form.querySelectorAll("select").forEach((select) => select.addEventListener("change", refreshAssignmentOptions));
    refreshAssignmentOptions();
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const assignments = {}, exceptions = [];
      for (const line of order.lines) {
        assignments[String(line.id)] = [];
        for (const select of form.querySelectorAll(`[name="line-${line.id}"]`)) {
          const note = select.closest("label").querySelector("input").value;
          if (["missing","faulty"].includes(select.value)) exceptions.push({line_id:line.id,reason:select.value,note});
          else {
            assignments[String(line.id)].push(Number(select.value)); if (select.selectedOptions[0]?.dataset.replacement) exceptions.push({line_id:line.id,reason:"replacement",replacement_id:Number(select.value),note});
            for (const row of select.closest(".assignment-slot").querySelectorAll(".component-slot")) {const reason=row.querySelector("select").value;if(reason!=="issued")exceptions.push({line_id:line.id,equipment_id:Number(select.value),component:row.dataset.component,reason,replacement_name:row.querySelector("input").value,note});}
          }
        }
      }
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try { await api(`/api/miniapp/admin/bookings/${order.id}/assignments`, { method: "PUT", body: JSON.stringify({ assignments, exceptions }) }); await showAdmin("orders"); }
      catch (error) { showError(error.message); submit.disabled = false; }
    });
  }

  function openInspection(order, asset, stage, saved = null) {
    const content = $("admin-content");
    const card = document.createElement("article"); card.className = "admin-card inspection-editor";
    card.innerHTML = `<div class="order-head"><div><h3>${stage === "pre_issue" ? "Неисправность перед выдачей" : "Неисправность при возврате"}</h3><p>${escapeHtml(asset.name)} · серийный № ${escapeHtml(asset.serial)}</p></div><button type="button" class="button ghost compact inspection-close">Закрыть</button></div><form class="inspection-form"><div class="form-grid"><label class="field wide"><span>Что произошло</span><textarea name="defect" maxlength="4000" required placeholder="Опишите неисправность"></textarea></label><label class="field wide"><span>Комментарий</span><textarea name="notes" maxlength="2000" placeholder="Дополнительная информация"></textarea></label>${stage === "check_in" ? '<label class="field wide"><span>Фото повреждения (необязательно)</span><input name="damage_photo" type="file" accept="image/*" capture="environment"><small>Фото можно сделать камерой телефона. Новое фото заменит предыдущее.</small></label>' : ""}<label class="field"><span>Оценка ущерба, ₽</span><input name="estimated_cost" type="number" min="0" step="0.01" value="0"></label><label class="check-row"><input name="charge_customer" type="checkbox"><span>Ущерб клиента</span></label></div><div class="action-row"><button class="button primary" type="submit">Сохранить неисправность</button></div></form>`;
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

  function hideDeleteSnackbar() { $("delete-snackbar").hidden = true; $("delete-retry").hidden = true; }
  function updateEquipmentEmpty(container) {
    if (!container?.classList.contains("request-equipment")) return;
    const empty = container.querySelector(".request-equipment-empty");
    if (empty) empty.hidden = [...container.querySelectorAll(".request-equipment-row")].some((row) => !row.inert);
  }
  function adjustAssetLine(deletion, delta) {
    if (!deletion.assetId || !deletion.line) return;
    deletion.line.quantity += delta;
    const row = document.querySelector(`.request-card[data-booking-id="${deletion.bookingId}"] .request-equipment-row[data-line-id="${deletion.line.id}"]`);
    if (row) { row.querySelector("span").textContent = `${deletion.line.title || deletion.line.name} × ${deletion.line.quantity}`; row.style.visibility = deletion.line.quantity ? "" : "hidden"; row.inert = !deletion.line.quantity; updateEquipmentEmpty(row.parentElement); }
  }
  function revealDeletedCard(deletion) {
    if (deletion.assetAdjusted) { adjustAssetLine(deletion, 1); deletion.assetAdjusted = false; }
    if (deletion.card?.isConnected) { deletion.card.style.visibility = ""; deletion.card.inert = false; deletion.card.removeAttribute("aria-hidden"); updateEquipmentEmpty(deletion.card.parentElement); }
  }
  function prepareDeletionIntent(deletion) {
    const targetType = deletion.assetId ? "asset" : deletion.lineId ? "line" : "request";
    return api(`/api/miniapp/admin/bookings/${deletion.bookingId}/deletion-intents`, {method:"POST", body:JSON.stringify({id:deletion.intentId, target_type:targetType, target_id:deletion.assetId || deletion.lineId || null})})
      .then((result) => ({result}), (error) => ({error}));
  }
  async function cancelDeletionIntent(deletion) {
    let prepared = await deletion.intentPromise;
    if (prepared.error) { deletion.intentPromise = prepareDeletionIntent(deletion); prepared = await deletion.intentPromise; }
    if (prepared.error) throw prepared.error;
    await api(`/api/miniapp/admin/bookings/${deletion.bookingId}/deletion-intents/${deletion.intentId}/cancel`, {method:"POST"});
  }
  async function commitRequestDeletion(deletion, replacement = null) {
    if (deletion.committing) return;
    deletion.committing = true;
    clearInterval(deletion.timer);
    if (pendingDeletion === deletion) $("delete-undo").disabled = true;
    try {
      let prepared = await deletion.intentPromise;
      if (prepared.error) { deletion.intentPromise = prepareDeletionIntent(deletion); prepared = await deletion.intentPromise; }
      if (prepared.error) throw prepared.error;
      if (replacement) { const next = await replacement.intentPromise; if (next.error) throw next.error; }
      const replacementQuery = replacement ? `&replacement=${encodeURIComponent(replacement.intentId)}` : "";
      await api(`/api/miniapp/admin/bookings/${deletion.bookingId}${deletion.lineId ? `/lines/${deletion.lineId}` : deletion.assetId ? `/assets/${deletion.assetId}` : ""}?intent=${encodeURIComponent(deletion.intentId)}${replacementQuery}`, { method: "DELETE" });
      if (pendingDeletion === deletion) { pendingDeletion = null; hideDeleteSnackbar(); }
    } catch (error) {
      deletion.committing = false;
      if (pendingDeletion !== deletion) { revealDeletedCard(deletion); showError(`Не удалось удалить заявку: ${error.message}`); return; }
      deletion.failed = true; $("delete-message").textContent = `Не удалось удалить заявку: ${error.message}`;
      $("delete-retry").hidden = false; $("delete-undo").disabled = false;
    }
  }
  function beginRequestDeletion(order, card, lineId = null, assetId = null) {
    const offset = window.scrollY;
    card.style.visibility = "hidden"; card.inert = true; card.setAttribute("aria-hidden", "true"); updateEquipmentEmpty(card.parentElement);
    window.scrollTo(window.scrollX, offset);
    const previous = pendingDeletion && !pendingDeletion.cancelRequested ? pendingDeletion : null;
    const deletion = { bookingId: order.id, lineId, assetId, card, intentId:newRequestId(), deadline: Date.now() + deleteUndoSeconds * 1000, timer: null, failed: false };
    if (assetId) {
      const asset = order.assets.find((item) => item.id === assetId);
      deletion.line = order.lines.find((line) => line.article_id === asset?.article_id);
      if (deletion.line && deletion.line.quantity > 0) { adjustAssetLine(deletion, -1); deletion.assetAdjusted = true; }
    }
    deletion.intentPromise = prepareDeletionIntent(deletion);
    pendingDeletion = deletion; $("delete-retry").hidden = true; $("delete-undo").disabled = false; $("delete-snackbar").hidden = false;
    deletion.intentPromise.then(({result}) => { if (result && Number.isInteger(result.undo_seconds) && pendingDeletion === deletion && !deletion.committing) deletion.deadline = Date.now() + result.undo_seconds * 1000; });
    deletion.previousCommit = previous ? commitRequestDeletion(previous, deletion) : Promise.resolve();
    const tick = () => {
      const left = Math.max(0, Math.ceil((deletion.deadline - Date.now()) / 1000));
      $("delete-message").textContent = `${assetId ? "Экземпляр" : lineId ? "Позиция" : "Заявка"} удалится через ${left} с`;
      if (!left) void commitRequestDeletion(deletion);
    };
    tick(); deletion.timer = setInterval(tick, 250);
  }
  async function finishDeletionUndo(deletion) {
    try { await deletion.previousCommit; await cancelDeletionIntent(deletion); if (pendingDeletion === deletion) { pendingDeletion = null; hideDeleteSnackbar(); } }
    catch (error) {
      if (error.status === 409) { if (pendingDeletion === deletion) pendingDeletion = null; hideDeleteSnackbar(); await showAdmin("orders"); showError("Удаление уже сохранено. Для восстановления обратитесь к администратору."); return; }
      if (!pendingDeletion || pendingDeletion === deletion) { pendingDeletion = deletion; deletion.failed = true; deletion.cancelRequested = true; $("delete-snackbar").hidden = false; $("delete-message").textContent = `Не удалось записать отмену: ${error.message}`; $("delete-undo").disabled = true; $("delete-retry").hidden = false; } else showError("Не удалось записать отмену удаления.");
    }
  }
  $("delete-undo").addEventListener("click", () => {
    if (!pendingDeletion || pendingDeletion.committing) return;
    const deletion = pendingDeletion; clearInterval(deletion.timer); deletion.cancelRequested = true;
    revealDeletedCard(deletion); pendingDeletion = null; hideDeleteSnackbar(); void finishDeletionUndo(deletion);
  });
  $("delete-retry").addEventListener("click", () => { if (pendingDeletion?.failed) { const deletion = pendingDeletion; deletion.failed = false; $("delete-retry").hidden = true; if (deletion.cancelRequested) void finishDeletionUndo(deletion); else void commitRequestDeletion(deletion); } });

  $("operator-notification-settings").addEventListener("toggle", async (event) => {
    if (!event.currentTarget.open) return;
    try { const settings = await api("/api/miniapp/admin/notification-preferences"); const form = $("operator-quiet-form"); form.elements.quiet_start.value = settings.quiet_start || ""; form.elements.quiet_end.value = settings.quiet_end || ""; }
    catch (error) { $("operator-quiet-status").textContent = error.message; }
  });
  $("operator-quiet-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    try { await api("/api/miniapp/admin/notification-preferences", {method:"PUT", body:JSON.stringify({quiet_start:form.elements.quiet_start.value || null, quiet_end:form.elements.quiet_end.value || null})}); $("operator-quiet-status").textContent = "Сохранено"; }
    catch (error) { $("operator-quiet-status").textContent = error.message; }
  });
  $("main-button").addEventListener("click", next);
  $("client-catalog-search").addEventListener("input", renderItems);
  function setCatalogLayout(layout) {
    $("items-grid").classList.toggle("items-grid-tiles", layout === "grid");
    $("catalog-list").setAttribute("aria-pressed", String(layout === "list"));
    $("catalog-grid").setAttribute("aria-pressed", String(layout === "grid"));
    try { localStorage.setItem("polyrental-catalog-layout", layout); } catch (_) { /* Preference is optional. */ }
  }
  $("catalog-list").addEventListener("click", () => setCatalogLayout("list"));
  $("catalog-grid").addEventListener("click", () => setCatalogLayout("grid"));
  try { setCatalogLayout(localStorage.getItem("polyrental-catalog-layout") === "grid" ? "grid" : "list"); } catch (_) { setCatalogLayout("list"); }
  $("retry-items").addEventListener("click", loadItems);
  $("change-dates").addEventListener("click", () => { state.step = 0; render(); });
  $("back-button").addEventListener("click", back);
  let supportContext = { screen: "profile", bookingId: null }, supportReturnFocus = null;
  async function openSupport(screen, bookingId = null) {
    supportContext = {screen, bookingId}; supportReturnFocus = document.activeElement;
    $("support-dialog").hidden = false; $("support-result").textContent = ""; $("support-question").value = ""; render();
    $("support-close").focus(); $("support-faq").textContent = "Загружаем…";
    try {
      const result = await api("/api/miniapp/support/faq"); $("support-faq").replaceChildren();
      for (const item of result.items) { const details = document.createElement("details"); const title = document.createElement("summary"); const answer = document.createElement("p"); title.textContent = item.question; answer.textContent = item.answer; details.append(title, answer); $("support-faq").append(details); }
    } catch (_) { $("support-faq").textContent = "Не удалось загрузить частые вопросы."; }
  }
  function closeSupport() { $("support-dialog").hidden = true; render(); if (supportReturnFocus?.isConnected) supportReturnFocus.focus({preventScroll:true}); }
  $("profile-support").addEventListener("click", () => openSupport("profile"));
  $("blocked-support").addEventListener("click", () => openSupport("booking"));
  $("support-close").addEventListener("click", closeSupport);
  $("support-dialog").addEventListener("keydown", (event) => { if (event.key === "Tab") trapDialogFocus(event, $("support-dialog")); if (event.key === "Escape") closeSupport(); });
  $("support-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try { const result = await api("/api/miniapp/support/questions", { method:"POST", body:JSON.stringify({ question:$("support-question").value, screen:supportContext.screen, booking_id:supportContext.bookingId }) }); $("support-question").value = ""; $("support-result").textContent = result.status; }
    catch (error) { $("support-result").textContent = error.message; }
    finally { button.disabled = false; }
  });
  function renderSupportThreads(result) {
    const content = $("admin-content"); content.replaceChildren();
    if (!result.items.length) { content.textContent = "Обращений пока нет."; return; }
    for (const thread of result.items) {
      const card = document.createElement("article"); card.className = "admin-card"; card.dataset.supportThreadId = String(thread.id);
      const heading = document.createElement("h3"); heading.textContent = `Обращение №${thread.id}${thread.request_number ? ` · ${thread.request_number}` : ""}`; card.append(heading);
      const meta = document.createElement("p"); meta.textContent = `${thread.status === "resolved" ? "Закрыто" : thread.owner_id ? `Владелец ID ${thread.owner_id}` : "Без владельца"} · ${dateText(thread.created_at)} МСК`; card.append(meta);
      if (!thread.owner_id && thread.status !== "resolved" && state.role?.pii_admin) {
        const claim = document.createElement("button"); claim.type = "button"; claim.className = "button secondary"; claim.textContent = "Взять обращение";
        claim.addEventListener("click", async () => { try { await api(`/api/miniapp/admin/support/${thread.id}/claim`, {method:"POST"}); await showAdmin("support"); } catch (error) { showError(error.message); } }); card.append(claim);
      }
      if (thread.owner_id === state.role?.id && state.role?.pii_admin) {
        const open = document.createElement("button"); open.type = "button"; open.className = "button secondary"; open.textContent = "Открыть сообщения"; card.append(open);
        const body = document.createElement("div"); card.append(body);
        open.addEventListener("click", async () => {
          try {
            const result = await api(`/api/miniapp/admin/support/${thread.id}/messages`); body.replaceChildren();
            const context = document.createElement("p"); context.textContent = `Telegram ID ${result.customer_id} · экран ${result.screen}`; body.append(context);
            for (const message of result.items) { const p = document.createElement("p"); p.textContent = `${message.direction === "client" ? "Клиент" : "Оператор"}: ${message.text}`; body.append(p); }
            if (thread.status !== "resolved") { const form = document.createElement("form"); form.innerHTML = `<label class="field"><span>Ответ</span><textarea maxlength="3000" required></textarea></label><button class="button primary" type="submit">Ответить в Telegram</button>`;
              form.addEventListener("submit", async (event) => { event.preventDefault(); try { await api(`/api/miniapp/admin/support/${thread.id}/reply`, {method:"POST", body:JSON.stringify({text:form.querySelector("textarea").value})}); await showAdmin("support"); } catch (error) { showError(error.message); } }); body.append(form); }
          } catch (error) { showError(error.message); }
        });
      }
      if (state.role?.pii_admin && thread.owner_id === state.role?.id && thread.status !== "resolved") { const done = document.createElement("button"); done.type="button"; done.className="button ghost"; done.textContent="Закрыть обращение"; done.addEventListener("click", async () => { try { await api(`/api/miniapp/admin/support/${thread.id}/resolve`,{method:"POST"}); await showAdmin("support"); } catch (error) { showError(error.message); } }); card.append(done); }
      if (thread.status !== "resolved") { const form = document.createElement("form"); form.className="action-row"; form.innerHTML = `<label class="field"><span>Сотрудник с доступом к ПД</span><select required></select></label><button class="button ghost" type="submit">Передать</button>`; for (const id of (result.eligible_owners || [])) { const option = document.createElement("option"); option.value = id; option.textContent = `Telegram ID ${id}`; form.querySelector("select").append(option); } form.addEventListener("submit", async (event) => { event.preventDefault(); try { await api(`/api/miniapp/admin/support/${thread.id}/owner`,{method:"PUT",body:JSON.stringify({assignee_id:Number(form.querySelector("select").value)})}); await showAdmin("support"); } catch(error) { showError(error.message); } }); card.append(form); }
      content.append(card);
      if (state.supportTargetId === thread.id) { state.supportTargetId = null; card.scrollIntoView({block:"center"}); }
    }
  }

  const onboardingSlides = [
    ["Выбор дат", "Выберите даты и время получения и возврата оборудования."],
    ["Каталог и подборка", "Посмотрите доступное оборудование и выберите количество."],
    ["Оформление заявки", "Укажите контакт, проверьте подборку и отправьте заявку."],
    ["Мои заявки и поддержка", "Следите за заявками в профиле и обращайтесь к оператору в чате бота."],
  ];
  let onboardingIndex = 0, onboardingReturnFocus = null;
  function drawOnboarding() {
    const [title, copy] = onboardingSlides[onboardingIndex];
    $("onboarding-title").textContent = title; $("onboarding-copy").textContent = copy;
    $("onboarding-progress").textContent = `${onboardingIndex + 1} / ${onboardingSlides.length}`;
    $("onboarding-next").textContent = onboardingIndex === onboardingSlides.length - 1 ? "Готово" : "Далее";
  }
  function openOnboarding() {
    onboardingReturnFocus = document.activeElement; onboardingIndex = 0; drawOnboarding();
    $("onboarding-dialog").hidden = false; render(); $("onboarding-next").focus();
  }
  async function finishOnboarding() {
    $("onboarding-dialog").hidden = true; render();
    if (onboardingReturnFocus?.isConnected) onboardingReturnFocus.focus({ preventScroll: true });
    if (authorized) { try { await api("/api/miniapp/onboarding/complete", { method: "POST" }); } catch (_) { showError("Не удалось сохранить отметку о просмотре инструкции."); } }
  }
  async function maybeShowOnboarding() {
    if (state.onboardingPending && state.view === "flow") { state.onboardingPending = false; openOnboarding(); return; }
    if (!authorized || !state.profile || state.profile.onboarding_seen || state.onboardingLoading) return;
    state.onboardingLoading = true;
    try {
      const result = await api("/api/miniapp/onboarding/show", { method: "POST" });
      state.profile.onboarding_seen = true;
      if (result.first_show) { if (state.view === "flow") openOnboarding(); else state.onboardingPending = true; }
    } catch (_) { showError("Не удалось загрузить инструкцию. Её можно открыть в профиле."); }
    finally { state.onboardingLoading = false; }
  }
  function enterClientMode() {
    clearError();
    if (state.role?.admin && state.view === "admin") {
      api("/api/miniapp/operator/client-mode", { method: "POST" }).catch(() => showError("Не удалось записать переход в режим бронирования."));
    }
    if (state.profile?.client_allowed === false) { state.view = "blocked"; render(); return; }
    state.view = "flow";
    if (state.step === 4) { state.step = 0; state.quantities.clear(); state.items = []; state.requestId = null; $("start").value = ""; $("end").value = ""; }
    syncDateFields("start"); syncDateFields("end");
    rangeCalendar.setRange($("start-date").value, $("end-date").value); applyBookingDateLimits(); render();
    void maybeShowOnboarding();
  }
  $("tab-new").addEventListener("click", enterClientMode);
  $("onboarding-reopen").addEventListener("click", openOnboarding);
  $("reminders-enabled").addEventListener("change", async (event) => {
    const checkbox = event.target, previous = state.profile.reminders_enabled;
    checkbox.disabled = true;
    try { const result = await api("/api/miniapp/profile/reminders", { method: "PUT", body: JSON.stringify({ enabled: checkbox.checked }) }); state.profile.reminders_enabled = result.enabled; checkbox.checked = result.enabled; }
    catch (error) { checkbox.checked = previous; showError(`Не удалось сохранить настройку: ${error.message}`); }
    finally { checkbox.disabled = false; }
  });
  $("onboarding-skip").addEventListener("click", finishOnboarding);
  $("onboarding-next").addEventListener("click", () => { if (onboardingIndex + 1 === onboardingSlides.length) void finishOnboarding(); else { onboardingIndex++; drawOnboarding(); } });
  $("onboarding-dialog").addEventListener("keydown", (event) => { if (event.key === "Tab") trapDialogFocus(event, $("onboarding-dialog")); if (event.key === "Escape") void finishOnboarding(); });
  $("tab-orders").addEventListener("click", showOrders);
  let profileSearchTimer;
  function applyProfileSearch() {
    clearTimeout(profileSearchTimer);
    if (state.view !== "orders") return;
    state.profileTargetId = null; state.profileNumber = $("profile-number").value.trim(); state.profilePage = 0; state.profileFilter = "all"; $("profile-filter").value = "all"; void showOrders();
  }
  $("profile-number").addEventListener("input", () => { clearTimeout(profileSearchTimer); profileLoadSequence += 1; profileSearchTimer = setTimeout(applyProfileSearch, 350); });
  $("profile-search").addEventListener("submit", (event) => { event.preventDefault(); applyProfileSearch(); });
  $("profile-filter").addEventListener("change", (event) => { state.profileTargetId = null; state.profileFilter = event.target.value; state.profilePage = 0; void showOrders(); });
  $("profile-prev").addEventListener("click", () => { state.profilePage = Math.max(0, state.profilePage - 1); void showOrders(); });
  $("profile-next").addEventListener("click", () => { state.profilePage++; void showOrders(); });
  $("tab-admin").addEventListener("click", () => showAdmin(state.adminMode));
  $("identity-close").addEventListener("click", () => { $("identity-form").reset(); state.consent = null; state.identityBookingId = null; showOrders(); });
  $("document-viewer-close").addEventListener("click", closeDocumentViewer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("document-viewer").hidden) closeDocumentViewer();  });
  $("document-viewer").addEventListener("keydown", (event) => { if (event.key === "Tab") trapDialogFocus(event, $("document-viewer")); });
  $("document-viewer-prev").addEventListener("click", async () => { if (documentViewerIndex > 0) { documentViewerIndex -= 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("document-viewer-next").addEventListener("click", async () => { if (documentViewerIndex < documentViewerItems.length - 1) { documentViewerIndex += 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("consent-next").addEventListener("click", async () => {
    if (!state.consent) return showError("Текст согласия не загружен.");
    if (!$("consent-check").checked) return showError("Чтобы продолжить, подтвердите согласие.");
    clearError(); const button = $("consent-next"); button.disabled = true;
    try {
      $("consent-step").hidden = true; $("identity-form").hidden = false;
      const bookingId = state.identityBookingId;
      const reusableDocuments = [...state.identityReusableDocuments];
      if (!reusableDocuments.length) return;
      const status = $("identity-status"), submit = $("identity-submit");
      status.textContent = "Подготавливаем фотографии из предыдущей анкеты…"; status.hidden = false;
      submit.disabled = true; submit.textContent = "Подготавливаем фотографии…";
      void restoreReusableIdentityPhotos(bookingId, reusableDocuments).finally(() => {
        if (state.identityBookingId !== bookingId || $("identity-form").hidden) return;
        status.hidden = true; submit.disabled = false; submit.textContent = "Отправить на проверку";
      });
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
    if (status) status.textContent = file ? `Загружено ✓ · ${file.name}` : "";
    clearIdentityFieldError(input);
  }));
  document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => {
    const buttons = document.createElement("div"); buttons.className="action-row photo-actions";
    buttons.append(plainButton("Заменить",()=>input.click(),"ghost"));
    const remove = plainButton("🗑",async () => {
      input.value=""; await saveIdentityPhoto(input.name,null);
      identityPhotoDrafts.delete(identityPhotoKey(input.name));
      try { await photoDraftTransaction("readwrite",(store)=>store.delete(identityPhotoKey(input.name))); } catch (_) {}
      input.required=true;
      if (!state.identityRequiredPhotos.includes(input.name)) state.identityRequiredPhotos.push(input.name);
      const status=input.closest(".field").querySelector(".file-draft-status"); if (status) status.textContent="Фото удалено. Загрузите новое перед отправкой.";
    },"ghost danger"); remove.setAttribute("aria-label","Удалить фото"); buttons.append(remove);
    input.closest(".field").insertAdjacentElement("afterend", buttons);
  });
  document.querySelectorAll(".admin-mode").forEach((button) => button.addEventListener("click", () => showAdmin(button.dataset.mode)));
  $("admin-request-filter").addEventListener("change", (event) => { state.adminRequestFilter = event.target.value; void showAdmin("orders"); });
  $("done-orders").addEventListener("click", showOrders);
  $("done-chat").addEventListener("click", () => tg?.close?.());
  for (const id of ["start", "end"]) $(`${id}-time`).addEventListener("input", periodChanged);
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
  syncDateFields("start"); syncDateFields("end");
  const restoredPeriod = ensureBookingPeriod(); applyBookingDateLimits();
  rangeCalendar = new window.PolyRentalCalendar.RangeCalendar($("range-calendar"), {
    minimum: minimumBookingDate(), start: $("start-date").value, end: $("end-date").value,
    isDisabled: scheduleDayDisabled,
    onChange: ({start, end}) => { $("start-date").value = start; $("end-date").value = end; periodChanged(); },
  });
  if (!preview) void api("/api/miniapp/schedule").then((policy)=>{ if (!policy.enforced) return; schedulePolicy=policy; rangeCalendar.render(); applyBookingDateLimits(); render(); }).catch(()=>{});
  if (siteProfile) {
    document.querySelector('.eyebrow').textContent = 'БРОНИРОВАНИЕ ЧЕРЕЗ TELEGRAM';
    const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'button ghost'; logout.textContent = 'Выйти';
    logout.addEventListener('click', async () => { try { const response = await fetch('/site/logout', {method:'POST',headers:{'X-Telegram-Init-Data':''}}); if (response.ok || response.redirected) location.assign('/site/login'); else showError('Не удалось выйти. Повторите попытку.'); } catch (_) { showError('Не удалось выйти. Проверьте соединение.'); } });
    document.querySelector('.topbar').append(logout);
  }
  const profile = tg?.initDataUnsafe?.user || siteProfile;
  if (!preview) void api("/api/miniapp/catalog/categories").then(result => { setCategories(result.items || []); render(); }).catch(() => {});
  if (authorized && profile && !$("customer-name").value) {
    $("customer-name").value = [profile.first_name, profile.last_name].filter(Boolean).join(" ").slice(0, 200);
  }
  void restoreLastBookingContact(hasSavedContact);
  if (preview) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Демонстрация интерфейса: можно пройти шаги, но заявка не отправляется."; }
  else if (!authorized && !keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Чтобы оформить бронь, откройте Mini App через кнопку в Telegram-боте."; }
  else if (keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "После отправки приложение закроется, а бот пришлёт номер заявки и статус."; }
  else if (siteProfile) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Вы вошли через Telegram. Чтобы получать уведомления, начните диалог с ботом."; }
  else if (hasDraft && restoredPeriod) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Мы восстановили сроки и выбранное оборудование из черновика на этом устройстве."; }
  tg?.expand?.();
  if (authorized) {
    Promise.all([api("/api/miniapp/me"), api("/api/miniapp/profile").catch(() => null), api("/api/miniapp/cart").catch(() => null)]).then(([role, profileState, cart]) => {
      state.role = role; state.profile = profileState; $("tab-admin").hidden = !role.admin; $("admin-hidden-tests").hidden = !profileState?.system_admin;
      if (cart && Number.isInteger(cart.version) && Array.isArray(cart.lines)) {
        state.cartVersion = cart.version;
        if (cart.start || cart.end || cart.lines.length) {
          $("start").value = cart.start; $("end").value = cart.end;
          state.quantities = new Map(cart.lines.map((line) => [line.article_id, line.quantity]));
          syncDateFields("start"); syncDateFields("end"); ensureBookingPeriod();
          rangeCalendar.setRange($("start-date").value, $("end-date").value); applyBookingDateLimits(); render();
        } else if (hasDraft) saveDraft();
      }
      void claimStageNotices();
      const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get("startapp");
      const linkedBooking = /^booking_(\d+)$/.exec(startParam || "")?.[1] || new URLSearchParams(location.search).get("booking");
      if (linkedBooking && /^\d+$/.test(linkedBooking)) {
        if (role.admin) { selectedRequestId = Number(linkedBooking); return showAdmin("orders"); }
        selectedCustomerOrderId = Number(linkedBooking); state.profileTargetId = Number(linkedBooking); state.profileFilter = "all"; $("profile-filter").value = "all"; return showOrders();
      }
      const linkedSupport = /^support_(\d+)$/.exec(startParam || "")?.[1];
      if (linkedSupport && role.admin) { state.supportTargetId = Number(linkedSupport); return showAdmin("support"); }
      if (["my_bookings", "orders"].includes(startParam)) return showOrders();
      if (profileState?.start_screen === "blocked") { state.view = "blocked"; render(); return; }
      if (startParam === "booking" && role.admin) { state.view = "admin"; enterClientMode(); return; }
      if ((profileState?.start_screen || (role.admin ? "management" : "booking")) === "management" && role.admin) {
        let mode = profileState?.last_section || "orders"; if (!profileState?.last_section) try { mode = localStorage.getItem(`polyrental-admin-tab:${role.id}`) || "orders"; } catch (_) {}
        if (!["orders", "catalog", "repairs", "support", ...(profileState?.system_admin ? ["hidden_tests"] : [])].includes(mode)) mode = "orders";
        return showAdmin(mode);
      }
      void maybeShowOnboarding();
    }).catch(() => showError("Не удалось определить права. Откройте приложение через Telegram ещё раз."))
      .finally(() => document.documentElement.classList.remove("role-pending"));
  }
  tg?.onEvent?.("activated", () => { if (state.view === "orders") showOrders(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "orders") showOrders(); });

  tg?.ready?.();
  render();
})();
