(async () => {
  "use strict";

  function setDialogHidden(dialog, hidden) {
    dialog.inert = hidden;
    dialog.hidden = hidden;
    window.PolyRentalDialogs?.refresh();
  }
  function removeNotice(notice) {
    if (window.PolyRentalMotion) void window.PolyRentalMotion.removeDialog(notice);
    else notice.remove();
  }

  // Animate the element's height so the surrounding document follows the reveal.
  const desktopMotion = window.matchMedia("(min-width: 769px)");
  const desktopWorkspace = window.matchMedia("(min-width: 1024px)");
  function enterWorkspace(element) {
    if (desktopWorkspace.matches) window.PolyRentalMotion?.enter(element);
  }
  const disclosureAnimations = new Map();
  const gridDisclosures = new WeakMap();
  const viewportFocus = window.PolyRentalViewportFocus;
  const siteNavigationAPI = window.PolyRentalSiteNavigation;
  let siteNavigation;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  reducedMotion?.addEventListener("change", () => {
    if (!reducedMotion.matches) return;
    for (const state of disclosureAnimations.values()) state.animation.finish();
    const panels = document.querySelectorAll("#orders-panel, #admin-panel, #admin-content, #release-dialog .dialog-card");
    for (const panel of panels) {
      for (const animation of panel.getAnimations()) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
    }
  });
  function scrollElementIntoView(element, options) {
    return viewportFocus?.reveal(element, options);
  }
  function afterDisclosureTransition(element) {
    element.getBoundingClientRect();
    return Promise.allSettled((element.getAnimations?.() || []).map(animation => animation.finished));
  }
  function settleGridDisclosure(drawer, expanded, animate = true) {
    const reveal = {};
    gridDisclosures.set(drawer, reveal);
    drawer.inert = !expanded;
    drawer.setAttribute("aria-hidden", String(!expanded));
    drawer.classList.toggle("is-settled", expanded && !animate);
    if (!expanded || !animate) return;
    return afterDisclosureTransition(drawer).then(() => {
      if (gridDisclosures.get(drawer) === reveal) drawer.classList.add("is-settled");
    });
  }
  function bindEquipmentDisclosure(row, drawer) {
    settleGridDisclosure(drawer, false, false);
    const toggle = event => {
      if (event.target.closest("button, a, .inspection-editor, input, textarea, select, label")) return;
      if (event.type === "keydown") {
        if (event.repeat || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
      }
      const expanded = row.classList.toggle("is-expanded");
      row.setAttribute("aria-expanded", String(expanded));
      const after = settleGridDisclosure(drawer, expanded);
      if (expanded) {
        focusDisclosure(row);
        scrollElementIntoView(row, {after, valid: () => !drawer.inert});
      }
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", toggle);
  }
  async function revealNavigation(load, target) {
    const since = viewportFocus?.checkpoint();
    await load();
    return scrollElementIntoView(target(), {since});
  }
  function disclosureIsOpen(details) {
    return disclosureAnimations.get(details)?.opening ?? details.open;
  }
  function focusDisclosure(control) {
    control?.focus({preventScroll: true});
  }
  function setDisclosureOpen(details, opening, focus = false) {
    const summary = [...details.children].find(child => child.tagName === "SUMMARY");
    if (opening && focus) focusDisclosure(summary);
    const previous = disclosureAnimations.get(details);
    const startHeight = details.getBoundingClientRect().height;
    previous?.observer?.disconnect();
    if (previous?.resizeFrame) cancelAnimationFrame(previous.resizeFrame);
    disclosureAnimations.delete(details);
    previous?.animation.cancel();
    // Management cards contain the page's main content. Keep them in normal
    // flow: a clipped, animated details becomes a nested scrolling surface in
    // mobile WebViews, and revealing it can override the user's scroll gesture.
    const workspaceCard = desktopMotion.matches && details.matches(".request-accordion, .customer-order-accordion");
    if (workspaceCard || details.matches(".request-accordion") || reducedMotion?.matches || typeof details.animate !== "function") {
      details.style.overflow = previous?.overflow ?? details.style.overflow;
      details.open = opening;
      if (opening && workspaceCard) window.PolyRentalMotion?.enter(details.querySelector(".request-body, .customer-order-body"));
      if (opening && focus) scrollElementIntoView(details, {block: workspaceCard ? "nearest" : undefined, valid: () => details.open});
      return;
    }
    const overflow = previous?.overflow ?? details.style.overflow;
    details.style.overflow = "clip";
    if (opening) details.open = true;
    if (!summary) { details.open = opening; details.style.overflow = overflow; disclosureAnimations.delete(details); return; }
    let endHeight;
    if (opening) {
      endHeight = details.getBoundingClientRect().height;
    } else {
      const style = getComputedStyle(details);
      endHeight = summary.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    }
    const animation = details.animate([{height: `${startHeight}px`}, {height: `${endHeight}px`}], {
      duration: desktopMotion.matches ? 170 : 220, easing: "cubic-bezier(.22, 1, .36, 1)"
    });
    const state = {animation, opening, overflow};
    disclosureAnimations.set(details, state);
    animation.onfinish = () => {
      if (disclosureAnimations.get(details) !== state) return;
      state.observer?.disconnect();
      cancelAnimationFrame(state.resizeFrame);
      if (!opening) details.open = false;
      details.style.overflow = overflow;
      disclosureAnimations.delete(details);
    };
    animation.oncancel = () => {
      if (disclosureAnimations.get(details) !== state) return;
      state.observer?.disconnect();
      cancelAnimationFrame(state.resizeFrame);
      details.style.overflow = overflow;
      disclosureAnimations.delete(details);
    };
    if (opening && typeof ResizeObserver === 'function') {
      const heights = new Map([...details.children].map(child=>[child,child.getBoundingClientRect().height]));
      state.observer = new ResizeObserver(entries=>{
        const changed = entries.some(({target})=>heights.get(target)!==target.getBoundingClientRect().height);
        if (changed && !state.resizeFrame) state.resizeFrame = requestAnimationFrame(() => {
          if (disclosureAnimations.get(details) === state) setDisclosureOpen(details, true);
        });
      });
      for (const child of details.children) state.observer.observe(child);
    }
    if (opening && focus) scrollElementIntoView(details, {valid: () => disclosureIsOpen(details)});
  }
  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0) return;
    const summary = event.target.closest?.("summary");
    const details = summary?.parentElement;
    if (!details || details.tagName !== "DETAILS" || details.firstElementChild !== summary) return;
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    event.preventDefault();
    const opening = !disclosureIsOpen(details);
    setDisclosureOpen(details, opening, opening);
  });

  function changeHeading(element, text) {
    if (window.PolyRentalMotion?.morphText) window.PolyRentalMotion.morphText(element, text); else element.textContent = text;
  }
  const tg = window.Telegram?.WebApp;
  if (tg?.onEvent) {
    const viewportState = () => JSON.stringify([tg.isFullscreen, tg.safeAreaInset, tg.contentSafeAreaInset]);
    let previous = viewportState();
    for (const event of ["safeAreaChanged", "contentSafeAreaChanged", "fullscreenChanged"]) {
      tg.onEvent(event, () => {
        const current = viewportState();
        if (current !== previous) window.PolyRentalMotion?.cancelTransient();
        previous = current;
      });
    }
  }
  const startup = window.PolyRentalStartup;
  startup?.start(tg);
  if (startup?.failed()) return;
  function calendarImpact() {
    try { tg?.HapticFeedback?.impactOccurred?.("light"); } catch (_) { /* Older clients may not support haptics. */ }
  }
  window.polyRentalApplyTheme?.();
  tg?.onEvent?.("themeChanged", () => window.polyRentalApplyTheme?.());
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  let siteProfile = null;
  if (!tg?.initData && location.pathname === "/site") {
    try { const response = await fetch("/api/site/session", {cache:"no-store"}); if (response.ok) siteProfile = await response.json(); else { siteNavigationAPI?.rememberLoginRoute(); location.replace("/site/login"); return; } }
    catch (_) { document.body.textContent = "Не удалось проверить вход. Обновите страницу."; return; }
  }
  const authorized = Boolean(tg?.initData || siteProfile);
  const keyboardMode = !authorized && !preview && Boolean(tg?.sendData) && Boolean(tg?.platform) && tg.platform !== "unknown";
  if (startup?.active() && !authorized && !keyboardMode) {
    startup.fail("Не удалось подтвердить вход. Откройте приложение из Telegram ещё раз.");
    return;
  }
  const draftKey = `polyrental-booking-draft-v2:${tg?.initDataUnsafe?.user?.id || siteProfile?.id || "local"}`;
  const contactKey = `polyrental-booking-contact-v1:${tg?.initDataUnsafe?.user?.id || siteProfile?.id || "local"}`;
  const $ = (id) => document.getElementById(id);
  let rentalPurposeEnabled = true;
  async function refreshBookingQuestion() {
    try {
      if (!preview) {
        const settings = await api('/api/miniapp/booking-settings');
        if (typeof settings.rental_purpose_enabled === 'boolean') rentalPurposeEnabled = settings.rental_purpose_enabled;
      }
    } catch (_) { /* An optional question must not block booking during a read failure. */ }
    $('rental-purpose-field').hidden = !rentalPurposeEnabled;
  }
  $('rental-purpose').addEventListener('input', persistCurrentCart);
  function showLoading(host, message = "Загружаем…") {
    host.replaceChildren();
    const catalog = host.matches('#items-grid, .admin-catalog-items');
    if (message) {
      const status = document.createElement("p");
      status.className = catalog ? "sr-only" : "loading-status";
      status.setAttribute("role", "status");
      status.textContent = message;
      host.append(status);
    }
    if (!catalog) return;
    const admin = host.matches('.admin-catalog-items');
    const lines = '<div class="catalog-skeleton-lines"><i class="skeleton-block"></i><i class="skeleton-block"></i><i class="skeleton-block"></i></div>';
    const action = '<i class="catalog-skeleton-action skeleton-block"></i>';
    for (let index = 0; index < 4; index++) {
      const card = document.createElement("article");
      card.className = `loading-skeleton catalog-skeleton-card ${admin ? "admin-card article-card" : "item-card"}`;
      card.setAttribute("aria-hidden", "true");
      card.innerHTML = admin
        ? `<div class="article-card-head"><div class="article-media skeleton-block"></div><div class="article-main">${lines}</div><div class="article-head-actions">${action}</div></div>`
        : `<div class="item-media skeleton-block"></div><div class="item-main">${lines}${action}</div>`;
      host.append(card);
    }
  }
  const sections = ["step-items", "step-contact", "step-dates", "step-review"];
  const state = { step: 0, view: "flow", items: [], quantities: new Map(), requestId: null, busy: false, booking: null, role: null, identityBookingId: null, identityNeedsChanges: false, identityRequiredPhotos: [], identityReusableDocuments: [], identityLegacyInstitution: null, universities: [], consent: null, adminMode: "orders", profile: null, onboardingLoading: false, onboardingPending: false, profileFilter: "all", profileSort: "date", profilePage: 0, profileNumber: "", adminRequestFilter: "all", adminStatus: "all", adminSort: "date", adminPage: 0, adminTargetId: null, adminQueue: "all", supportPage: 0, supportFilterId: null, cartVersion: null };
  const clientCatalog = {page:0, pageSize:20, total:0, paged:null, pageItems:[], timer:null, category:"", categories:[]};
  const catalogView = { editingCategories: false, layout: "list", category: "", query: "", status: "all", page: 0, sequence: 0, timer: null, expanded: new Set() };
  let selectedRequestId = null;
  let selectedCustomerOrderId = null;
  let pendingDeletion = null;
  let deleteUndoSeconds = 5;
  let adminRenderSequence = 0;
  let profileLoadSequence = 0;
  let profileIdentitySequence = 0;
  let availabilitySequence = 0;
  let availabilityCheck = null;
  let nearestProposal = null;
  let nearestSearchSequence = 0;
  let leaseRefreshTimer = null;
  let adminOrdersSnapshot = null, customerOrdersSnapshot = null, workflowRefreshBusy = false;
  let renderedAdminOrdersPath = null, renderedAdminOrdersData = null;
  let addressSuggestTimer = null;
  let addressSuggestController = null;
  let addressSuggestSequence = 0;
  let rangeCalendar = null;
  let schedulePolicy = null;
  let availabilityFresh = false;
  let bookingSubmitting = false;
  const identityPhotoDrafts = new Map();
  let identitySession = null;
  let identityGeneration = 0;
  let profileIdentityData = null;
  const photoDraftLifetime = 24 * 60 * 60 * 1000;
  const exampleItems = [
    { id: 1, sku: "CAM-FX3", category: "camera", name: "Камера Sony FX3", description: "Компактная кинокамера для съёмок в движении", available_quantity: 3 },
    { id: 2, sku: "LENS-2470", category: "optics", name: "Объектив 24–70 мм", description: "Универсальный светосильный объектив", available_quantity: 4 },
    { id: 3, sku: "TRI-MANF", category: "support", name: "Штатив Manfrotto", description: "Устойчивая опора для камеры", available_quantity: 2 },
  ];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const categoryMeta = {
    camera: ["Камера", "camera"], optics: ["Оптика", "lens"], light: ["Свет", "light"],
    battery: ["Питание", "battery"], accessory: ["Аксессуар", "accessory"], generic: ["Оборудование", "equipment"],
  };
  const categoryIcons = {camera:"camera", optics:"optics", light:"light", battery:"battery", accessory:"accessory", sound:"sound", support:"support", cables:"cables", media:"media", computer:"computer", monitors:"monitors", furniture:"furniture", generic:"generic"};
  function categoryIcon(category) {
    const fallback = {camera:"camera", lens:"optics", light:"light", battery:"battery", accessory:"accessory", equipment:"generic"};
    return categoryIcons[category.code] || fallback[category.icon] || "generic";
  }
  function setCategories(categories) {
    clientCatalog.categories = categories;
    for (const key of Object.keys(categoryMeta)) delete categoryMeta[key];
    for (const category of categories) categoryMeta[category.code] = [category.name, category.icon || categoryMeta[category.code]?.[1] || "equipment"];
  }
  function categoryOptions(selected) {
    return Object.entries(categoryMeta).map(([code, meta]) => `<option value="${escapeHtml(code)}" ${code === selected ? "selected" : ""}>${escapeHtml(meta[0])}</option>`).join("");
  }
  async function createCategoryDialog(parentCode = "") {
    let created = null;
    const data = await workflowDialog("Создать категорию", `<label class="field"><span>Название категории</span><input name="name" maxlength="100" required></label><label class="field"><span>Родительская категория</span><select name="parent_code"><option value="">Нет</option>${categoryOptions(parentCode)}</select></label><label class="field"><span>Пиктограмма</span><select name="icon"><option value="equipment">Оборудование</option><option value="camera">Камера</option><option value="lens">Оптика</option><option value="light">Свет</option><option value="battery">Питание</option><option value="accessory">Аксессуары</option></select></label>`, "Создать", null,
      async values => { created = await api("/api/miniapp/admin/catalog/categories", {method:"POST", body:JSON.stringify({name:values.get("name"), parent_code:values.get("parent_code") || null, icon:values.get("icon")})}); });
    if (!data) return null;
    setCategories([...clientCatalog.categories, created]);
    return created;
  }
  function categoryVisual(category) {
    return category.image_data ? `<img class="category-card-photo" src="${escapeHtml(category.image_data)}" alt="" loading="lazy">` : `<svg class="icon" aria-hidden="true"><use href="#icon-category-${categoryIcon(category)}"></use></svg>`;
  }
  function bindCategoryPhoto(button, category) {
    const image = button.querySelector(".category-card-photo");
    if (!image) return;
    bindCatalogPhotoClick(image, category.name, button);
    button.setAttribute("aria-keyshortcuts", "Shift+Enter");
    button.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !event.shiftKey || event.repeat) return;
      event.preventDefault();
      openCatalogPhoto(image, category.name, button);
    });
  }
  async function editCategoryDialog(category) {
    const path = `/api/miniapp/admin/catalog/categories/${encodeURIComponent(category.code)}`;
    const photo = category.image_data ? catalogMedia(category, "request-item") : "";
    const data = await workflowDialog("Изменить категорию", `<label class="field"><span>Название категории</span><input name="name" maxlength="100" value="${escapeHtml(category.name)}" required></label>${photo}<label class="field"><span>Новое фото категории</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>${category.image_data ? '<label class="check-row"><input name="remove_photo" type="checkbox"><span>Удалить текущее фото</span></label>' : ''}<p class="supporting">JPEG, PNG или WebP, не более 8 МБ.</p>`, "Сохранить", null, async values => {
      const file = values.get("photo");
      if (file instanceof File && file.size && values.get("remove_photo")) throw new Error("Выберите новое фото или удалите текущее.");
      if (file instanceof File && file.size > 8 * 1024 * 1024) throw new Error("Фото больше 8 МБ. Выберите файл меньшего размера.");
      const upload = new FormData(); upload.set("name", values.get("name"));
      if (file instanceof File && file.size) upload.set("photo", file);
      if (values.get("remove_photo")) upload.set("remove_photo", "true");
      try {
        await api(`${path}/edit`, {method:"POST", body:upload});
      } catch (error) {
        if (error.status === 413) throw new Error("Фото не прошло проверку размера. Выберите файл до 8 МБ и повторите загрузку.");
        throw error;
      }
    });
    if (data) await showAdmin("catalog");
  }
  function categoryLabel(category) { return categoryMeta[category]?.[0] || categoryMeta.generic?.[0] || "Оборудование"; }
  function catalogType(item) {
    return item.category && item.category !== "generic" ? categoryLabel(item.category) : (item.description || categoryLabel(item.category));
  }
  function catalogTitle(item) {
    return item.name || item.title || catalogType(item);
  }
  const assetCountForms = {one:"экземпляр", few:"экземпляра", many:"экземпляров", other:"экземпляров"};
  const assetCountRules = new Intl.PluralRules("ru");
  function assetCountLabel(count) {
    return `${count} ${assetCountForms[assetCountRules.select(count)]}`;
  }
  function catalogMedia(item, className) {
    const meta = categoryMeta[item.category] || categoryMeta.generic || ["Оборудование", "equipment"];
    const src = /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(item.image_data || "") ? item.image_data : /^https:\/\//i.test(item.image_url || "") ? item.image_url : "";
    const placeholder = !src && (className === "article" || className === "article-editor") ? "Нет фото" : meta[0];
    return `<div class="catalog-media ${className}-media" data-photo-state="${src ? "loading" : "empty"}" aria-busy="${Boolean(src)}"><div class="${className}-placeholder catalog-photo-placeholder" aria-label="${escapeHtml(placeholder)}"><svg class="placeholder-icon icon" aria-hidden="true"><use href="#icon-${meta[1]}"></use></svg><svg class="frame-placeholder-icon icon" aria-hidden="true"><use href="#icon-category-${categoryIcon({code:item.category, icon:meta[1]})}"></use></svg><small>${escapeHtml(placeholder)}</small></div>${src ? `<img class="${className}-photo catalog-loading" src="${escapeHtml(src)}" alt="Фото: ${escapeHtml(item.name)}" loading="lazy"><span class="catalog-photo-progress" role="status" aria-label="Загрузка фото"><span class="loading-spinner photo-spinner" aria-hidden="true"></span></span><button class="catalog-photo-retry" type="button" aria-label="Повторить загрузку фото: ${escapeHtml(item.name)}"><span aria-hidden="true">↻</span><small>Повторить</small></button>` : ""}</div>`;
  }
  async function prepareCatalogPhoto(file) {
    if (!(file instanceof File) || !file.size) throw new Error("Выберите изображение.");
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch (_) { throw new Error("Не удалось открыть изображение. Выберите JPEG, PNG или WebP."); }
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .88));
      if (!blob) throw new Error("Не удалось подготовить изображение.");
      const upload = new FormData();
      upload.set("photo", blob, `photo.${({"image/webp":"webp","image/png":"png","image/jpeg":"jpg"})[blob.type] || "png"}`);
      return upload;
    } finally { bitmap.close(); }
  }
  function photoState(image, state) {
    const media = image.closest(".catalog-media"); if (!media) return;
    media.dataset.photoState = state; media.setAttribute("aria-busy", String(state === "loading"));
    image.hidden = state === "error"; image.classList.toggle("catalog-loading", state === "loading");
    image.tabIndex = state === "loaded" ? 0 : -1;
  }
  function bindCatalogPhoto(image, name) {
    if (image.classList.contains("catalog-photo-target")) return;
    bindCatalogPhotoClick(image, name, image);
    image.setAttribute("role", "button");
    image.setAttribute("aria-haspopup", "dialog");
    image.setAttribute("aria-label", `Открыть фото: ${name}`);
    image.tabIndex = 0;
    image.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key) || event.repeat) return;
      event.preventDefault(); event.stopPropagation();
      openCatalogPhoto(image, name);
    });
  }
  function bindCatalogPhotoClick(image, name, opener) {
    image.classList.add("catalog-photo-target");
    image.draggable = false;
    let press = null, dragged = false;
    image.addEventListener("pointerdown", event => {
      press = [event.clientX, event.clientY]; dragged = false;
    });
    image.addEventListener("pointermove", event => {
      if (press && Math.hypot(event.clientX - press[0], event.clientY - press[1]) > 10) dragged = true;
    });
    image.addEventListener("pointerleave", () => { if (press) dragged = true; });
    image.addEventListener("pointerup", () => { press = null; });
    image.addEventListener("pointercancel", () => { press = null; dragged = true; });
    image.addEventListener("click", event => {
      if (!image.complete || !image.naturalWidth) return;
      if (opener.matches("a")) event.preventDefault();
      event.stopPropagation();
      if (!event.detail || !dragged) openCatalogPhoto(image, name, opener);
    });
  }
  function inspectPhoto(image) {
    bindCatalogPhoto(image, image.alt.replace(/^Фото:\s*/, "") || "Оборудование");
    if (image.complete) photoState(image, image.naturalWidth ? "loaded" : "error");
    else photoState(image, "loading");
  }
  const photoImages = node => node.nodeType === 1 ? [...(node.matches(".catalog-media > img") ? [node] : []), ...node.querySelectorAll(".catalog-media > img")] : [];
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) for (const image of photoImages(node)) inspectPhoto(image);
    }
  }).observe(document.body, {childList:true, subtree:true});
  document.addEventListener("load", event => { if (event.target.matches?.(".catalog-media > img")) photoState(event.target, "loaded"); }, true);
  document.addEventListener("error", event => { if (event.target.matches?.(".catalog-media > img")) photoState(event.target, "error"); }, true);
  document.addEventListener("click", event => {
    const button = event.target.closest?.(".catalog-photo-retry"); if (!button) return;
    const image = button.closest(".catalog-media").querySelector("img");
    photoState(image, "loading"); const src = image.getAttribute("src"); image.removeAttribute("src"); image.src = src;
  });
  function canDownloadCatalogPhoto() {
    return ["operator", "manager", "admin"].includes(state.role?.staff_role) && !state.role?.pii_only;
  }
  async function downloadCatalogPhoto(source, name) {
    if (!canDownloadCatalogPhoto()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let content;
    try {
      const response = await fetch(source, {referrerPolicy:"no-referrer", signal:controller.signal});
      if (response.ok) content = await response.blob();
    } finally { clearTimeout(timeout); }
    if (!content || !content.type.startsWith("image/") || !content.size) throw new Error("Не удалось получить фото");
    const extensions = {"image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif", "image/avif":"avif", "image/svg+xml":"svg", "image/bmp":"bmp"};
    const title = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 90).trim() || "Фото оборудования";
    downloadBlob(content, `${title}.${extensions[content.type] || "img"}`);
  }
  function openCatalogPhoto(image, name, opener = image) {
    if (!image.isConnected || !image.complete || !image.naturalWidth || image.closest("[inert]")) return;
    const source = image.currentSrc || image.src;
    if (!/^(https:\/\/|blob:|data:image\/(?:webp|png|jpeg);base64,)/i.test(source)) return;
    const actions = canDownloadCatalogPhoto() ? '<p class="catalog-photo-download-status" role="status" hidden></p>' : "";
    void workflowDialog(name, `<img class="catalog-photo-full" src="${escapeHtml(source)}" alt="${escapeHtml(name)}">${actions}`, "Закрыть", dialog => {
      dialog.classList.add("catalog-photo-dialog-view");
      dialog.querySelector(".workflow-cancel").hidden = true;
      const close = dialog.querySelector('[type="submit"]');
      close.dataset.initialFocus = "";
      const status = dialog.querySelector(".catalog-photo-download-status");
      if (!status) return;
      const download = plainButton("Скачать фото", async () => {
        download.disabled = true;
        status.hidden = false;
        status.textContent = "Скачиваем фото…";
        try { await downloadCatalogPhoto(source, name); status.hidden = true; }
        catch (_) {
          status.hidden = false;
          status.textContent = "Не удалось скачать фото.";
          if (source.startsWith("https://")) {
            const original = document.createElement("a");
            original.href = source; original.target = "_blank"; original.rel = "noopener noreferrer";
            original.textContent = "Открыть оригинал";
            status.append(" ", original);
          }
        } finally { download.disabled = false; }
      }, "secondary");
      close.before(download);
    }, null, {opener});
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
  const dateFormatSetting = $("profile-date-format");
  const dateFormatKey = "polyrental-date-format";
  try { dateFormatSetting.value = localStorage.getItem(dateFormatKey) === "mdy" ? "mdy" : "dmy"; } catch (_) {}
  const formDateNames = new Set(["birth_date", "passport_issued_at"]);
  function formDatePlaceholder() { return dateFormatSetting.value === "mdy" ? "ММ/ДД/ГГГГ" : "ДД.ММ.ГГГГ"; }
  function displayFormDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return value || "";
    const [, year, month, day] = match;
    return dateFormatSetting.value === "mdy" ? `${month}/${day}/${year}` : `${day}.${month}.${year}`;
  }
  function parseFormDate(value) {
    const raw = String(value || "").trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.test(raw);
    const pattern = dateFormatSetting.value === "mdy" ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/ : /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
    const digits = /^\d{8}$/.test(raw) ? [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4)] : null;
    const parts = pattern.exec(raw)?.slice(1) || digits;
    if (!iso && !parts) return "";
    const [first, second, year] = parts || [];
    const [month, day] = dateFormatSetting.value === "mdy" ? [first, second] : [second, first];
    const result = iso ? raw : `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const date = new Date(`${result}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : "";
  }
  dateFormatSetting.addEventListener("change", () => {
    try { localStorage.setItem(dateFormatKey, dateFormatSetting.value); } catch (_) {}
    document.querySelectorAll("[data-form-date]").forEach(input => { input.placeholder = formDatePlaceholder(); });
    document.querySelectorAll("#profile-identity-fields [data-iso-date]").forEach(value => {
      value.textContent = displayFormDate(value.dataset.isoDate);
    });
  });
  document.querySelectorAll("[data-form-date]").forEach(input => { input.placeholder = formDatePlaceholder(); });
  document.addEventListener("focusout", event => {
    if (!event.target.matches?.("[data-form-date]")) return;
    const parsed = parseFormDate(event.target.value);
    if (parsed) event.target.value = displayFormDate(parsed);
  });
  function bookingTimeValue(id) {
    const value = $(`${id}-time`).value.trim();
    let match = value.match(/^(\d{1,2})(?:[:.,]|\s+)(\d{2})$/);
    if (!match && /^\d{3,4}$/.test(value)) match = [value, value.slice(0, -2), value.slice(-2)];
    if (!match && /^\d{1,2}$/.test(value)) match = [value, value, "00"];
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  }
  function installKeyboardBookingTimes() {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    for (const id of ["start", "end"]) {
      const input = $(`${id}-time`);
      input.type = "text"; input.classList.add("keyboard-time"); input.placeholder = "ЧЧ:ММ";
      input.maxLength = 8; input.autocomplete = "off"; input.spellcheck = false;
      input.setAttribute("aria-describedby", `${id}-time-hint ${id}-error`);
      const hint = document.createElement("small"); hint.id = `${id}-time-hint`; hint.className = "booking-time-hint";
      hint.textContent = "Например, 09:30 или 0930 (МСК)"; input.after(hint);
      const commit = () => {
        const value = bookingTimeValue(id);
        if (value) input.value = value;
        const invalid = Boolean(input.value.trim()) && !value;
        if (input.value.trim()) {
          input.setAttribute("aria-invalid", String(invalid));
          $(`${id}-error`).textContent = invalid ? "Введите время от 00:00 до 23:59, например 09:30." : "";
          $(`${id}-error`).hidden = !invalid;
        }
        return !invalid;
      };
      input.addEventListener("focus", () => input.select());
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (commit()) (id === "start" ? $("end-time") : $("main-button")).focus();
      });
    }
  }
  function syncDateTime(id) {
    const date = $(`${id}-date`).value, time = bookingTimeValue(id);
    $(id).value = date && time ? `${date}T${time}` : "";
  }
  function syncDateFields(id) {
    const match = String($(id).value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    $(`${id}-date`).value = match?.[1] || "";
    $(`${id}-time`).value = match?.[2] || "";
  }
  function moscowDateIso(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const addIsoDays = window.PolyRentalCalendar.addDays;
  function minimumBookingDate() { return moscowDateIso(); }
  function normalizePastBookingStart() {
    const date = $("start-date").value;
    const time = bookingTimeValue("start");
    const current = moscowInput(new Date());
    if (!date || !time || `${date}T${time}` >= current) return false;
    $("start-date").value = current.slice(0, 10);
    $("start-time").value = current.slice(11);
    syncDateTime("start");
    if (date !== $("start-date").value) rangeCalendar?.setRange($("start-date").value, $("end-date").value);
    return true;
  }
  function bookingDateLabel(value) {
    return new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC", day: "numeric", month: "long"}).format(new Date(`${value}T12:00:00Z`));
  }
  function dateValidationMessage() {
    if ($("start-date").value && $("end-date").value && (!$("start-time").value || !$("end-time").value)) return "Выберите время получения и возврата.";
    if (["start", "end"].some(id => $(`${id}-time`).value && !bookingTimeValue(id))) return "Введите время в формате ЧЧ:ММ, например 09:30.";
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
      $(`${id}-time-label`).textContent = `${id === "start" ? "Получение" : "Возврат"}: ${$(`${id}-date`).value ? datePickerText($(`${id}-date`).value) : "выберите дату"}`;
      $(`${id}-time`).disabled = !$("end-date").value;
    }
    const start = $("start").value, end = $("end").value;
    $("period-summary").textContent = start && end ? `${datePickerText($("start-date").value)}, ${bookingTimeValue("start")} — ${datePickerText($("end-date").value)}, ${bookingTimeValue("end")} (МСК)` : $("start-date").value ? `${datePickerText($("start-date").value)} — выберите конец` : "Выберите начало и конец";
    $("period-error").textContent = dateValidationMessage();
  }
  function periodChanged() {
    syncDateTime("start"); syncDateTime("end"); applyBookingDateLimits();
    state.requestId = null; availabilityFresh = false;
    $("availability-result").hidden = true; $("availability-edit-cart").hidden = true; $("nearest-period").hidden = true;
    fieldError("start", ""); fieldError("end", ""); saveDraft(); render(); queueCalendarAvailability();
  }
  function ensureBookingPeriod() {
    if ($("start-date").value && $("start-date").value < minimumBookingDate() && $("end-date").value <= minimumBookingDate()) {
      $("start").value = ""; $("end").value = ""; syncDateFields("start"); syncDateFields("end"); return false;
    }
    normalizePastBookingStart();
    return Boolean($("start-date").value && $("end-date").value);
  }
  function dateText(value) { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  function shortRequestDateTime(value) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.day}.${parts.month}.${parts.year}\u00a0\u00a0${parts.hour}:${parts.minute}`;
  }
  function reviewDateTime(value) { return `${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))} МСК`; }

  function clearError() { $("global-error").hidden = true; $("global-error").textContent = ""; }
  function showError(message) {
    const notice = $("global-error");
    const changed = notice.hidden || notice.textContent !== message;
    notice.textContent = message; notice.hidden = false;
    if (changed) enterWorkspace(notice);
    scrollElementIntoView(notice, {block:"nearest"});
  }
  function showIdentityFieldError(name, message) {
    const input = document.querySelector(`#identity-form [name="${name}"]`);
    const field = input?.closest(".field");
    if (!input || !field) { showError(message); return; }
    let error = field.querySelector(".identity-field-error");
    if (!error) { error = document.createElement("small"); error.className = "field-error identity-field-error"; error.setAttribute("role", "alert"); field.append(error); }
    error.textContent = message; input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id || (error.id = `identity-error-${name}`));
    scrollElementIntoView(field, {block: "center"}); input.focus({ preventScroll: true });
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
  let cartDirty = false, cartTimer = null, cartSaving = null, cartConfirmed = null, cartPending = null, cartLocked = false;
  const pendingCartKey = `${draftKey}:unsynced`;
  function cartPayload() {
    return { start: $("start").value, end: $("end").value,
      lines: [...state.quantities].map(([article_id, quantity]) => ({ article_id, quantity })), version: state.cartVersion };
  }
  function normalizedCart(value) {
    if (!value || typeof value.start !== "string" || typeof value.end !== "string" || !Array.isArray(value.lines) || value.lines.length > 30) return null;
    const datePattern = /^(?:|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/;
    if (!datePattern.test(value.start) || !datePattern.test(value.end)) return null;
    const seen = new Set(), lines = [];
    for (const line of value.lines) {
      if (!Number.isInteger(line.article_id) || line.article_id <= 0 || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 30 || seen.has(line.article_id)) return null;
      seen.add(line.article_id); lines.push({article_id:line.article_id, quantity:line.quantity});
    }
    lines.sort((a,b) => a.article_id-b.article_id);
    return {start:value.start, end:value.end, lines, ...(Number.isInteger(value.version) && value.version >= 0 ? {version:value.version} : {})};
  }
  function sameCart(left, right) {
    const a = normalizedCart(left), b = normalizedCart(right);
    return Boolean(a && b && a.start === b.start && a.end === b.end && JSON.stringify(a.lines) === JSON.stringify(b.lines));
  }
  function rememberPendingCart(value) {
    cartPending = normalizedCart(value);
    try { if (cartPending) localStorage.setItem(pendingCartKey, JSON.stringify(cartPending)); else localStorage.removeItem(pendingCartKey); } catch (_) { /* resolution remains available in this session */ }
  }
  function readPendingCart() { try { return normalizedCart(JSON.parse(localStorage.getItem(pendingCartKey) || "null")); } catch (_) { return null; } }
  function persistCurrentCart() {
    try { localStorage.setItem(draftKey, JSON.stringify({ start:$("start").value, end:$("end").value, quantities:[...state.quantities], rental_purpose:$('rental-purpose').value })); } catch (_) { /* storage can be disabled */ }
  }
  function applyCartSnapshot(cart) {
    $("start").value = cart.start; $("end").value = cart.end;
    state.quantities = new Map(cart.lines.map(line => [line.article_id, line.quantity])); state.requestId = null;
    syncDateFields("start"); syncDateFields("end"); rangeCalendar?.setRange($("start-date").value, $("end-date").value); applyBookingDateLimits();
    if (state.view === "flow" && state.step === 3) state.step = 1;
    availabilityFresh = false;
    if (state.view === "flow" && state.step === 0) renderItems();
    if (state.view === "flow" && state.step === 1) renderCart();
    persistCurrentCart(); render();
  }
  function showCartSyncProblem(message) {
    cartLocked = true; $("cart-sync-message").textContent = message;
    const count = cart => cart?.lines.reduce((total, line) => total + line.quantity, 0) || 0;
    const period = cart => cart ? `${cart.start || "—"} — ${cart.end || "—"}` : "неизвестно";
    $("cart-sync-summary").textContent = `На сервере: ${count(cartConfirmed)} шт.; в ваших несохранённых изменениях: ${count(cartPending)} шт. Сроки на сервере: ${period(cartConfirmed)}; ваши сроки: ${period(cartPending)}. При сохранении ваши изменения заменят серверную подборку.`;
    render();
  }
  async function reconcileCartFailure(error, sent) {
    // Freeze editing before checking the server so later interactions cannot be lost.
    cartLocked = true; const desired = normalizedCart(cartPayload());
    $("cart-sync-message").textContent = "Проверяем состояние подборки на сервере…"; $("cart-sync-summary").textContent = ""; render();
    let current = null;
    try { const value = await api("/api/miniapp/cart"); current = normalizedCart(value); if (!current || !Number.isInteger(current.version)) current = null; } catch (_) {}
    if (current && sameCart(current, sent)) {
      cartConfirmed = current; state.cartVersion = current.version; cartLocked = false;
      cartDirty = !sameCart(cartPayload(), current); if (!cartDirty) rememberPendingCart(null); render(); return true;
    }
    rememberPendingCart(desired); cartDirty = false;
    if (current) { cartConfirmed = current; state.cartVersion = current.version; }
    if (cartConfirmed) applyCartSnapshot(cartConfirmed);
    showCartSyncProblem(error.status === 409 ? "Подборка изменилась на другом устройстве. Показана серверная версия." : current ? "Не удалось сохранить изменение. Показана серверная версия." : "Не удалось проверить сервер. Показана последняя подтверждённая версия; подключитесь к сети для выбора действия.");
    return false;
  }
  async function flushCart() {
    if (cartTimer) { clearTimeout(cartTimer); cartTimer = null; }
    if (cartSaving) return cartSaving;
    if (cartLocked) throw new Error("Сначала выберите, какую подборку сохранить.");
    if (!cartDirty || !Number.isInteger(state.cartVersion)) return;
    cartSaving = (async () => {
      while (cartDirty && !cartLocked) {
        const sent = cartPayload(); cartDirty = false;
        try {
          const result = normalizedCart(await api("/api/miniapp/cart", { method:"PUT", body:JSON.stringify(sent) }));
          if (!result || !Number.isInteger(result.version)) throw new Error("Сервер вернул неверную версию подборки.");
          cartConfirmed = result; state.cartVersion = result.version;
          if (!cartDirty) rememberPendingCart(null);
        } catch (error) { if (!await reconcileCartFailure(error, sent)) throw error; }
      }
    })();
    try { await cartSaving; } finally { cartSaving = null; }
  }
  function saveDraft() {
    persistCurrentCart();
    if (authorized && Number.isInteger(state.cartVersion) && !cartLocked) {
      rememberPendingCart(cartPayload());
      cartDirty = true; clearTimeout(cartTimer);
      cartTimer = setTimeout(() => { void flushCart().catch((error) => { if (!cartLocked) { $("mode-banner").hidden = false; $("mode-banner").textContent = `Не удалось синхронизировать подборку: ${error.message}`; } }); }, 300);
    }
  }
  async function resolveCartSync(useLocal) {
    const serverButton = $("cart-sync-server"), localButton = $("cart-sync-local"); serverButton.disabled = localButton.disabled = true;
    try {
      const remote = normalizedCart(await api("/api/miniapp/cart"));
      if (!remote || !Number.isInteger(remote.version)) throw new Error("Сервер вернул неверную подборку.");
      cartConfirmed = remote; state.cartVersion = remote.version;
      if (useLocal && cartPending && !sameCart(cartPending, remote)) {
        const desired = cartPending; cartLocked = false; applyCartSnapshot(desired); cartDirty = true;
        await flushCart();
      } else { cartDirty = false; cartLocked = false; applyCartSnapshot(remote); rememberPendingCart(null); }
      if (!cartLocked && state.view === "flow" && state.step === 0) await loadItems();
    } catch (error) { if (!cartLocked) showCartSyncProblem(`Не удалось проверить подборку: ${error.message}`); else $("cart-sync-message").textContent = `Не удалось проверить подборку: ${error.message}`; }
    finally { serverButton.disabled = localButton.disabled = false; }
  }
  $("cart-sync-server").addEventListener("click", () => { void resolveCartSync(false); });
  $("cart-sync-local").addEventListener("click", () => { void resolveCartSync(true); });
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || "{}");
      if (typeof draft.start === "string") $("start").value = draft.start;
      if (typeof draft.end === "string") $("end").value = draft.end;
      if (typeof draft.rental_purpose === 'string') $('rental-purpose').value = draft.rental_purpose.slice(0, 2000);
      if (Array.isArray(draft.quantities)) state.quantities = new Map(draft.quantities.filter((row) => Array.isArray(row) && Number.isInteger(row[0]) && row[0] > 0 && Number.isInteger(row[1]) && row[1] > 0 && row[1] <= 30));
      return Boolean(draft.start || draft.end || draft.quantities?.length);
    } catch (_) { /* start with an empty form */ }
    return false;
  }
  function clearDraft() { $('rental-purpose').value = ''; try { localStorage.removeItem(draftKey); } catch (_) { /* no persistent draft */ } }
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
  async function restoreIdentityPhotos(session, savedDocuments = []) {
    const inputs = [...document.querySelectorAll('#identity-form input[type="file"]')];
    for (const input of inputs) {
      if (!identitySessionCurrent(session)) return;
      const key = identityPhotoKey(input.name, session.bookingId); let entry = identityPhotoDrafts.get(key);
      if (!entry) {
        try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; }
      }
      if (!identitySessionCurrent(session)) return;
      if (entry && Date.now() - entry.savedAt <= photoDraftLifetime) identityPhotoDrafts.set(key, entry);
      else { identityPhotoDrafts.delete(key); entry = null; try { await photoDraftTransaction("readwrite", (store) => store.delete(key)); } catch (_) {} }
      if (!identitySessionCurrent(session)) return;
      const status = input.closest(".field")?.querySelector(".file-draft-status");
      if (status) status.textContent = entry ? `Загружено: ${entry.name}`
        : savedDocuments.includes(input.name) ? "Документ сохранён в заявке"
        : "";
    }
  }
  async function restoreReusableIdentityPhotos(session, documents) {
    const bookingId = session.bookingId;
    await Promise.all(documents.map(async (kind) => {
      const photoVersion = session.photoVersions.get(kind) || 0;
      const current = () => identitySessionCurrent(session) && (session.photoVersions.get(kind) || 0) === photoVersion;
      if (!current()) return;
      const key = identityPhotoKey(kind, bookingId);
      let entry = identityPhotoDrafts.get(key);
      if (!entry) {
        try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; }
      }
      if (!current()) return;
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
        if (!current()) return;
        if (!response.ok) throw new Error("download failed");
        const blob = await response.blob();
        if (!current()) return;
        await saveIdentityPhoto(kind, new File([blob], `previous-${kind}.jpg`, { type: blob.type || "image/jpeg" }), bookingId);
        if (!current()) return;
        if (status) status.textContent = "Фото из предыдущей анкеты прикреплено. Новое фото заменит его.";
      } catch (_) {
        if (!current()) return;
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

  const readCache = new Map();
  const cachedReads = [
    [/^\/api\/miniapp\/(?:catalog(?:\/categories)?|admin\/catalog(?:\/options)?)$/, "catalog", 30000],
    [/^\/api\/miniapp\/(?:booking-settings|schedule|admin\/(?:booking-settings|handover-settings|notification-preferences|assignees))$/, "settings", 60000],
    [/^\/api\/miniapp\/(?:profile\/history|admin\/(?:bookings|repairs)|customer\/next-actions)$/, "orders", 5000],
    [/^\/api\/miniapp\/(?:support\/(?:faq|threads)|admin\/support)$/, "support", 15000],
    [/^\/api\/miniapp\/release$/, "release", 60000],
  ];

  function invalidateReads(path) {
    const name = path.split("?")[0].slice("/api/miniapp/".length);
    if (/^(?:notifications\/|operator\/(?:last-section|client-mode)$|onboarding\/)/.test(name)) return;
    let groups;
    if (/^(?:admin\/)?catalog(?:\/|$)/.test(name)) groups = ["catalog", "orders"];
    else if (/^(?:admin\/)?(?:bookings|repairs)(?:\/|$)/.test(name)) groups = ["orders", "catalog"];
    else if (/^(?:admin\/)?support(?:\/|$)/.test(name)) groups = ["support", "orders"];
    else if (/^admin\/(?:handover-settings|booking-settings|notification-preferences)$/.test(name)) groups = ["settings"];
    else if (name === "release/seen") groups = ["release"];
    else if (name === "cart") return;
    else groups = ["catalog", "settings", "orders", "support"];
    for (const [key, entry] of readCache) {
      if (groups.includes(entry.group)) readCache.delete(key);
    }
  }

  function api(path, {fresh = false, ...options} = {}) {
    if ((options.method || "GET").toUpperCase() !== "GET") {
      return requestApi(path, options).then(result => {
        invalidateReads(path);
        return result;
      });
    }
    const rule = !options.signal && cachedReads.find(([pattern]) => pattern.test(path.split("?")[0]));
    if (!rule) return requestApi(path, options);
    const [, group, ttl] = rule;
    const cached = readCache.get(path);
    if (cached && (!cached.expires || (!fresh && cached.expires > Date.now()))) {
      return cached.value.then(JSON.parse);
    }
    const entry = {group, expires:0};
    entry.value = requestApi(path, options).then(result => {
      entry.expires = Date.now() + ttl;
      return JSON.stringify(result);
    }, error => {
      if (readCache.get(path) === entry) readCache.delete(path);
      throw error;
    });
    readCache.delete(path);
    readCache.set(path, entry);
    if (readCache.size > 60) readCache.delete(readCache.keys().next().value);
    return entry.value.then(JSON.parse);
  }

  async function requestApi(path, options) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.body instanceof FormData?120000:20000);
    let response;
    try { response = await fetch(path, {
      ...options,
      signal:options.signal || controller.signal,
      headers: { "X-Telegram-Init-Data": tg?.initData || "", ...((options.body && !(options.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store",
    }); } catch(error) { if(error.name==="AbortError")throw new Error("Сервер не ответил вовремя. Повторите попытку."); if(error instanceof TypeError)throw new Error("Не удалось связаться с сервером. Проверьте интернет и повторите попытку."); throw error; } finally {clearTimeout(timer);}
    let body;
    try { body = await response.json(); } catch (_) {
      const error = new Error(response.status === 413 ? "Размер файла превышает допустимый лимит." :
        "Сервер вернул неожиданный ответ. Попробуйте ещё раз.");
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const detail = typeof body.detail === "string" ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((item) => item.msg || item.message || "").filter(Boolean).join("; ")
        : "";
      const structured = body.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail : null;
      const error = new Error(structured?.message || detail || "Не удалось выполнить запрос. Попробуйте ещё раз.");
      error.status = response.status;
      const formFields = new Set(["full_name", "phone", "birth_date", "passport_combined", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution", "passport_main", "passport_registration", "student_front"]);
      const invalidField = Array.isArray(body.detail) ? body.detail.map((item) => item.loc?.at(-1)).find((field) => formFields.has(field)) : null;
      if (typeof structured?.field === "string") error.field = structured.field;
      else if (invalidField) error.field = invalidField;
      throw error;
    }
    return body;
  }

  // Coalesce rapid repeat activations of the same control without slowing counters.
  let lastActivation = null, lastTouch = null;
  document.addEventListener("touchend", event => {
    const touch = event.changedTouches[0];
    if (touch) lastTouch = {time:event.timeStamp, x:touch.clientX, y:touch.clientY};
  }, {capture:true, passive:true});
  document.addEventListener("click", event => {
    if (!event.isTrusted || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const control = event.target.closest?.("button, a[href], [role=button]");
    if (!control || control.closest(".quantity-control, .request-catalog-controls, .calendar-nav")) {
      lastActivation = null;
      return;
    }
    const key = control.id || control;
    const touchClick = event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents ||
      (event.detail > 0 && lastTouch && event.timeStamp - lastTouch.time < 400 &&
        Math.hypot(event.clientX - lastTouch.x, event.clientY - lastTouch.y) < 8);
    const repeatedPointer = event.detail > 1 || touchClick;
    const sameSpot = event.detail > 0 && lastActivation?.pointer &&
      Math.hypot(event.clientX - lastActivation.x, event.clientY - lastActivation.y) < 8;
    if (repeatedPointer && lastActivation && (lastActivation.key === key || sameSpot) && event.timeStamp - lastActivation.time < 325) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    lastActivation = {key, time:event.timeStamp, pointer:event.detail > 0, x:event.clientX, y:event.clientY};
  }, true);

  function updateMainAction(total) {
    const labels = [`В корзину (${total})`, "Выбрать даты", "Проверить заявку", "Отправить заявку"];
    $("main-button").textContent = state.busy ? (bookingSubmitting ? "Отправляем заявку…" : "Проверяем доступность…") : labels[state.step] || "Продолжить";
    $("main-button").setAttribute("aria-busy", String(state.busy));
    $("main-button").disabled = state.busy || cartLocked || (state.step === 3 && (exceedsStock() || !availabilityFresh || unavailableSelection().length > 0)) || (state.step === 2 &&
      (!$("start-date").value || !$("end-date").value || ($("start-time").value && $("end-time").value && Boolean(dateValidationMessage())))) || (!authorized && !keyboardMode && !preview);
    const canClear = state.view === "flow" && state.step === 0 && total > 0;
    $("clear-cart").hidden = !canClear;
    $("clear-cart").disabled = state.busy || cartLocked || !total;
    $("action-bar").classList.toggle("with-clear-cart", canClear);
  }

  function updateCartCounters() {
    const total = [...state.quantities.values()].reduce((sum, value) => sum + value, 0);
    const selectedCount = $("selected-count");
    if (selectedCount) selectedCount.textContent = String(total);
    const floatingCount = $("floating-cart-count");
    if (floatingCount) {
      floatingCount.textContent = String(total);
      floatingCount.classList.toggle("has-items", total > 0);
    }
    const floatingBtn = $("floating-cart-button");
    if (floatingBtn) {
      floatingBtn.hidden = !(state.view === "flow" && state.step >= 0 && state.step < 4);
      floatingBtn.classList.toggle("has-items", total > 0);
      floatingBtn.setAttribute("aria-label", `Открыть корзину: выбрано ${total}`);
    }
    updateMainAction(total);
  }

  function openCartView() {
    if (bookingSubmitting) return;
    if (!guardStaffNavigation() || !guardIdentityNavigation()) return;
    clearError();
    if (state.profile?.client_allowed === false) { state.view = "blocked"; render(); return; }
    if (!state.items.length && preview) state.items = [...exampleItems];
    state.view = "flow";
    state.step = 1;
    renderCart();
    render();
  }

  let renderedMainView = null, mainViewAnimation = null, renderedFlowStep = null;
  let cachedCatalogKey = null, cachedCatalogData = null, renderedCatalogQuantities = null, cachedProfileKey = null, cachedProfileData = null;
  function render() {
    const oldMainView = renderedMainView;
    if (state.view !== 'admin' && !$('admin-settings').hidden) {
      $('admin-settings').hidden = true; $('admin-panel').classList.remove('settings-open'); $('admin-heading').textContent = 'Управление';
      $("management-settings").hidden = true;
    }
    const mainViews = ["admin", "flow", "orders"];
    const animateMainView = mainViews.includes(state.view) && mainViews.includes(oldMainView) && state.view !== oldMainView;
    if (oldMainView !== null && state.view !== oldMainView) {
      viewportFocus?.cancel();
      window.PolyRentalMotion?.cancelTransient();
    }
    renderedMainView = state.view;
    if (availabilityCheck && (state.view !== "flow" || state.step !== 2)) {
      availabilityCheck = null; availabilitySequence++; state.busy = false;
    }
    if (state.view !== "orders") {
      resetProfileIdentity();
      const disclosure = $("profile-disclosure"), motion = disclosureAnimations.get(disclosure);
      if (motion) {
        disclosureAnimations.delete(disclosure); motion.observer?.disconnect(); cancelAnimationFrame(motion.resizeFrame);
        motion.animation.cancel(); disclosure.style.overflow = motion.overflow;
      }
      disclosure.open = false;
    }
    if (state.view !== "admin") document.querySelectorAll(".request-card").forEach(clearRequestReview);
    document.body.classList.toggle("dates-view", state.view === "flow" && state.step === 2);
    const done = state.step === 4;
    const progress = $("frame-progress");
    progress.hidden = state.view !== "flow" || done;
    [...progress.children].forEach((step, index) => {
      if (index === state.step) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
      step.classList.toggle("completed", index < state.step);
    });
    const backButton = $("top-back-button");
    backButton.hidden = (state.view === 'flow' && state.step === 0) || state.view === 'admin';
    backButton.disabled = bookingSubmitting || (state.view === "flow" && state.step === 0 && !clientCatalog.category);
    $("client-catalog-back").disabled = backButton.disabled;
    $("client-catalog-back").hidden = !clientCatalog.category;
    $("done-chat").hidden = !(location.pathname === "/miniapp" && typeof tg?.close === "function" && (authorized || keyboardMode));
    $("done-orders").classList.toggle("primary", $("done-chat").hidden);
    $("done-orders").classList.toggle("secondary", !$("done-chat").hidden);
    backButton.title = backButton.disabled ? "Вы на первом экране" : "Назад";
    $("booking-flow").hidden = state.view !== "flow";
    $("customer-next").hidden = state.view !== "flow" || state.step !== 0 || !$("customer-next").children.length;
    $("booking-flow").inert = cartLocked || bookingSubmitting; $("cart-sync-notice").hidden = !cartLocked;
    $("booking-flow").setAttribute("aria-busy", String(bookingSubmitting));
    for (const id of ["tab-new", "tab-orders", "tab-admin", "floating-cart-button"]) {
      const control = $(id);
      if (control?.matches("a")) control.setAttribute("aria-disabled", String(bookingSubmitting));
      else if (control) control.disabled = bookingSubmitting;
    }
    $("booking-blocked").hidden = state.view !== "blocked";
    $("orders-panel").hidden = state.view !== "orders";
    $("identity-panel").hidden = state.view !== "identity";
    $("admin-panel").hidden = state.view !== "admin";
    if (animateMainView && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const panel = $(({admin:"admin-panel", flow:"booking-flow", orders:"orders-panel"})[state.view]);
      mainViewAnimation?.cancel();
      mainViewAnimation = panel.animate([{opacity:desktopMotion.matches ? .84 : .72}, {opacity:1}], {duration:desktopMotion.matches ? 160 : 300, easing:"cubic-bezier(.22, 1, .36, 1)"});
    }
    $("tab-new").classList.toggle("active", state.view === "flow");
    $("tab-orders").classList.toggle("active", state.view === "orders");
    $("tab-admin").classList.toggle("active", state.view === "admin");
    $("tab-new").setAttribute("aria-current", state.view === "flow" ? "page" : "false");
    $("tab-orders").setAttribute("aria-current", state.view === "orders" ? "page" : "false");
    $("tab-admin").setAttribute("aria-current", state.view === "admin" ? "page" : "false");
    updateCartCounters();
    if (preview) {
      try { localStorage.setItem("polyrental-preview-view", state.view); } catch (_) {}
    }
    changeHeading($("page-title"), state.view === "admin" ? "Управление арендой" : state.view === "identity" ? "Документы для договора" : state.view === "orders" ? "Профиль" : done ? "Заявка оформлена" : "Бронирование техники");
    $("page-intro").textContent = state.view === "admin" ? "Комплектация, проверки, возврат, каталог и ремонт." : state.view === "identity" ? "Защищённая передача данных напрямую в ПолиРентал." : state.view === "orders" ? "Здесь можно следить за статусом и отменить активную заявку." : done ? "Менеджер получил запрос и скоро ответит." : "Выберите оборудование, затем укажите сроки аренды.";
    sections.forEach((id, index) => { $(id).hidden = state.view !== "flow" || state.step !== index; });
    $("step-done").hidden = state.view !== "flow" || !done;
    const showAction = state.view === "flow" && !done && $("onboarding-dialog").hidden && $("support-dialog").hidden && $("release-dialog").hidden;
    $("action-bar").hidden = !showAction;
    // A previously displayed native control can survive a Mini App reopen.
    // Always remove it before rendering the in-app action bar.
    tg?.MainButton?.hide();
    syncCatalogBackButton();
    if (tg && (authorized || keyboardMode)) {
      if (done) tg.disableClosingConfirmation?.(); else tg.enableClosingConfirmation?.();
    }
    if (state.view === "flow" && !cartLocked && !bookingSubmitting) {
      if (renderedFlowStep !== null && renderedFlowStep !== state.step) {
        const panel = $(sections[state.step] || "step-done"), heading = panel.querySelector("h2");
        if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
        scrollElementIntoView(panel);
        window.PolyRentalMotion?.stage(panel, state.step > renderedFlowStep ? 1 : -1);
        if (done) window.PolyRentalMotion?.result(panel.querySelector('.success-mark'));
      }
      renderedFlowStep = state.step;
    } else if (state.view !== "flow") renderedFlowStep = null;
    showPendingRelease();
  }

  function validateDates() {
    clearError();
    if (normalizePastBookingStart()) periodChanged();
    applyBookingDateLimits();
    if (dateValidationMessage()) {
      for (const id of ["start", "end"]) fieldError(id, !$(`${id}-time`).value ? `Выберите время ${id === "start" ? "получения" : "возврата"}.` : "");
      if ($("start-time").value && $("end-time").value) showError(dateValidationMessage());
      document.querySelector('#step-dates [aria-invalid="true"]')?.focus(); render(); return false;
    }
    return true;
  }

  const quantityStocks = new Map();
  function quantityLimit(id) {
    const capacity = quantityStocks.get(id)?.capacity;
    return Number.isInteger(capacity) ? Math.max(0, Math.min(30, capacity)) : 0;
  }
  function stockLabel(id) {
    const capacity = quantityStocks.get(id)?.capacity;
    return Number.isInteger(capacity) ? `Всего для аренды: ${capacity}` : "Проверяем общее количество…";
  }
  function exceedsStock() { return [...state.quantities].some(([id, quantity]) => quantity > quantityLimit(id)); }
  function stockWarning(id, quantity) {
    return quantity > quantityLimit(id) ? `${stockLabel(id)}. Уменьшите количество или удалите позицию.` : stockLabel(id);
  }
  function availabilityPath(start, end) {
    const params = new URLSearchParams({start:toIso(start), end:toIso(end), page:String(clientCatalog.page), page_size:String(clientCatalog.pageSize), q:$("client-catalog-search").value.trim()});
    if (clientCatalog.category) params.set("category", clientCatalog.category);
    for (const [id] of state.quantities) params.append("selected", String(id));
    return `/api/miniapp/availability?${params}`;
  }
  function reconcileAvailability(data, previousItems) {
    const pageItems = [...(data.all_items || data.items || [])];
    const paged = Number.isInteger(data.page);
    const merged = new Map(pageItems.map(item => [item.id, item]));
    for (const item of data.selected_items || []) merged.set(item.id, item);
    for (const [id] of state.quantities) if (!merged.has(id)) {
      const previous = previousItems.find(item => item.id === id);
      const missing = {...(previous || {id, name:"Позиция больше недоступна", description:""}), capacity:0, available_quantity:0};
      merged.set(id, missing); if (!paged) pageItems.push(missing);
    }
    clientCatalog.paged = paged;
    clientCatalog.total = paged ? data.total : pageItems.length;
    clientCatalog.pageSize = paged ? data.page_size : 20;
    clientCatalog.pageItems = pageItems;
    return [...merged.values()];
  }
  async function loadItems(checkAvailability = false, preservePosition = false) {
    if (typeof checkAvailability !== "boolean") checkAvailability = false;
    if (checkAvailability) availabilityFresh = false;
    const sequence = ++availabilitySequence;
    const periodStart = $("start").value, periodEnd = $("end").value;
    const requestedPage = clientCatalog.page, requestedQuery = $("client-catalog-search").value.trim(), requestedCategory = clientCatalog.category;
    const previousItems = state.items;
    const requestKey = JSON.stringify([requestedPage, requestedQuery, requestedCategory, periodStart, periodEnd, [...state.quantities]]);
    const retainCatalog = !checkAvailability && cachedCatalogKey === requestKey;
    if (retainCatalog && renderedCatalogQuantities !== JSON.stringify([...state.quantities])) renderItems();
    if (!retainCatalog) {
      const grid = $("items-grid");
      grid.hidden = false;
      grid.classList.toggle("items-grid-tiles", categoryIsLeaf(requestedCategory) && catalogLayout("client") === "grid");
      showLoading(grid, checkAvailability ? "" : "Загружаем оборудование…");
    }
    if (!retainCatalog) { $("items-status").hidden = !checkAvailability; $("items-status").textContent = checkAvailability ? "Проверяем доступность оборудования…" : ""; }
    $("retry-items").hidden = true;
    const startIso = toIso($("start").value), endIso = toIso($("end").value);
    $("period-label").innerHTML = startIso && endIso
      ? `<span class="period-label-caption">Период аренды (МСК)</span><strong class="period-label-value">${escapeHtml(`${shortRequestDateTime(startIso)} — ${shortRequestDateTime(endIso)}`)}</strong>`
      : `<span class="period-label-caption">Период аренды (МСК)</span><strong class="period-label-value">Выберите даты</strong>`;
    try {
      const catalogParams = new URLSearchParams({page:String(clientCatalog.page), page_size:String(clientCatalog.pageSize), q:requestedQuery, category:requestedCategory});
      for (const [id] of state.quantities) catalogParams.append("selected", String(id));
      const data = preview ? { items: exampleItems, unavailable_count: 0, unavailable: [] } : await api(checkAvailability ? availabilityPath(periodStart, periodEnd) : `/api/miniapp/catalog?${catalogParams}`);
      if (preservePosition) await window.PolyRentalMotion?.waitCategory();
      if (sequence !== availabilitySequence || periodStart !== $("start").value || periodEnd !== $("end").value || (Number.isInteger(data.page) && (requestedPage !== clientCatalog.page || requestedCategory !== clientCatalog.category || requestedQuery !== $("client-catalog-search").value.trim()))) return false;
      if (Number.isInteger(data.page) && data.page > 0 && data.page * data.page_size >= data.total) { clientCatalog.page = Math.max(0, Math.ceil(data.total / data.page_size) - 1); return loadItems(checkAvailability); }
      const catalogData = JSON.stringify([data, clientCatalog.categories]);
      const unchangedCatalog = retainCatalog && cachedCatalogData === catalogData;
      state.items = reconcileAvailability(data, previousItems);
      if (!checkAvailability) { cachedCatalogKey = requestKey; cachedCatalogData = catalogData; }
      for (const item of state.items) {
        const old = quantityStocks.get(item.id) || {};
        const capacity = Number.isInteger(item.capacity) ? item.capacity : (old.capacity ?? (Number.isInteger(item.available_quantity) ? item.available_quantity : null));
        quantityStocks.set(item.id, {capacity: capacity ?? old.capacity});
      }
      availabilityFresh=checkAvailability;
      if (state.view === "flow" && state.step === 1) renderCart();
      if (state.view === "flow" && state.step === 3) renderReview();
      updateCartCounters();
      if (!checkAvailability) {
        if (unchangedCatalog) return true;
        $("items-status").hidden = Boolean(clientCatalog.pageItems.length);
        $("items-status").textContent = requestedQuery ? "По вашему запросу ничего не найдено." : "В каталоге пока нет оборудования.";
        const scroll = preservePosition ? {x:window.scrollX, y:window.scrollY} : null;
        renderItems();
        if (!preservePosition) enterWorkspace($('items-status').hidden ? $('items-grid') : $('items-status'));
        if (scroll) window.scrollTo(scroll.x, scroll.y);
        return true;
      }
      if (clientCatalog.pageItems.length) {
        $("items-status").textContent = data.unavailable_count ? `${data.unavailable_count} позиций недоступно в выбранный период.` : "Все показанные экземпляры свободны на выбранный срок.";
        $("items-status").hidden = !data.unavailable_count;
      } else {
        $("items-status").textContent = requestedQuery ? "По вашему запросу ничего не найдено." : "На эти даты свободного оборудования нет. Вернитесь и выберите другой период.";
      }
      $("unavailable-details").hidden = !data.unavailable?.length;
      $("unavailable-list").replaceChildren();
      for (const item of data.unavailable || []) {
        const line = document.createElement("p");
        line.textContent = `${item.name} (${item.sku}): нет свободных единиц на выбранный период`;
        $("unavailable-list").append(line);
      }
      renderItems(); return true;
    } catch (error) {
      if (sequence !== availabilitySequence) return false;
      if (!checkAvailability && !retainCatalog) { quantityStocks.clear(); cachedCatalogKey = null; cachedCatalogData = null; }
      if (state.view === "flow" && state.step === 1) renderCart();
      if (state.view === "flow" && state.step === 3) renderReview();
      updateCartCounters();
      if (!retainCatalog) $("items-grid").replaceChildren();
      $("items-status").hidden = false; $("items-status").textContent = `Не удалось загрузить оборудование: ${error.message}`;
      $("retry-items").hidden = false;
      showError(error.message);
      return false;
    }
  }
  function catalogEditorBackButton() {
    return state.view === "admin" && state.adminMode === "catalog"
      ? document.querySelector("#admin-panel.catalog-editing .catalog-editor-back") : null;
  }
  function syncCatalogBackButton() {
    const adminCategory = state.view === "admin" && state.adminMode === "catalog" && catalogView.category &&
      !$('admin-panel').classList.contains('catalog-editing');
    const inCategory = adminCategory || (state.view === "flow" && state.step === 0 && clientCatalog.category);
    const editorBack = catalogEditorBackButton();
    const settingsOpen = state.view === 'admin' && !$('admin-settings').hidden;
    $('admin-back-button').hidden = !settingsOpen;
    $('admin-back-button').disabled = !settingsOpen;
    if ((inCategory || settingsOpen || editorBack) && $("support-dialog").hidden && $("onboarding-dialog").hidden && $("release-dialog").hidden) tg?.BackButton?.show();
    else tg?.BackButton?.hide();
  }
  function categoryParent(code) { return clientCatalog.categories.find(category => category.code === code)?.parent_code || ""; }
  function categoryPath(code) {
    const names = [], visited = new Set();
    while (code && !visited.has(code)) { visited.add(code); const item = clientCatalog.categories.find(category => category.code === code); if (!item) break; names.unshift(item.name); code = item.parent_code; }
    return names.length ? ["Каталог", ...names].join(" › ") : "";
  }
  function categoryIsLeaf(code) { return Boolean(code) && !clientCatalog.categories.some(category => category.parent_code === code); }
  function catalogLayout(kind) { try { return localStorage.getItem(`polyrental-${kind}-product-layout`) === 'grid' ? 'grid' : 'list'; } catch (_) { return 'list'; } }
  function layoutPicker(kind, host) {
    const wrap = document.createElement('div'); wrap.className='catalog-layout product-layout'; wrap.setAttribute('role','group'); wrap.setAttribute('aria-label','Вид товаров');
    for (const [layout,label,icon] of [['list','Список','list'],['grid','Плитка','grid']]) {
      const button=document.createElement('button'); button.type='button'; button.className='button ghost catalog-layout-icon'; button.setAttribute('aria-label',label); button.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`; button.setAttribute('aria-pressed',String(catalogLayout(kind)===layout));
      button.addEventListener('click', () => {
        try { localStorage.setItem(`polyrental-${kind}-product-layout`, layout); } catch (_) {}
        const tileClass = kind === 'client' ? 'items-grid-tiles' : 'tiles';
        const changed = host.classList.contains(tileClass) !== (layout === 'grid');
        host.classList.toggle(tileClass, layout === 'grid');
        wrap.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
        if (changed) enterWorkspace(host);
      });
      wrap.append(button);
    } return wrap;
  }
  function categoryContains(code, parent) {
    const visited = new Set();
    while (code && !visited.has(code)) { if (code === parent) return true; visited.add(code); code = categoryParent(code); }
    return false;
  }
  const categoryTransitions = {client: 0, admin: 0};
  let preserveAdminCatalogControls = false;
  let inboxUnread = false, inboxOffset = 0, inboxBusy = false, inboxOpener = null;
  const categoryScrollPositions = {client: new Map(), admin: new Map()};
  function settleCategoryScroll(heading, backwards, savedPosition, since, valid) {
    if (since !== viewportFocus?.checkpoint() || !valid()) return;
    if (backwards) return viewportFocus?.restore(savedPosition, valid);
    return scrollElementIntoView(heading, {since, valid});
  }
  const categoryHeightLocks = new WeakMap();
  function holdCategoryHeight(panel) {
    if (!panel || reducedMotion?.matches) return () => {};
    const old = categoryHeightLocks.get(panel);
    const rect = panel.getBoundingClientRect();
    const floor = Math.max(window.innerHeight, window.innerHeight - rect.top + 24);
    panel.style.setProperty("--category-scroll-floor", `${floor}px`);
    panel.classList.add("catalog-scroll-stable");
    const minimum = Math.max(rect.height, panel.scrollHeight);
    const state = {previous:old?.previous ?? panel.style.minHeight};
    panel.style.minHeight = `${minimum}px`;
    categoryHeightLocks.set(panel, state);
    return () => {
      if (categoryHeightLocks.get(panel) !== state) return;
      panel.style.minHeight = state.previous;
      categoryHeightLocks.delete(panel);
    };
  }
  let previousCategoryScroll = window.scrollY;
  let categoryScrollFrame = 0;
  window.addEventListener("scroll", () => {
    const current = window.scrollY, movingUp = current < previousCategoryScroll; previousCategoryScroll = current;
    if (!movingUp || categoryScrollFrame) return;
    categoryScrollFrame = requestAnimationFrame(() => {
      categoryScrollFrame = 0;
      const panel = state.view === "flow" && state.step === 0 ? $("step-items") : state.view === "admin" && state.adminMode === "catalog" ? $("admin-content") : null;
      if (!panel?.classList.contains("catalog-scroll-stable")) return;
      const floor = Math.max(window.innerHeight, window.innerHeight - panel.getBoundingClientRect().top + 24);
      const previous = parseFloat(panel.style.getPropertyValue("--category-scroll-floor")) || 0;
      if (floor < previous) panel.style.setProperty("--category-scroll-floor", `${floor}px`);
    });
  }, {passive:true});
  async function navigateClientCategory(code, origin = null) {
    viewportFocus?.cancel();
    const since = viewportFocus?.checkpoint();
    const initialScroll = {x:window.scrollX, y:window.scrollY};
    const snapshot = window.PolyRentalMotion?.captureCategoryView($("client-catalog-level"));
    window.PolyRentalMotion?.cancelReflow([$("client-categories"), $("items-grid")]);
    const releaseHeight = holdCategoryHeight($("step-items"));
    const direction = code === categoryParent(clientCatalog.category) ? -1 : 1;
    if (code && direction > 0) {
      try { localStorage.setItem(`${draftKey}:recent-category`, code); } catch (_) {}
    }
    if (direction > 0) categoryScrollPositions.client.set(clientCatalog.category, initialScroll.y);
    const targetScroll = direction < 0 ? (categoryScrollPositions.client.get(code) ?? initialScroll.y) : initialScroll.y;
    const token = ++categoryTransitions.client;
    ++availabilitySequence;
    clientCatalog.category = code; clientCatalog.page = 0;
    syncCatalogBackButton(); render(); renderItems();
    window.scrollTo(initialScroll.x, initialScroll.y);
    const heading = $("catalog-page-title"); heading.focus({preventScroll:true});
    const loading = loadItems(false, true);
    window.scrollTo(initialScroll.x, initialScroll.y);
    window.PolyRentalMotion?.transitionCategoryView(snapshot, $("client-catalog-level"), direction);
    const current = () => token === categoryTransitions.client && state.view === "flow" && state.step === 0 && clientCatalog.category === code;
    try {
      await loading;
      if (!current()) return;
      await window.PolyRentalMotion?.waitCategory();
      await settleCategoryScroll($("catalog-page-title"), direction < 0, targetScroll, since, current);
    } finally { releaseHeight(); }
  }
  function catalogBack() {
    if (state.view === 'admin' && !$('admin-settings').hidden) {
      if (siteNavigation) siteNavigation.backTo(adminSiteRoute());
      else closeAdminSettings();
      return true;
    }
    const editorBack = catalogEditorBackButton();
    if (editorBack) { editorBack.click(); return true; }
    if (state.view === "flow" && state.step === 0 && clientCatalog.category) {
      const parent = categoryParent(clientCatalog.category);
      if (siteNavigation) siteNavigation.backTo(catalogSiteRoute("catalog", parent));
      else void navigateClientCategory(parent);
      return true;
    }
    if (state.view === "admin" && state.adminMode === "catalog" && catalogView.category && !$('admin-panel').classList.contains('catalog-editing')) {
      const parent = categoryParent(catalogView.category);
      if (siteNavigation) siteNavigation.backTo(catalogSiteRoute("management-catalog", parent));
      else void navigateAdminCategory(parent);
      return true;
    }
    return false;
  }
  tg?.BackButton?.onClick?.(() => { if (!catalogBack()) back(); });
  function categoryEmptyOverlay(host) {
    const overlay = document.createElement("section"); overlay.className = "category-empty-overlay"; overlay.setAttribute("role", "region"); overlay.setAttribute("aria-label", "Пустая категория");
    const message = document.createElement("p"); message.textContent = "Тут ещё ничего нет :(";
    overlay.append(message); host.append(overlay);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => position()) : null;
    const position = () => {
      if (!overlay.isConnected) { window.removeEventListener("scroll", position); window.removeEventListener("resize", position); observer?.disconnect(); return; }
      const area = host.getBoundingClientRect(), bottom = Math.min(window.innerHeight - 80, area.bottom), top = Math.max(0, area.top);
      overlay.hidden = bottom - top < 56;
      overlay.style.left = `${Math.max(0, area.left)}px`; overlay.style.width = `${Math.max(0, area.width)}px`;
      overlay.style.top = `${top}px`; overlay.style.height = `${Math.max(0, bottom - top)}px`;
    };
    window.addEventListener("scroll", position, {passive:true}); window.addEventListener("resize", position, {passive:true});
    observer?.observe(host);
    position(); requestAnimationFrame(position);
  }
  function renderItems() {
    $("step-items").classList.toggle("catalog-category-screen", Boolean(clientCatalog.category));
    $("step-items").querySelector(".category-empty-overlay")?.remove();
    renderedCatalogQuantities = JSON.stringify([...state.quantities]);
    $("items-grid").replaceChildren();
    const categoryHost = $("client-categories"); categoryHost.replaceChildren();
    const queryText = $("client-catalog-search").value.trim();
    let recentCode = ""; try { recentCode = localStorage.getItem(`${draftKey}:recent-category`) || ""; } catch (_) {}
    const recent = clientCatalog.categories.find(category => category.code === recentCode);
    $("recent-category").hidden = Boolean(clientCatalog.category || queryText || !recent?.parent_code);
    $("recent-category").textContent = recent ? `Снова открыть: ${recent.name}` : "";
    if (recent && siteNavigation) siteNavigation.bind($("recent-category"), catalogSiteRoute("catalog", recent.code));
    else $("recent-category").onclick = () => { if (recent) void navigateClientCategory(recent.code, $("recent-category")); };
    const parent = clientCatalog.categories.find(c => c.code === clientCatalog.category);
    $("catalog-page-title").textContent = parent?.name || (queryText ? "Результаты поиска" : "Каталог оборудования");
    if (siteNavigation) {
      const titleGroup = $("catalog-page-title").parentElement;
      if (clientCatalog.category) titleGroup.id = catalogSiteRoute("catalog", clientCatalog.category);
      else titleGroup.removeAttribute("id");
      titleGroup.classList.toggle("site-anchor-target", Boolean(clientCatalog.category));
    }
    $("client-catalog-path").textContent = categoryPath(clientCatalog.category);
    $("client-catalog-search-label").textContent = parent ? `Поиск: ${parent.name}` : "Поиск по всему каталогу";
    syncCatalogBackButton();
    const children = clientCatalog.categories.filter(c => (c.parent_code || "") === clientCatalog.category);
    const picker = $('client-product-layout'); picker.replaceChildren(); picker.hidden = !categoryIsLeaf(clientCatalog.category); $('items-grid').classList.toggle('items-grid-tiles', !picker.hidden && catalogLayout('client') === 'grid'); if (!picker.hidden) picker.append(layoutPicker('client',$('items-grid')));
    if (!queryText) for (const category of children) {
      const button = document.createElement("button"); button.type = "button"; button.className = "category-card";
      button.innerHTML = `<span class="category-card-icon">${categoryVisual(category)}</span><span class="category-card-name">${escapeHtml(category.name)}</span><span class="category-card-arrow" aria-hidden="true">›</span>`;
      button.dataset.categoryCode = category.code;
      categoryHost.append(button);
      const link = bindSiteLink(button, catalogSiteRoute("catalog", category.code), () => { void navigateClientCategory(category.code, button); });
      bindCategoryPhoto(link, category);
    }
    const showCategoryIndex = !clientCatalog.category && !queryText && clientCatalog.categories.length;
    $("items-grid").hidden = Boolean(showCategoryIndex);
    if (showCategoryIndex) $("items-status").hidden = true;
    const query = $("client-catalog-search").value.trim().toLocaleLowerCase("ru-RU");
    for (const item of (showCategoryIndex ? [] : (clientCatalog.paged ? clientCatalog.pageItems : state.items))) {
      if (!clientCatalog.paged && clientCatalog.category && !categoryContains(item.category || "generic", clientCatalog.category)) continue;
      if (!clientCatalog.paged && query && ![item.title, item.name, item.description, item.brand, item.kind, item.key_spec, item.sku].join(" ").toLocaleLowerCase("ru-RU").includes(query)) continue;
      const quantity = state.quantities.get(item.id) || 0;
      const selected = quantity > 0;
      const card = document.createElement("article");
      card.className = `item-card${selected ? " selected" : ""}`;
      const media = catalogMedia(item, "item");
      const typeNote = item.description && item.description !== catalogType(item) ? `<span class="item-type">${escapeHtml(item.description)}</span>` : "";
      card.innerHTML = `${media}<div class="item-main"><div class="item-top"><div><h3 class="item-name">${escapeHtml(catalogTitle(item))}</h3>${typeNote}<span class="available-badge">${escapeHtml(stockWarning(item.id, quantity))}</span><div class="item-notes"></div></div></div><div class="quantity-control" role="group" aria-label="Количество: ${escapeHtml(catalogTitle(item))}"><button type="button" class="button ghost minus" aria-label="Уменьшить количество: ${escapeHtml(catalogTitle(item))}" ${quantity === 0 ? "disabled" : ""}>−</button><strong class="quantity-value" aria-live="polite" aria-atomic="true">${quantity}</strong><button type="button" class="button ghost plus" aria-label="Увеличить количество: ${escapeHtml(catalogTitle(item))}" ${quantity >= quantityLimit(item.id) ? "disabled" : ""}>+</button></div></div>`;
      const changeQuantity = (delta) => {
        const current = state.quantities.get(item.id) || 0;
        if (delta > 0 && current >= quantityLimit(item.id)) return;
        const next = Math.max(0, current + delta);
        if (next > 0 && !state.quantities.has(item.id) && state.quantities.size >= 30) { showError("В подборке может быть не больше 30 позиций."); return; }
        if (next > 0) state.quantities.set(item.id, next); else state.quantities.delete(item.id);
        state.requestId = null;
        card.classList.toggle("selected", next > 0);
        card.querySelector(".quantity-value").textContent = String(next);
        card.querySelector(".minus").disabled = next === 0;
        card.querySelector(".plus").disabled = next >= quantityLimit(item.id);
        card.querySelector(".available-badge").textContent = stockWarning(item.id, next);
        window.PolyRentalMotion?.quantityFeedback(card.querySelector('.quantity-value'), $("main-button"));
        if (delta > 0 && next > current) window.PolyRentalMotion?.flyToCart(card, $("main-button"));
        renderedCatalogQuantities = JSON.stringify([...state.quantities]);
        updateCartCounters(); saveDraft();
      };
      card.querySelector(".minus").addEventListener("click", () => changeQuantity(-1));
      card.querySelector(".plus").addEventListener("click", () => changeQuantity(1));
      const notes = card.querySelector(".item-notes");
      const details = document.createElement("details"); details.className = "client-item-details";
      const summary = document.createElement("summary"); summary.textContent = "Подробнее";
      const composition = document.createElement("p"); composition.className = "composition-text";
      composition.textContent = `Комплектация: ${item.composition || "пока не указана"}`;
      details.append(summary, composition); notes.append(details);
      if (item.name && item.name !== catalogTitle(item)) { const full = document.createElement("p"); full.textContent = item.name; notes.append(full); }
      if (item.owners?.length) { const owner = document.createElement("p"); owner.textContent=`Владелец: ${item.owners.join(", ")}`; notes.append(owner); }
      $("items-grid").append(card);
    }
    if (clientCatalog.category && !queryText && !$("items-grid").querySelector(".item-card")) {
      $("items-status").hidden = Boolean(children.length);
      if (!children.length) { $("items-status").hidden = true; categoryEmptyOverlay($("items-grid")); }
    }
    const pages = Math.max(1, Math.ceil(clientCatalog.total / clientCatalog.pageSize));
    $("client-catalog-pagination").hidden = showCategoryIndex || !clientCatalog.paged || pages <= 1;
    $("client-catalog-prev").disabled = clientCatalog.page <= 0; $("client-catalog-next").disabled = clientCatalog.page + 1 >= pages;
    $("client-catalog-page").textContent = `${clientCatalog.page + 1} / ${pages}`;
    updateCartCounters();
    $("nearest-period").hidden = !availabilityFresh || !authorized || preview || state.quantities.size === 0;
    if (nearestProposal && nearestProposal.key !== nearestSelectionKey()) { nearestProposal = null; $("nearest-status").textContent = ""; $("nearest-apply").hidden = true; }
  }
  function nearestSelectionKey() { return JSON.stringify([$("start").value, $("end").value, [...state.quantities].sort((a,b) => a[0] - b[0])]); }
  let calendarAvailability = null, calendarAvailabilityKey = "", calendarSequence = 0, calendarTimer = null;
  const availabilityLabels = {all:"Всё оборудование доступно", partial:"Доступна часть оборудования", none:"Нет доступного оборудования"};
  function calendarDayState(day) {
    if (!calendarAvailability || day < minimumBookingDate()) return "";
    return (calendarAvailability.daily || calendarAvailability.days)?.[day] || "";
  }
  function placeCalendarStatus(status) {
    const anchor = $(desktopWorkspace.matches ? 'period-error' : 'range-calendar');
    if (anchor.nextElementSibling !== status) anchor.after(status);
  }
  desktopWorkspace.addEventListener('change', () => {
    const status = $('calendar-availability-status');
    if (status) placeCalendarStatus(status);
  });
  function queueCalendarAvailability() {
    const sequence = ++calendarSequence;
    clearTimeout(calendarTimer);
    const dailyKey = JSON.stringify([rangeCalendar?.month, [...state.quantities].sort((a,b) => a[0] - b[0])]);
    if (dailyKey !== calendarAvailabilityKey) calendarAvailability = null;
    rangeCalendar?.render();
    let status = $("calendar-availability-status");
    if (!status) {
      status = document.createElement('p'); status.id = 'calendar-availability-status'; status.className = 'supporting';
      status.setAttribute('role', 'status'); placeCalendarStatus(status);
    }
    status.textContent = "";
    const startDate = $("start-date").value, endDate = $("end-date").value;
    if (!rangeCalendar || !state.quantities.size) return;
    if (["start", "end"].some(id => $(`${id}-time`).value && !bookingTimeValue(id))) { status.textContent = "Введите корректное время, чтобы проверить доступность."; return; }
    status.textContent = "Проверяем доступность…";
    calendarTimer = setTimeout(async () => {
      // Until time is entered, check the whole selected days conservatively.
      const anchor = startDate || minimumBookingDate();
      const start = `${anchor}T${bookingTimeValue("start") || "00:00"}`;
      const end = endDate && bookingTimeValue("end") ? `${endDate}T${bookingTimeValue("end")}` : `${addIsoDays(endDate || anchor, 1)}T00:00`;
      if (end <= start) { status.textContent = "Возврат должен быть позже получения."; return; }
      const first = addIsoDays(rangeCalendar.month, -((new Date(`${rangeCalendar.month}T12:00:00Z`).getUTCDay() + 6) % 7));
      try {
        const data = preview ? {selected:"all", days:Object.fromEntries(Array.from({length:42}, (_, i) => [addIsoDays(first, i), "all"]))} : await api("/api/miniapp/availability/calendar", {method:"POST", body:JSON.stringify({start:toIso(start), end:toIso(end), first_day:first, lines:[...state.quantities].map(([article_id, quantity]) => ({article_id, quantity}))})});
        if (sequence !== calendarSequence) return;
        calendarAvailability = data; calendarAvailabilityKey = dailyKey; rangeCalendar.render();
        const selected = startDate && endDate && bookingTimeValue("start") && bookingTimeValue("end") ? `${availabilityLabels[data.selected] || ""} на выбранный срок. ` : "";
        status.textContent = selected.trim();
        if (selected) enterWorkspace(status);
      } catch (_) { if (sequence === calendarSequence) status.textContent = "Не удалось подсветить даты. Нажмите «Проверить заявку», чтобы повторить проверку."; }
    }, 250);
  }
  function showAvailabilityShortage(missing) {
    const result = $("availability-result"); result.replaceChildren(); result.hidden = false;
    const heading = document.createElement("p"); heading.textContent = "На выбранные даты оборудования недостаточно. Измените даты или состав подборки:"; result.append(heading);
    for (const [id, quantity] of missing) {
      const item = state.items.find(row => row.id === id), line = document.createElement("p");
      line.textContent = `${catalogTitle(item || {name:"Позиция больше недоступна"})}: нужно ${quantity} шт., доступно ${item?.available_quantity ?? 0} шт.`; result.append(line);
    }
    $("availability-edit-cart").hidden = false; $("nearest-period").hidden = !authorized || preview;
    if (authorized && !preview && !exceedsStock()) void findNearestPeriod();
  }
  function unavailableSelection() {
    return [...state.quantities].filter(([id, quantity]) => quantity > (state.items.find(item => item.id === id)?.available_quantity ?? 0));
  }
  function renderCart() {
    const container = $("cart-items"); container.replaceChildren();
    updateCartCounters();
    if (!state.quantities.size) {
      const empty = document.createElement("p"); empty.className = "supporting"; empty.textContent = "В корзине пока нет выбранных позиций.";
      container.append(empty);
    }
    for (const [id, quantity] of state.quantities) {
      const item = state.items.find((row) => row.id === id) || {id, name:"Позиция недоступна", available_quantity:0};
      const row = document.createElement("article"); row.className = "order-card cart-item";
      row.innerHTML = `${catalogMedia(item, "cart")}<div class="cart-item-main"><h3>${escapeHtml(catalogTitle(item))}</h3></div>`;
      if (quantity > quantityLimit(id)) { const warning = document.createElement("p"); warning.setAttribute("role", "status"); warning.textContent = stockWarning(id, quantity); row.querySelector(".cart-item-main").append(warning); }
      const stockNote = document.createElement("p"); stockNote.className = "supporting stock-note"; stockNote.textContent = stockLabel(id); row.querySelector(".cart-item-main").append(stockNote);
      const controls = document.createElement("div"); controls.className = "quantity-control";
      controls.innerHTML = `<button type="button" class="button ghost minus" aria-label="Уменьшить количество">−</button><strong>${quantity}</strong><button type="button" class="button secondary plus" aria-label="Увеличить количество" ${quantity >= quantityLimit(id) ? "disabled" : ""}>+</button>`;
      const changeQuantity = delta => {
        const current = state.quantities.get(id) || 0;
        if (delta > 0 && current >= quantityLimit(id)) return;
        const next = Math.max(0, current + delta);
        if (next) state.quantities.set(id, next); else state.quantities.delete(id);
        state.requestId = null;
        if (!next) {
          const returnFocus = row.nextElementSibling?.querySelector(".plus") || row.previousElementSibling?.querySelector(".plus") || $("top-back-button");
          if (row.contains(document.activeElement)) returnFocus.focus({preventScroll:true});
          const exit = window.PolyRentalMotion ? window.PolyRentalMotion.removeRow(row) : (row.remove(), Promise.resolve());
          void exit.then(() => { if (!state.quantities.size) renderCart(); });
          const total = [...state.quantities.values()].reduce((sum, count) => sum + count, 0);
          $("cart-total").textContent = total ? `Всего: ${total} шт.` : "Подборка пуста. Вернитесь в каталог, чтобы добавить оборудование.";
          updateCartCounters(); saveDraft(); return;
        }
        controls.querySelector("strong").textContent = String(next);
        window.PolyRentalMotion?.quantityFeedback(controls.querySelector("strong"));
        controls.querySelector(".plus").disabled = next >= quantityLimit(id);
        const warning = row.querySelector('[role="status"]');
        if (warning) { if (next <= quantityLimit(id)) warning.remove(); else warning.textContent = stockWarning(id, next); }
        const total = [...state.quantities.values()].reduce((sum, count) => sum + count, 0);
        $("cart-total").textContent = `Всего: ${total} шт.`;
        updateCartCounters(); saveDraft();
      };
      controls.querySelector(".minus").addEventListener("click", () => changeQuantity(-1));
      controls.querySelector(".plus").addEventListener("click", () => changeQuantity(1));
      row.querySelector(".cart-item-main").append(controls); container.append(row);
    }
    const total = [...state.quantities.values()].reduce((sum, quantity) => sum + quantity, 0);
    $("cart-total").textContent = total ? `Всего: ${total} шт.` : "Подборка пуста. Вернитесь в каталог, чтобы добавить оборудование.";
  }
  function reviewRow(label, value, extraClass = "") { return `<div class="review-row"><span>${escapeHtml(label)}</span><strong class="${extraClass}">${escapeHtml(value)}</strong></div>`; }
  function renderReview() {
    const chosen = state.items.filter((item) => (state.quantities.get(item.id) || 0) > 0);
    const itemCount = chosen.reduce((sum, item) => sum + state.quantities.get(item.id), 0);
    $("review-content").innerHTML = `<section class="review-group"><div class="review-group-head"><h3 class="review-heading">Срок аренды</h3><button type="button" class="button ghost review-edit" data-step="2" aria-label="Изменить срок аренды">Изменить</button></div>${reviewRow("Получение", reviewDateTime(toIso($("start").value)))}${reviewRow("Возврат", reviewDateTime(toIso($("end").value)))}</section><section class="review-group"><div class="review-group-head"><h3 class="review-heading">Оборудование (${itemCount} шт.)</h3><button type="button" class="button ghost review-edit" data-step="1" aria-label="Изменить оборудование">Изменить</button></div><ul class="review-items">${chosen.map((item) => `<li>${catalogMedia(item, "review")}<div class="review-item-main"><strong>${escapeHtml(catalogTitle(item))}</strong><span>${state.quantities.get(item.id)} шт. в заявке</span><p class="supporting">${escapeHtml(stockWarning(item.id, state.quantities.get(item.id)))}</p><div class="quantity-control"><button type="button" class="button ghost review-minus" data-id="${item.id}" aria-label="Уменьшить количество: ${escapeHtml(catalogTitle(item))}" ${itemCount === 1 ? "disabled" : ""}>−</button><strong>${state.quantities.get(item.id)}</strong><button type="button" class="button ghost review-plus" data-id="${item.id}" aria-label="Увеличить количество: ${escapeHtml(catalogTitle(item))}" ${state.quantities.get(item.id) >= quantityLimit(item.id) ? "disabled" : ""}>+</button></div></div></li>`).join("")}</ul></section><p class="supporting">Заявка привязана к вашему Telegram. ФИО и телефон вы укажете в анкете после подтверждения.</p>`;
    $("review-content").querySelectorAll(".review-edit").forEach(button => button.addEventListener("click", () => {
      if (bookingSubmitting) return;
      clearError(); state.step = Number(button.dataset.step);
      if (state.step === 1) renderCart();
      render();
      const target = button.dataset.focus ? $(button.dataset.focus) : state.step === 2 ? $("range-calendar") : $("cart-items");
      if (target) { scrollElementIntoView(target, {block:"start"}); if (button.dataset.focus) target.focus({preventScroll:true}); }
    }));
    $("review-content").querySelectorAll(".review-minus, .review-plus").forEach((button) => button.addEventListener("click", () => {
      const id = Number(button.dataset.id), quantity = state.quantities.get(id) || 0;
      if (button.classList.contains("review-plus") && quantity >= quantityLimit(id)) return;
      const nextQuantity = quantity + (button.classList.contains("review-plus") ? 1 : -1);
      if (nextQuantity > 0) state.quantities.set(id, nextQuantity); else state.quantities.delete(id);
      state.requestId = null; saveDraft(); renderCart();
      if (unavailableSelection().length) { state.step = 2; render(); showAvailabilityShortage(unavailableSelection()); queueCalendarAvailability(); return; }
      renderReview();
      $("review-content").querySelector(`.${button.classList.contains("review-plus") ? "review-plus" : "review-minus"}[data-id="${id}"]`)?.focus();
    }));
  }

  async function next() {
    if (state.busy || cartLocked || state.view !== "flow") return;
    clearError();
    if (!authorized && !keyboardMode && !preview) return showError("Откройте приложение кнопкой в чате с ботом Telegram.");
    if (state.step === 0) {
      if (!state.quantities.size) return showError("Выберите хотя бы одну единицу оборудования.");
      state.step = 1; renderCart(); render();
    } else if (state.step === 1) {
      if (!state.quantities.size) return showError("Подборка пуста. Добавьте оборудование в каталоге.");
      $("availability-result").hidden = true; $("availability-edit-cart").hidden = true; $("nearest-period").hidden = true;
      state.step = 2; render(); queueCalendarAvailability();
    } else if (state.step === 2) {
      if (!validateDates()) return;
      const check = {}; availabilityCheck = check;
      saveDraft(); state.busy = true; render();
      const loaded = await loadItems(true);
      if (availabilityCheck !== check) return;
      availabilityCheck = null;
      state.busy = false;
      if (!loaded) { render(); return; }
      const missing = unavailableSelection();
      if (missing.length) {
        showAvailabilityShortage(missing); render(); return;
      }
      $("availability-result").hidden = true; $("availability-edit-cart").hidden = true; $("nearest-period").hidden = true;
      state.busy = true; render();
      await refreshBookingQuestion();
      state.busy = false;
      state.step = 3; renderReview(); render();
    } else if (state.step === 3) {
      await submit();
    }
  }

  function back() {
    if (bookingSubmitting) return;
    clearError();
    if (catalogEditorBackButton()) { catalogBack(); return; }
    if (state.view === "admin" && !guardStaffNavigation()) return;
    if (catalogBack()) return;
    if (state.view === "admin") return;
    if (state.view === "identity") { void showOrders(); return; }
    if (state.view !== "flow") { state.view = "flow"; if (state.step === 0) void loadItems(); render(); return; }
    if (state.step === 4) { void showOrders(); return; }
    if (state.step > 0 && state.step < 4) { state.step--; if (state.step === 1) renderCart(); if (state.step === 0) void loadItems(); render(); }
  }

  async function submit() {
    if (bookingSubmitting || cartLocked) return;
    bookingSubmitting = true; state.busy = true; render();
    let closing = false;
    try { closing = await submitBooking() === "sent-to-chat"; }
    finally { if (!closing) { bookingSubmitting = false; state.busy = false; render(); } }
  }

  async function submitBooking() {
    if ($("start").value && new Date(toIso($("start").value)).getTime() < Date.now() - 60_000 && normalizePastBookingStart()) {
      state.step = 2;
      periodChanged();
      return showError("Начало обновлено до текущего времени. Проверьте срок аренды.");
    }
    if (exceedsStock() || !availabilityFresh || unavailableSelection().length) { state.step = 2; render(); return showError("Проверьте доступность оборудования на выбранный срок."); }
    if (authorized && (cartDirty || cartSaving)) { try { await flushCart(); } catch (error) { return showError(`Не удалось сохранить подборку: ${error.message}`); } }
    if (cartLocked || state.step !== 3) return;
    if (preview) return showError("Это демонстрация интерфейса. Отправка заявки доступна из Telegram.");
    if (!state.requestId) state.requestId = newRequestId();
    const payload = { request_id: state.requestId, start: toIso($("start").value), end: toIso($("end").value), lines: [...state.quantities].map(([article_id, quantity]) => ({ article_id, quantity })) };
    payload.rental_purpose = $('rental-purpose').value.trim();
    if (keyboardMode) {
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 4096) return showError('Заявка слишком большая для отправки через чат. Сократите цель аренды или откройте приложение кнопкой в сообщении бота.');
      state.busy = true; render();
      try { tg.sendData(JSON.stringify(payload)); clearDraft(); return "sent-to-chat"; }
      catch (_) { state.busy = false; render(); showError("Не удалось передать заявку боту. Попробуйте ещё раз."); }
      return;
    }
    state.busy = true; render();
    try {
      const booking = await api("/api/miniapp/bookings", { method: "POST", body: JSON.stringify(payload) });
      state.booking = booking; state.step = 4; clearDraft();
      state.quantities.clear(); state.requestId = null; availabilityFresh = false;
      $("start").value = ""; $("end").value = "";
      syncDateFields("start"); syncDateFields("end"); rangeCalendar.setRange("", "");
      if (Number.isInteger(state.cartVersion)) {
        try { const result = await api("/api/miniapp/cart", { method: "PUT", body: JSON.stringify({start:"", end:"", lines:[], version:state.cartVersion}) }); state.cartVersion = result.version; cartConfirmed = normalizedCart(result); cartDirty = false; rememberPendingCart(null); }
        catch (_) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Заявка отправлена, но очистить подборку на сервере не удалось."; }
      }
      $("done-title").textContent = `Заявка ${booking.human_number || `№${booking.id}`} создана`;
      $("done-description").textContent = "Статус заявки доступен в профиле. Оборудование будет зарезервировано после подтверждения сотрудником; затем потребуется заполнить анкету.";
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch (error) {
      const changed = error.message.includes("Цена изменилась") || error.message.includes("занято") || error.message.includes("недоступно") || error.message.includes("Недостаточно свободных единиц");
      if (changed || error.status === 409) { state.requestId = null; state.step = 2; availabilityFresh = false; $("availability-result").hidden = true; $("availability-edit-cart").hidden = true; }
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
    toggle.addEventListener("click", () => {
      form.hidden = !form.hidden;
      toggle.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) scrollElementIntoView(form);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        const data = new FormData(form);
        await api(`/api/miniapp/bookings/${order.id}/contact`, { method: "PATCH", body: JSON.stringify({ name: data.get("name"), contact: data.get("contact") }) });
        await showOrders();
      } catch (error) { showError(error.message); button.disabled = false; }
    });
    card.append(toggle, form);
  }

  async function loadProfileSupportThreads(page, sequence) {
    const host = $("profile-support-status");
    try {
      const result = await api(`/api/miniapp/support/threads?page=${page}&page_size=20`);
      if (sequence !== profileLoadSequence || state.view !== "orders") return;
      if (page === 0) host.replaceChildren(); else host.querySelector(".support-more")?.remove();
      for (const thread of result.items || []) { const line = document.createElement("p"); line.textContent = `${thread.request_number || "Общее обращение"}: ${thread.status}`; host.append(line); }
      if ((page + 1) * (result.page_size || 20) < (result.total ?? result.items.length)) {
        const more = plainButton("Показать ещё обращения", () => loadProfileSupportThreads(page + 1, sequence), "ghost"); more.classList.add("support-more"); host.append(more);
      }
    } catch (_) { if (sequence === profileLoadSequence && state.view === "orders") { host.replaceChildren(); host.append(plainButton("Повторить загрузку обращений", () => loadProfileSupportThreads(0, sequence), "ghost")); } }
  }

  async function showOrders(prefetched = null) {
    if (bookingSubmitting) return;
    if (!guardStaffNavigation() || !guardIdentityNavigation()) return;
    const sequence = ++profileLoadSequence;
    clearError(); state.view = "orders"; render();
    const telegramProfile = tg?.initDataUnsafe?.user || siteProfile || {};
    const displayName = state.profile?.display_name || [telegramProfile.first_name, telegramProfile.last_name].filter(Boolean).join(" ") || "Профиль Telegram";
    $("profile-name").textContent = displayName;
    $("profile-avatar-fallback").textContent = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase("ru-RU") || "П";
    const avatar = $("profile-avatar-image");
    try { const url = new URL(telegramProfile.photo_url); if (url.protocol !== "https:") throw new Error(); avatar.src = url.href; avatar.hidden = false; $("profile-avatar-fallback").hidden = true; }
    catch (_) { avatar.removeAttribute("src"); avatar.hidden = true; $("profile-avatar-fallback").hidden = false; }
    $("profile-contact").textContent = state.profile?.contact || "";
    $("reminders-enabled").checked = state.profile?.reminders_enabled !== false;
    $("reminders-enabled").disabled = !authorized || !state.profile || typeof state.profile.reminders_enabled !== "boolean";
    $("profile-since").textContent = state.profile?.member_since ? `С нами с ${new Date(state.profile.member_since).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}` : "";
    const profileKey = JSON.stringify([state.profileFilter, state.profileSort, state.profilePage, state.profileNumber, state.profileTargetId]);
    if (cachedProfileKey !== profileKey) showLoading($("orders-content"), "Загружаем заявки…");
    if (authorized) void loadProfileSupportThreads(0, sequence);
    if (keyboardMode) { $("orders-content").textContent = "Вернитесь в чат с ботом и нажмите «Мои заявки». Там же можно узнать статус и связаться с менеджером."; return; }
    if (preview) { $("orders-content").textContent = "В демонстрации заявок нет. Откройте Mini App через Telegram, чтобы увидеть свои заявки."; return; }
    if (!authorized) { $("orders-content").textContent = "Откройте приложение через Telegram."; return; }
    try {
      const result = prefetched?.items ? prefetched : await api(`/api/miniapp/profile/history?category=${encodeURIComponent(state.profileFilter)}&page=${state.profilePage}&sort=${encodeURIComponent(state.profileSort)}&number=${encodeURIComponent(state.profileNumber)}${state.profileTargetId ? `&booking_id=${state.profileTargetId}` : ""}`);
      if (sequence !== profileLoadSequence || state.view !== "orders") return;
      const profileData = JSON.stringify(result);
      if (cachedProfileKey === profileKey && cachedProfileData === profileData) return;
      cachedProfileKey = profileKey; cachedProfileData = profileData;
      $("orders-content").replaceChildren();
      customerOrdersSnapshot = workflowSnapshot(result);
      const filtered = result.items;
      const pages = Math.max(1, Math.ceil((result.total ?? filtered.length) / 10));
      if (state.profilePage >= pages) { state.profilePage = pages - 1; return showOrders(); }
      $("profile-pagination").hidden = pages <= 1;
      $("profile-prev").disabled = state.profilePage === 0; $("profile-next").disabled = state.profilePage >= pages - 1;
      $("profile-page").textContent = `${state.profilePage + 1} / ${pages}`;
      if (!filtered.length) { $("orders-content").textContent = "В этой категории заявок пока нет."; enterWorkspace($("orders-content")); return; }
      for (const order of filtered) {
        const outer = document.createElement("article"); outer.className = "order-card customer-order-card"; outer.dataset.bookingId = String(order.id);
        const accordion = document.createElement("details"); accordion.className = "customer-order-accordion"; accordion.open = selectedCustomerOrderId === order.id;
        const toggle = document.createElement("summary"); toggle.className = "customer-order-toggle";
        toggle.innerHTML = `<span class="order-head"><strong>№ ${escapeHtml(order.human_number || String(order.id))}</strong><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></span><span class="customer-order-period">${escapeHtml(`${shortRequestDateTime(order.starts_at)} — ${shortRequestDateTime(order.ends_at)} МСК`)}</span><span class="customer-order-items">${order.items.map((item) => `${escapeHtml(item.title || item.name)} × ${item.quantity}`).join(", ")}</span>`;
        const card = document.createElement("div"); card.className = "customer-order-body";
        appendRentalPurpose(card, order);
        if (order.estimated_until) { const estimate = document.createElement("p"); estimate.textContent = `В обработке, ориентировочно до ${dateText(order.estimated_until)} МСК`; card.append(estimate); }
        const help = document.createElement("button"); help.type = "button"; help.className = "button secondary"; help.textContent = "Поддержка";
        help.addEventListener("click", () => openSupport("request", order.id)); card.append(help);
        const repeat = document.createElement("button"); repeat.type = "button"; repeat.className = "button secondary"; repeat.textContent = "Повторить заявку";
        repeat.addEventListener("click", () => {
          clearError();
          state.quantities = new Map(order.items.map((item) => [item.id, item.quantity]));
          state.items = order.items.map((item) => ({ ...item, available_quantity: 0 }));
          state.requestId = null; state.booking = null; state.view = "flow"; state.step = 1;
          $('rental-purpose').value = '';
          $("start").value = ""; $("end").value = "";
          syncDateFields("start"); syncDateFields("end");
          rangeCalendar.setRange("", ""); applyBookingDateLimits(); saveDraft(); renderCart(); render(); void loadItems();
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
        }
        if (["pending", "needs_changes", "confirmed"].includes(order.status)) {
          card.append(plainButton("Отменить заявку", async () => {
            if (!await confirmCancel(order.human_number || "")) return;
            await api(`/api/miniapp/bookings/${order.id}/cancel`, {method:"POST"});
            await showOrders();
          }, "ghost"));
        }
        const statusPanel = document.createElement('section'); statusPanel.className = 'customer-status-panel request-next-overview';
        const statusDetail = document.createElement('p'); statusDetail.className = 'customer-status-detail';
        statusDetail.textContent = order.change_status === 'disputed' && order.status === 'pending'
          ? 'Вы отклонили предложенные изменения. Сотрудник рассмотрит заявку с исходными условиями.'
          : order.next_action?.description || (order.status === 'pending' ? 'Ожидайте подтверждения оператора.' : '');
        if (order.next_action?.return_overdue) {
          const warning = document.createElement('strong'); warning.textContent = order.next_action.title; statusPanel.append(warning);
        }
        const showPickupStep = order.identity_status === 'verified' && (
          order.status === 'preparing' || (order.status === 'ready' && order.next_action?.action !== 'support')
        );
        if (showPickupStep) statusPanel.append(customerPickupStep(order));
        else if (statusDetail.textContent) statusPanel.append(statusDetail);
        const customerActions = document.createElement('details'); customerActions.className = 'request-more-actions customer-actions';
        const customerActionsTitle = document.createElement('summary'); customerActionsTitle.textContent = 'Действия с заявкой'; customerActions.append(customerActionsTitle);
        const customerPrimaryLabels = new Set(['Внести изменения', 'Посмотреть изменения', 'Ваше возражение', 'Заполнить документы', 'Исправить данные', 'Сдать оборудование']);
        for (const node of [...card.childNodes]) { if (node.nodeType === 1 && (node.matches('button.primary, .stage-notice, .handover-progress, .equipment-features') || (node.tagName === 'BUTTON' && customerPrimaryLabels.has(node.textContent)))) statusPanel.append(node); else customerActions.append(node); }
        statusPanel.append(customerActions); card.append(statusPanel);
        const customerPeriod = reviewSection('Период аренды', 'request-summary'); customerPeriod.dataset.rentalStart = order.starts_at; customerPeriod.dataset.rentalEnd = order.ends_at; customerPeriod.dataset.rentalClosed = String(['returned','cancelled','expired'].includes(order.status));
        const customerDates = document.createElement('div'); customerDates.className = 'rental-period'; for (const date of [order.starts_at,order.ends_at]) { const value = document.createElement('span'); value.textContent = dateText(date); customerDates.append(value); } customerPeriod.append(customerDates); updateRentalProgress(customerPeriod); card.append(customerPeriod);
        const customerEquipment = document.createElement('details'); customerEquipment.className = 'request-section request-equipment-section'; customerEquipment.open = true;
        const customerEquipmentTitle = document.createElement('summary'); customerEquipmentTitle.textContent = `Техника (${order.items.length} поз.)`; customerEquipment.append(customerEquipmentTitle);
        const customerEquipmentList = document.createElement('div'); customerEquipmentList.className = 'request-equipment';
        const itemRows = order.items.map(item => {
          const row = document.createElement("div"); row.className = "request-equipment-row";
          const article = {...order.article_media?.[item.id], ...item};
          const main = document.createElement("div"); main.className = "equipment-card-main";
          const thumb = document.createElement("div"); thumb.className = "request-equipment-thumb";
          thumb.innerHTML = catalogMedia(article, "request-item");
          const info = document.createElement("div"); info.className = "request-equipment-info";
          const name = document.createElement("span"); name.className = "request-equipment-title"; name.textContent = item.title || item.name;
          const quantity = document.createElement("span"); quantity.className = "request-equipment-quantity"; quantity.textContent = String(item.quantity);
          info.append(name, quantity); main.append(thumb, info); row.append(main);
          bindEquipmentPreview(row, main, article, {keyboard: true});
          customerEquipmentList.append(row);
          return row;
        });
        customerEquipment.append(customerEquipmentList); if (itemRows.length > 5) { const more = document.createElement('button'); more.type = 'button'; more.className = 'request-equipment-more'; const update = expanded => { itemRows.forEach((row,index) => row.hidden = index >= 5 && !expanded); more.setAttribute('aria-expanded',String(expanded)); more.textContent = expanded ? 'Свернуть список ▴' : `Показать ещё ${itemRows.length - 5} ▾`; }; more.addEventListener('click',() => { const expanded = more.getAttribute('aria-expanded') !== 'true'; update(expanded); if (expanded) scrollElementIntoView(customerEquipment); }); update(false); customerEquipment.append(more); } if (!showPickupStep) card.append(customerEquipment);
        if (!(order.status === 'cancelled' && order.identity_status === 'not_required')) { const customerIdentity = document.createElement('section'); customerIdentity.className = 'request-section customer-identity-status'; const identityTitle = document.createElement('h4'); identityTitle.textContent = 'Анкета'; const identitySummary = document.createElement('p'); identitySummary.className = order.identity_status === 'verified' ? 'identity-verified' : 'identity-unverified'; identitySummary.textContent = order.status === 'pending' && ['required','needs_changes'].includes(order.identity_status) ? 'Доступна после подтверждения заявки' : identityStatusNames[order.identity_status] || 'Не заполнена'; customerIdentity.append(identityTitle,identitySummary); card.append(customerIdentity); }
        accordion.append(toggle, card); outer.append(accordion); $("orders-content").append(outer);
        toggle.addEventListener("click", event => {
          event.preventDefault(); const opening = !disclosureIsOpen(accordion);
          if (opening) for (const other of $("orders-content").querySelectorAll(".customer-order-accordion")) if (other !== accordion) setDisclosureOpen(other, false);
          setDisclosureOpen(accordion, opening, opening); selectedCustomerOrderId = opening ? order.id : null;
          if (opening) showStageNotice(order);
        });
      }
      enterWorkspace($("orders-content"));
    } catch (error) { if (sequence === profileLoadSequence && state.view === "orders") { cachedProfileKey = null; cachedProfileData = null; $("orders-content").textContent = "Не удалось загрузить заявки. "; $("orders-content").append(plainButton("Повторить", () => showOrders(), "secondary")); showError(error.message); } }
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
    const since = viewportFocus?.checkpoint();
    const list = $("address-suggestions"), opening = list.hidden;
    list.replaceChildren();
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
      if (opening) scrollElementIntoView(list, {since});
    } catch (error) {
      if (error.name === "AbortError" || sequence !== addressSuggestSequence) return;
      const status = document.createElement("p"); status.className = "address-suggestion-status"; status.textContent = "Подсказки временно недоступны. Адрес можно ввести вручную."; list.replaceChildren(status);
      list.hidden = false; $("registration_address").setAttribute("aria-expanded", "true");
      if (opening) scrollElementIntoView(list, {since});
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

  function identitySessionCurrent(session) {
    return Boolean(session && identitySession === session && session.generation === identityGeneration && state.identityBookingId === session.bookingId && state.view === "identity");
  }
  function identityFormSnapshot() {
    return JSON.stringify([staffFormSnapshot($("identity-form")), [...state.identityRequiredPhotos].sort()]);
  }
  function identityFormDirty() {
    return identitySessionCurrent(identitySession) && identitySession.baseline !== null && identitySession.baseline !== identityFormSnapshot();
  }
  function clearIdentityRestoreKey() {
    try { localStorage.removeItem("polyrental-identity-booking"); } catch (_) {}
  }
  function closeIdentitySession() {
    identityGeneration++; identitySession = null;
    state.identityBookingId = null; state.consent = null;
    state.identityNeedsChanges = false; state.identityRequiredPhotos = []; state.identityReusableDocuments = [];
    state.identityLegacyInstitution = null;
    closeAddressSuggestions(); clearIdentityRestoreKey();
    $("identity-form").reset();
  }
  function guardIdentityNavigation() {
    if (state.view !== "identity") return true;
    if (identitySession?.submitting) { showError("Дождитесь завершения отправки анкеты."); return false; }
    if (identityFormDirty() && !window.confirm("В анкете есть несохранённые изменения. Закрыть её и потерять введённые данные?")) return false;
    closeIdentitySession();
    return true;
  }
  window.addEventListener("beforeunload", event => {
    if (identityFormDirty() || identitySession?.submitting) { event.preventDefault(); event.returnValue = ""; }
  });

  async function openIdentity(bookingId) {
    if (!guardIdentityNavigation()) return;
    const session = {bookingId, generation: ++identityGeneration, baseline: null, submitting: false, photoVersions: new Map()};
    identitySession = session;
    clearError(); state.identityBookingId = bookingId; state.view = "identity";
    try { localStorage.setItem("polyrental-identity-booking", String(bookingId)); } catch (_) {}
    render();
    scrollElementIntoView($("identity-panel"));
    state.consent = null; state.identityNeedsChanges = false; state.identityRequiredPhotos = []; state.identityReusableDocuments = [];
    $("identity-form").reset();
    $("identity-submit").disabled = false; $("identity-submit").textContent = "Отправить на проверку";
    $("identity-form").querySelectorAll("input, textarea").forEach(clearIdentityFieldError);
    document.querySelectorAll('#identity-form .needs-fix').forEach((field) => field.classList.remove("needs-fix"));
    document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => { input.required = false; });
    document.querySelector('[name="residential_address"]').readOnly = false;
    $("identity-status").hidden = true; $("identity-form").hidden = true; $("identity-feedback").hidden = true; $("consent-step").hidden = false;
    $("consent-check").checked = false; $("consent-text").textContent = "Загружаем текст согласия…";
    try {
      const current = await api(`/api/miniapp/bookings/${bookingId}/identity`);
      if (!identitySessionCurrent(session)) return;
      state.identityNeedsChanges = current.status === "needs_changes";
      await restoreIdentityPhotos(session, current.documents || []);
      if (!identitySessionCurrent(session)) return;
      const fields = current.fields || {};
      if (!state.identityNeedsChanges && !Object.values(fields).some((value) => Boolean(value))) {
        const saved = await api(`/api/miniapp/bookings/${bookingId}/identity/reusable-profile`);
        if (!identitySessionCurrent(session)) return;
        if (saved.reusable) {
          Object.assign(fields, saved.fields || {});
          state.identityReusableDocuments = saved.documents || [];
          const feedback = $("identity-feedback");
          feedback.textContent = "После согласия подставим данные и фотографии из предыдущей анкеты. Проверьте их перед отправкой.";
          feedback.hidden = false;
        }
      }
      state.identityLegacyInstitution = !state.universities.includes(fields.student_institution)
        ? (fields.student_institution || null) : null;
      const combined = `${fields.passport_series || ""}${fields.passport_number || ""}`;
      if (combined) fields.passport_combined = `${combined.slice(0, 4)} ${combined.slice(4)}`;
      for (const [name, value] of Object.entries(fields)) {
        const input = $("identity-form").elements.namedItem(name);
        if (input) input.value = formDateNames.has(name) ? displayFormDate(value) : value || "";
      }
      const feedback = $("identity-feedback");
      if (current.status === "needs_changes") {
        state.identityRequiredPhotos = (current.review_fields || []).filter((field) => ["passport_main", "passport_registration", "student_front"].includes(field));
        for (const name of state.identityRequiredPhotos) {
          const input = document.querySelector(`#identity-form [name="${name}"]`);
          const status = input?.closest(".field")?.querySelector(".file-draft-status");
          if (status) status.textContent = "Оператор запросил новое фото — загрузите замену.";
        }
        const labels = { full_name: "ФИО", phone: "телефон для связи", birth_date: "дата рождения", passport_combined: "серия и номер паспорта", passport_issued_at: "дата выдачи", passport_issuer: "кем выдан паспорт", passport_division_code: "код подразделения", registration_address: "адрес регистрации", residential_address: "адрес проживания", student_id_number: "номер студенческого", student_institution: "учебное заведение", passport_main: "фото паспорта", passport_registration: "страница регистрации", student_front: "лицевая сторона студенческого" };
        feedback.innerHTML = `<strong>Нужно исправить:</strong> ${(current.review_fields || []).map((field) => escapeHtml(labels[field] || field)).join(", ") || "проверьте данные по комментарию оператора"}.<br>${escapeHtml(current.review_comment || "")}`;
        feedback.hidden = false; $("consent-step").hidden = true; $("identity-form").hidden = false;
        for (const field of current.review_fields || []) { const input = document.querySelector(`[name="${field}"]`); input?.closest(".field")?.classList.add("needs-fix"); }
        document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => { input.required = false; });
        session.baseline = identityFormSnapshot();
        return;
      }
      const consent = await api("/api/miniapp/privacy-consent");
      if (!identitySessionCurrent(session)) return;
      state.consent = consent;
      $("consent-text").textContent = state.consent.text;
      session.baseline = identityFormSnapshot();
    } catch (error) { if (identitySessionCurrent(session)) { $("consent-text").textContent = "Форма временно недоступна."; showError(error.message); } }
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
    const session = identitySession;
    if (!identitySessionCurrent(session) || session.submitting || $("identity-submit").disabled) return;
    const bookingId = session.bookingId;
    const form = event.currentTarget; const button = $("identity-submit");
    const data = new FormData(form); const fields = {};
    const textFields = ["full_name", "phone", "birth_date", "passport_issued_at", "passport_issuer", "passport_division_code", "registration_address", "residential_address", "student_id_number", "student_institution"];
    for (const name of textFields) {
      const value = String(data.get(name) || ""); fields[name] = name === "student_id_number" ? value : value.trim();
    }
    const labels = { full_name: "ФИО", phone: "телефон для связи", birth_date: "дату рождения", passport_issued_at: "дату выдачи паспорта", passport_issuer: "кем выдан паспорт", passport_division_code: "код подразделения", registration_address: "адрес регистрации", residential_address: "адрес проживания", student_id_number: "номер студенческого", student_institution: "вуз" };
    for (const name of textFields) if (!["student_id_number", "student_institution"].includes(name) && !fields[name]) { showIdentityFieldError(name, `Укажите ${labels[name]}.`); return; }
    for (const name of formDateNames) {
      fields[name] = parseFormDate(fields[name]);
      if (!fields[name]) { showIdentityFieldError(name, `Введите дату в формате ${formDatePlaceholder()}.`); return; }
    }
    if (!/^\+?[0-9](?:[0-9 ()-]*[0-9])?$/.test(fields.phone) || fields.phone.replace(/\D/g, '').length < 10 || fields.phone.replace(/\D/g, '').length > 15) { showIdentityFieldError("phone", "Укажите телефон: от 10 до 15 цифр."); return; }
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
    session.submitting = true;
    button.disabled = true; button.textContent = "Отправляем анкету…";
    try {
      for (const name of ["passport_main", "passport_registration", "student_front"]) {
        const selected = data.get(name); const key = identityPhotoKey(name, bookingId);
        let entry = identityPhotoDrafts.get(key);
        if (!entry) { try { entry = await photoDraftTransaction("readonly", (store) => store.get(key)); } catch (_) { entry = null; } }
        if (!identitySessionCurrent(session)) return;
        const freshFile = selected?.size ? selected : null;
        if (state.identityRequiredPhotos.includes(name) && !freshFile) { const photoError = new Error(`Загрузите новое фото: ${name === "passport_main" ? "паспорт — страница с фото" : name === "passport_registration" ? "паспорт — страница регистрации" : "студенческий — лицевая сторона"}.`); photoError.field = name; throw photoError; }
        const file = freshFile || (entry && Date.now() - entry.savedAt <= photoDraftLifetime ? new File([entry.blob], entry.name, { type: entry.type }) : null);
        if (file?.size) upload.set(name, await jpegFile(file));
        if (!identitySessionCurrent(session)) return;
      }
      const missingPhoto = !state.identityNeedsChanges && ["passport_main", "passport_registration"].find((name) => !upload.get(name));
      if (missingPhoto) { const photoError = new Error(`Добавьте фото: ${missingPhoto === "passport_main" ? "паспорт — страница с фото" : missingPhoto === "passport_registration" ? "паспорт — страница регистрации" : "студенческий — лицевая сторона"}.`); photoError.field = missingPhoto; throw photoError; }
      await api(`/api/miniapp/bookings/${bookingId}/identity`, { method: "POST", body: upload });
      await clearIdentityPhotoDrafts(bookingId);
      if (!identitySessionCurrent(session)) return;
      session.baseline = null; session.submitting = false;
      clearIdentityRestoreKey();
      form.reset();
      void revealNavigation(showOrders, () => $("orders-panel"));
    } catch (error) { if (identitySessionCurrent(session)) showIdentityError(error); }
    finally { session.submitting = false; if (identitySessionCurrent(session)) { button.disabled = false; button.textContent = "Отправить на проверку"; } }
  }

  function updateRentalProgress(summary) {
    const start = Date.parse(summary.dataset.rentalStart), end = Date.parse(summary.dataset.rentalEnd), now = Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    let progress = summary.querySelector(".rental-progress"), overdue = summary.querySelector(".rental-overdue");
    if (now > end && summary.dataset.rentalClosed !== "true") {
      progress?.remove();
      if (!overdue) { overdue = document.createElement("div"); overdue.className = "rental-overdue"; overdue.textContent = "Просрочено"; summary.append(overdue); }
      return;
    }
    overdue?.remove();
    if (!progress) { progress = document.createElement("progress"); progress.className = "rental-progress"; progress.max = 1; progress.setAttribute("aria-label", "Прошедшая часть срока аренды"); summary.append(progress); }
    const value = Math.max(0, Math.min(1, (now - start) / (end - start)));
    progress.value = value;
    progress.style.setProperty("--progress-color", value < .25 ? "#24a65a" : value < .5 ? "#e3bc24" : value < .75 ? "#ed8b24" : "#d83d3d");
  }
  setInterval(() => document.querySelectorAll(".request-summary[data-rental-start]").forEach(updateRentalProgress), 5000);

  function actionButton(label, action, bookingId, className = "secondary", refresh = true) {
    const button = document.createElement("button"); button.type = "button"; button.className = `button compact ${className}`; button.textContent = label;
    button.setAttribute("aria-label",label);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
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
    if (host) {
      host.dataset.reviewSequence = String(Number(host.dataset.reviewSequence || 0) + 1); host.querySelector(".review-loading")?.remove();
      const toggle = host.querySelector('.request-review-button');
      if (toggle) { toggle.textContent = toggle.dataset.closedLabel; toggle.setAttribute('aria-label', toggle.dataset.closedLabel); toggle.setAttribute('aria-expanded', 'false'); }
    }
    if (documentViewerBookingId === Number(card.dataset.bookingId)) closeDocumentViewer();
  }

  function equipmentComparison(before = {}, after = {}) {
    const old = new Map((before.lines || []).map(line => [line.article_id, line]));
    const next = new Map((after.lines || []).map(line => [line.article_id, line]));
    return {lines: [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
      const first = old.get(id)?.quantity || 0, last = next.get(id)?.quantity || 0;
      return first === last ? [] : [{article_id:id, name:next.get(id)?.name || old.get(id)?.name || String(id), before:first, after:last, kind:!first ? "added" : !last ? "removed" : "updated"}];
    }), dates: ["start", "end"].flatMap(field => before[field] && after[field] && new Date(before[field]).getTime() !== new Date(after[field]).getTime() ? [{field, before:before[field], after:after[field]}] : [])};
  }

  function changeDetailsHtml(changes) {
    const dates = (changes.dates || []).map(date => `<p>${date.field === "start" ? "Выдача" : "Возврат"}: ${escapeHtml(dateText(date.before))} → ${escapeHtml(dateText(date.after))} МСК</p>`).join("");
    const lines = (changes.lines || []).map(line => `<div class="request-equipment-row equipment-change-${escapeHtml(line.kind)}"><strong>${escapeHtml(line.name)}</strong><span>${line.kind === "added" ? "Добавлено" : line.kind === "removed" ? "Удалено" : "Количество изменено"}: ${Number(line.before)} → ${Number(line.after)} шт.</span></div>`).join("");
    return dates + `<div class="request-equipment change-details">${lines}</div>` + (!dates && !lines ? "<p>Сроки и состав не менялись.</p>" : "");
  }

  async function loadEquipmentChanges(order, card) {
    try {
      const change = await api(`/api/miniapp/admin/bookings/${order.id}/changes`);
      if (!card.isConnected || !card.querySelector(".request-accordion").open || !change || !["pending", "accepted"].includes(change.status) || change.change_type === "client_fix" && change.status === "pending") return;
      const changes = equipmentComparison(change.before, change.after);
      const equipment = card.querySelector(".request-equipment");
      if (equipment.hidden || equipment.dataset.changeId === String(change.id)) return;
      equipment.dataset.changeId = String(change.id);
      for (const line of changes.lines) {
        let row = equipment.querySelector(`[data-article-id="${line.article_id}"]`);
        if (!row) {
          row = document.createElement("div"); row.className = "request-equipment-row"; row.dataset.articleId = String(line.article_id);
          const main = document.createElement("div"); main.className = "equipment-card-main";
          const thumb = document.createElement("div"); thumb.className = "request-equipment-thumb"; thumb.innerHTML = catalogMedia({name:line.name,category:"generic"}, "request-item");
          const info = document.createElement("div"); info.className = "request-equipment-info";
          const name = document.createElement("span"); name.className = "request-equipment-title"; name.textContent = line.name;
          const quantity = document.createElement("span"); quantity.className = "request-equipment-quantity"; quantity.textContent = String(line.after || line.before);
          info.append(name, quantity); main.append(thumb, info); row.append(main); equipment.append(row);
          equipment.querySelector(".request-equipment-empty").hidden = true;
        }
        row.classList.add(`equipment-change-${line.kind}`);
        row.tabIndex = 0; row.setAttribute("role", "button");
        const label = line.kind === "added" ? "Добавлено" : line.kind === "removed" ? "Удалено" : "Изменено";
        row.setAttribute("aria-label", `${line.name}: ${label.toLocaleLowerCase("ru-RU")}. Посмотреть изменения`);
        row.title = `${label}. Нажмите, чтобы посмотреть изменения`;
        const marker = document.createElement("span"); marker.className = "equipment-change-marker"; marker.textContent = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "↔"; marker.setAttribute("aria-hidden", "true"); row.append(marker);
        const open = event => {
          if (event.target.closest("button, .catalog-photo-target")) return;
          if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
          event.preventDefault(); event.stopImmediatePropagation();
          void workflowDialog(change.status === "pending" ? "Предложенное изменение" : "Изменение товара", changeDetailsHtml({lines:[line], dates:[]}), "Закрыть");
        };
        row.addEventListener("click", open, true); row.addEventListener("keydown", open, true);
      }
      if (changes.dates.length) {
        const period = card.querySelector(".rental-period"); period.classList.add("equipment-change-updated");
        period.tabIndex = 0; period.setAttribute("role", "button"); period.setAttribute("aria-label", "Сроки изменены. Посмотреть изменения");
        const open = event => { if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return; event.preventDefault(); void workflowDialog("Изменение сроков", changeDetailsHtml({lines:[], dates:changes.dates}), "Закрыть"); };
        period.addEventListener("click", open); period.addEventListener("keydown", open);
      }
    } catch (_) { /* History remains available with a retry if the comparison cannot load. */ }
  }

  async function loadRequestHistory(order, card, page = 0) {
    const history = card.querySelector(".request-history"); const body = history.querySelector(".request-history-body");
    const sequence = String(Number(history.dataset.sequence || 0) + 1); history.dataset.sequence = sequence;
    body.setAttribute("aria-busy", "true");
    showLoading(body, "Загружаем историю…");
    try {
      const result = await api(`/api/miniapp/admin/bookings/${order.id}/history?page=${page}&page_size=20`);
      if (!card.isConnected || !card.querySelector(".request-accordion").open || history.dataset.sequence !== sequence) return;
      body.replaceChildren();
      const names = { operator_return_confirmed: "Сотрудник подтвердил фактический возврат", customer_change_requested: "Клиент запросил изменения", customer_change_approved: "Запрос клиента на изменения одобрен", customer_change_rejected: "Запрос клиента на изменения отклонён", pending: "Заявка возвращена на проверку", subject_request: "Данные удалены по запросу клиента", delete_failed: "Не удалось удалить", customer_received: "Клиент подтвердил получение", customer_returning: "Клиент подтвердил сдачу", paper_issue_signed: "Бумажная подпись при выдаче отмечена", paper_return_signed: "Бумажная подпись при возврате отмечена", assignee_cleared: "Закрепление снято", request_changes_proposed: "Предложены изменения заявки", request_changes_disputed: "Клиент оспорил изменения", request_changes_unanswered: "Клиент не ответил на изменения", request_updated: "Заявка изменена", request_force_edited: "Сотрудник применил изменения заявки", request_rejected: "Заявка отклонена", returned_for_rework: "Заявка возвращена на доработку", return_finding_existing: "Отмечена прежняя особенность", return_finding_damage: "Зафиксировано повреждение", return_finding_lost: "Зафиксирована утеря", legacy_receipt_migrated: "Подготовлена расписка старой выдачи", test_hidden: "Тестовая заявка скрыта", test_unhidden: "Тестовая заявка возвращена", test_flag_on: "Заявка отмечена как тестовая", test_flag_off: "Тестовая отметка снята", support_created: "Создано обращение", support_reopened: "Обращение открыто повторно", support_claimed: "Обращение взято в работу", support_resolved: "Обращение закрыто", support_client_message: "Получено сообщение клиента", support_operator_reply: "Подготовлен ответ оператора", support_routed_to_assignee: "Обращение передано владельцу заявки", created: "Заявка создана", confirmed: "Заявка подтверждена", preparing: "Начата подготовка", ready: "Готово к выдаче", issued: "Оборудование выдано", return_inspection: "Начата проверка возврата", returned: "Возврат завершён", cancelled: "Заявка отменена", expired: "Заявка истекла", submitted: "Анкета отправлена", verified: "Анкета одобрена", changes_requested: "Запрошены исправления анкеты", act_signed: "Отмечено подписание акта", contact_updated: "Контакт обновлён", repair_closed: "Ремонт закрыт", blocked: "Анкета заблокирована", unblocked: "Анкета разблокирована", manual_delete: "Анкета удалена", retention_purge: "Анкета удалена по сроку хранения" };
      if (!result.items?.length) { body.textContent = "Записей пока нет."; return; }
      const list = document.createElement("ol"); list.className = "request-history-list";
      for (const event of result.items) {
        const item = document.createElement("li"); const label = document.createElement("strong"); const meta = document.createElement("span");
        label.textContent = names[event.action] || (event.action.startsWith("support_owner:") ? `Обращение передано: ${event.target_name || "Сотрудник"}` : event.action.startsWith("assignee:") ? `Назначен ответственный: ${event.target_name || "Сотрудник"}` : event.action.startsWith("asset_deleted:") ? `Экземпляр ${event.action.split(":")[1]} удалён` : event.action.startsWith("asset_restored:") ? `Экземпляр ${event.action.split(":")[1]} восстановлен` : event.action.startsWith("line_deleted:") ? `Позиция ${event.action.split(":")[1]} удалена` : event.action.startsWith("line_restored:") ? `Позиция ${event.action.split(":")[1]} восстановлена` : event.action.startsWith("sla_") ? "Уведомление о сроке обработки" : event.action.includes("_delete_intent") ? "Запрошено удаление" : event.action.includes("_delete_undo") ? "Удаление отменено" : event.action === "request_deleted" ? "Заявка удалена" : event.action === "request_restored" ? "Заявка восстановлена" : "Служебное действие");
        meta.textContent = `${dateText(event.created_at)} МСК, ${event.actor_name || (event.actor_id ? "Пользователь" : "Система")}`;
        item.append(label, meta);
        if (event.changes || event.changes_unavailable) {
          const details = plainButton("Что изменилось", () => workflowDialog("Изменения заявки", event.changes ? changeDetailsHtml(event.changes) : "<p>Для этого старого изменения подробности не сохранились.</p>", "Закрыть"), "ghost compact");
          item.append(details);
        }
        list.append(item);
      }
      body.append(list);
      const pages = Math.max(1, Math.ceil((result.total ?? result.items.length) / (result.page_size || 20)));
      if (pages > 1) {
        const controls = document.createElement("div"); controls.className = "action-row";
        const previous = plainButton("Назад", () => loadRequestHistory(order, card, page - 1), "secondary"); previous.disabled = page === 0;
        const current = document.createElement("span"); current.textContent = `${page + 1} / ${pages}`;
        const next = plainButton("Далее", () => loadRequestHistory(order, card, page + 1), "secondary"); next.disabled = page + 1 >= pages;
        controls.append(previous, current, next); body.append(controls);
      }
    } catch (_) {
      if (card.isConnected && history.dataset.sequence === sequence) {
        body.textContent = "История временно недоступна. ";
        body.append(actionButton("Повторить", () => loadRequestHistory(order, card, page), order.id, "ghost lock-exempt", false));
      }
    } finally {
      if (history.dataset.sequence === sequence) body.removeAttribute("aria-busy");
    }
  }

  function updateRequestLease(order, card) {
    const lease = order.operation_lease_state || order.operation_lease;
    const activeStage = ["pending", "confirmed", "preparing", "ready", "issued", "return_inspection"].includes(order.status);
    const ownership = card.querySelector(".stage-lock");
    ownership.hidden = order.status === "needs_changes";
    ownership.classList.toggle("stage-lock-complete", !activeStage && order.status !== "needs_changes");
    if (!activeStage) ownership.classList.remove("stage-lock-expired");
    if (order.status === "needs_changes") return;
    if (!activeStage) { ownership.textContent = "Этап завершён. Закрепление не требуется."; return; }
    const expired = lease && (lease.expired || new Date(lease.expires_at).getTime() <= Date.now());
    const mine = lease?.actor_id === state.role?.id;
    const hardStage=["preparing","ready","issued","return_inspection"].includes(order.status)&&order.assignee_id;
    const otherOwner=hardStage&&order.assignee_id!==state.role?.id;
    ownership.hidden = !lease && !otherOwner;
    ownership.classList.toggle("stage-lock-expired", Boolean(expired));
    ownership.textContent = !lease ? (order.assignee_id === state.role?.id ? "Закреплено за вами" : order.assignee_id ? "Закреплено за сотрудником" : "Ожидает сотрудника")
      : expired ? `Закрепление истекло: ${lease.actor_name || "Сотрудник"}, до ${dateText(lease.expires_at)} МСК. Этап доступен для обработки.`
      : `${mine ? "Вы обрабатываете" : "Обрабатывает"}: ${lease.actor_name || "Сотрудник"}. Закрепление до ${dateText(lease.expires_at)} МСК.`;
    if (hardStage) ownership.textContent=`${otherOwner?"Закреплено за сотрудником":"Закреплено за вами"}. ${lease ? (expired?"Мягкая блокировка истекла.":ownership.textContent) : ""}`;
    for (const button of card.querySelectorAll(".request-actions :is(button:not(.document-button):not(.lock-exempt), .next-step-component input)")) {
      if ((otherOwner && !button.classList.contains("handover-action")) || (lease && !expired && !mine)) {
        if (!button.dataset.lockBlocked) button.dataset.lockWasDisabled = String(button.disabled);
        button.dataset.lockBlocked = "true"; button.disabled = true;
      } else if (button.dataset.lockBlocked) {
        button.disabled = button.dataset.lockWasDisabled === "true" || button.dataset.actionPending === "true"; delete button.dataset.lockBlocked; delete button.dataset.lockWasDisabled;
      }
    }
  }

  function adminBookingsPath() {
    const params = new URLSearchParams({page:String(state.adminPage), status:state.adminStatus, sort:state.adminSort, scope:state.adminRequestFilter, queue:state.adminQueue});
    if (state.adminTargetId) params.set("booking_id", String(state.adminTargetId));
    return `/api/miniapp/admin/bookings?${params}`;
  }

  let adminTabAnimations = [];
  let desiredAdminSection = null, savedAdminSection = null, savingAdminSection = false;
  async function rememberAdminSection(mode) {
    desiredAdminSection = mode;
    if (savingAdminSection || savedAdminSection === mode) return;
    savingAdminSection = true;
    try {
      while (desiredAdminSection !== savedAdminSection) {
        const section = desiredAdminSection;
        await api("/api/miniapp/operator/last-section", {method:"PUT", body:JSON.stringify({section})});
        savedAdminSection = section;
      }
    } catch (_) { /* A later visit can retry saving the preference. */ }
    finally { savingAdminSection = false; }
  }
  async function showAdmin(mode = "orders", prefetched = null) {
    if (bookingSubmitting) return;
    if (!guardStaffNavigation() || !guardIdentityNavigation()) return;
    const changingAdminTab = state.view === "admin" && state.adminMode !== mode;
    const adminOrder = ['orders','catalog','repairs','support'];
    const adminDirection = adminOrder.indexOf(mode) < adminOrder.indexOf(state.adminMode) ? -1 : 1;
    adminTabAnimations.forEach(animation => animation.cancel()); adminTabAnimations = [];
    if (changingAdminTab) window.PolyRentalMotion?.cancelTransient();
    const returningToOrders = state.view !== "admin" && state.adminMode === "orders" && mode === "orders";
    $("admin-panel").classList.remove("catalog-editing");
    $("admin-settings-open").hidden = Boolean(state.role?.pii_only);
    if (state.role?.pii_only) {mode = "orders";document.querySelectorAll("#admin-panel .calendar-sync").forEach(node=>node.hidden=true);}
    document.querySelectorAll(".admin-tabs .admin-mode").forEach((button) => { if (state.role?.pii_only && button.dataset.mode !== "orders") button.hidden = true; });
    if (state.role?.staff_role === "admin" && !$("staff-settings-button")) {
      const settings = plainButton("Сотрудники", async () => {
        const result = await api("/api/miniapp/admin/staff");
        if (!result.items?.length) throw new Error("Нет сотрудников для настройки. Обратитесь к администратору.");
        const data = await workflowDialog("Сотрудники", `<label class="field"><span>Сотрудник</span><select name="staff">${result.items.map((item) => `<option value="${item.telegram_id}">${escapeHtml(item.name || item.full_name || "Сотрудник")}</option>`).join("")}</select></label><label class="field"><span>Роль</span><select name="role"><option value="operator">Оператор</option><option value="manager">Менеджер</option><option value="admin">Администратор</option></select></label><p class="workflow-hint">Доступ к персональным данным назначается отдельно.</p>`, "Сохранить", (dialog) => {
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
      }); settings.id="staff-settings-button"; $("settings-staff").append(settings);
    }
    const sequence = ++adminRenderSequence;
    const anchoredRequestId = selectedRequestId;
    const previousCard = document.querySelector(`.request-card[data-booking-id="${selectedRequestId}"]`);
    const previousTop = previousCard?.querySelector(".request-toggle")?.getBoundingClientRect().top;
    const focused = previousCard?.contains(document.activeElement) ? document.activeElement.textContent : null;
    if (leaseRefreshTimer) clearInterval(leaseRefreshTimer);
    closeDocumentViewer();
    clearError(); state.view = "admin"; state.adminMode = mode;
    if (siteNavigation) $("admin-panel").querySelector(".admin-section-anchor").id = `management-${mode}`;
    if (mode !== "catalog") $("admin-content").classList.remove("catalog-category-screen");
    $("catalog-import-open").hidden = mode !== "catalog" || !["manager", "admin"].includes(state.role?.staff_role);
    $("admin-order-controls").hidden = mode !== "orders"; $("admin-queues").hidden = mode !== "orders"; $("admin-request-filter-field").hidden = mode !== "orders";
    $("admin-status-field").hidden = mode !== "orders"; $("admin-sort-field").hidden = mode !== "orders"; $("admin-pagination").hidden = true; $("admin-clear-target").hidden = mode !== "orders" || !state.adminTargetId;
    if (state.role?.id) { try { localStorage.setItem(`polyrental-admin-tab:${state.role.id}`, mode); } catch (_) {} }
    if (state.role?.staff_role) void rememberAdminSection(mode);
    render();
    document.querySelectorAll(".admin-mode").forEach(control => {
      const active = control.dataset.mode === mode;
      control.className = `button ${active ? "secondary" : "ghost"} admin-mode`;
      if (control.matches("a")) control.setAttribute("aria-current", active ? "page" : "false");
      else control.setAttribute("aria-pressed", String(active));
    });
    const content = $("admin-content");
    const previousScrollY = window.scrollY;
    const since = viewportFocus?.checkpoint();
    content.style.minHeight = mode === "orders" && previousCard ? `${content.offsetHeight}px` : "";
    content.querySelectorAll(".request-card").forEach(clearRequestReview);
    if (!content.querySelector(".request-card") || mode !== "orders") {
      showLoading(content, ({orders:"Загружаем заказы…", catalog:"Загружаем каталог…", repairs:"Загружаем ремонт…", support:"Загружаем обращения…"})[mode]);
    }
    if (changingAdminTab && !reducedMotion?.matches) for (const element of [content]) {
      const frames = desktopMotion.matches ? [{opacity:.84}, {opacity:1}]
        : [{transform:`translateX(${-adminDirection * 36}px)`,opacity:.75},{transform:'translateX(0)',opacity:1}];
      adminTabAnimations.push(element.animate(frames,{duration:desktopMotion.matches ? 160 : 300,easing:'cubic-bezier(.22,1,.36,1)'}));
    }
    try {
      if (mode === "support") {
        const result = await api(`/api/miniapp/admin/support?page=${state.supportPage}&page_size=20${state.supportFilterId ? `&thread_id=${state.supportFilterId}` : ""}`);
        if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
        return renderSupportThreads(result);
      }
      if (mode === "catalog" || mode === "repairs") {
        const result = await api(mode === "catalog" ? catalogPagePath() : "/api/miniapp/admin/repairs");
        if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
        if (mode === "catalog" && result.page != null && catalogView.page > 0 && catalogView.page * (result.page_size || 20) >= result.total) { catalogView.page = Math.max(0, Math.ceil(result.total / (result.page_size || 20)) - 1); return showAdmin("catalog"); }
        return mode === "catalog" ? renderAdminCatalog(result) : renderRepairs(result);
      }
      const ordersPath = adminBookingsPath();
      const result = prefetched ?? await api(ordersPath);
      if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
      const ordersData = JSON.stringify(result);
      if (returningToOrders && !pendingDeletion && content.querySelector(".request-card") && ordersPath === renderedAdminOrdersPath && ordersData === renderedAdminOrdersData) {
        content.style.minHeight = "";
        leaseRefreshTimer = setInterval(() => {
          if (state.view !== "admin" || state.adminMode !== "orders") { clearInterval(leaseRefreshTimer); return; }
          content.querySelectorAll(".request-card").forEach(card => updateRequestLease(card.requestOrder, card));
        }, 1000);
        return;
      }
      renderedAdminOrdersPath = ordersPath; renderedAdminOrdersData = ordersData;
      adminOrdersSnapshot = workflowSnapshot(result);
      const queues = $("admin-queues"); queues.hidden = !result.queues;
      if (result.queues) {
        const select = $("admin-queue");
        select.replaceChildren(...[["all", "Все заявки"], ["review", "Нужна проверка"], ["handover", "К выдаче"], ["return", "К возврату"]].map(([key, label]) => {
          const option = document.createElement("option"); option.value = key; option.textContent = key === "all" ? label : `${label} (${result.queues[key]})`; return option;
        }));
        select.value = state.adminQueue;
      }
      const pages = Math.max(1, Math.ceil((result.total ?? result.items.length) / (result.page_size || 20)));
      if (state.adminPage >= pages) { state.adminPage = pages - 1; return showAdmin("orders"); }
      $("admin-pagination").hidden = pages <= 1;
      $("admin-prev").disabled = state.adminPage === 0; $("admin-next").disabled = state.adminPage >= pages - 1;
      $("admin-page").textContent = `${state.adminPage + 1} / ${pages}`;
      content.replaceChildren();
      if (!result.items.length) { content.textContent = "Заказов пока нет."; enterWorkspace(content); return; }
      deleteUndoSeconds = Number.isInteger(result.undo_seconds) ? Math.max(1, Math.min(30, result.undo_seconds)) : 5;
      const visibleOrders = result.items.filter((order) => {
        const filter = state.adminRequestFilter;
        return filter === "all" || (filter === "mine" && order.assignee_id === state.role?.id) || (filter === "unassigned" && !order.assignee_id && order.sla?.stage !== "closed") || (filter === "overdue" && order.sla?.breached) || (filter === "soon" && order.sla?.soon && !order.sla?.breached);
      });
      if (!visibleOrders.length) { content.textContent = "Нет заявок для выбранного фильтра."; enterWorkspace(content); return; }
      for (const order of visibleOrders) {
        if (pendingDeletion?.bookingId === order.id && !pendingDeletion.lineId && !pendingDeletion.assetId) continue;
        const card = document.createElement("article"); card.className = "admin-card request-card"; card.dataset.bookingId = String(order.id);
        const accordion = document.createElement("details"); accordion.className = "request-accordion";
        const toggle = document.createElement("summary"); toggle.className = "request-toggle";
        toggle.innerHTML = `<span class="order-head"><strong>№ ${escapeHtml(order.human_number || String(order.id))}</strong><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(statusNames[order.status] || order.status)}</span></span><span class="request-client">${escapeHtml(order.customer_name)}</span><span class="request-period">${escapeHtml(`${shortRequestDateTime(order.starts_at)} — ${shortRequestDateTime(order.ends_at)} МСК`)}</span>`;
        const owner = document.createElement("span"); owner.className = "request-assignee";
        owner.textContent = order.assignee_id ? (order.assignee_id === state.role?.id ? "Ответственный: вы" : `Ответственный: ${order.assignee_name || "Сотрудник"}`) : "Ответственный не назначен";
        toggle.append(owner);
        if (order.return_overdue || order.return_risk) {
          const warning = document.createElement("span"); warning.className = "notice";
          warning.textContent = order.return_overdue ? "Возврат просрочен" : "Риск срыва выдачи. Проверьте комплект.";
          toggle.append(warning);
        }
        const body = document.createElement("div"); body.className = "request-body";
        appendRentalPurpose(body, order);
        const hasInspectionCards = ["preparing", "return_inspection"].includes(order.status) && order.assets?.length > 0;
        const summary = reviewSection("Период аренды", "request-summary");
        if (order.actionable_count) { const count = document.createElement("p"); count.textContent = `Требуют действия: ${order.actionable_count}`; summary.append(count); }
        const period = document.createElement("div"); period.className = "rental-period";
        period.innerHTML = `<span>${escapeHtml(dateText(order.starts_at))}</span><span>${escapeHtml(dateText(order.ends_at))}</span>`;
        summary.append(period);
        summary.dataset.rentalStart = order.starts_at; summary.dataset.rentalEnd = order.ends_at;
        summary.dataset.rentalClosed = String(["returned", "cancelled", "expired"].includes(order.status));
        updateRentalProgress(summary);
        const equipment = document.createElement("div"); equipment.className = "request-equipment";
        for (const line of order.lines) {
          if (pendingDeletion?.bookingId === order.id && pendingDeletion.lineId === line.id) continue;
          const row = document.createElement("div"); row.className = "request-equipment-row"; row.dataset.lineId = String(line.id); row.dataset.articleId = String(line.article_id);
          const article = order.article_media?.[line.article_id] || state.items.find((item) => item.id === line.article_id);
          const mediaItem = {
            name: line.title || line.name || article?.name || "",
            category: line.category || article?.category || (/объектив|lens/i.test(line.name || "") ? "optics" : /камера|camera|fx/i.test(line.name || "") ? "camera" : "generic"),
            image_url: line.image_url || article?.image_url,
            image_data: line.image_data || article?.image_data,
          };
          const thumb = document.createElement("div"); thumb.className = "request-equipment-thumb";
          thumb.innerHTML = catalogMedia(mediaItem, "request-item");
          const info = document.createElement("div"); info.className = "request-equipment-info";
          const label = document.createElement("span"); label.className = "request-equipment-title"; label.textContent = `${line.title || line.name}`; const qty = document.createElement("span"); qty.className = "request-equipment-quantity"; qty.textContent = String(line.quantity); qty.setAttribute("aria-label", `Количество: ${line.quantity}`); info.append(label, qty);
          const lineAssets = (order.assets || []).filter((asset) => !(pendingDeletion?.bookingId === order.id && pendingDeletion.assetId === asset.id) && (asset.line_id === line.id || (!asset.line_id && asset.article_id === line.article_id)));
          const assetSummary = lineAssets.map((asset) => `№ ${asset.asset_code || asset.serial}${asset.location ? ` (${asset.location})` : ""}`).join(", ");
          const fullName = line.title && line.title !== line.name ? line.name : "";
          const extraDescription = line.description || article?.description || "";
          const mainBar = document.createElement("div"); mainBar.className = "equipment-card-main";
          mainBar.append(thumb, info);
          if (order.status === "pending") {
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact request-equipment-remove";
            remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg>'; remove.title = `Удалить позицию ${line.title || line.name}`; remove.setAttribute("aria-label", `Удалить позицию ${line.title || line.name}`);
            remove.addEventListener("click", (event) => { event.stopPropagation(); beginRequestDeletion(order, row, line.id); }); mainBar.append(remove);
          }
          row.append(mainBar);
          bindEquipmentPreview(row, mainBar, {...mediaItem, title: line.title || article?.title, description: extraDescription},
            {keyboard: !(fullName || extraDescription || assetSummary)});
          if (fullName || extraDescription || assetSummary) {
            row.classList.add("is-expandable");
            row.tabIndex = 0;
            row.setAttribute("aria-expanded", "false");
            const drawer = document.createElement("div"); drawer.className = "equipment-card-drawer";
            const drawerInner = document.createElement("div"); drawerInner.className = "equipment-card-drawer-inner";
            if (fullName) { const full = document.createElement("small"); full.className = "request-equipment-full"; full.textContent = fullName; drawerInner.append(full); }
            if (extraDescription && extraDescription !== fullName) { const desc = document.createElement("small"); desc.className = "request-equipment-desc"; desc.textContent = extraDescription; drawerInner.append(desc); }
            if (assetSummary) { const meta = document.createElement("small"); meta.className = "inspection-unit-meta"; meta.textContent = assetSummary; drawerInner.append(meta); }
            drawer.append(drawerInner);
            row.append(drawer);
            bindEquipmentDisclosure(row, drawer);
          }
          equipment.append(row);
        }
        const emptyEquipment = document.createElement("p"); emptyEquipment.className = "request-equipment-empty"; emptyEquipment.textContent = "В заявке пока нет оборудования.";
        emptyEquipment.hidden = Boolean(equipment.querySelector(".request-equipment-row")); equipment.append(emptyEquipment);
        equipment.hidden = hasInspectionCards;
        const equipmentSection = document.createElement("details"); equipmentSection.className = "request-section request-equipment-section"; equipmentSection.open = true;
        const equipmentHeading = document.createElement("summary"); equipmentHeading.textContent = `Техника (${equipment.querySelectorAll('.request-equipment-row').length} поз.)`; equipmentSection.append(equipmentHeading, equipment);
        const equipmentRows = [...equipment.querySelectorAll('.request-equipment-row')];
        if (equipmentRows.length > 5) {
          const more = document.createElement('button'); more.type = 'button'; more.className = 'request-equipment-more'; more.setAttribute('aria-expanded', 'false');
          const updateEquipmentVisibility = expanded => { equipmentRows.forEach((row, index) => { row.hidden = index >= 5 && !expanded; }); more.setAttribute('aria-expanded', String(expanded)); more.textContent = expanded ? 'Свернуть список ▴' : `Показать ещё ${equipmentRows.length - 5} ▾`; };
          more.addEventListener('click', () => {
            const expanded = more.getAttribute('aria-expanded') !== 'true';
            updateEquipmentVisibility(expanded);
            if (expanded) scrollElementIntoView(equipmentSection);
          });
          updateEquipmentVisibility(false); equipmentSection.append(more);
        }
        if (hasInspectionCards) equipmentSection.hidden = true;
        const formHost = document.createElement('section'); formHost.className = 'request-section request-form-host';
        const formDetails = document.createElement('details'); formDetails.className = 'request-form-details';
        const formHeading = document.createElement('summary'); formHeading.textContent = 'Анкета клиента'; formDetails.append(formHeading);
        const formStatus = document.createElement('span'); formStatus.className = 'request-form-status'; formStatus.textContent = identityStatusNames[order.identity_status] || 'Не заполнена';
        formStatus.classList.add(order.identity_status === 'verified' ? 'identity-verified' : 'identity-unverified');
        const formSection = document.createElement('section'); formSection.className = 'request-section request-form-section';
        formSection.hidden = order.status === 'cancelled' && order.identity_status === 'not_required';
        formHeading.append(formStatus);
        formDetails.append(labelledValues([["Имя в заявке", order.customer_name], ["Контакт", order.customer_contact]]));
        if (!state.role?.pii_admin) {
          const formHint = document.createElement("p");
          formHint.textContent = "Документы и решение по анкете доступны администратору ПД.";
          formDetails.append(formHint);
        }
        formHost.append(formDetails);
        const actions = document.createElement("div"); actions.className = "action-row";
        const ownership = document.createElement("p"); ownership.className = "stage-lock"; ownership.setAttribute("role", "status");
        const nextStep = document.createElement("p"); nextStep.className = "request-next-step";
        nextStep.textContent = ({pending: "Следующий шаг: подтвердить заявку.", needs_changes: "Ждём ответа клиента.", confirmed: "Следующий шаг: проверить анкету и начать подготовку.", preparing: "Следующий шаг: проверить экземпляры и подтвердить готовность.", ready: "Оформите выдачу оборудования клиенту.", issued: "Ждём подтверждение получения и возврата оборудования клиентом.", return_inspection: "Проверьте возвращённое оборудование и завершите заявку.", returned: "Заявка завершена"})[order.status] || "Обработка заявки завершена.";
        if (order.status === "confirmed" && order.identity_status !== "verified") {
          nextStep.textContent = order.identity_status === "submitted"
            ? (state.role?.pii_admin ? "Следующий шаг: проверьте анкету клиента." : "Ждём проверку анкеты сотрудником с доступом к персональным данным.")
            : (order.identity_status === "needs_changes" ? "Ждём исправленную анкету клиента." : "Ждём заполненную анкету клиента.");
        }

        const nextOverview = document.createElement("section"); nextOverview.className = "request-next-overview request-actions";
        const nextHead = document.createElement("div"); nextHead.className = "request-next-head";
        const terminal = ["returned", "cancelled", "expired"].includes(order.status);
        const nextHeading = document.createElement("h4");
        nextHeading.textContent = terminal ? "Обработка заявки" : "Следующий шаг";
        nextStep.textContent = nextStep.textContent.replace(/^Следующий шаг:\s*/i, '');
        if (order.status === 'pending') nextStep.textContent = 'Проверьте заявку';
        if (order.status === 'confirmed' && order.identity_status === 'verified') nextStep.textContent = 'Начните подготовку';
        if (order.status === 'preparing') nextStep.textContent = 'Проверьте экземпляры';
        if (order.status === 'confirmed' && !['submitted', 'verified', 'needs_changes'].includes(order.identity_status)) nextStep.textContent = 'Ожидаем анкету';
        nextStep.textContent = nextStep.textContent.replace(/\.+\s*$/, '').replace(/^\p{Ll}/u, letter => letter.toLocaleUpperCase('ru-RU'));
        const pickupStep = ['preparing', 'ready'].includes(order.status) && !state.role?.pii_only;
        nextHead.append(...(pickupStep ? [ownership] : [nextHeading, ownership]));
        nextOverview.append(nextHead);
        if (pickupStep) nextOverview.append(staffPickupStep(order, transition => transitionAction(transition)(), card));
        else if (!terminal) nextOverview.append(nextStep);
        appendHandoverProgress(nextOverview, order, true);
        body.append(nextOverview, summary, equipmentSection, formSection); formSection.append(formHost); accordion.append(toggle, body); card.append(accordion);
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
        if (order.status === 'issued' || (order.status === 'return_inspection' && !order.handover?.operator_return)) {
          nextStep.textContent = 'Подтвердите получение, когда оборудование будет у вас';
          actions.append(actionButton('Подтвердить получение оборудования', async () => {
            await workflowDialog('Получение оборудования', '<p>Подтвердите, что оборудование уже у вас.</p>', 'Подтвердить получение', null,
              async () => api(`/api/miniapp/admin/bookings/${order.id}/return-without-customer`, {method:'POST'}));
          }, order.id, 'primary workflow-next'));
        }
        if (order.status === "confirmed") {
          if (order.customer_change_request?.status === "pending") { const note = document.createElement("p"); note.className="notice"; note.textContent="Клиент запросил изменения. Рассмотрите запрос до начала подготовки."; actions.append(note); }
          else if (order.identity_status === "verified") actions.append(actionButton("Начать подготовку", transitionAction("preparing"), order.id, "primary workflow-next"));
          else { const note = document.createElement("p"); note.className = "workflow-hint"; note.textContent = state.role?.pii_admin ? "После заполнения проверьте документы." : "После заполнения документы проверит ответственный сотрудник."; actions.append(note); }
        }
        if (state.role?.pii_admin && ["submitted", "needs_changes", "verified"].includes(order.identity_status)) {
          const label = order.identity_status === 'verified' ? "Посмотреть анкету" : "Проверить анкету";
          const reviewToggle = actionButton(label, () => {
            if (formHost.querySelector('.identity-check-review, .review-loading')) {
              clearRequestReview(card); reviewToggle.disabled = false; reviewToggle.focus({preventScroll:true});
            }
            else return reviewIdentity(order, card);
          }, order.id, "primary workflow-next lock-exempt request-review-button", false);
          reviewToggle.dataset.closedLabel = label; reviewToggle.setAttribute('aria-expanded', 'false');
          formHost.append(reviewToggle);
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
        if (!state.role?.pii_only && ["pending", "cancelled", "expired"].includes(order.status)) {
          const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact";
          remove.textContent = "Удалить заявку"; remove.title = "Удалить заявку"; remove.setAttribute("aria-label", `Удалить заявку ${order.human_number || ""}`);
          remove.addEventListener("click", () => beginRequestDeletion(order, card));
          actions.append(remove);
        }
        const primaryActions = document.createElement("div"); primaryActions.className = "action-row request-primary-actions";
        const secondaryGrid = document.createElement("div"); secondaryGrid.className = "request-secondary-grid";
        const dangerZone = document.createElement("div"); dangerZone.className = "request-danger-zone";
        for (const node of [...actions.childNodes]) {
          if (node.nodeType === 1 && node.tagName === "BUTTON") {
            if (node.hidden) continue;
            if (node.classList.contains("workflow-next") || node.classList.contains("primary")) primaryActions.append(node);
            else if (node.classList.contains("danger")) dangerZone.append(node);
            else secondaryGrid.append(node);
          } else {
            primaryActions.append(node);
          }
        }
        if (primaryActions.childNodes.length) nextOverview.append(primaryActions);
        if (secondaryGrid.childNodes.length || dangerZone.childNodes.length) {
          const moreActions = document.createElement("details"); moreActions.className = "request-more-actions";
          const moreSummary = document.createElement("summary"); moreSummary.textContent = "Действия с заявкой";
          const moreBody = document.createElement("div"); moreBody.className = "request-more-body";
          if (secondaryGrid.childNodes.length) moreBody.append(secondaryGrid);
          if (dangerZone.childNodes.length) moreBody.append(dangerZone);
          moreActions.append(moreSummary, moreBody);
          nextOverview.append(moreActions);
        }
        updateRequestLease(order, card);
        card.requestOrder = order;
        const history = document.createElement("details"); history.className="request-section request-history";
        const historyTitle=document.createElement("summary"); historyTitle.textContent="История действий"; history.append(historyTitle);
        const historyBody = document.createElement("div"); historyBody.className = "request-history-body"; history.append(historyBody);
        body.append(history);
        const setOpen = (open, focus = false) => {
          setDisclosureOpen(accordion, open, focus);
          if (open) { selectedRequestId = order.id; loadRequestHistory(order, card); void loadEquipmentChanges(order, card); }
          else { clearRequestReview(card); history.dataset.sequence = String(Number(history.dataset.sequence || 0) + 1); if (selectedRequestId === order.id) selectedRequestId = null; }
        };
        toggle.addEventListener("click", (event) => {
          event.preventDefault(); content.style.minHeight = ""; const top = toggle.getBoundingClientRect().top; const opening = !disclosureIsOpen(accordion);
          if (opening) for (const other of content.querySelectorAll(".request-card")) {
            if (other === card) continue;
            setDisclosureOpen(other.querySelector(".request-accordion"), false); clearRequestReview(other);
          }
          setOpen(opening, opening); window.scrollBy(0, toggle.getBoundingClientRect().top - top);
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
      if (anchoredRequestId === selectedRequestId && previousTop != null && selectedToggle && since === viewportFocus?.checkpoint()) {
        const targetScrollY = window.scrollY + selectedToggle.getBoundingClientRect().top - previousTop;
        content.style.minHeight = "";
        const shortfall = previousScrollY + window.innerHeight - document.documentElement.scrollHeight;
        if (shortfall > 0) content.style.minHeight = `${content.offsetHeight + shortfall}px`;
        window.scrollTo(0, targetScrollY);
      } else { content.style.minHeight = ""; }
      if (anchoredRequestId === selectedRequestId && focused && selectedCard) ([...selectedCard.querySelectorAll("button, summary")].find((node) => node.textContent === focused) || selectedToggle)?.focus({ preventScroll: true });
      if (!changingAdminTab && !selectedCard) enterWorkspace(content);
    } catch (error) {
      if (sequence !== adminRenderSequence || state.view !== "admin" || state.adminMode !== mode) return;
      content.textContent = "Не удалось загрузить раздел. "; content.append(plainButton("Повторить", () => showAdmin(mode), "secondary")); showError(error.message);
    }
  }

  function inspectionFor(order, asset, stage) {
    return (order.inspections || []).find((item) => item.equipment_id === asset.id && item.stage === stage);
  }

  const pickupIcons = {
    wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    clipboard: '<path d="M9 5H6a1 1 0 0 0-1 1v14h14V6a1 1 0 0 0-1-1h-3M9 14l2 2 4-5"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
    done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    arrow: '<path d="m6 9 6 6 6-6"/>',
    partial: '<path d="M6 12h12"/>',
    remove: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
  };
  const pickupOpenRows = new Set();

  function pickupIcon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${Object.hasOwn(pickupIcons, name) ? pickupIcons[name] : `<use href="#icon-${escapeHtml(name)}"></use>`}</svg>`;
  }

  function pickupEquipmentIcon(item) {
    const category = item.category || (/объектив|lens/i.test(item.name) ? 'optics' : /камер|camera|fx/i.test(item.name) ? 'camera' : 'generic');
    const fallback = {camera: 'camera', optics: 'lens', light: 'light', battery: 'battery'};
    return pickupIcon(categoryMeta[category]?.[1] || (Object.hasOwn(fallback, category) ? fallback[category] : 'equipment'));
  }

  function pickupPanel(tone, title, description) {
    const panel = document.createElement('div');
    panel.className = 'next-step';
    panel.dataset.tone = tone;
    panel.innerHTML = `<h4>Следующий шаг</h4><div class="next-step-banner"><span class="next-step-slot">${pickupIcon(tone)}</span>
      <div><h5>${escapeHtml(title)}</h5><p>${escapeHtml(description)}</p></div></div>`;
    return panel;
  }

  function pickupDisclosure(row, button, drawer, id, key = null) {
    drawer.id = id;
    button.setAttribute('aria-controls', id);
    function setOpen(open, animate) {
      row.classList.toggle('is-expanded', open);
      button.setAttribute('aria-expanded', String(open));
      settleGridDisclosure(drawer, open, animate);
      if (key) {
        if (open) pickupOpenRows.add(key);
        else pickupOpenRows.delete(key);
      }
    }
    setOpen(Boolean(key && pickupOpenRows.has(key)), false);
    button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true', !reducedMotion?.matches));
  }

  function customerPickupStep(order) {
    const ready = order.status === 'ready';
    const panel = pickupPanel(ready ? 'done' : 'wait', ready ? 'Оборудование готово к выдаче' : 'Оборудование готовится к выдаче',
      ready ? (order.next_action?.description || 'Оборудование можно забрать.') : 'Сообщим, когда можно будет забрать оборудование.');
    if (ready) {
      for (const text of [order.next_action?.pickup_location, order.next_action?.pickup_instructions].filter(Boolean)) {
        const detail = document.createElement('p');
        detail.textContent = text;
        panel.querySelector('.next-step-banner > div').append(detail);
      }
    }
    const title = document.createElement('h5');
    title.textContent = 'Комплектация';
    const list = document.createElement('ul');
    list.className = 'next-step-list';
    (order.pickup_items?.length ? order.pickup_items : order.items).forEach((item, index) => {
      const article = {...order.article_media?.[item.id], ...item};
      const row = document.createElement('li');
      row.className = 'next-step-row';
      const composition = item.composition || [];
      const hasPreview = Boolean(article.image_data || article.image_url || article.description);
      const expandable = composition.length || hasPreview;
      const tag = expandable ? 'button' : 'div';
      row.innerHTML = `<${tag} ${expandable ? 'type="button"' : ''} class="next-step-line next-step-client-row">
        <span class="next-step-slot">${pickupEquipmentIcon(article)}</span>
        <strong>${escapeHtml(item.title || item.name)}</strong>
        <span class="next-step-slot" aria-label="Количество ${item.quantity}">× ${item.quantity}</span>
        <span class="next-step-slot next-step-arrow">${expandable ? pickupIcon('arrow') : ''}</span></${tag}>`;
      if (expandable) {
        const drawer = document.createElement('div');
        drawer.className = 'next-step-drawer';
        drawer.innerHTML = `<div class="next-step-drawer-inner">${composition.length
          ? `<ul>${composition.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>` : ''}</div>`;
        if (hasPreview) {
          const preview = plainButton('Подробнее о технике', () => showEquipmentPreview(article, preview), 'ghost next-step-details-button');
          preview.setAttribute('aria-label', `Подробнее: ${item.title || item.name}`);
          drawer.firstElementChild.append(preview);
        }
        row.append(drawer);
        pickupDisclosure(row, row.firstElementChild, drawer, `client-pickup-${order.id}-${index}`, `client-${order.id}-${index}`);
      }
      list.append(row);
    });
    panel.append(title, list);
    return panel;
  }

  function staffPickupStep(order, transition, card) {
    const complete = order.status === 'ready';
    const panel = pickupPanel(complete ? 'done' : 'clipboard', complete ? 'Готовность подтверждена' : 'Проверка перед выдачей', '');
    const banner = panel.querySelector('.next-step-banner');
    const progressText = banner.querySelector('p');
    progressText.className = 'inspection-progress';
    progressText.setAttribute('role', 'status');
    const progress = document.createElement('div');
    progress.className = 'next-step-progress';
    progress.setAttribute('aria-hidden', 'true');
    progress.append(document.createElement('div'));
    const list = document.createElement('ul');
    list.className = 'next-step-list';
    const warning = document.createElement('div');
    warning.className = 'next-step-fault';
    warning.id = `pickup-warning-${order.id}`;
    const confirm = actionButton('Подтвердить готовность к выдаче', async () => {
      await transition('ready');
      await showAdmin('orders');
      const next = document.querySelector(`.request-card[data-booking-id="${order.id}"] .next-step-banner`);
      if (next) {
        window.PolyRentalMotion?.enter(next);
        const heading = next.querySelector('h5');
        heading.tabIndex = -1;
        focusDisclosure(heading);
      }
    }, order.id, 'primary next-step-confirm', false);
    let saving = 0;
    const assetRows = [];
    const assets = (order.assets || []).filter(asset => !(pendingDeletion?.bookingId === order.id && pendingDeletion.assetId === asset.id));
    const omitted = (order.handover?.exceptions || []).filter(item => !item.component && item.reason !== 'replacement').length;
    const expected = order.lines?.length ? order.lines.reduce((count, line) => count + line.quantity, 0) - omitted : assets.length;
    const buttonState = (button, disabled) => {
      if (button.dataset.lockBlocked) button.dataset.lockWasDisabled = String(disabled);
      else button.disabled = disabled;
    };
    const savedFor = asset => inspectionFor(order, asset, 'pre_issue');
    const validCheck = (asset, saved) => !asset.composition_signature || !(asset.components || []).length ||
      saved?.checklist?.__composition_signature === asset.composition_signature;
    const failed = asset => savedFor(asset)?.result === 'fail' || (asset.condition && asset.condition !== 'available');
    const checked = asset => !failed(asset) && savedFor(asset)?.result === 'pass' && validCheck(asset, savedFor(asset));
    const readyToConfirm = () => assets.length > 0 && assets.length === expected && assets.every(checked);
    const drawProgress = () => {
      const count = complete ? assets.length : assets.filter(checked).length;
      const total = Math.max(expected, assets.length);
      progressText.textContent = `Проверено ${count} из ${total} ${total === 1 ? 'комплекта' : 'комплектов'}`;
      progress.firstElementChild.style.width = total ? `${count / total * 100}%` : '0%';
      buttonState(confirm, !readyToConfirm() || saving > 0);
      const defects = assets.filter(failed);
      warning.hidden = !defects.length;
      if (defects.length) {
        warning.innerHTML = `<strong>Подтверждение заблокировано</strong>
          ${defects.map(asset => `<p>${escapeHtml(asset.name)}. ${escapeHtml(savedFor(asset)?.defect || 'Экземпляр недоступен для выдачи.')}</p>`).join('')}
          <p>Замените неисправный комплект в редакторе состава и проверьте замену.</p>`;
        confirm.setAttribute('aria-describedby', warning.id);
      } else confirm.removeAttribute('aria-describedby');
    };
    if (!complete) {
      const pencil = actionButton('Редактировать состав', () => manualAssign(order, pencil), order.id, 'secondary next-step-icon', false);
      pencil.title = 'Редактировать состав';
      pencil.innerHTML = pickupIcon('pencil');
      banner.append(pencil);
      panel.append(progress);
    }
    for (const asset of assets) {
      const article = order.article_media?.[asset.article_id];
      const identifier = asset.asset_code || asset.inventory_code || asset.serial;
      const name = asset.title || article?.title || asset.name;
      const nameWithNumber = identifier ? `${name}, № ${identifier}` : name;
      const row = document.createElement('li');
      row.className = 'next-step-row inspection-row';
      row.dataset.equipmentId = String(asset.id);
      row.innerHTML = `<div class="next-step-line next-step-staff-row">
          <span class="next-step-slot">${pickupEquipmentIcon({...article, name, category: asset.category || article?.category})}</span>
          <div><strong class="inspection-unit-name">${escapeHtml(nameWithNumber)}</strong><span class="next-step-row-fault" hidden>Неисправность</span></div>
          <button type="button" class="button secondary next-step-icon next-step-mark" role="checkbox"></button>
          <button type="button" class="button ghost next-step-icon next-step-arrow lock-exempt" aria-label="Комплектующие: ${escapeHtml(nameWithNumber)}">${pickupIcon('arrow')}</button></div>
        <div class="next-step-drawer"><div class="next-step-drawer-inner"></div></div>`;
      const mark = row.querySelector('.next-step-mark');
      mark.setAttribute('aria-label', `Проверка комплекта: ${nameWithNumber}`);
      const drawer = row.querySelector('.next-step-drawer');
      const content = drawer.firstElementChild;
      const current = asset.components || [];
      const checkable = [];
      current.forEach((component, index) => {
        const label = document.createElement('label');
        label.className = 'next-step-component';
        const name = component.replacement_name || component.name;
        if (['missing', 'faulty'].includes(component.state)) {
          label.textContent = `${name} (не выдаётся)`;
        } else {
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.addEventListener('change', () => save(false, input));
          label.append(input, document.createTextNode(name));
          checkable.push({index, input});
        }
        content.append(label);
      });
      if (!current.length) {
        const text = document.createElement('p');
        text.textContent = 'Отдельные комплектующие не указаны.';
        content.append(text);
      }
      if (!complete && !state.role?.pii_only) {
        const defect = plainButton(failed(asset) ? 'Изменить неисправность' : 'Отметить неисправность',
          () => openInspection(order, asset, 'pre_issue', savedFor(asset), row), 'ghost next-step-defect');
        content.append(defect);
      }
      pickupDisclosure(row, row.querySelector('.next-step-arrow'), drawer, `staff-pickup-${order.id}-${asset.id}`, `staff-${order.id}-${asset.id}`);
      let rowSaving = false;
      function refresh(animate = false) {
        const saved = savedFor(asset);
        const availableCheck = validCheck(asset, saved);
        for (const {index, input} of checkable) {
          input.checked = complete || (availableCheck && Boolean(saved?.checklist?.[`component:${index}`] ?? (saved?.result === 'pass')));
          buttonState(input, complete || failed(asset) || rowSaving);
        }
        const status = complete || checked(asset) ? 'true' : checkable.some(({input}) => input.checked) && !failed(asset) ? 'mixed' : 'false';
        if (mark.getAttribute('aria-checked') !== status) {
          mark.setAttribute('aria-checked', status);
          mark.innerHTML = status === 'true' ? pickupIcon('check') : status === 'mixed' ? pickupIcon('partial') : '';
          if (animate) window.PolyRentalMotion?.enter(mark.firstElementChild);
        }
        row.querySelector('.next-step-row-fault').hidden = complete || !failed(asset);
        buttonState(mark, complete || failed(asset) || rowSaving);
      }
      async function save(whole, source) {
        if (rowSaving || complete || failed(asset) || source.dataset.lockBlocked) return;
        const all = mark.getAttribute('aria-checked') !== 'true';
        const checklist = Object.fromEntries(checkable.map(({index, input}) => [`component:${index}`, whole ? all : input.checked]));
        const result = (whole ? all : Object.values(checklist).every(Boolean)) ? 'pass' : 'partial';
        rowSaving = true;
        saving++;
        refresh();
        drawProgress();
        const update = { equipment_id: asset.id, stage: 'pre_issue', result, checklist, composition_signature: asset.composition_signature };
        try {
          const response = await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method:'POST', body:JSON.stringify(update) });
          const inspections = (order.inspections || []).filter(item => item.equipment_id !== asset.id || item.stage !== 'pre_issue');
          order.inspections = [...inspections, {...update, checklist: {...checklist, __composition_signature: asset.composition_signature}}];
          if (response.operation_lease_state && card.isConnected) {
            order.operation_lease_state = response.operation_lease_state;
            updateRequestLease(order, card);
          }
        } catch (error) {
          showError(error.message);
        } finally {
          rowSaving = false;
          saving--;
          refresh(true);
          drawProgress();
          if (card.isConnected && (document.activeElement === document.body || document.activeElement === source) && !source.disabled) focusDisclosure(source);
        }
      }
      mark.addEventListener('click', () => save(true, mark));
      refresh();
      assetRows.push(row);
    }
    list.append(...assetRows);
    panel.append(list);
    if (!complete) {
      panel.append(warning, confirm);
      if (!assets.length) panel.append(Object.assign(document.createElement('p'), {textContent: 'Добавьте экземпляры в редакторе состава.'}));
    }
    drawProgress();
    return panel;
  }

  function appendInspectionGroup(actions, order, stage, onInspectionChange = () => {}) {
    if (!order.assets?.length) return;
    const group = document.createElement("section"); group.className = "inspection-group";
    const head = document.createElement("div"); head.className = "inspection-group-head";
    const title = document.createElement("h4"); title.className = "inspection-group-title";
    title.textContent = stage === "pre_issue" ? "Проверка перед выдачей" : "Проверка при возврате";
    const progress = document.createElement("p"); progress.className = "inspection-progress";
    const pending = () => order.assets.filter((asset) => !inspectionFor(order, asset, stage));
    const updateProgress = () => {
      const checked = order.assets.length - pending().length;
      progress.textContent = `Проверено ${checked} из ${order.assets.length}`;
    };
    head.append(title, progress);
    group.append(head);
    updateProgress();
    for (const asset of order.assets) {
      if (pendingDeletion?.bookingId === order.id && pendingDeletion.assetId === asset.id) continue;
      const saved = inspectionFor(order, asset, stage);
      const row = document.createElement("div"); row.className = "inspection-row is-expandable"; row.dataset.equipmentId = String(asset.id);
      row.tabIndex = 0; row.setAttribute("aria-expanded", "false");
      const article = order.article_media?.[asset.article_id] || state.items.find((item) => item.id === asset.article_id);
      const mediaItem = {
        name: asset.name || article?.name || "",
        category: asset.category || article?.category || (/объектив|lens/i.test(asset.name || "") ? "optics" : /камера|camera|fx/i.test(asset.name || "") ? "camera" : "generic"),
        image_url: asset.image_url || article?.image_url,
        image_data: asset.image_data || article?.image_data,
      };
      const thumb = document.createElement("div"); thumb.className = "request-equipment-thumb inspection-unit-thumb";
      thumb.innerHTML = catalogMedia(mediaItem, "request-item");
      const details = document.createElement("div"); details.className = "inspection-unit";
      const topLine = document.createElement("div"); topLine.className = "inspection-unit-head";
      const name = document.createElement("strong"); name.className = "inspection-unit-name";
      const assetIdentifier = asset.asset_code || asset.inventory_code || asset.serial;
      const shortTitle = asset.title || article?.title || asset.name;
      name.textContent = assetIdentifier ? `${shortTitle} № ${assetIdentifier}` : `${shortTitle} (без номера)`;
      const status = document.createElement("span"); status.className = `inspection-state${saved ? " checked" : ""}`;
      status.textContent = saved ? (saved.result === "pass" ? "Исправно" : "Зафиксирована неисправность") : "Ожидает проверки";
      topLine.append(name, status);
      details.append(topLine);
      const rowActions = document.createElement("div"); rowActions.className = "inspection-row-actions";
      const defect = document.createElement("button"); defect.type = "button"; defect.className = "button ghost compact inspection-defect-button";
      if (stage === "check_in") defect.classList.add("handover-action");
      const defectLabel = saved?.result === "fail" ? `Изменить неисправность: ${asset.name}` : `Отметить неисправность: ${asset.name}`;
      defect.title = saved?.result === "fail" ? "Изменить неисправность" : "Неисправность";
      defect.setAttribute("aria-label", defectLabel);
      defect.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-wrench"></use></svg>';
      defect.addEventListener("click", (event) => { event.stopPropagation(); openInspection(order, asset, stage, saved, row); });
      rowActions.append(defect);
      if (order.status === "preparing" && !state.role?.pii_only) {
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost danger compact request-equipment-remove";
        remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg>'; remove.title = `Удалить экземпляр ${asset.name}`; remove.setAttribute("aria-label", `Удалить экземпляр ${asset.name}`);
        remove.addEventListener("click", (event) => { event.stopPropagation(); beginRequestDeletion(order, row, null, asset.id); });
        rowActions.append(remove);
      }
      const mainBar = document.createElement("div"); mainBar.className = "equipment-card-main";
      mainBar.append(thumb, details, rowActions);
      bindEquipmentPreview(row, mainBar, {...mediaItem, title: shortTitle, description: article?.description});
      row.append(mainBar);
      const drawer = document.createElement("div"); drawer.className = "equipment-card-drawer";
      const drawerInner = document.createElement("div"); drawerInner.className = "equipment-card-drawer-inner";
      if (asset.name && asset.name !== shortTitle) {
        const full = document.createElement("small"); full.className = "request-equipment-full"; full.textContent = asset.name;
        drawerInner.append(full);
      }
      if (asset.location || asset.serial) {
        const meta = document.createElement("small"); meta.className = "inspection-unit-meta";
        meta.textContent = [asset.location || "Без ячейки", asset.serial ? `S/N ${asset.serial}` : ""].filter(Boolean).join(", ");
        drawerInner.append(meta);
      }
      if (asset.components?.length) {
        const list=document.createElement("ul"); list.className = "inspection-components";
        for (const component of asset.components) { const item=document.createElement("li"); item.textContent=(component.replacement_name || component.name)+(component.state==="missing"||component.state==="faulty"?" (не выдано)":component.state==="replacement"?" (замена)":""); list.append(item); }
        drawerInner.append(list);
      }
      drawer.append(drawerInner);
      row.append(drawer);
      bindEquipmentDisclosure(row, drawer);
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
    const card = document.createElement("div"); card.className = "identity-check-review";
    card.setAttribute("aria-label", "Проверка анкеты"); card.tabIndex = -1;
    const personal = reviewSection("Личные данные", "review-personal-data");
    personal.append(labelledValues([["ФИО", masked.full_name || order.customer_name], ["Контакт", order.customer_contact]]));
    const documentSection = reviewSection("Документ", "review-document-data");
    documentSection.append(labelledValues([["Тип документа", "Паспорт РФ и студенческий билет"], ["Номер паспорта (скрыт)", masked.passport || "Скрыт до раскрытия реквизитов"], ["Номер студенческого (скрыт)", masked.student_id || "Скрыт до раскрытия реквизитов"]]));
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
    const documentKinds = (masked.documents || []).filter(kind => ['passport_main','passport_registration','student_front'].includes(kind));
    if (documentKinds.length) documentSection.append(actionButton('Просмотр документов', () => openDocumentViewer(bookingId, documentKinds), bookingId, 'primary document-button lock-exempt', false));
    else { const note = document.createElement('p'); note.textContent = 'Фотографии документов отсутствуют'; documentSection.append(note); }
    const decision = reviewSection("Решение по анкете", "review-decision");
    if (masked.review_comment) { const comment = document.createElement("p"); comment.textContent = `Комментарий к исправлениям: ${masked.review_comment}`; decision.append(comment); }
    const actions = document.createElement("div"); actions.className = "action-row";
    const approve = actionButton("Подтвердить документы", async () => {
      if (!window.confirm("Фотографии и реквизиты сверены? Подтвердить документы?")) return;
      await api(`/api/miniapp/admin/bookings/${bookingId}/identity/review`, { method: "POST", body: JSON.stringify({ approved: true, comment: "", fields: [] }) });
      selectedRequestId = bookingId;
      await showAdmin("orders");
      const refreshed = document.querySelector(`.request-card[data-booking-id="${bookingId}"]`);
      if (refreshed) {
        const heading = refreshed.querySelector('.request-toggle');
        heading?.focus({preventScroll:true});
        scrollElementIntoView(refreshed);
      }
    }, bookingId, "primary lock-exempt", false);
    const changes = actionButton("Отклонить / исправить", () => requestIdentityChanges(bookingId, documentKinds), bookingId, "ghost lock-exempt");
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
    if (order.identity_status !== 'verified') { decision.append(actions); card.append(personal, documentSection, decision); }
    else card.append(personal, documentSection);
    host.append(card);
    const toggle = host.querySelector('.request-review-button');
    if (toggle) { toggle.textContent = 'Скрыть анкету'; toggle.setAttribute('aria-label', 'Скрыть анкету'); toggle.setAttribute('aria-expanded', 'true'); }
    card.focus({preventScroll:true}); scrollElementIntoView(card);
  }

  function requestIdentityChanges(bookingId, documentKinds) {
    const dialog = $("identity-review-dialog");
    const form = $("identity-review-form");
    const fields = [
      ["full_name", "ФИО"], ["phone", "Телефон"], ["birth_date", "Дата рождения"], ["passport_combined", "Серия и номер паспорта"],
      ["passport_issued_at", "Дата выдачи паспорта"], ["passport_issuer", "Кем выдан паспорт"],
      ["passport_division_code", "Код подразделения"], ["registration_address", "Адрес регистрации"],
      ["residential_address", "Адрес проживания"], ["student_id_number", "Номер студенческого"],
      ["student_institution", "Учебное заведение"], ["passport_main", "Паспорт — страница с фото"],
      ["passport_registration", "Паспорт — страница регистрации"], ["student_front", "Студенческий — лицевая сторона"],
    ];
    const choices = $("identity-review-fields"); choices.replaceChildren();
    for (const [value, label] of fields) {
      if (value === "student_front" && !documentKinds.includes(value)) continue;
      const row = document.createElement("label"); row.className = "check-row review-field-option";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = "fields"; checkbox.value = value;
      const text = document.createElement("span"); text.textContent = label;
      row.append(checkbox, text); choices.append(row);
    }
    const returnFocus = document.activeElement;
    form.reset(); $("identity-review-submit").disabled = false; setDialogHidden(dialog, false); dialog.querySelector("input")?.focus({preventScroll:true});
    return new Promise((resolve, reject) => {
      let submitting = false;
      const keydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
        if (event.key === "Tab") trapDialogFocus(event, dialog);
      };
      const finish = () => { setDialogHidden(dialog, true); form.reset(); $("identity-review-cancel").disabled = false; form.removeEventListener("submit", submit); dialog.removeEventListener("keydown", keydown); $("identity-review-cancel").removeEventListener("click", cancel); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
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
    if (!siteProfile && authorized && (supportsNativeDownload || typeof tg?.openLink === "function")) {
      try {
        const ticket = await api(`${path}/download-link`, { method: "POST" });
        if (supportsNativeDownload) {
          try {
            tg.downloadFile({ url: ticket.url, file_name: ticket.file_name || filename });
            return;
          } catch (_) { /* Some Telegram builds expose this method without a native handler. */ }
        }
        if (typeof tg.openLink === "function") {
          tg.openLink(ticket.url);
          return;
        }
      } catch (_) { /* Authenticated browser download is available as a fallback. */ }
    }
    const response = await fetch(path, { headers: { "X-Telegram-Init-Data": tg?.initData || "" }, cache: "no-store" });
    if (!response.ok) { let detail = "Не удалось скачать документ"; try { detail = (await response.json()).detail || detail; } catch (_) {} throw new Error(detail); }
    const disposition = response.headers.get("Content-Disposition") || "";
    filename = /filename="([^"]+)"/.exec(disposition)?.[1] || filename;
    downloadBlob(await response.blob(), filename);
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = filename; link.style.display = "none"; document.body.append(link); link.click(); link.remove();
    // iOS Telegram may start reading the file after the click handler returns.
    // Revoking immediately can leave its document preview on a black screen.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function downloadCatalogTemplate() {
    const path = `/miniapp/static/equipment-import-template.csv?v=${encodeURIComponent(document.querySelector('meta[name="app-version"]').content)}`;
    const filename = "equipment-import-template.csv";
    const version = String(tg?.version || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const supportsNativeDownload = typeof tg?.downloadFile === "function" && (version[0] > 8 || (version[0] === 8 && version[1] >= 0));
    if (supportsNativeDownload) {
      try {
        tg.downloadFile({ url: new URL(path, location.href).href, file_name: filename });
        return;
      } catch (_) { /* Fall back to a browser download below. */ }
    }
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось скачать шаблон CSV");
    downloadBlob(await response.blob(), filename);
  }

  let documentViewerUrl = "";
  let documentViewerItems = [];
  let documentViewerIndex = 0;
  let documentViewerBookingId = null;
  let documentViewerSequence = 0;
  let documentViewerReturnFocus = null;
  function trapDialogFocus(event, dialog) {
    window.PolyRentalDialogs?.trap(event, dialog);
  }

  function requestReworkComment(target) {
    const dialog = $("rework-dialog"), form = $("rework-form"), cancel = $("rework-cancel");
    const comment = form.elements.comment, returnFocus = document.activeElement;
    form.reset(); $("rework-target").textContent = `Заявка вернётся на этап «${target}».`;
    setDialogHidden(dialog, false); comment.focus({preventScroll:true});
    return new Promise((resolve) => {
      const finish = (value) => {
        setDialogHidden(dialog, true); form.reset(); form.removeEventListener("submit", submit);
        cancel.removeEventListener("click", cancelHandler); dialog.removeEventListener("keydown", keydown);
        if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); resolve(value);
      };
      const submit = (event) => { event.preventDefault(); const value = comment.value.trim(); if (value) finish(value); else comment.focus(); };
      const cancelHandler = () => finish(null);
      const keydown = (event) => { if (event.key === "Escape") { event.preventDefault(); finish(null); } else if (event.key === "Tab") trapDialogFocus(event, dialog); };
      form.addEventListener("submit", submit); cancel.addEventListener("click", cancelHandler); dialog.addEventListener("keydown", keydown);
    });
  }
  async function openDocumentViewer(bookingId, kinds) {
    if (!state.role?.pii_admin) return;
    documentViewerReturnFocus = document.activeElement;
    documentViewerBookingId = bookingId;
    documentViewerItems = kinds;
    documentViewerIndex = 0;
    const viewer = $("document-viewer"); setDialogHidden(viewer, false);
    $("document-viewer-close").focus({preventScroll:true});
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
    documentViewerSequence += 1; documentViewerBookingId = null; setDialogHidden($("document-viewer"), true); $("document-viewer-image").removeAttribute("src"); if (documentViewerUrl) URL.revokeObjectURL(documentViewerUrl); documentViewerUrl = "";
    if (wasOpen && documentViewerReturnFocus?.isConnected) documentViewerReturnFocus.focus({ preventScroll: true });
    documentViewerReturnFocus = null;
  }

  async function navigateAdminCategory(code, staticResult = null, origin = null) {
    viewportFocus?.cancel();
    const since = viewportFocus?.checkpoint();
    const initialScroll = {x:window.scrollX, y:window.scrollY};
    const previousCategory = catalogView.category;
    const backwards = code === categoryParent(previousCategory);
    if (!backwards) categoryScrollPositions.admin.set(previousCategory, initialScroll.y);
    const targetScroll = backwards ? (categoryScrollPositions.admin.get(code) ?? initialScroll.y) : initialScroll.y;
    const snapshot = window.PolyRentalMotion?.captureCategoryView($("admin-catalog-level"));
    window.PolyRentalMotion?.cancelReflow([document.querySelector(".admin-categories"), document.querySelector(".admin-catalog-items")]);
    const releaseHeight = holdCategoryHeight($("admin-content"));
    const token = ++categoryTransitions.admin;
    preserveAdminCatalogControls = true;
    ++catalogView.sequence;
    catalogView.category = code; catalogView.page = 0;
    $("admin-content").classList.toggle("catalog-category-screen", Boolean(code));
    $("admin-content").querySelector(".category-empty-overlay")?.remove();
    clearTimeout(catalogView.timer); syncCatalogBackButton();
    const pendingHeading = $("admin-catalog-heading"); if (pendingHeading) pendingHeading.textContent = clientCatalog.categories.find(category => category.code === code)?.name || "Каталог оборудования";
    if (staticResult) { renderAdminCatalog(staticResult); window.scrollTo(initialScroll.x, initialScroll.y); window.PolyRentalMotion?.transitionCategoryView(snapshot, $("admin-catalog-level"), backwards ? -1 : 1); }
    else {
      const content = $("admin-content");
      content.querySelector(".admin-categories")?.replaceChildren();
      const items = content.querySelector(".admin-catalog-items");
      if (items) {
        items.classList.toggle("tiles", categoryIsLeaf(code) && catalogLayout("admin") === "grid");
        showLoading(items, "Загружаем оборудование…");
      }
      window.scrollTo(initialScroll.x, initialScroll.y);
      window.PolyRentalMotion?.transitionCategoryView(snapshot, $("admin-catalog-level"), backwards ? -1 : 1);
      await reloadCatalogPage(false, true);
    }
    const current = () => token === categoryTransitions.admin && state.view === "admin" && state.adminMode === "catalog" && catalogView.category === code;
    try {
      if (token === categoryTransitions.admin) preserveAdminCatalogControls = false;
      if (!current()) return;
      const heading = $("admin-catalog-heading");
      if (since === viewportFocus?.checkpoint()) heading?.focus({preventScroll:true});
      await window.PolyRentalMotion?.waitCategory();
      await settleCategoryScroll(heading, backwards, targetScroll, since, current);
    } finally { releaseHeight(); }
  }
  function catalogPagePath() {
    return `/api/miniapp/admin/catalog?${new URLSearchParams({page:String(catalogView.page), page_size:"20", q:catalogView.query, condition:catalogView.status, category:catalogView.category})}`;
  }
  async function reloadCatalogPage(preserveSearch = false, preservePosition = false) {
    const sequence = ++catalogView.sequence, query = catalogView.query, condition = catalogView.status, page = catalogView.page, category = catalogView.category;
    const current = $("admin-content").querySelector(".catalog-controls input");
    const selection = preserveSearch && current && current === document.activeElement ? [current.selectionStart, current.selectionEnd, current.selectionDirection] : null;
    try {
      const result = await api(catalogPagePath());
      if (preservePosition) await window.PolyRentalMotion?.waitCategory();
      if (sequence !== catalogView.sequence || state.view !== "admin" || state.adminMode !== "catalog" || $("admin-panel").classList.contains("catalog-editing") || query !== catalogView.query || condition !== catalogView.status || category !== catalogView.category || page !== catalogView.page) return;
      if (page > 0 && page * (result.page_size || 20) >= result.total) { catalogView.page = Math.max(0, Math.ceil(result.total / (result.page_size || 20)) - 1); return reloadCatalogPage(preserveSearch); }
      const scroll = preservePosition ? {x:window.scrollX, y:window.scrollY} : null;
      renderAdminCatalog(result);
      if (!preservePosition) enterWorkspace($("admin-content").querySelector('.admin-catalog-items'));
      if (scroll) window.scrollTo(scroll.x, scroll.y);
      if (selection) { const search = $("admin-content").querySelector(".catalog-controls input"); search?.focus({preventScroll:true}); if (selection[0] != null && selection[1] != null) search?.setSelectionRange(selection[0], selection[1], selection[2] || "none"); }
    } catch (error) {
      if (sequence !== catalogView.sequence || state.view !== "admin" || state.adminMode !== "catalog") return;
      const items = $("admin-content").querySelector(".admin-catalog-items:has(.catalog-skeleton-card)");
      const message = `Не удалось загрузить каталог: ${error.message}`;
      if (!items) { showError(message); return; }
      const recovery = document.createElement("div");
      recovery.className = "catalog-loading-retry";
      const notice = document.createElement("p");
      notice.setAttribute("role", "alert");
      notice.textContent = message;
      recovery.append(notice, plainButton("Повторить загрузку", async () => {
        showLoading(items, "Загружаем оборудование…");
        await reloadCatalogPage(false, preservePosition);
      }));
      items.replaceChildren(recovery);
    }
  }

  $("catalog-import-open").addEventListener("click", async () => {
    if (state.adminMode !== "catalog" || !["manager", "admin"].includes(state.role?.staff_role)) return;
    let imported;
    const data = await workflowDialog("Импорт CSV", `<p>Скачайте шаблон и замените два учебных примера своими данными. Одна строка — один экземпляр оборудования.</p><button class="button secondary catalog-template-download" type="button">Скачать шаблон CSV</button><p class="csv-download-error" role="alert"></p><label class="field"><span>CSV-файл, не больше 1 МБ и 500 экземпляров</span><input name="file" type="file" accept=".csv,text/csv" required></label><details class="csv-help"><summary>Формат CSV и правила импорта</summary><p>Шаблон содержит два учебных примера: замените их своими данными перед импортом. Одна строка — один экземпляр оборудования; для экземпляров одной модели укажите одинаковый SKU и одинаковые поля модели. Поддерживаются технический CSV в UTF-8 с разделителем «;» (<code>sku</code>, <code>name</code>, необязательные <code>serial</code> и <code>inventory_code</code>) с полями модели <code>kind</code> (вид), <code>brand</code> (бренд), <code>key_spec</code> (основная характеристика) и опись с колонками «Наименование», «Модель», «S/N», «Инвентаризационный номер/ Код ОС». Пустой или «-» S/N не создаёт значение; повторные S/N допустимы, а инвентарный код уникален. Состояние <code>condition</code>: <code>available</code> — доступен, <code>maintenance</code> — на ремонте, <code>retired</code> — выведен из эксплуатации. Файл импортируется целиком или не импортируется вовсе.</p></details>`, "Добавить из CSV", dialog => {
      const heading = dialog.querySelector("h2"); heading.tabIndex = -1; heading.dataset.initialFocus = "";
      dialog.querySelector(".catalog-template-download").addEventListener("click", async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await downloadCatalogTemplate(); }
        catch(error) { const message = dialog.querySelector(".csv-download-error"); message.textContent = error.message; }
        finally {
          button.disabled = false;
          window.PolyRentalDialogs?.restoreFocus(button);
        }
      });
    }, async form => { imported = await api("/api/miniapp/admin/catalog/import-csv", {method:"POST", body:form}); });
    if (!data) return;
    await showAdmin("catalog");
    const notice = document.createElement("p"); notice.className = "notice"; notice.setAttribute("role", "status");
    notice.textContent = `Добавлено моделей: ${imported.articles_created}; экземпляров: ${imported.equipment_created}.`;
    $("admin-content").prepend(notice);
    window.PolyRentalDialogs?.restoreFocus($("catalog-import-open"));
  });

  function renderAdminCatalog(result, editor = null) {
    setCategories(result.categories || []);
    $("admin-panel").classList.toggle("catalog-editing", Boolean(editor));
    const preservedControls = preserveAdminCatalogControls && !editor && result.page != null ? $("admin-content").querySelector('.catalog-controls') : null;
    const content = $("admin-content"); content.classList.toggle("catalog-category-screen", Boolean(catalogView.category) && !editor); content.replaceChildren();
    if (editor) {
      const form = catalogEditor(result, editor);
      content.append(form);
      syncCatalogBackButton();
      const heading = form.querySelector("h3"); heading.tabIndex = -1;
      heading.focus({preventScroll:true}); scrollElementIntoView(form);
      return;
    }
    syncCatalogBackButton();
    const canManageItems = ["manager", "admin"].includes(state.role?.staff_role);
    const operations = document.createElement("section"); operations.className = "catalog-operations"; operations.hidden = !canManageItems;
    const operationsTitle = document.createElement("h3"); operationsTitle.textContent = "Состав комплектов";
    operations.append(operationsTitle);
    const dependencyNote = document.createElement("p");
    dependencyNote.textContent = "Зависимости комплектов хранятся справочно. Автоматическое добавление отключено: клиент выбирает каждую позицию отдельно. Аренда бесплатная.";
    operations.append(dependencyNote);
    const toolbar = document.createElement("div"); toolbar.className = "action-row catalog-toolbar";
    for (const [label, type, className] of [["Новый артикул", "article", "primary"], ["Новый экземпляр", "equipment", "secondary"], ["Настроить состав комплекта", "dependency", "secondary"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = label;
      button.addEventListener("click", () => renderAdminCatalog(result, { type })); toolbar.append(button);
    }
    toolbar.hidden = !canManageItems;
    content.append(toolbar);
    const controls = document.createElement("div"); controls.className = "catalog-controls";
    controls.innerHTML = `<label><span class="sr-only">Поиск в каталоге</span><span class="catalog-search-input"><input type="search" placeholder="Поиск: модель, SKU, S/N, инвентарный код" value="${escapeHtml(catalogView.query)}"><button class="admin-search-hide-keyboard" type="button" aria-label="Скрыть клавиатуру" title="Скрыть клавиатуру"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M5 8h1m2 0h1m2 0h1m2 0h1m2 0h1M5 11h1m2 0h1m2 0h1m2 0h1m2 0h1M7 14h10m-7 5 2 2 2-2"/></svg></button></span></label><label><span class="sr-only">Состояние экземпляра</span><select><option value="all">Все состояния</option><option value="available">Доступен</option><option value="maintenance">На ремонте</option><option value="retired">Выведен из эксплуатации</option></select></label>`;
    const [search, status] = controls.querySelectorAll("input, select"); status.value = catalogView.status;
    const bell = document.querySelector('.catalog-search > .notification-bell').cloneNode(true);
    const searchRow = document.createElement('div'); searchRow.className = 'catalog-search-row';
    controls.firstElementChild.before(searchRow); searchRow.append(controls.querySelector('label'), bell);
    bell.querySelector('.notification-dot').hidden = !inboxUnread;
    controls.querySelector(".admin-search-hide-keyboard").addEventListener("click", () => search.blur());
    search.addEventListener("input", () => {
      content.querySelector(".category-empty-overlay")?.remove();
      const selection = { start: search.selectionStart, end: search.selectionEnd, direction: search.selectionDirection };
      catalogView.query = search.value;
      if (result.page != null) { catalogView.page = 0; catalogView.sequence++; clearTimeout(catalogView.timer); catalogView.timer = setTimeout(() => { void reloadCatalogPage(true); }, 300); return; }
      renderAdminCatalog(result, editor);
      const refreshedSearch = $("admin-content").querySelector(".catalog-controls input");
      refreshedSearch?.focus({ preventScroll: true });
      if (selection.start != null && selection.end != null) refreshedSearch?.setSelectionRange(selection.start, selection.end, selection.direction || "none");
    });
    status.addEventListener("change", () => { catalogView.status = status.value; if (result.page != null) { catalogView.page = 0; clearTimeout(catalogView.timer); void reloadCatalogPage(); } else renderAdminCatalog(result, editor); });
    content.prepend(preservedControls || controls);

    if (result.dependencies.length) {
      const dependencies = document.createElement("article"); dependencies.className = "admin-card";
      dependencies.innerHTML = `<div class="dependency-list"></div>`;
      const list = dependencies.querySelector(".dependency-list");
      for (const item of result.dependencies) {
        const parent = result.articles.find((article) => article.id === item.parent_article_id);
        const child = result.articles.find((article) => article.id === item.child_article_id);
        const row = document.createElement("div"); row.className = "dependency-row";
        row.innerHTML = `<span><strong>${escapeHtml(parent?.name || item.parent_name || item.parent_article_id)}</strong> → ${escapeHtml(child?.name || item.child_name || item.child_article_id)} × ${item.quantity} (справочная связь)</span>`;
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "button ghost compact danger"; remove.textContent = "Удалить";
        remove.addEventListener("click", () => runButton(remove, async () => {
          await api(`/api/miniapp/admin/catalog/dependencies/${item.parent_article_id}/${item.child_article_id}`, {method:"DELETE"});
          await showAdmin("catalog");
        }));
        row.append(remove); list.append(row);
      }
      operations.append(dependencies);
    }

    const level = document.createElement("div"); level.id = "admin-catalog-level"; level.className = "catalog-level"; content.append(level);
    const categoryHost = document.createElement("div"); categoryHost.className = "client-categories admin-categories categories-list";
    const currentCategory = clientCatalog.categories.find(c => c.code === catalogView.category);
    const selectCategory = (code, origin = null) => { void navigateAdminCategory(code, result.page != null ? null : result, origin); };
    if (!catalogView.query.trim()) for (const category of clientCatalog.categories.filter(c => (c.parent_code || "") === catalogView.category)) {
      const button = document.createElement("button"); button.type = "button"; button.className = "category-card";
      button.innerHTML = `<span class="category-card-icon">${categoryVisual(category)}</span><span class="category-card-name">${escapeHtml(category.name)}</span><span class="category-card-arrow" aria-hidden="true">›</span>`;
      button.dataset.categoryCode = category.code;
      categoryHost.append(button);
      const link = bindSiteLink(button, catalogSiteRoute("management-catalog", category.code), () => selectCategory(category.code, button));
      bindCategoryPhoto(link, category);
      if (!catalogView.editingCategories) continue;
      const tile = document.createElement("div"); tile.className = "category-edit-tile"; tile.append(link);
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "category-edit";
      edit.setAttribute("aria-label", `Изменить категорию: ${category.name}`); edit.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-pencil"></use></svg>';
      edit.addEventListener("click", () => runButton(edit, async () => { clearError(); await editCategoryDialog(category); }));
      tile.append(edit);
      if (category.code !== "generic") {
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "category-delete";
        remove.setAttribute("aria-label", `Удалить категорию: ${category.name}`); remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg>';
        remove.addEventListener("click", () => runButton(remove, async () => {
          clearError();
          if (!window.confirm(`Удалить категорию «${category.name}»?`)) return;
          await api(`/api/miniapp/admin/catalog/categories/${encodeURIComponent(category.code)}`, {method:"DELETE"});
          await showAdmin("catalog");
        }));
        tile.append(remove);
      }
      categoryHost.append(tile);
    }
    if (catalogView.editingCategories && !catalogView.query.trim()) {
      const addCategory = document.createElement("button"); addCategory.type = "button"; addCategory.className = "category-card category-add";
      addCategory.setAttribute("aria-label", "Создать категорию"); addCategory.innerHTML = '<span aria-hidden="true">+</span>';
      addCategory.addEventListener("click", () => runButton(addCategory, async () => {
        clearError();
        if (await createCategoryDialog(catalogView.category)) await showAdmin("catalog");
      }));
      categoryHost.append(addCategory);
    }
    const categoryHeading = document.createElement("h3"); categoryHeading.id = "admin-catalog-heading"; categoryHeading.tabIndex = -1; categoryHeading.className = "catalog-screen-heading";
    categoryHeading.textContent = currentCategory?.name || (catalogView.query.trim() ? "Результаты поиска" : "Каталог оборудования");
    const categoryHeadingRow = document.createElement("div"); categoryHeadingRow.className = "catalog-heading-row";
    if (siteNavigation && catalogView.category) {
      categoryHeadingRow.id = catalogSiteRoute("management-catalog", catalogView.category);
      categoryHeadingRow.classList.add("site-anchor-target");
    }
    const backButton = document.createElement('button'); backButton.type='button'; backButton.className='catalog-search-back'; backButton.setAttribute('aria-label','Назад'); backButton.innerHTML='<svg class="icon" aria-hidden="true"><use href="#icon-back"></use></svg>'; backButton.hidden = !catalogView.category; backButton.addEventListener('click',back);
    const manageCategories = plainButton("", () => {
      catalogView.editingCategories = !catalogView.editingCategories;
      if (catalogView.query.trim()) { catalogView.query = ""; catalogView.page = 0; if (result.page != null) { void reloadCatalogPage(); return; } }
      renderAdminCatalog(result);
      document.querySelector(".catalog-manage-categories")?.focus({preventScroll:true});
    }, "ghost compact catalog-manage-categories");
    manageCategories.setAttribute("aria-label", catalogView.editingCategories ? "Завершить редактирование категорий" : "Редактировать категории");
    manageCategories.setAttribute("aria-pressed", String(catalogView.editingCategories));
    manageCategories.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 20l4-.8L19.4 7.8a2.1 2.1 0 0 0-3-3L5 16.2 4 20zM14.8 6.4l2.8 2.8"/></svg>';
    const path = document.createElement("p"); path.className = "catalog-path"; path.textContent = categoryPath(catalogView.category);
    const titleGroup = document.createElement("div"); titleGroup.append(path, categoryHeading);
    categoryHeadingRow.append(backButton, titleGroup, manageCategories);
    level.append(categoryHeadingRow, categoryHost); syncCatalogBackButton();
    const categoryIndex = !catalogView.category && !catalogView.query.trim() && clientCatalog.categories.length;
    const categoryMatches = code => { let current = clientCatalog.categories.find(c => c.code === code); const visited = new Set(); while (current && !visited.has(current.code)) { if (current.code === catalogView.category) return true; visited.add(current.code); current = clientCatalog.categories.find(c => c.code === current.parent_code); } return false; };
    const query = catalogView.query.trim().toLocaleLowerCase("ru-RU");
    const visibleArticles = result.page != null ? result.articles : result.articles.filter((article) => {
      const searchText = [article.title, article.name, article.kind, article.brand, article.key_spec, article.description, article.sku, ...article.equipment.flatMap((asset) => [asset.serial, asset.inventory_code, asset.asset_code, asset.location])].join(" ").toLocaleLowerCase("ru-RU");
      return (!catalogView.category || categoryMatches(article.category)) && (!query || searchText.includes(query)) && (catalogView.status === "all" || article.equipment.some((asset) => asset.condition === catalogView.status));
    });
    const articleGrid = document.createElement("div"); articleGrid.className = "admin-catalog-items";
    articleGrid.classList.toggle("tiles", categoryIsLeaf(catalogView.category) && catalogLayout('admin') === 'grid');
    if (categoryIsLeaf(catalogView.category)) level.insertBefore(layoutPicker('admin',articleGrid),categoryHost);
    const emptyCategory = Boolean(catalogView.category && !query && !visibleArticles.length && !clientCatalog.categories.some(category => category.parent_code === catalogView.category));
    const summary = document.createElement("p"); summary.hidden = Boolean(categoryIndex || emptyCategory); summary.className = "catalog-summary"; summary.textContent = `Показано моделей: ${visibleArticles.length} из ${result.total ?? result.articles.length}`; level.append(summary, articleGrid);
    if (emptyCategory && !catalogView.editingCategories) categoryEmptyOverlay(articleGrid);
    for (const article of (categoryIndex ? [] : visibleArticles)) {
      const card = document.createElement("article"); card.className = `admin-card article-card${article.active ? "" : " inactive"}`;
      const matchingAssets = catalogView.status === "all" ? article.equipment : article.equipment.filter(asset => asset.condition === catalogView.status);
      const count = assetCountLabel(matchingAssets.length);
      const headingId = `catalog-article-${article.id}`;
      card.setAttribute("aria-labelledby", headingId);
      card.innerHTML = `
        <div class="article-card-head">
          ${catalogMedia(article, "article")}
          <div class="article-main">
            <h3 id="${headingId}">${escapeHtml(catalogTitle(article))}</h3>
            <p class="article-type">${escapeHtml(article.key_spec || categoryLabel(article.category))}</p>
            <p class="article-sku">Артикул ${escapeHtml(article.sku)}</p>
            ${article.active === false ? '<p class="article-hidden-label">Скрыт от клиентов</p>' : ""}
            <p class="article-count">${count}</p>
          </div>
          <div class="article-head-actions">
            <button type="button" class="button ghost compact article-toggle" aria-controls="${headingId}-assets">
              <span class="article-list-count">${count}</span><span class="article-tile-toggle">Экземпляры</span>
            </button>
          </div>
        </div>
        <div class="article-collapse" id="${headingId}-assets">
          <div class="article-collapse-inner">
            <div class="article-collapse-content">
              <div class="equipment-list"></div>
              <details class="article-details"><summary>Комплектация</summary>
                ${article.description ? `<p>${escapeHtml(article.description)}</p>` : ""}
                <p class="composition-text">${escapeHtml(article.composition || "Комплектация не указана.")}</p>
              </details>
            </div>
          </div>
        </div>`;
      const collapse = card.querySelector(".article-collapse");
      const header = card.querySelector(".article-card-head");
      const toggle = card.querySelector(".article-toggle");
      const setExpanded = (expanded, animate) => {
        collapse.classList.toggle("is-open", expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        if (expanded) catalogView.expanded.add(article.id); else catalogView.expanded.delete(article.id);
        return settleGridDisclosure(collapse, expanded, animate);
      };
      setExpanded(catalogView.expanded.has(article.id), false);
      const toggleDetails = () => {
        const opening = !catalogView.expanded.has(article.id);
        const after = setExpanded(opening, true);
        if (opening) scrollElementIntoView(card, {valid: () => !collapse.inert, after});
      };
      toggle.addEventListener("click", toggleDetails);
      header.addEventListener("click", event => {
        if (!event.target.closest("button, a, input, select, textarea, summary")) toggleDetails();
      });
      const cardActions = document.createElement("div"); cardActions.className = "action-row";
      if (canManageItems && article.equipment.length) {
        const occupancy = plainButton("Занятость вне сервиса", async () => {
          if (!guardStaffNavigation()) return;
          const assets = article.equipment;
          if (assets.length === 1) return externalOccupancyDialog(assets[0]);
          const options = assets.map(asset => `<option value="${asset.id}">${escapeHtml(asset.serial || asset.asset_code || String(asset.id))}</option>`).join("");
          const data = await workflowDialog("Выберите экземпляр", `<label class="field"><span>Экземпляр оборудования</span><select name="equipment" required>${options}</select></label>`, "Открыть занятость");
          if (data) await externalOccupancyDialog(assets.find(asset => String(asset.id) === data.get("equipment")));
        }, "secondary compact article-occupancy");
        cardActions.append(occupancy);
      }
      const editArticle = plainButton("Изменить", () => renderAdminCatalog(result, {
        type:"article", value:article, returnScroll:{x:window.scrollX, y:window.scrollY},
      }), "ghost compact article-edit");
      editArticle.dataset.editArticleId = article.id;
      editArticle.setAttribute("aria-label", `Изменить артикул: ${article.name}`);
      editArticle.innerHTML = 'Изменить<span class="article-tile-edit"> артикул</span>';
      const addAsset = document.createElement("button"); addAsset.type = "button"; addAsset.className = "button secondary compact"; addAsset.textContent = "Добавить экземпляр";
      addAsset.addEventListener("click", () => renderAdminCatalog(result, { type: "equipment", value: { article_id: article.id, condition: "available" } }));
      const photo=plainButton(article.image_data ? "Заменить фото модели" : "Загрузить фото модели",async()=>{
        let savedPhoto;
        const data=await workflowDialog("Фото модели оборудования",'<label class="field"><span>Выберите изображение с устройства</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label><img class="catalog-upload-preview" alt="Предпросмотр выбранного фото" hidden><p class="supporting">JPEG, PNG или WebP. Изображение будет уменьшено и сохранено в WebP.</p><p class="photo-save-status" role="status"><span class="loading-spinner photo-spinner" aria-hidden="true"></span>Подготовка и загрузка фото…</p>',"Сохранить", dialog => {
          dialog.classList.add("catalog-photo-dialog");
          const input = dialog.querySelector('input[name="photo"]'), preview = dialog.querySelector('.catalog-upload-preview');
          bindCatalogPhoto(preview, article.name);
          input.addEventListener('change', () => { if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url); const file = input.files?.[0]; preview.hidden = !file; if (file) { preview.dataset.url = URL.createObjectURL(file); preview.src = preview.dataset.url; } });
        }, async data => {
          const upload = await prepareCatalogPhoto(data.get("photo"));
          savedPhoto = await api(`/api/miniapp/admin/catalog/articles/${article.id}/photo`, {method:"PUT", body:upload});
        });
        if(data) {
          if (savedPhoto?.image_data) { article.image_data = savedPhoto.image_data; renderAdminCatalog(result); }
          else await showAdmin("catalog");
          const notice = document.createElement("p"); notice.className = "notice"; notice.setAttribute("role","status"); notice.textContent = "Фото сохранено."; $("admin-content").prepend(notice);
        }
      });
      if (canManageItems) { card.querySelector(".article-head-actions").append(editArticle); cardActions.append(addAsset,photo); }
      if (article.active) cardActions.append(plainButton("Скрыть от клиентов", async () => {
        if (!window.confirm(`Скрыть «${article.name}» от клиентов?`)) return;
        try { await api(`/api/miniapp/admin/catalog/articles/${article.id}/hide`, {method:"POST"}); await showAdmin("catalog"); } catch (error) { showError(error.message); }
      }, "ghost"));
      if (state.role?.staff_role === "admin") {
        const removeArticle = plainButton("Удалить артикул", async () => {
          const confirmed = await workflowDialog(
            "Удалить артикул из каталога?",
            `<p>«${escapeHtml(article.name)}» и все его экземпляры станут недоступны для новых заявок. Предыдущие заявки, выдачи и ремонты сохранятся. Вернуть артикул через интерфейс будет нельзя.</p><label class="field"><span>Для подтверждения введите артикул ${escapeHtml(article.sku)}</span><input name="confirmation" autocomplete="off" required></label>`,
            "Удалить артикул", null, async data => {
              if (data.get("confirmation") !== article.sku) throw new Error("Артикул введён неверно.");
              await api(`/api/miniapp/admin/catalog/articles/${article.id}`, {method:"DELETE"});
            });
          if (confirmed) await showAdmin("catalog");
        }, "ghost danger");
        removeArticle.setAttribute("aria-label", `Удалить артикул: ${article.name}`);
        cardActions.append(removeArticle);
      }
      if(canManageItems && article.image_data)cardActions.append(plainButton("Удалить фото модели",async()=>{
        if(await workflowDialog("Удалить фото модели",'<p>Удалить загруженное фото этой модели?</p>',"Удалить",null,async()=>api(`/api/miniapp/admin/catalog/articles/${article.id}/photo`,{method:"DELETE"})))await showAdmin("catalog");
      }));
      card.querySelector(".article-collapse-content").append(cardActions);
      const equipmentList = card.querySelector(".equipment-list");
      if (!matchingAssets.length) equipmentList.textContent = "Нет экземпляров с выбранным состоянием.";
      for (const asset of matchingAssets) {
        const row = document.createElement("div"); row.className = `equipment-row condition-${asset.condition}`;
        const blocks = asset.external_blocks || [];
        const currentBlocks = blocks.filter(block => Date.parse(block.start) <= Date.now() && Date.parse(block.end) > Date.now());
        const identifiers = [asset.serial && `S/N ${asset.serial}`, asset.location && `ячейка ${asset.location}`].filter(Boolean);
        row.innerHTML = `<div class="equipment-main"><div class="article-asset-summary"><div><strong>${escapeHtml(asset.asset_code || asset.serial || "Экземпляр")}</strong>${identifiers.length ? `<p>${escapeHtml(identifiers.join(", "))}</p>` : ""}</div><span class="article-asset-condition">${escapeHtml(asset.condition === "available" ? "На складе" : conditionLabel(asset.condition))}</span></div>${blocks.length ? `<span class="external-occupancy-badge">${currentBlocks.length ? "Занят вне сервиса" : "Запланирована занятость вне сервиса"}</span>` : ""}<details class="equipment-details"><summary>Подробно</summary><dl><dt>Инвентарный номер</dt><dd>${escapeHtml(asset.inventory_code || "не указан")}</dd><dt>Особенности</dt><dd>${(asset.features || []).map(feature => escapeHtml(feature.description)).join("<br>") || "не указаны"}</dd><dt>Владелец</dt><dd>${escapeHtml(asset.owner || "не указан")}</dd></dl>${blocks.map(block => `<p>${escapeHtml(block.reason)}: ${escapeHtml(dateText(block.start))} — ${escapeHtml(dateText(block.end))} МСК</p>`).join("")}</details></div>`;
        if (canManageItems) {
          const actions = document.createElement("div"); actions.className = "equipment-icon-actions";
          const edit = plainButton("✎", () => renderAdminCatalog(result, {
            type:"equipment", value:{...asset, article_id:article.id},
            returnScroll:{x:window.scrollX, y:window.scrollY},
          }), "ghost compact icon-action");
          edit.dataset.editAssetId = asset.id;
          edit.setAttribute("aria-label", `Изменить экземпляр: ${asset.serial || asset.asset_code}`); edit.title = "Изменить экземпляр";
          edit.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-pencil"></use></svg>';
          const remove = plainButton("×", async () => {
            if (!window.confirm(`Удалить экземпляр ${asset.serial || asset.asset_code}? Если он последний и не имеет истории, артикул также будет удалён.`)) return;
            try { await api(`/api/miniapp/admin/catalog/equipment/${asset.id}`, {method:"DELETE"}); await showAdmin("catalog"); } catch (error) { showError(error.message); }
          }, "ghost compact danger icon-action");
          remove.setAttribute("aria-label", `Удалить экземпляр: ${asset.serial || asset.asset_code}`); remove.title = "Удалить экземпляр";
          actions.append(edit, remove); row.append(actions);
        }
        equipmentList.append(row);
      }
      articleGrid.append(card);
    }
    if (result.dependencies.length) content.append(operations);
    if (result.page != null) {
      const pages = Math.max(1, Math.ceil(result.total / (result.page_size || 20)));
      if (pages > 1 && !categoryIndex) {
        const controls = document.createElement("div"); controls.className = "action-row catalog-pagination";
        const previous = plainButton("Назад", () => { catalogView.page--; void reloadCatalogPage(); }, "secondary"); previous.disabled = catalogView.page === 0;
        const current = document.createElement("span"); current.textContent = `${catalogView.page + 1} / ${pages}`;
        const next = plainButton("Далее", () => { catalogView.page++; void reloadCatalogPage(); }, "secondary"); next.disabled = catalogView.page + 1 >= pages;
        controls.append(previous, current, next); content.append(controls);
      }
    }
  }

  // Form contents stay in memory. Only enumerated catalog controls may be
  // persisted; free text, contacts, uploaded files and identity fields never are.
  const staffFormBaselines = new WeakMap();
  const safeCatalogDraftFields = new Set(["category", "inspection_profile", "active", "article_id", "condition", "parent_article_id", "child_article_id", "quantity", "billable"]);
  function staffFormSnapshot(form) {
    return JSON.stringify([...form.elements].filter(el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !["submit", "button", "search"].includes(el.type)).map(el => [el.name, el.type === "file" ? [...el.files].map(file => [file.name, file.size]) : ["checkbox", "radio"].includes(el.type) ? el.checked : el.value]));
  }
  function registerStaffForm(form) { staffFormBaselines.set(form, staffFormSnapshot(form)); }
  function staffFormDirty(form) { return staffFormBaselines.has(form) && staffFormBaselines.get(form) !== staffFormSnapshot(form); }
  function safeCatalogFields(form) {
    const result = {};
    for (const element of form.elements) if (safeCatalogDraftFields.has(element.name)) {
      if (element.tagName === "SELECT") {
        const allowed = element.name === "category" ? null
          : element.name === "inspection_profile" ? /^(generic|camera|optics|light|battery)$/
          : element.name === "condition" ? /^(available|maintenance|retired)$/ : /^\d*$/;
        if (element.name === "category" ? [...element.options].some(option => option.value === element.value) : allowed.test(element.value)) result[element.name] = element.value;
      } else if (element.type === "checkbox") result[element.name] = element.checked;
      else if (element.type === "number" && /^\d{0,2}$/.test(element.value)) result[element.name] = element.value;
    }
    return result;
  }
  function catalogDraftKey(editor) { return `polyrental-staff-catalog-draft-v1:${editor.type}:${editor.value?.id || "new"}:${editor.value?.article_id || ""}`; }
  function guardStaffNavigation() {
    if (document.querySelector("#admin-content .instance-editor[aria-busy='true']")) return false;
    const forms = [...document.querySelectorAll("#admin-content form, #handover-settings-form, #booking-settings-form")]
      .filter(form => staffFormDirty(form) && (form.getClientRects().length || form.closest(".instance-editor")));
    if (!forms.length) return true;
    if (!window.confirm("Есть несохранённые изменения. Текстовые поля и файлы не восстанавливаются. Перейти в другой раздел?")) return false;
    forms.forEach(registerStaffForm);
    return true;
  }
  window.addEventListener("beforeunload", event => {
    if ([...document.querySelectorAll("#admin-content form, .workflow-dialog form, #handover-settings-form, #booking-settings-form")].some(staffFormDirty)) { event.preventDefault(); event.returnValue = ""; }
  });
  function installCatalogDraft(form, editor) {
    let key = catalogDraftKey(editor), baseline = safeCatalogFields(form);
    const notice = document.createElement("p"); notice.className = "supporting wide catalog-draft-status";
    if (!form.closest(".instance-editor")) notice.textContent = "Выборы и числовые поля можно восстановить на этом устройстве. Текст и файлы не сохраняются.";
    form.prepend(notice); registerStaffForm(form);
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt >= 0 && Date.now() - saved.savedAt <= 24 * 60 * 60 * 1000) {
        if (JSON.stringify(saved.baseline) === JSON.stringify(baseline)) {
          for (const element of form.elements) if (safeCatalogDraftFields.has(element.name) && Object.prototype.hasOwnProperty.call(saved.values || {}, element.name)) {
            const next = saved.values[element.name];
            if (element.tagName === "SELECT" && typeof next === "string") {
              if (![...element.options].some(option => option.value === next) && /^(article_id|parent_article_id|child_article_id)$/.test(element.name) && /^\d+$/.test(next)) element.add(new Option(`Артикул №${next}`, next));
              if ([...element.options].some(option => option.value === next)) element.value = next;
            }
            else if (element.type === "checkbox" && typeof next === "boolean") element.checked = next;
            else if (element.type === "number" && typeof next === "string" && /^\d{0,2}$/.test(next)) element.value = next;
          }
          notice.textContent = "Восстановлены безопасные поля черновика. Текст и файлы нужно заполнить заново.";
        } else {
          notice.textContent = "Карточка изменилась после сохранения черновика. Открыты актуальные данные; прежние выборы не применены.";
          localStorage.removeItem(key);
        }
      } else if (saved) localStorage.removeItem(key);
    } catch (_) { notice.textContent = "Черновик на устройстве недоступен. Сохраняйте изменения перед выходом."; }
    const save = () => {
      try {
        const values = safeCatalogFields(form);
        if (JSON.stringify(values) === JSON.stringify(baseline)) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({savedAt:Date.now(), baseline, values}));
      } catch (_) { notice.textContent = "Не удалось сохранить черновик на устройстве. Сохраняйте изменения перед выходом."; }
    };
    form.addEventListener("input", save); form.addEventListener("change", save);
    const clear = () => { try { localStorage.removeItem(key); } catch (_) {} };
    return {
      clear,
      rebase: nextEditor => {
        clear();
        key = catalogDraftKey(nextEditor); baseline = safeCatalogFields(form);
        notice.textContent = "";
        clear();
      },
    };
  }

  function installArticlePickers(form, searchPanel = null) {
    for (const select of form.querySelectorAll('select[name="article_id"], select[name="parent_article_id"], select[name="child_article_id"]')) {
      const search = document.createElement("input"); search.type = "search"; search.placeholder = "Найти артикул по названию или SKU"; search.setAttribute("aria-label", `Поиск: ${select.closest("label")?.querySelector("span")?.textContent || "артикул"}`);
      const more = document.createElement("button"); more.type = "button"; more.className = "button ghost compact"; more.textContent = "Показать ещё артикулы"; more.hidden = true;
      const status = document.createElement("small"); status.setAttribute("role", "status");
      if (searchPanel) searchPanel.append(search, status, more);
      else { select.before(search); select.after(status, more); }
      let page = 0, sequence = 0, timer = null;
      const load = async (append = false) => {
        const current = ++sequence, query = search.value.trim();
        if (!append) page = 0;
        status.textContent = "Загружаем артикулы…"; more.disabled = true;
        try {
          const result = await api(`/api/miniapp/admin/catalog/options?${new URLSearchParams({page:String(page), page_size:"20", q:query})}`);
          if (current !== sequence || !form.isConnected) return;
          const selected = select.selectedOptions[0];
          if (!append) { const placeholder = new Option("Выберите артикул", ""); select.replaceChildren(placeholder); if (selected?.value) select.add(selected); }
          const existing = new Set([...select.options].map(option => option.value));
          for (const article of result.items) if (!existing.has(String(article.id))) {
            const option = new Option(`${article.name} (${searchPanel ? "" : "SKU: "}${article.sku})`, String(article.id));
            if (searchPanel) option.dataset.modelName = article.name;
            select.add(option);
          }
          if (selected?.value) select.value = selected.value;
          status.textContent = result.total ? `Найдено артикулов: ${result.total}` : "Артикулы не найдены.";
          more.hidden = (page + 1) * result.page_size >= result.total;
        } catch (error) { if (current === sequence) { status.textContent = `Не удалось загрузить артикулы: ${error.message}`; more.textContent = "Повторить"; more.hidden = false; } }
        finally { if (current === sequence) more.disabled = false; }
      };
      search.addEventListener("input", () => { sequence++; clearTimeout(timer); timer = setTimeout(() => { more.textContent = "Показать ещё артикулы"; void load(); }, 300); });
      more.addEventListener("click", () => { if (more.textContent !== "Повторить") page++; more.textContent = "Показать ещё артикулы"; void load(true); });
      void load();
    }
  }

  function equipmentSavePayload(data, value, expected) {
    return {
      id: value.id || null, article_id: Number(data.get("article_id")), serial: data.get("serial"),
      inventory_code: data.get("inventory_code"), location: data.get("location"), condition: data.get("condition"),
      health: value.health ?? null, charge: value.charge ?? null, expected_before: expected,
    };
  }

  function installCatalogEditorTabs(wrapper) {
    const tablist = wrapper.querySelector('[role="tablist"]');
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    function select(tab) {
      for (const candidate of tabs) {
        const selected = candidate === tab;
        candidate.setAttribute("aria-selected", String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        wrapper.querySelector(`#${candidate.getAttribute("aria-controls")}`).hidden = !selected;
      }
    }
    for (const tab of tabs) tab.addEventListener("click", () => select(tab));
    tablist.addEventListener("keydown", event => {
      const index = tabs.indexOf(event.target);
      const next = {ArrowLeft:(index + tabs.length - 1) % tabs.length, ArrowRight:(index + 1) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
      if (index < 0 || next === undefined) return;
      event.preventDefault(); select(tabs[next]); tabs[next].focus();
    });
    return panel => {
      const tab = tabs.find(candidate => candidate.getAttribute("aria-controls") === panel?.id);
      if (tab) select(tab);
    };
  }

  function restoreCatalogEditorOrigin(result, editor, targetSelector, refreshError = null) {
    renderAdminCatalog(result);
    const target = $("admin-content").querySelector(targetSelector);
    if (editor.returnScroll) window.scrollTo(editor.returnScroll.x, editor.returnScroll.y);
    (target || $("admin-catalog-heading"))?.focus({preventScroll:true});
    if (target) scrollElementIntoView(target, {block:"nearest"});
    if (refreshError) showError(`Не удалось обновить каталог после сохранения: ${refreshError.message}`);
  }

  function existingEquipmentEditor(wrapper, result, editor) {
    const value = editor.value;
    const path = `/api/miniapp/admin/catalog/equipment/${value.id}`;
    const canEditFeatures = state.role?.staff_role === "admin";
    const articleName = id => {
      const article = result.articles.find(candidate => candidate.id === id);
      return article ? catalogTitle(article) : "";
    };
    const options = result.articles.map(article => `<option value="${article.id}" data-model-name="${escapeHtml(article.name)}" ${value.article_id === article.id ? "selected" : ""}>${escapeHtml(article.name)} (${escapeHtml(article.sku)})</option>`).join("");
    wrapper.classList.add("instance-editor");
    wrapper.innerHTML = `
      <header class="instance-editor-header">
        <button class="button ghost instance-editor-back catalog-editor-back" type="button"><svg class="icon" aria-hidden="true"><use href="#icon-back"></use></svg>Назад</button>
        <h3>Изменить экземпляр</h3>
        <p class="instance-editor-context"><strong>${escapeHtml(articleName(value.article_id))}</strong>${value.asset_code ? `<span>Код экземпляра ${escapeHtml(value.asset_code)}</span>` : ""}</p>
      </header>
      <div class="instance-editor-tabs" role="tablist" aria-label="Разделы экземпляра">
        <button type="button" role="tab" id="instance-data-tab" aria-controls="instance-data" aria-selected="true">Данные</button>
        <button type="button" role="tab" id="instance-owner-tab" aria-controls="instance-owner" aria-selected="false" tabindex="-1">Владелец</button>
        <button type="button" role="tab" id="instance-notes-tab" aria-controls="instance-notes" aria-selected="false" tabindex="-1">Особенности</button>
      </div>
      <section class="instance-editor-pane" id="instance-data" role="tabpanel" aria-labelledby="instance-data-tab">
        <form class="catalog-form">
          <div>
            <label class="field"><span>Модель</span><select name="article_id" required><option value="">Выберите модель</option>${options}</select></label>
            <details class="instance-model-search" hidden><summary>Найти модель по названию или SKU</summary></details>
          </div>
          <div class="instance-field-pair">
            <label class="field"><span>Серийный номер</span><input name="serial" value="${escapeHtml(value.serial || "")}" maxlength="80" aria-describedby="instance-serial-help"><small id="instance-serial-help">Может отсутствовать или повторяться.</small></label>
            <label class="field"><span>Инвентарный код</span><input name="inventory_code" value="${escapeHtml(value.inventory_code || "")}" maxlength="80" aria-describedby="instance-inventory-help"><small id="instance-inventory-help">Если указан, должен быть уникальным.</small></label>
          </div>
          <div class="instance-field-pair">
            <label class="field"><span>Складская ячейка</span><input name="location" value="${escapeHtml(value.location || "")}" maxlength="120" placeholder="A-01"></label>
            <label class="field"><span>Состояние</span><select name="condition">${selectOptions(["available", "maintenance", "retired"], value.condition || "available")}</select></label>
          </div>
          <div class="instance-editor-actions"><p class="supporting" role="status"></p><button class="button primary" type="submit">Сохранить экземпляр</button></div>
        </form>
      </section>
      <section class="instance-editor-pane" id="instance-owner" role="tabpanel" aria-labelledby="instance-owner-tab" hidden>
        <form class="equipment-owner-form">
          <label class="field"><span>Имя или организация</span><input name="name" maxlength="200" value="${escapeHtml(value.owner || "")}"></label>
          <label class="field"><span>Контакт владельца</span><input name="contact" maxlength="300" value="${escapeHtml(value.owner_contact || "")}" placeholder="Телефон или Telegram"></label>
          <div class="instance-editor-actions"><p class="supporting" role="status"></p><button class="button primary" type="submit">Сохранить владельца</button></div>
        </form>
      </section>
      <section class="instance-editor-pane" id="instance-notes" role="tabpanel" aria-labelledby="instance-notes-tab" hidden>
        <ul class="equipment-feature-list" aria-label="Особенности экземпляра"></ul>
        <p class="supporting instance-no-features" hidden>Особенности пока не добавлены.</p>
        <form class="feature-add">
          <label class="field"><span>Новая особенность</span><textarea name="description" rows="3" maxlength="2000" required></textarea></label>
          <div class="instance-editor-actions">
            <p class="supporting" role="status"></p>
            <button class="button ghost feature-cancel" type="button" hidden>Отмена</button>
            <button class="button ghost danger feature-remove" type="button" hidden>Удалить</button>
            <button class="button primary" type="submit">Добавить особенность</button>
          </div>
        </form>
      </section>`;

    const backButton = wrapper.querySelector(".instance-editor-back");
    const dataForm = wrapper.querySelector(".catalog-form");
    const ownerForm = wrapper.querySelector(".equipment-owner-form");
    const noteForm = wrapper.querySelector(".feature-add");
    const forms = [dataForm, ownerForm, noteForm];
    const features = (value.features || []).map(feature => ({...feature}));
    const featureList = wrapper.querySelector(".equipment-feature-list");
    const description = noteForm.elements.namedItem("description");
    const noteLabel = noteForm.querySelector(".field > span");
    const noteSubmit = noteForm.querySelector('[type="submit"]');
    const cancelNote = noteForm.querySelector(".feature-cancel");
    const removeNote = noteForm.querySelector(".feature-remove");
    let activeNote = null;
    let changed = false;
    let expected = {
      article_id: value.article_id, serial_number: value.serial || null, asset_inventory_code: value.inventory_code || null,
      condition: value.condition, storage_location: value.location || "", health_percent: value.health ?? null, charge_percent: value.charge ?? null,
    };

    installCatalogEditorTabs(wrapper);

    const searchPanel = wrapper.querySelector(".instance-model-search");
    if (result.page != null) { searchPanel.hidden = false; installArticlePickers(dataForm, searchPanel); }
    const draft = installCatalogDraft(dataForm, editor);
    registerStaffForm(ownerForm); registerStaffForm(noteForm);
    for (const form of forms) form.addEventListener("input", () => {
      form.querySelector(".instance-editor-actions [role='status']").textContent = "";
    });

    async function perform(action, form) {
      if (wrapper.getAttribute("aria-busy") === "true") return;
      const focus = form?.contains(document.activeElement) ? document.activeElement : null;
      clearError();
      wrapper.setAttribute("aria-busy", "true");
      backButton.disabled = true;
      if (form) form.inert = true;
      try { await action(); }
      catch (error) { showError(error.message); }
      finally {
        if (form) form.inert = false;
        backButton.disabled = false;
        wrapper.removeAttribute("aria-busy");
        if (focus?.getClientRects().length && document.activeElement === document.body) focus.focus({preventScroll:true});
      }
    }

    backButton.addEventListener("click", () => {
      if (forms.some(staffFormDirty) && !window.confirm("Выйти без сохранения? Несохранённые изменения и черновик будут удалены.")) return;
      void perform(async () => {
        let next = result, refreshError;
        if (changed) {
          try { next = await api(catalogPagePath()); }
          catch (error) { refreshError = error; }
        }
        draft.clear();
        restoreCatalogEditorOrigin(next, editor, `[data-edit-asset-id="${Number(value.id)}"]`, refreshError);
      });
    });

    dataForm.addEventListener("submit", event => {
      event.preventDefault();
      const payload = equipmentSavePayload(new FormData(dataForm), value, expected);
      void perform(async () => {
        await api("/api/miniapp/admin/catalog/equipment", {method:"POST", body:JSON.stringify(payload)});
        const identifier = input => ["-", "—"].includes(input.trim()) ? "" : input.trim();
        const serial = identifier(payload.serial), inventoryCode = identifier(payload.inventory_code);
        dataForm.elements.serial.value = serial;
        dataForm.elements.inventory_code.value = inventoryCode;
        dataForm.elements.location.value = payload.location.trim();
        expected = {
          ...expected, article_id:payload.article_id, serial_number:serial || null, asset_inventory_code:inventoryCode || null,
          condition:payload.condition, storage_location:dataForm.elements.location.value,
        };
        const model = dataForm.elements.article_id.selectedOptions[0];
        wrapper.querySelector(".instance-editor-context strong").textContent = articleName(payload.article_id) ||
          model.dataset.modelName || model.textContent;
        draft.rebase({...editor, value:{...value, article_id:payload.article_id}});
        registerStaffForm(dataForm);
        dataForm.querySelector(".instance-editor-actions [role='status']").textContent = "Данные сохранены";
        changed = true;
      }, dataForm);
    });

    ownerForm.addEventListener("submit", event => {
      event.preventDefault();
      const name = ownerForm.elements.namedItem("name"), contact = ownerForm.elements.namedItem("contact");
      const body = {name:name.value.trim(), contact:contact.value.trim()};
      void perform(async () => {
        await api(path + "/owner", {method:"PUT", body:JSON.stringify(body)});
        name.value = body.name; contact.value = body.contact;
        registerStaffForm(ownerForm);
        ownerForm.querySelector('[role="status"]').textContent = "Владелец сохранён";
        changed = true;
      }, ownerForm);
    });

    function selectNote(feature) {
      activeNote = feature;
      description.value = feature?.description || "";
      noteLabel.textContent = feature ? "Особенность" : "Новая особенность";
      noteSubmit.textContent = feature ? "Сохранить особенность" : "Добавить особенность";
      cancelNote.hidden = removeNote.hidden = !feature;
      noteForm.querySelector('[role="status"]').textContent = "";
      registerStaffForm(noteForm);
    }
    function guardNoteChange() {
      return !staffFormDirty(noteForm) || window.confirm("Отменить несохранённые изменения особенности?");
    }
    function renderFeatures() {
      featureList.replaceChildren();
      wrapper.querySelector(".instance-no-features").hidden = features.length > 0;
      for (const feature of features) {
        const row = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = feature.description;
        row.append(text);
        if (canEditFeatures) row.append(plainButton("Изменить", () => {
          if (wrapper.getAttribute("aria-busy") === "true" || activeNote === feature || !guardNoteChange()) return;
          selectNote(feature); description.focus();
        }, "ghost compact"));
        featureList.append(row);
      }
    }
    renderFeatures();
    cancelNote.addEventListener("click", () => { if (guardNoteChange()) { selectNote(null); description.focus(); } });
    removeNote.addEventListener("click", () => {
      const feature = activeNote;
      if (!feature || !window.confirm("Удалить особенность?")) return;
      void perform(async () => {
        await api(`${path}/features/${feature.id}`, {method:"DELETE"});
        features.splice(features.indexOf(feature), 1);
        selectNote(null); renderFeatures();
        noteForm.querySelector('[role="status"]').textContent = "Особенность удалена";
        changed = true;
      }, noteForm);
    });
    noteForm.addEventListener("submit", event => {
      event.preventDefault();
      const feature = activeNote, text = description.value.trim();
      if (!text) { description.value = ""; description.reportValidity(); return; }
      void perform(async () => {
        const saved = await api(feature ? `${path}/features/${feature.id}` : path + "/features", {
          method:feature ? "PUT" : "POST", body:JSON.stringify({description:text}),
        });
        if (feature) feature.description = text;
        else features.push({id:saved.id, description:text});
        selectNote(null); renderFeatures();
        noteForm.querySelector('[role="status"]').textContent = "Особенность сохранена";
        changed = true;
      }, noteForm);
    });
    return wrapper;
  }

  function articleEditorState(article) {
    return {
      sku:article.sku, name:article.name, kind:article.kind || "", brand:article.brand || "",
      key_spec:article.key_spec || "", description:article.description || "", composition:article.composition || "",
      category:article.category, inspection_profile:article.inspection_profile || "generic",
      buffer_hours:article.buffer_hours ?? 24, image_url:article.image_url || "", is_active:article.active !== false,
    };
  }

  function articleFormState(data, article) {
    return {
      sku:data.get("sku").trim(), name:data.get("name").trim(), kind:data.get("kind").trim(),
      brand:data.get("brand").trim(), key_spec:data.get("key_spec").trim(), description:data.get("description").trim(),
      composition:data.get("composition").trim(), category:data.get("category"), inspection_profile:data.get("inspection_profile"),
      buffer_hours:article.buffer_hours ?? 24, image_url:data.get("image_url").trim(), is_active:data.has("active"),
    };
  }

  function saveArticleForm(article, state, expected) {
    const {is_active, ...fields} = state;
    return api("/api/miniapp/admin/catalog/articles", {method:"POST", body:JSON.stringify({
      ...fields, id:article.id || null, rate:"0", active:is_active, expected_before:expected,
    })});
  }

  function bindCatalogCategoryCreation(form) {
    form.querySelector(".create-category")?.addEventListener("click", async () => {
      try {
        const category = await createCategoryDialog();
        if (category && form.isConnected) {
          const select = form.elements.category;
          select.innerHTML = categoryOptions(category.code);
          select.dispatchEvent(new Event("change", {bubbles:true}));
        }
      } catch (error) { showError(error.message); }
    });
  }

  function existingArticleEditor(wrapper, result, editor) {
    const article = editor.value;
    const photoPath = `/api/miniapp/admin/catalog/articles/${article.id}/photo`;
    const sections = [["data","Данные"], ["description","Описание"], ["kit","Комплект"], ["photo","Фото"]];
    const field = (name, label, maxlength, required = false) => `<label class="field"><span>${label}</span><input name="${name}" maxlength="${maxlength}" value="${escapeHtml(article[name] || "")}" ${required ? "required" : ""}></label>`;
    wrapper.classList.add("instance-editor", "article-editor");
    wrapper.innerHTML = `
      <header class="instance-editor-header">
        <button class="button ghost instance-editor-back catalog-editor-back" type="button"><svg class="icon" aria-hidden="true"><use href="#icon-back"></use></svg>Назад</button>
        <h3>Изменить артикул</h3>
        <p class="instance-editor-context"><strong>${escapeHtml(article.name)}</strong><span>${escapeHtml(article.sku)}</span></p>
      </header>
      <div class="instance-editor-tabs" role="tablist" aria-label="Разделы артикула">
        ${sections.map(([id, label], index) => `<button type="button" role="tab" id="article-editor-${id}-tab" aria-controls="article-editor-${id}" aria-selected="${index === 0}" ${index ? 'tabindex="-1"' : ""}>${label}</button>`).join("")}
      </div>
      <form class="catalog-form">
        <section class="article-editor-pane" id="article-editor-data" role="tabpanel" aria-labelledby="article-editor-data-tab">
          ${field("name","Название модели",200,true)}
          <div class="instance-field-pair">
            ${field("sku","Артикул (SKU)",80,true)}
            <div><label class="field"><span>Категория</span><select name="category">${categoryOptions(article.category || "generic")}</select></label>
              <button class="button ghost compact create-category" type="button">Создать категорию</button></div>
          </div>
          <label class="check-row"><input name="active" type="checkbox" ${article.active !== false ? "checked" : ""}><span>Показывать клиентам в каталоге</span></label>
        </section>
        <section class="article-editor-pane" id="article-editor-description" role="tabpanel" aria-labelledby="article-editor-description-tab" hidden>
          <div class="instance-field-pair">${field("brand","Бренд",100)}${field("kind","Вид оборудования",80)}</div>
          ${field("key_spec","Основная характеристика",120)}
          <label class="field"><span>Описание</span><textarea name="description" rows="3" maxlength="4000">${escapeHtml(article.description || "")}</textarea></label>
        </section>
        <section class="article-editor-pane" id="article-editor-kit" role="tabpanel" aria-labelledby="article-editor-kit-tab" hidden>
          <label class="field"><span>Профиль проверки</span><select name="inspection_profile">${selectOptions(["generic","camera","optics","light","battery"], article.inspection_profile || "generic")}</select></label>
          <label class="field"><span>Комплектация для расписки</span><textarea name="composition" rows="4" maxlength="4000">${escapeHtml(article.composition || "")}</textarea><small>Один элемент на строку. Список используется при проверке экземпляра.</small></label>
        </section>
        <section class="article-editor-pane" id="article-editor-photo" role="tabpanel" aria-labelledby="article-editor-photo-tab" hidden>
          <div class="article-editor-photo-preview"></div>
          <div class="article-editor-photo-actions">
            <label class="button secondary article-editor-file"><span>Загрузить фото</span><input type="file" accept="image/jpeg,image/png,image/webp"></label>
            <button class="button ghost article-editor-remove-photo" type="button">Удалить фото</button>
          </div>
          <input type="hidden" name="photo_action">
          <label class="field"><span>HTTPS-ссылка на фото</span><input name="image_url" type="url" maxlength="500" value="${escapeHtml(article.image_url || "")}" placeholder="https://…"></label>
        </section>
        <div class="instance-editor-actions"><p class="supporting" role="status"></p><button class="button primary" type="submit">Сохранить артикул</button></div>
      </form>`;

    const form = wrapper.querySelector("form");
    const status = wrapper.querySelector(".instance-editor-actions [role='status']");
    const back = wrapper.querySelector(".catalog-editor-back");
    const fileInput = form.querySelector('input[type="file"]');
    const photoAction = form.elements.photo_action;
    const preview = form.querySelector(".article-editor-photo-preview");
    const showPanel = installCatalogEditorTabs(wrapper);
    const draft = installCatalogDraft(form, editor);
    let expected = articleEditorState(article);
    let stagedFile = null, previewUrl = "", changed = false;
    bindCatalogCategoryCreation(form);

    function renderPhoto() {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ""; }
      if (stagedFile) {
        const image = document.createElement("img");
        previewUrl = URL.createObjectURL(stagedFile); image.src = previewUrl; image.alt = "Предпросмотр фото модели";
        bindCatalogPhoto(image, article.name);
        preview.replaceChildren(image);
      } else {
        const imageUrl = form.elements.image_url.value.trim() === article.image_url ? article.image_url : "";
        const imageData = photoAction.value === "remove" ? "" : article.image_data;
        preview.innerHTML = catalogMedia({...article, image_data:imageData, image_url:imageUrl}, "article-editor");
      }
      const hasPhoto = Boolean(stagedFile || (photoAction.value !== "remove" && (article.image_data || form.elements.image_url.value.trim())));
      form.querySelector(".article-editor-file span").textContent = hasPhoto ? "Заменить фото" : "Загрузить фото";
      form.querySelector(".article-editor-remove-photo").hidden = !hasPhoto;
    }
    renderPhoto();
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      stagedFile = file; photoAction.value = "upload"; status.textContent = ""; renderPhoto();
    });
    form.querySelector(".article-editor-remove-photo").addEventListener("click", () => {
      stagedFile = null;
      photoAction.value = article.image_data ? "remove" : "";
      form.elements.image_url.value = "";
      status.textContent = ""; renderPhoto();
    });
    form.addEventListener("input", event => {
      status.textContent = "";
      if (event.target === form.elements.image_url && (!article.image_data || photoAction.value === "remove")) {
        form.querySelector(".article-editor-remove-photo").hidden = !form.elements.image_url.value.trim();
      }
    });
    form.addEventListener("invalid", event => showPanel(event.target.closest('[role="tabpanel"]')), true);

    function setBusy(busy) {
      if (busy) wrapper.setAttribute("aria-busy", "true");
      else wrapper.removeAttribute("aria-busy");
      form.inert = busy; back.disabled = busy;
    }
    back.addEventListener("click", async () => {
      if (staffFormDirty(form) && !window.confirm("Выйти без сохранения? Несохранённые изменения и черновик будут удалены.")) return;
      setBusy(true); clearError();
      let next = result, refreshError;
      if (changed) {
        try { next = await api(catalogPagePath()); }
        catch (error) { refreshError = error; }
      }
      draft.clear();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      restoreCatalogEditorOrigin(next, editor, `[data-edit-article-id="${Number(article.id)}"]`, refreshError);
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (wrapper.getAttribute("aria-busy") === "true") return;
      const fields = articleFormState(new FormData(form), article);
      setBusy(true); clearError(); status.textContent = "Сохраняем…";
      let savedFields = false;
      try {
        const upload = stagedFile ? await prepareCatalogPhoto(stagedFile) : null;
        if (Object.keys(fields).some(key => fields[key] !== expected[key])) {
          await saveArticleForm(article, fields, expected);
          const {is_active, ...saved} = fields;
          Object.assign(article, saved, {active:is_active});
          expected = fields;
          for (const [key, value] of Object.entries(saved)) {
            const input = form.elements.namedItem(key);
            if (input) input.value = value;
          }
          const context = wrapper.querySelector(".instance-editor-context");
          context.querySelector("strong").textContent = fields.name;
          context.querySelector("span").textContent = fields.sku;
          const pending = photoAction.value;
          photoAction.value = "";
          draft.rebase(editor); registerStaffForm(form);
          photoAction.value = pending;
          savedFields = changed = true;
        }
        if (upload) {
          const updated = await api(photoPath, {method:"PUT", body:upload});
          article.image_data = updated.image_data;
          changed = true;
        } else if (photoAction.value === "remove") {
          await api(photoPath, {method:"DELETE"});
          article.image_data = "";
          changed = true;
        }
        photoAction.value = ""; stagedFile = null;
        draft.rebase(editor); registerStaffForm(form); renderPhoto();
        status.textContent = "Артикул сохранён";
      } catch (error) {
        status.textContent = savedFields ? "Поля сохранены. Повторите сохранение фото." : "";
        showError(error.message);
      } finally {
        setBusy(false);
        if (document.activeElement === document.body) event.submitter?.focus({preventScroll:true});
      }
    });
    return wrapper;
  }

  function catalogEditor(result, editor) {
    const wrapper = document.createElement("article"); wrapper.className = "admin-card editor-card";
    const value = editor.value || {};
    if (editor.type === "equipment" && value.id) return existingEquipmentEditor(wrapper, result, editor);
    if (editor.type === "article" && value.id) return existingArticleEditor(wrapper, result, editor);
    const options = result.articles.map((article) => {
      const type = article.description || categoryLabel(article.category);
      return `<option value="${article.id}" ${Number(value.article_id) === article.id ? "selected" : ""}>${escapeHtml(article.name)} (${escapeHtml(type)}, SKU: ${escapeHtml(article.sku)})</option>`;
    }).join("");
    if (editor.type === "article") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить артикул" : "Новый артикул"}</h3><form class="catalog-form form-grid"><label class="field"><span>SKU / артикул</span><input name="sku" value="${escapeHtml(value.sku || "")}" maxlength="80" required></label><label class="field"><span>Полное название</span><input name="name" value="${escapeHtml(value.name || "")}" maxlength="200" required></label><label class="field"><span>Вид (например, camera или Карта памяти)</span><input name="kind" value="${escapeHtml(value.kind || "")}" maxlength="80"></label><label class="field"><span>Бренд</span><input name="brand" value="${escapeHtml(value.brand || "")}" maxlength="100"></label><label class="field"><span>Основная характеристика</span><input name="key_spec" value="${escapeHtml(value.key_spec || "")}" maxlength="120"></label><label class="field wide"><span>Описание</span><textarea name="description" maxlength="4000">${escapeHtml(value.description || "")}</textarea></label><label class="field wide"><span>Комплектация для расписки</span><textarea name="composition" maxlength="4000" placeholder="Оставьте пустым, пока состав комплекта не определён">${escapeHtml(value.composition || "")}</textarea><small>Один элемент на строке. Состав сохраняется для модели и проверяется поэлементно.</small></label><label class="field"><span>Категория</span><select name="category">${categoryOptions(value.category || "generic")}</select><button type="button" class="button ghost create-category">Создать категорию</button></label><label class="field"><span>Профиль проверки</span><select name="inspection_profile">${selectOptions(["generic", "camera", "optics", "light", "battery"], value.inspection_profile || "generic")}</select></label><label class="field wide"><span>HTTPS-ссылка на фото</span><input name="image_url" type="url" value="${escapeHtml(value.image_url || "")}" maxlength="500" placeholder="https://…"></label><label class="check-row wide"><input name="active" type="checkbox" ${value.active !== false ? "checked" : ""}><span>Показывать клиентам в каталоге</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить артикул</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else if (editor.type === "equipment") {
      wrapper.innerHTML = `<h3>${value.id ? "Изменить экземпляр" : "Новый экземпляр"}</h3><form class="catalog-form form-grid"><label class="field wide"><span>Артикул</span><select name="article_id" required><option value="">Выберите артикул</option>${options}</select></label><label class="field"><span>S/N</span><input name="serial" value="${escapeHtml(value.serial || "")}" maxlength="80"></label><label class="field"><span>Инвентарный код</span><input name="inventory_code" value="${escapeHtml(value.inventory_code || "")}" maxlength="80"></label><label class="field"><span>Складская ячейка</span><input name="location" value="${escapeHtml(value.location || "")}" maxlength="120" placeholder="A-01"></label><label class="field"><span>Состояние</span><select name="condition">${selectOptions(["available", "maintenance", "retired"], value.condition || "available")}</select></label><div class="info-strip wide"><span class="info-icon">i</span><p>S/N может отсутствовать или повторяться. Инвентарный код, если указан, уникален.</p></div><div class="action-row wide"><button class="button primary" type="submit">Сохранить экземпляр</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    } else {
      wrapper.innerHTML = `<h3>Настроить состав комплекта</h3><form class="catalog-form form-grid"><label class="field"><span>Основная модель</span><select name="parent_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Модель в составе комплекта</span><select name="child_article_id" required><option value="">Выберите</option>${options}</select></label><label class="field"><span>Количество на один комплект</span><input name="quantity" type="number" min="1" max="30" value="1" required></label><label class="check-row"><input name="billable" type="checkbox"><span>Оплачивается отдельно</span></label><div class="action-row wide"><button class="button primary" type="submit">Сохранить состав</button><button class="button ghost editor-cancel" type="button">Отмена</button></div></form>`;
    }
    if (editor.type === "article") {
      const form = wrapper.querySelector("form");
      for (const name of ["inspection_profile", "category", "name", "sku"]) form.prepend(form.querySelector(`[name="${name}"]`).closest("label"));
    }
    const editorForm = wrapper.querySelector("form");
    if (result.page != null && editor.type !== "article") installArticlePickers(editorForm);
    const {clear:clearDraft} = installCatalogDraft(editorForm, editor);
    wrapper.querySelector(".editor-cancel").addEventListener("click", () => {
      const forms = [...wrapper.querySelectorAll("form")];
      if (forms.some(staffFormDirty) && !window.confirm("Отменить несохранённые изменения? Черновик будет удалён.")) return;
      clearDraft(); forms.forEach(registerStaffForm); renderAdminCatalog(result);
    });
    bindCatalogCategoryCreation(editorForm);
    wrapper.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        if (editor.type === "article") {
          await saveArticleForm(value, articleFormState(data, value), null);
        }
        else if (editor.type === "equipment") await api("/api/miniapp/admin/catalog/equipment", { method: "POST", body: JSON.stringify(equipmentSavePayload(data, value, null)) });
        else await api("/api/miniapp/admin/catalog/dependencies", { method: "PUT", body: JSON.stringify({ parent_article_id: Number(data.get("parent_article_id")), child_article_id: Number(data.get("child_article_id")), quantity: Number(data.get("quantity")), billable: data.get("billable") === "on" }) });
        clearDraft(); registerStaffForm(form); await showAdmin("catalog");
      } catch (error) { showError(error.message); submit.disabled = false; }
    });
    return wrapper;
  }

  function selectOptions(values, selected) {
    const labels = { generic: "Общий", camera: "Камера", optics: "Оптика", light: "Свет", battery: "Аккумулятор", accessory: "Аксессуар", available: "На складе / доступен", maintenance: "В ремонте", retired: "Списан" };
    return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${labels[value] || value}</option>`).join("");
  }

  document.addEventListener("click", event => {
    const backdrop = event.target;
    if (!window.matchMedia("(min-width: 768px)").matches || !backdrop?.classList?.contains("dialog-backdrop") || backdrop.classList.contains("workflow-dialog")) return;
    const closeId = {"support-dialog":"support-close", "release-dialog":"release-close", "onboarding-dialog":"onboarding-skip", "rework-dialog":"rework-cancel", "identity-review-dialog":"identity-review-cancel"}[backdrop.id];
    if (!closeId || backdrop.hidden) return;
    const sensitive = [...backdrop.querySelectorAll('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')].some(input => input.type === "file" ? input.files?.length : input.value.trim());
    if (sensitive && !window.confirm("Отменить? Изменения не сохранятся.")) return;
    $(closeId).click();
  });
  $("document-viewer").addEventListener("click", event => { if (event.target === $("document-viewer") && window.matchMedia("(min-width: 768px)").matches) closeDocumentViewer(); });

  async function externalOccupancyDialog(asset) {
    const existing = await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/blocks`);
    const initialStart = moscowInput(new Date().toISOString());
    const initialEnd = moscowInput(new Date(Date.now() + 3600000).toISOString());
    const content = `<label class="field"><span>Действие</span><select name="operation"><option value="new">Отметить занятость</option>${existing.items.map(item => `<option value="${item.id}">Освободить: ${escapeHtml(item.reason.slice(0,120))}, до ${escapeHtml(dateText(item.end))}</option>`).join("")}</select></label><div class="external-period"><div class="range-calendar external-calendar" aria-label="Календарь занятости вне сервиса"></div><div class="external-time-grid"><label class="field"><span class="external-start-label">Начало (МСК)</span><input type="time" class="external-start-time" value="${initialStart.slice(11,16)}" required></label><label class="field"><span class="external-end-label">Конец (МСК)</span><input type="time" class="external-end-time" value="${initialEnd.slice(11,16)}" required></label></div><input type="hidden" name="start" value="${initialStart}"><input type="hidden" name="end" value="${initialEnd}"><p class="external-warning workflow-hint" role="status" aria-live="polite">Загружаем занятость…</p><button type="button" class="button ghost external-retry" hidden>Повторить загрузку занятости</button><label class="field"><span>Причина (видна клиентам)</span><textarea name="reason" maxlength="2000" required></textarea></label></div>`;
    let schedule = [], loaded = false, savingWarnings = [];
    const saved = await workflowDialog("Занятость вне сервиса", content, "Сохранить", dialog => {
      const start = dialog.querySelector('[name="start"]'), end = dialog.querySelector('[name="end"]');
      const startTime = dialog.querySelector('.external-start-time'), endTime = dialog.querySelector('.external-end-time');
      const warning = dialog.querySelector('.external-warning'), retry = dialog.querySelector('.external-retry');
      const overlaps = (left, right, item) => Date.parse(item.start) < right && (item.held_until_return || !item.end || Date.parse(item.end) > left);
      const update = range => {
        start.value = range.start && startTime.value ? `${range.start}T${startTime.value}` : '';
        end.value = range.end && endTime.value ? `${range.end}T${endTime.value}` : '';
        dialog.querySelector('.external-start-label').textContent = `Начало${range.start ? `: ${bookingDateLabel(range.start)}` : ''} (МСК)`;
        dialog.querySelector('.external-end-label').textContent = `Конец${range.end ? `: ${bookingDateLabel(range.end)}` : ''} (МСК)`;
        const left = Date.parse(`${start.value}:00+03:00`), right = Date.parse(`${end.value}:00+03:00`);
        const matches = schedule.filter(item => overlaps(left, right, item));
        warning.classList.toggle('has-overlap', matches.length > 0);
        warning.textContent = !loaded ? 'Занятость ещё не загружена. Отметку можно сохранить.' : !start.value || !end.value ? 'Выберите начало и конец периода.' : matches.length ? `Есть пересечения: ${matches.length}. ${[...new Set(matches.map(item=>item.kind === 'booking' ? `${item.label} — ${item.reason}` : 'Занятость вне сервиса'))].join('; ')}. Отметку можно сохранить.` : 'Пересечений с известной занятостью нет.';
      };
      const calendar = new window.PolyRentalCalendar.RangeCalendar(dialog.querySelector('.external-calendar'), {
        minimum:'', start:initialStart.slice(0,10), end:initialEnd.slice(0,10), onChange:update, onSelect:calendarImpact,
        dayNote: day => {
          const left = Date.parse(`${day}T00:00:00+03:00`), right = Date.parse(`${addIsoDays(day,1)}T00:00:00+03:00`);
          return schedule.some(item=>overlaps(left,right,item)) ? 'Уже есть занятость; выбор разрешён' : '';
        },
      });
      startTime.addEventListener('input',()=>update(calendar.range)); endTime.addEventListener('input',()=>update(calendar.range));
      const load = async () => {
        retry.hidden = true;
        try {
          const result = await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/schedule`);
          if (!dialog.isConnected) return;
          schedule = result.items; loaded = true; calendar.render(); update(calendar.range);
        } catch (_) { if (dialog.isConnected) { warning.textContent='Не удалось загрузить занятость. Отметку можно сохранить.'; retry.hidden=false; } }
      };
      retry.addEventListener('click',load);
      dialog.querySelector('[name="operation"]').addEventListener('change',event=>{
        const creating = event.target.value === 'new';
        dialog.querySelector('.external-period').hidden = !creating;
        dialog.querySelectorAll('.external-period input,.external-period textarea').forEach(input=>{input.disabled=!creating;});
      });
      update(calendar.range); void load();
    }, async data => {
      if (data.get('operation') !== 'new') { await api(`/api/miniapp/admin/catalog/blocks/${data.get('operation')}`,{method:'DELETE'}); return; }
      const start = data.get('start'), end = data.get('end');
      if (!start || !end || Date.parse(`${end}:00+03:00`) <= Date.parse(`${start}:00+03:00`)) throw new Error('Выберите начало и конец периода: конец должен быть позже начала.');
      const result = await api(`/api/miniapp/admin/catalog/equipment/${asset.id}/blocks`,{method:'POST',body:JSON.stringify({start:`${start}:00+03:00`,end:`${end}:00+03:00`,reason:data.get('reason')})});
      savingWarnings = result.warnings || [];
    });
    if (saved) {
      await showAdmin('catalog');
      if (savingWarnings.length) {
        const notice = document.createElement('div'); notice.className='stage-toast'; notice.setAttribute('role','status');
        const copy = document.createElement('span'); copy.textContent=`Занятость сохранена. Есть пересечения: ${savingWarnings.length}.`;
        const close = plainButton('×',()=>removeNotice(notice),'ghost'); close.setAttribute('aria-label','Закрыть уведомление'); notice.append(copy,close); document.body.append(notice); setTimeout(()=>removeNotice(notice),8000);
      }
    }
  }

  function showEquipmentPreview(article, opener, source = opener.getBoundingClientRect()) {
    const title = article.title?.trim() || catalogTitle(article);
    const description = article.description?.trim() || "Описание пока не добавлено.";
    const photo = article.image_data || article.image_url ? catalogMedia({...article, name:title}, "equipment-preview") : "";
    return workflowDialog(title, `${photo}<p class="equipment-preview-description">${escapeHtml(description)}</p>`, "Закрыть", dialog => {
      dialog.querySelector(".workflow-cancel").hidden = true;
      const close = dialog.querySelector('[type="submit"]');
      close.dataset.initialFocus = "";
      window.PolyRentalMotion?.morphEquipmentPreview(dialog, source, getComputedStyle(opener).borderRadius, close);
    }, null, {opener, equipmentPreview: true});
  }

  function bindEquipmentPreview(row, surface, article, {keyboard = false} = {}) {
    const holdDuration = 440;
    let gesture = null;
    let suppressClick = false;
    let previewOpen = false;
    surface.classList.add("equipment-preview-trigger");
    row.classList.add("equipment-preview-source");
    row.setAttribute("aria-keyshortcuts", keyboard ? "Enter Space" : "Shift+Enter");
    row.setAttribute("aria-description", "Удерживайте карточку, чтобы посмотреть оборудование.");
    if (keyboard) {
      row.tabIndex = 0;
      if (!row.querySelector("button, .catalog-media > img")) row.setAttribute("role", "button");
      row.setAttribute("aria-haspopup", "dialog");
    }
    const stop = () => {
      if (!gesture) return;
      clearTimeout(gesture.timer);
      gesture.listeners.abort();
      gesture = null;
      row.classList.remove("is-preview-pressed");
    };
    const show = async (source = row.getBoundingClientRect()) => {
      if (previewOpen || !row.isConnected || row.closest("[inert]") || !row.getClientRects().length) return;
      previewOpen = true;
      try {
        await showEquipmentPreview(article, row, source);
      } finally {
        previewOpen = false;
      }
    };
    surface.addEventListener("pointerdown", event => {
      stop();
      suppressClick = false;
      if (!event.isPrimary || event.button !== 0 || event.target.closest("button, a, input, select, textarea, label")) return;
      const {pointerId, clientX, clientY} = event;
      const listeners = new AbortController();
      const options = {capture:true, passive:true, signal:listeners.signal};
      row.classList.add("is-preview-pressed");
      const timer = setTimeout(() => {
        const source = row.getBoundingClientRect();
        stop();
        suppressClick = true;
        void show(source);
      }, holdDuration);
      gesture = {timer, listeners};
      window.addEventListener("pointermove", move => {
        if (move.pointerId === pointerId && Math.hypot(move.clientX - clientX, move.clientY - clientY) > 10) stop();
      }, options);
      window.addEventListener("pointerup", up => { if (up.pointerId === pointerId) stop(); }, options);
      window.addEventListener("pointercancel", cancel => { if (cancel.pointerId === pointerId) stop(); }, options);
      window.addEventListener("wheel", stop, options);
      window.addEventListener("blur", stop, options);
    });
    surface.addEventListener("contextmenu", event => {
      if (!event.target.closest("button, a, input, select, textarea")) event.preventDefault();
    });
    surface.addEventListener("dragstart", event => event.preventDefault());
    row.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    row.addEventListener("keydown", event => {
      if (event.target !== row || event.repeat || !(keyboard ? ["Enter", " "].includes(event.key) : event.shiftKey && event.key === "Enter")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void show();
    });
  }

  function workflowDialog(title, content, submitLabel = "Подтвердить", setup = null, onSubmit = null, {opener = null, equipmentPreview = false, confirmDiscard = true} = {}) {
    return new Promise((resolve) => {
      const previous = opener || window.PolyRentalDialogs?.opener() || document.activeElement;
      const dialog = document.createElement("section"); dialog.className = "dialog-backdrop workflow-dialog";
      if (equipmentPreview) {
        dialog.classList.add("equipment-preview-dialog");
        dialog.dataset.modalScroll = "overlay";
      }
      dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", title);
      dialog.dataset.dialogClose = ".workflow-cancel";
      dialog.innerHTML = `<form class="dialog-card"><h2>${escapeHtml(title)}</h2>${content}<div class="action-row"><button type="button" class="button ghost workflow-cancel">Отмена</button><button type="submit" class="button primary">${escapeHtml(submitLabel)}</button></div></form>`;
      let pending=false;
      const finish = (value, backdrop = false) => {
        if (pending) return;
        const form = dialog.querySelector("form");
        const sensitive = form.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea');
        if (value === null && confirmDiscard && staffFormDirty(form) && (!backdrop || sensitive) && !window.confirm("Отменить? Изменения не сохранятся.")) return;
        pending = true;
        const previewUrl = dialog.querySelector(".catalog-upload-preview")?.dataset.url;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const exit = window.PolyRentalMotion ? window.PolyRentalMotion.removeDialog(dialog) : (dialog.remove(), Promise.resolve());
        void exit.then(() => {
          resolve(value);
          window.PolyRentalDialogs?.restoreFocus(previous);
          // Async button handlers re-enable the opener after this promise resolves.
          requestAnimationFrame(() => window.PolyRentalDialogs?.restoreFocus(previous));
        });
      };
      dialog.querySelector(".workflow-cancel").addEventListener("click", () => finish(null));
      let previewPress = false;
      let backdropPress = false;
      dialog.addEventListener("pointerdown", event => {
        previewPress = true;
        backdropPress = event.target === dialog;
      });
      if (equipmentPreview) dialog.addEventListener("click", event => {
        // Android can retarget the click from the original hold to the new dialog.
        if (!previewPress && event.detail > 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        previewPress = false;
      }, true);
      dialog.addEventListener("click", event => {
        if (event.target === dialog && (equipmentPreview ? backdropPress : window.matchMedia("(min-width: 768px)").matches)) finish(null, true);
        backdropPress = false;
      });
      dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); if (event.key === "Tab") trapDialogFocus(event, dialog); });
      dialog.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();if(pending)return;
        const form=event.currentTarget,data=new FormData(form);
        if (!onSubmit) { finish(data);return; }
        pending=true;const buttons=[...form.querySelectorAll(dialog.classList.contains("catalog-photo-dialog") ? "button, input" : "button")], disabled=buttons.map(button=>button.disabled);buttons.forEach(button=>button.disabled=true);
        form.setAttribute("aria-busy", "true"); window.PolyRentalDialogs?.focus(dialog);
        const previousError = form.querySelector(".workflow-error");
        if (previousError) previousError.hidden = true;
        try { await onSubmit(data);pending=false;finish(data); }
        catch (error) {
          pending = false;
          form.removeAttribute("aria-busy");
          buttons.forEach((button, index) => button.disabled = disabled[index]);
          const message = previousError || document.createElement("p");
          if (!previousError) {
            message.className = "workflow-error";
            message.setAttribute("role", "alert");
            message.tabIndex = -1;
            form.querySelector(".workflow-cancel").parentElement.before(message);
          }
          message.hidden = false;
          message.textContent = error.message;
          scrollElementIntoView(message, {block:"nearest"});
          message.focus({preventScroll:true});
        }
      });
      document.body.append(dialog); window.PolyRentalDialogs?.refresh(); if (setup) setup(dialog);
      if (submitLabel === "Закрыть" && !onSubmit) {
        const close = dialog.querySelector('button[type="submit"]');
        if (!close.hidden) {
          dialog.querySelector(".workflow-cancel").hidden = true;
          dialog.dataset.dialogClose = 'button[type="submit"]';
        }
      }
      registerStaffForm(dialog.querySelector("form"));
      const initial = dialog.querySelector("[data-initial-focus]");
      if (initial) { initial.focus({preventScroll:true}); dialog.querySelector(".dialog-card").scrollTop = 0; }
      else (dialog.querySelector("input, textarea, select") || dialog.querySelector("button:not([hidden])")).focus({preventScroll:true});
    });
  }

  async function chooseAssignee(order) {
    const result = await api("/api/miniapp/admin/assignees");
    const items = (result.items || []).filter(item => Number.isInteger(item.id) && item.id > 0);
    if (!items.length) throw new Error("Нет доступных сотрудников для назначения. Обратитесь к администратору.");
    const options = items.map(item => `<option value="${item.id}" ${item.id === order.assignee_id ? "selected" : ""}>${escapeHtml(item.name || "Сотрудник")}</option>`).join("");
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
    if (status === "ready") steps = [[false, "Сотрудник подтверждает выдачу"], ];
    else {
      steps = [[Boolean(handover.returning_at || handover.operator_return) || isDone,
        handover.operator_return ? "Сотрудник подтвердил фактический возврат" : "Клиент отметил сдачу оборудования"]];
      if (admin) {
        const assets = order.assets || [];
        const checked = assets.length > 0 && assets.every(asset => Boolean(inspectionFor(order, asset, "check_in")));
        steps.push([checked || isDone, "Сотрудник проверил оборудование"]);
      }
      steps.push([isDone, "Сотрудник завершил возврат"]);
    }
    for (const [done, label] of steps) { const li = document.createElement("li"); const text = document.createElement("span"); text.textContent = label; const badge = document.createElement("span"); badge.className = `handover-badge ${done ? "done" : "waiting"}`; badge.textContent = done ? "Готово" : "Ожидается"; li.append(text, badge); list.append(li); }
    section.append(list); parent.append(section);
  }

  function workflowSnapshot(result) {
    return JSON.stringify({total: result.total, items: (result.items || []).map(order => ({id: order.id, status: order.status, return_overdue: order.return_overdue, return_risk: order.return_risk, identity_status: order.identity_status, change_status: order.change_status, change_type: order.change_type, customer_change_request: order.customer_change_request, can_request_changes: order.can_request_changes, assignee_id: order.assignee_id, starts_at: order.starts_at, ends_at: order.ends_at, items: order.items, assets: order.assets, inspections: order.inspections, handover: order.handover, receipt_available: order.receipt_available, receipt_preview_available: order.receipt_preview_available, sla: order.sla ? {stage: order.sla.stage, deadline: order.sla.deadline, breached: order.sla.breached, soon: order.sla.soon} : null}))});
  }

  function workflowRefreshSafe() {
    const active = document.activeElement;
    return !document.hidden && !state.busy && !viewportFocus?.inProgress() && !pendingDeletion && !document.querySelector('.workflow-dialog, .identity-check-review, .review-loading, .assignment-editor, .inspection-editor, .inspection-all-pass:disabled, [data-action-pending="true"]') && $("document-viewer").hidden && $("support-dialog").hidden && $("onboarding-dialog").hidden && $("release-dialog").hidden && $("rework-dialog").hidden && $("identity-review-dialog").hidden && !(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) && ![...document.querySelectorAll(".request-summary input:not([type=checkbox])")].some(input => input.value.trim());
  }

  async function refreshWorkflow() {
    if (!authorized || workflowRefreshBusy || !workflowRefreshSafe()) return;
    const view = state.view, mode = state.adminMode;
    if (view !== "orders" && !(view === "admin" && mode === "orders")) return;
    const baseline = view === "orders" ? customerOrdersSnapshot : adminOrdersSnapshot;
    if (baseline === null) return;
    const sequence = view === "orders" ? profileLoadSequence : adminRenderSequence;
    const path = view === "orders" ? `/api/miniapp/profile/history?category=${encodeURIComponent(state.profileFilter)}&page=${state.profilePage}&sort=${encodeURIComponent(state.profileSort)}&number=${encodeURIComponent(state.profileNumber)}${state.profileTargetId ? `&booking_id=${state.profileTargetId}` : ""}` : adminBookingsPath();
    workflowRefreshBusy = true;
    try {
      const result = await api(path, {fresh:true});
      if (state.view !== view || (view === "admin" && state.adminMode !== mode) || sequence !== (view === "orders" ? profileLoadSequence : adminRenderSequence) || !workflowRefreshSafe()) return;
      if (workflowSnapshot(result) !== baseline) {
        const scroll = window.scrollY;
        if (view === "orders") { await showOrders(result); window.scrollTo(window.scrollX, scroll); }
        else await showAdmin("orders", result);
      }
    } catch (_) { /* Keep the current view; retry on the next interval. */ }
    finally { workflowRefreshBusy = false; }
  }
  setInterval(refreshWorkflow, 5000);

  function receiptSummary(order) {
    const handover = order.handover || {};
    const snapshot = handover.snapshot || [];
    const items = snapshot.map(item => `<li>${escapeHtml(item.name)}${item.code ? ` #${escapeHtml(item.code)}` : ""}</li>`).join("");
    const features = snapshot.flatMap(item => (item.features || []).map(feature => `<li><strong>${escapeHtml(item.name)}</strong>: ${escapeHtml(feature.description)}</li>`)).join("");
    const exceptions = (handover.exceptions || []).map(item => `<li>${escapeHtml(item.name)}${item.component ? ` / ${escapeHtml(item.component)}` : ""}: ${escapeHtml(({missing:"Не выдано: отсутствует",faulty:"Не выдано: неисправность",replacement:"Заменено"})[item.reason] || item.reason || "")}${item.replacement_name ? ` → ${escapeHtml(item.replacement_name)}` : ""} ${escapeHtml(item.note || "")}</li>`).join("");
    return `<div class="receipt-summary"><section class="receipt-section"><h3>Состав выдачи</h3>${items ? `<ul>${items}</ul>` : "<p>Состав указан в сохранённом документе.</p>"}</section><section class="receipt-section"><h3>Особенности</h3>${features ? `<ul>${features}</ul>` : "<p>Не отмечены</p>"}</section>${exceptions ? `<section class="receipt-section"><h3>Исключения при частичной выдаче</h3><ul>${exceptions}</ul></section>` : ""}</div>`;
  }

  let stageNoticesBusy = false;
  function updateInboxDots() {
    const unread = Math.max(0, Number(inboxUnread) || 0);
    document.querySelectorAll('.notification-dot').forEach(dot => { dot.hidden = unread === 0; });
    document.querySelectorAll('.notification-bell').forEach(button => {
      button.setAttribute('aria-label', unread ? `Уведомления: ${unread} непрочитанных` : 'Уведомления');
    });
  }
  async function refreshInbox() {
    if (!authorized || preview || document.hidden) return;
    try { const result = await api('/api/miniapp/notifications/inbox?offset=0'); inboxUnread = result.unread_count ?? result.unread; updateInboxDots(); } catch (_) { /* Retry on the next poll. */ }
  }
  function notificationTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const day = new Intl.DateTimeFormat('ru', {dateStyle:'short', timeZone:'Europe/Moscow'});
    const today = new Date();
    if (day.format(date) === day.format(today)) {
      return new Intl.DateTimeFormat('ru', {hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow'}).format(date);
    }
    if (day.format(date) === day.format(Date.now() - 86400000)) return 'Вчера';
    return new Intl.DateTimeFormat('ru', {day:'numeric', month:'short', timeZone:'Europe/Moscow'}).format(date);
  }
  function appendInboxItem(item) {
    const support = item.kind === 'support';
    const tone = item.tone === 'urgent' ? 'urgent' : support ? 'support' : item.kind === 'booking' ? 'booking' : 'notification';
    const expandable = Boolean(item.support_message_id || item.booking_id);
    const row = document.createElement(expandable ? 'details' : 'article');
    row.className = 'notification-item'; row.dataset.tone = tone;
    const head = document.createElement(expandable ? 'summary' : 'div'); head.className = 'notification-item-head';
    const icon = document.createElement('span'); icon.className = 'notification-item-icon'; icon.setAttribute('aria-hidden','true');
    const symbol = support ? 'support-message' : tone === 'booking' ? 'box' : 'info';
    icon.innerHTML = `<svg class="icon"><use href="#icon-${symbol}"></use></svg>`;
    const copy = document.createElement('div'); copy.className = 'notification-item-copy';
    const meta = document.createElement('div'); meta.className = 'notification-item-meta';
    const category = document.createElement('span');
    category.textContent = support && item.preview ? `Поддержка · ${item.title}`
      : ({support:'Поддержка', urgent:'Возврат', booking:'Бронирование', notification:'Уведомление'})[tone];
    meta.append(category);
    if (item.unread) {
      const unread = document.createElement('span'); unread.className = 'notification-item-unread';
      unread.textContent = 'Новое'; meta.append(unread);
    }
    const title = document.createElement('strong');
    const lines = String(item.message || '').split('\n').map(line=>line.trim()).filter(line=>line && !line.startsWith('Автор:') && line !== 'Открыть заявку');
    const fallbackTitle = lines.shift();
    title.textContent = item.preview || item.title || fallbackTitle || 'Уведомление';
    copy.append(meta, title);
    const summary = item.summary ?? lines.join(' ');
    if (summary) { const message = document.createElement('p'); message.textContent = summary; copy.append(message); }
    const date = document.createElement('time'); date.dateTime = item.created_at; date.textContent = notificationTime(item.created_at); date.title = dateText(item.created_at);
    head.append(icon, copy, date); row.append(head);
    const detail = document.createElement('div'); detail.className = 'notification-item-detail';
    if (support && item.support_message_id) {
      const body = document.createElement('p'); body.className = 'notification-item-message';
      detail.append(body);
      let loading = false, loaded = false;
      async function loadMessage() {
        if (!row.open || loading || loaded) return;
        loading = true; body.textContent = 'Загружаем сообщение…';
        try {
          const result = await api(`/api/miniapp/notifications/inbox/support/${item.support_message_id}`);
          body.textContent = result.text; loaded = true;
        } catch (_) {
          body.textContent = 'Не удалось открыть сообщение. ';
          body.append(plainButton('Повторить', loadMessage, 'ghost'));
        } finally { loading = false; }
      }
      row.addEventListener('toggle', loadMessage);
    }
    if (support && item.support_thread_id && item.staff) detail.append(plainButton("Открыть обращение", async () => {
      if (!guardStaffNavigation() || !guardIdentityNavigation()) return;
      $("notification-close").click();
      state.supportTargetId = state.supportFilterId = item.support_thread_id;
      state.supportPage = 0;
      await showAdmin("support");
    }, "ghost"));
    if (support && item.support_thread_id && !item.staff) detail.append(plainButton("Написать оператору", () => {
      $("notification-close").click();
      return openSupport(item.booking_id ? "request" : "profile", item.booking_id || null);
    }, "ghost"));
    if (!support && item.booking_id) detail.append(plainButton("Открыть заявку", async () => {
      $("notification-close").click();
      if (!item.staff) return openCustomerBooking(item.booking_id);
      selectedRequestId = item.booking_id;
      state.adminTargetId = item.booking_id;
      state.adminPage = 0;
      state.adminRequestFilter = state.adminQueue = state.adminStatus = "all";
      await revealNavigation(() => showAdmin("orders"), () => document.querySelector(`.request-card[data-booking-id="${item.booking_id}"]`));
    }, "ghost"));
    if (!support && item.booking_id && !item.staff) detail.append(plainButton("Связаться с оператором", () => {
      $("notification-close").click();
      return openSupport("request", item.booking_id);
    }, "ghost"));
    if (expandable) row.append(detail);
    $('notification-items').append(row);
  }
  async function loadInboxPage(reset = false) {
    if (inboxBusy) return;
    inboxBusy = true;
    $('notification-items').setAttribute('aria-busy','true');
    $('notification-more').disabled = true; $('notification-retry').hidden = true;
    try {
      if (reset) { inboxOffset = 0; $('notification-items').replaceChildren(); $('notification-count').hidden = true; }
      $('notification-status').classList.add('loading-status');
      $('notification-status').textContent = 'Загрузка…';
      const result = await api(`/api/miniapp/notifications/inbox?offset=${inboxOffset}&support_preview=1`);
      $('notification-status').classList.remove('loading-status');
      if (reset && result.unread_count > 0) {
        const form = new Intl.PluralRules('ru').select(result.unread_count);
        $('notification-count').textContent = `${result.unread_count} ${form === 'one' ? 'новое' : 'новых'}`;
        $('notification-count').hidden = false;
      }
      for (const item of result.items) appendInboxItem(item);
      inboxOffset += result.items.length;
      $('notification-more').hidden = !result.has_more;
      $('notification-status').textContent = inboxOffset ? '' : 'Пока нет уведомлений';
      if (result.items.length) await api('/api/miniapp/notifications/inbox/read', {method:'POST',body:JSON.stringify({ids:result.items.map(item=>item.id)})});
      await refreshInbox();
    } catch (_) {
      $('notification-status').textContent = 'Не удалось загрузить уведомления';
      $('notification-retry').hidden = false; $('notification-more').hidden = true;
    }
    finally { inboxBusy = false; $('notification-status').classList.remove('loading-status'); $('notification-items').setAttribute('aria-busy','false'); $('notification-more').disabled = false; }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.notification-bell'); if (!button) return;
    if (!authorized || preview) { showError('Уведомления доступны после входа.'); return; }
    inboxOpener = button; setDialogHidden($('notification-dialog'), false); $('notification-title').focus({preventScroll:true}); void loadInboxPage(true);
  });
  $('notification-more').addEventListener('click', () => void loadInboxPage());
  $('notification-retry').addEventListener('click', () => void loadInboxPage(inboxOffset === 0));
  $('notification-close').addEventListener('click', () => { setDialogHidden($('notification-dialog'), true); window.PolyRentalDialogs?.restoreFocus(inboxOpener); });
  $('notification-dialog').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('notification-close').click(); } });
  if (authorized && !preview) { void refreshInbox(); setInterval(() => void refreshInbox(), 15000); }
  function showStageNotice() { void claimStageNotices(); }
  let customerHomeBusy = false, customerHomeData = '', readyInvitationBusy = false;
  let readyInvitations = [];
  const acknowledgedInvitations = new Set(), pendingInvitationAcks = new Set();
  async function acknowledgeInvitation(id) {
    acknowledgedInvitations.add(id); pendingInvitationAcks.add(id);
    try { await api(`/api/miniapp/notifications/${id}/ack`, {method:'POST',body:'{}'}); pendingInvitationAcks.delete(id); }
    catch (_) { /* Retry while open; unacknowledged invitations are never lost. */ }
  }
  function openCustomerBooking(id) {
    clearTimeout(profileSearchTimer);
    selectedCustomerOrderId = id;
    state.profileTargetId = id;
    state.profilePage = 0;
    state.profileNumber = $("profile-number").value = "";
    state.profileFilter = $("profile-filter").value = "all";
    return revealNavigation(showOrders, () => $("orders-content").querySelector(`[data-booking-id="${id}"]`) || $("orders-content"));
  }
  async function startCustomerReturn(id) {
    const order = await api(`/api/miniapp/bookings/${id}`);
    if (order.status !== 'issued' && !(order.status === 'return_inspection' && order.handover?.legacy_issue && !order.handover?.returning_at)) {
      await refreshCustomerHome(); return showError('Сдача уже отмечена или техника ещё не выдана. Откройте актуальную заявку.');
    }
    if (await workflowDialog('Сдать оборудование', `<p>Заявка ${escapeHtml(order.human_number || String(id))}. Вы уже передаёте оборудование сотруднику?</p><p>После подтверждения начнётся приёмка. Аренду завершит сотрудник после проверки.</p>${receiptSummary(order)}`, 'Да, передаю сотруднику', null,
      async()=>api(`/api/miniapp/bookings/${id}/attest`,{method:'POST',body:JSON.stringify({action:'returning',issued_at:order.handover?.issued_at || null})}))) {
      await refreshCustomerHome(); await openCustomerBooking(id);
    }
  }
  async function refreshCustomerHome() {
    if (!authorized || preview || document.hidden || customerHomeBusy) return;
    customerHomeBusy=true;
    try {
      for (const id of [...pendingInvitationAcks]) await acknowledgeInvitation(id);
      const result=await api('/api/miniapp/customer/next-actions');
      const serialized=JSON.stringify(result.items || []);
      if(serialized!==customerHomeData){
        customerHomeData=serialized;$('customer-next').replaceChildren();
        for(const item of result.items || []){
          const card=document.createElement('article');card.className='customer-next-card';card.dataset.bookingId=String(item.booking_id);
          const title=document.createElement('h3');title.textContent=`${item.human_number}: ${item.title}`;card.append(title);
          if(item.equipment?.length){const summary=document.createElement('p');summary.className='supporting';summary.textContent=item.equipment.slice(0,5).map(row=>`${row.name} × ${row.quantity}`).join(', ')+(item.equipment.length>5?` и ещё ${item.equipment.length-5} поз.`:'');card.append(summary);}
          for(const text of [item.description,item.pickup_location,item.pickup_instructions])if(text){const p=document.createElement('p');p.textContent=text;card.append(p);}
          const action=plainButton(item.label,async()=>{
            if(item.action==='return')await startCustomerReturn(item.booking_id);
            else if(item.action==='identity')await openIdentity(item.booking_id);
            else if(item.action==='support')await openSupport('request',item.booking_id);
            else await openCustomerBooking(item.booking_id);
          },'primary');card.append(action);
          if(item.status==='ready'&&!item.pickup_location)card.append(plainButton('Уточнить место у оператора',()=>openSupport('request',item.booking_id),'ghost'));
          $('customer-next').append(card);
        }
        $('customer-next').hidden=state.view!=='flow'||state.step!==0||!$('customer-next').children.length;
      }
      const pending=await api('/api/miniapp/notifications/pending');
      readyInvitations=(pending.items||[]).filter(item=>!acknowledgedInvitations.has(item.event_id));
    } catch (_) { /* Keep the last useful state; retry on the next activation. */ }
    finally {customerHomeBusy=false;void showReadyInvitation();}
  }
  function readyDisplayAllowed(){
    return !document.hidden&&!state.busy&&['flow','orders'].includes(state.view)&&(state.view!=='flow'||state.step===0)&&
       !document.querySelector('.dialog-backdrop:not([hidden]), .contact-editor:not([hidden])')&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'');
  }
  async function showReadyInvitation(){
    if(readyInvitationBusy||!readyInvitations.length||!readyDisplayAllowed())return;
    const item=readyInvitations.shift();if(acknowledgedInvitations.has(item.event_id))return;
    readyInvitationBusy=true;
    try {
      const current=await api(`/api/miniapp/bookings/${item.booking_id}`);
      if(current.status!=='ready'||current.identity_status!=='verified'||new Date(current.ends_at)<=new Date())return;
      if(!readyDisplayAllowed()){readyInvitations.unshift(item);return;}
      const content=[`Заявка ${item.human_number}`,item.description,item.pickup_location,item.pickup_instructions].filter(Boolean).map(text=>`<p>${escapeHtml(text)}</p>`).join('');
      const opened=await workflowDialog('Всё готово к выдаче',content,'Открыть заявку',dialog=>{dialog.classList.add('ready-invitation');dialog.querySelector('.workflow-cancel').textContent='Понятно';});
      await acknowledgeInvitation(item.event_id);if(opened)await openCustomerBooking(item.booking_id);
    } catch (_) { /* Remains pending on the server and will be retried. */ }
    finally {readyInvitationBusy=false;}
  }
  function appendEquipmentFeatures(parent, order){
    const items=order.equipment_details || order.handover?.snapshot || [];if(!items.length)return false;
    const section=document.createElement('section');section.className='equipment-features';
    const heading=document.createElement('h4');heading.textContent='Особенности и комплектация';section.append(heading);
    items.forEach((item,index)=>{
      const title=document.createElement('strong');title.textContent=`${item.name} (экземпляр ${index+1})`;section.append(title);
      const rows=(item.features||[]).map(feature=>`Особенность: ${feature.description}`);
      if(!rows.length)rows.push('Известных особенностей нет.');
      for(const component of item.components||[])rows.push(`${component.replacement_name||component.name}${['missing','faulty'].includes(component.state)?' — не выдано':''}`);
      const p=document.createElement('p');p.textContent=rows.join('\n');section.append(p);
    });
    if(order.handover?.exceptions?.length){
      const label=document.createElement('strong');label.textContent='Частичная выдача';section.append(label);
      for(const item of order.handover.exceptions){const p=document.createElement('p');p.textContent=`${item.name}${item.component?` / ${item.component}`:''}: ${item.reason==='replacement'?'заменено':'не выдано'}${item.replacement_name?` — ${item.replacement_name}`:''}`;section.append(p);}
    }
    parent.append(section);
    return Boolean(order.handover?.exceptions?.length);
  }
  async function loadHandoverSettings(){
    const form=$('handover-settings-form');if(form.inert || staffFormDirty(form))return;form.inert=true;form.querySelector('button').disabled=true;
    try{const data=await api('/api/miniapp/admin/handover-settings');for(const key of ['pickup_location','pickup_instructions'])form.elements[key].value=data[key]||'';registerStaffForm(form);form.querySelector('button').disabled=false;}
    catch(error){$('handover-settings-status').textContent=error.message;}
    finally{form.inert=false;}
  }
  function appendRentalPurpose(parent, order) {
    if (!order.rental_purpose) return;
    const section = reviewSection('Цель аренды', 'rental-purpose-summary');
    const text = document.createElement('p'); text.textContent = order.rental_purpose;
    text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; section.append(text); parent.append(section);
  }
  async function loadBookingSettings() {
    const form = $('booking-settings-form'), button = form.querySelector('button');
    if (form.inert || staffFormDirty(form)) return;
    form.inert = true; button.disabled = true;
    try {
      const data = await api('/api/miniapp/admin/booking-settings');
      form.elements.rental_purpose_enabled.checked = data.rental_purpose_enabled;
      registerStaffForm(form); button.disabled = false;
    } catch (error) { $('booking-settings-status').textContent = error.message; }
    finally { form.inert = false; }
  }
  $('booking-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api('/api/miniapp/admin/booking-settings', {method:'PUT', body:JSON.stringify({rental_purpose_enabled:form.elements.rental_purpose_enabled.checked})});
      registerStaffForm(form); $('booking-settings-status').textContent = 'Настройки оформления сохранены';
    } catch (error) { $('booking-settings-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('handover-settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');
    if(button.disabled)return;
    button.disabled=true;
    try{await api('/api/miniapp/admin/handover-settings',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(form)))});registerStaffForm(form);$('handover-settings-status').textContent='Настройки выдачи сохранены';}
    catch(error){$('handover-settings-status').textContent=error.message;}finally{button.disabled=false;}
  });
  setInterval(()=>{if(!state.busy)void refreshCustomerHome();},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshCustomerHome();});
  tg?.onEvent?.('activated',()=>void refreshCustomerHome());
  async function claimStageNotices() {
    if (!authorized || stageNoticesBusy || document.hidden) return;
    stageNoticesBusy = true;
    try {
      const result = await api("/api/miniapp/notifications/claim", {method:"POST", body:"{}"});
      for (const item of result.items || []) {
        const notice = document.createElement("div"); notice.className = "stage-toast"; notice.setAttribute("role", "status");
        const copy = document.createElement("span"); copy.textContent = `Заявка №${item.booking_id}: ${item.message}`;
        const close = plainButton("×", () => removeNotice(notice), "ghost"); close.setAttribute("aria-label", "Закрыть уведомление");
        notice.append(copy, close); document.body.append(notice); setTimeout(() => removeNotice(notice), 8000);
      }
    } catch (_) { /* The next poll retries without replaying server-claimed events. */ }
    finally { stageNoticesBusy = false; }
  }
  setInterval(() => { void claimStageNotices(); }, 5000);

  function plainButton(title, handler, className = "secondary") {
    const button = document.createElement("button"); button.type = "button"; button.className = `button ${className}`; button.textContent = title;
    button.addEventListener("click", () => runButton(button, handler));
    return button;
  }

  async function runButton(button, action, onError = error => showError(error.message)) {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { onError(error); }
    finally { button.disabled = false; }
  }

  function moscowInput(value) { return new Date(new Date(value).getTime() + 3*3600000).toISOString().slice(0,16); }

  function requestEditDate(name, label, timeLabel, value) {
    const local = moscowInput(value);
    return `<label class="field"><span>${label}</span><input name="${name}-date" data-form-date inputmode="numeric" maxlength="10" required placeholder="${formDatePlaceholder()}" value="${displayFormDate(local.slice(0, 10))}"></label>
      <label class="field"><span>${timeLabel}</span><input name="${name}-time" type="time" step="60" required value="${local.slice(11)}"></label>`;
  }

  function requestEditPeriod(data, originalStart) {
    const startDate = parseFormDate(data.get("start-date")), endDate = parseFormDate(data.get("end-date"));
    const startTime = data.get("start-time"), endTime = data.get("end-time");
    if (!startDate || !endDate || !startTime || !endTime) throw new Error(`Проверьте дату и время аренды. Формат даты — ${formDatePlaceholder()}.`);
    const pickedStart = `${startDate}T${startTime}`;
    const current = moscowInput(new Date());
    const start = pickedStart !== moscowInput(originalStart) && pickedStart < current ? current : pickedStart;
    const end = `${endDate}T${endTime}`;
    if (end <= start) throw new Error("Возврат должен быть позже начала аренды.");
    return {start: toIso(start), end: toIso(end)};
  }

  function requestEditPosition(id, name, quantity, media) {
    const photo = media.image_data || media.image_url ? catalogMedia({...media, name}, "request-item") : "";
    return `<div class="request-edit-position">${photo}<label class="field"><span>${escapeHtml(name)}</span><input name="quantity-${Number(id)}" type="number" min="0" max="30" value="${Number(quantity)}" required></label></div>`;
  }

  async function editRequestDialog(order, manager = false, change = null, force = false) {
    const forceUrl = `/api/miniapp/admin/bookings/${order.id}/force-edit`;
    const edit = force ? await api(forceUrl) : null;
    const values = edit?.draft || change?.after || {start:order.starts_at,end:order.ends_at,lines:order.items.map(item=>({article_id:item.id,quantity:item.quantity,name:item.title||item.name}))};
    const catalogUrl = manager ? forceUrl + "/availability" : `/api/miniapp/bookings/${order.id}/edit-availability`;
    const resetPreparation = ["preparing", "ready"].includes(order.status);
    const notice = force ? (resetPreparation ? "Правки сохранятся сразу. Подтвердите заявку заново, затем соберите и проверьте комплект." : "Правки сохранятся сразу. Подтвердите заявку заново. Если клиенту уже отправлено предложение, оно закроется.") : "Клиенту придёт уведомление. На подтверждение — 24 часа.";
    const content=`<p>Укажите сроки аренды по МСК.</p><div class="request-edit-period">${requestEditDate('start', 'Начало аренды', 'Время начала', values.start)}${requestEditDate('end', 'Возврат', 'Время возврата', values.end)}</div><div class="request-edit-lines">${values.lines.map(line => { const item = order.items.find(item => item.id === line.article_id); const media = {...item, ...order.article_media?.[line.article_id]}; return requestEditPosition(line.article_id, line.name || item?.name || String(line.article_id), line.quantity, media); }).join("")}</div><button type="button" class="button ghost request-add-position">Добавить позицию</button><div class="request-add-options"></div>${manager?'<label class="field"><span>Комментарий для клиента</span><textarea name="comment" maxlength="2000" required></textarea></label><p>'+notice+'</p>':""}`;
    const data=await workflowDialog(force ? "Изменить без согласования" : manager ? "Изменить заявку" : "Исправить заявку", content, force ? "Применить изменения" : manager ? "Подтвердить" : "Подтверждаю",dialog=>{
      const startDate = dialog.querySelector('[name="start-date"]');
      const startTime = dialog.querySelector('[name="start-time"]');
      const correctStart = () => {
        const day = parseFormDate(startDate.value);
        const picked = `${day}T${startTime.value}`;
        const current = moscowInput(new Date());
        if (!day || !startTime.value || picked === moscowInput(values.start) || picked >= current) return;
        startDate.value = displayFormDate(current.slice(0, 10));
        startTime.value = current.slice(11);
      };
      startDate.addEventListener("change", correctStart);
      startTime.addEventListener("change", correctStart);
      const add=dialog.querySelector(".request-add-position");
      add.addEventListener("click",async()=>{
        let period;
        try { period = requestEditPeriod(new FormData(dialog.querySelector('form')), values.start); }
        catch (error) { showError(error.message); return; }
        const existing = new Set([...dialog.querySelectorAll('[name^="quantity-"]')].map(input => Number(input.name.slice(9))));
        const selected = new Map(); let items = null;
        await workflowDialog("Добавить оборудование", `<p>Доступность на сроки заявки. Выберите позиции и количество.</p><label class="field"><span>Поиск в каталоге</span><input type="search" class="request-catalog-search" placeholder="Название, модель или артикул"></label><p class="request-catalog-status" role="status"></p><div class="request-catalog-results"></div><p class="request-catalog-total" role="status">Ничего не выбрано</p><button type="button" class="button secondary request-catalog-retry" hidden>Повторить загрузку</button>`, "Добавить выбранное", picker => {
          const search=picker.querySelector('.request-catalog-search'), host=picker.querySelector('.request-catalog-results'), status=picker.querySelector('.request-catalog-status'), total=picker.querySelector('.request-catalog-total'), retry=picker.querySelector('.request-catalog-retry'), submit=picker.querySelector('[type="submit"]');
          const render=()=>{
            if (!items) return;
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
              if (item.image_data || item.image_url) row.insertAdjacentHTML("beforeend", catalogMedia(item, "request-item"));
              controls.append(minus,value,plus);row.append(heading,hint,controls);host.append(row);
            }
            const quantity=[...selected.values()].reduce((a,b)=>a+b,0);total.textContent=quantity ? `Выбрано: ${quantity} шт.` : 'Ничего не выбрано'; submit.disabled=!quantity;
          };
          const load=async()=>{retry.hidden=true;status.textContent='';showLoading(host,'Загружаем оборудование…');submit.disabled=true;try {const result=await api(`${catalogUrl}?${new URLSearchParams(period)}`);items=result.all_items||result.items||[];render();}catch(error){host.replaceChildren();status.textContent=`Не удалось загрузить каталог: ${error.message}`;retry.hidden=false;}};
          search.addEventListener('input',render);retry.addEventListener('click',load);void load();
        },async()=>{
          for(const [id,quantityValue] of selected){
            const item=items.find(entry=>entry.id===id);if(!item)continue;
            dialog.querySelector(".request-edit-lines").insertAdjacentHTML("beforeend", requestEditPosition(id, item.title || item.name, quantityValue, item));
          }
        });
      });
    },async data=>{
      const proposed={...requestEditPeriod(data, values.start),lines:[...data].filter(([key])=>key.startsWith("quantity-")).map(([key,value])=>({article_id:Number(key.slice(9)),quantity:Number(value)})).filter(line=>line.quantity>0)};
      if (force) await api(forceUrl, {method:"PUT", body:JSON.stringify({...proposed, comment:data.get("comment"), revision:edit.revision})});
      else if(manager)await api(`/api/miniapp/admin/bookings/${order.id}/changes`,{method:"POST",body:JSON.stringify({change_type:"manager_edit",comment:data.get("comment"),proposed})});
      else if(change)await api(`/api/miniapp/bookings/${order.id}/changes/respond`,{method:"POST",body:JSON.stringify({change_id:change.id,accept:true,corrected:proposed})});
      else await api(`/api/miniapp/bookings/${order.id}`,{method:"PUT",body:JSON.stringify(proposed)});
    });
    if(data) {if(manager)await showAdmin("orders");else await showOrders();}
  }

  function appendCustomerWorkflow(card, order) {
    if (order.status === "pending") card.append(plainButton("Изменить заявку", () => editRequestDialog(order)));
    const request = order.customer_change_request;
    if (order.status === "confirmed" && request) {
      const note = document.createElement("p"); note.className="notice stage-notice"; note.setAttribute("role","status");
      note.textContent = request.status === "pending" ? "Запрос на изменения отправлен. Дождитесь решения оператора." : request.status === "rejected" ? "Оператор отклонил запрос на изменения. Заявка остаётся подтверждённой." : "";
      if (note.textContent) card.append(note);
      if (["pending","rejected"].includes(request.status)) card.append(plainButton("Посмотреть запрос на изменения", async () => {
        const details = await api(`/api/miniapp/bookings/${order.id}/change-request`);
        await workflowDialog("Запрос на изменения", `<p>${escapeHtml(details?.reason || "")}</p>${details?.decision_comment ? `<p>Комментарий оператора: ${escapeHtml(details.decision_comment)}</p>` : ""}`, "Закрыть");
      }));
    }
    if (order.can_request_changes) card.append(plainButton("Запросить изменения", async () => {
      const data = await workflowDialog("Запросить изменения", '<p>Укажите, что хотите изменить и почему. После одобрения вы сможете исправить даты или состав заявки и отправить её на повторное подтверждение.</p><label class="field"><span>Причина запроса</span><textarea name="reason" maxlength="2000" required></textarea></label>', "Отправить запрос", null, async data => {
        const reason = String(data.get("reason") || "").trim();
        if (!reason) throw new Error("Обязательно укажите причину запроса.");
        await api(`/api/miniapp/bookings/${order.id}/change-request`, {method:"POST",body:JSON.stringify({reason})});
      });
      if (data) await showOrders();
    }));
    if(order.rework_available)card.append(plainButton("Комментарий доработки",async()=>{const reason=await api(`/api/miniapp/bookings/${order.id}/rework-reason`);await workflowDialog("Вернули на доработку",`<p>${escapeHtml(reason.comment)}</p>`,"Закрыть");}));
    if (order.change_status === "rejected") card.append(plainButton("Причина отклонения",async () => {
      const change=await api(`/api/miniapp/bookings/${order.id}/changes`);
      await workflowDialog("Заявка отклонена",`<p>${escapeHtml(change?.comment || "")}</p>`,"Закрыть");
    }));
    if (order.change_status === "disputed") {
      const dispute = plainButton("Ваше возражение", async () => {
        const change = await api(`/api/miniapp/bookings/${order.id}/changes`);
        await workflowDialog("Изменения оспорены", `<p>Вы отклонили предложенные изменения. Возражение передано сотруднику.</p>${change?.dispute ? `<h3>Ваш комментарий</h3><p>${escapeHtml(change.dispute)}</p>` : ''}`, "Закрыть");
      });
      dispute.classList.add("customer-dispute-details");
      card.append(dispute);
    }
    if (order.change_type === "staff_edit" || order.status === "needs_changes" || order.change_status === "unanswered") {
      card.append(plainButton(request?.status === "approved" ? "Внести изменения" : "Посмотреть изменения", async () => {
        const change = await api(`/api/miniapp/bookings/${order.id}/changes`);
        if (!change) return;
        if (change.change_type === "staff_edit") {
          await workflowDialog("Изменения заявки", `<p>Сотрудник уже применил изменения.</p><p>${escapeHtml(change.comment || "")}</p>${changeDetailsHtml(equipmentComparison(change.before, change.after))}`, "Закрыть");
          return;
        }
        if (change.change_type === "client_fix") { const data = await workflowDialog("Нужно исправить", `<p>${escapeHtml(change.comment)}</p>`, "Перейти к исправлению"); if (data) await editRequestDialog(order,false,change); return; }
        const diff = `<p>${escapeHtml(change.comment || "")}</p>${changeDetailsHtml(equipmentComparison(change.before, change.after))}<p>${change.deadline ? `Ответить до ${escapeHtml(dateText(change.deadline))} МСК` : ""}</p>`;
        if (change.status === "unanswered" || order.change_status === "unanswered") {
          await workflowDialog("Изменения заявки", `${diff}<p>Срок ответа истёк. Сотрудник решит, как продолжить.</p>`, "Закрыть");
          return;
        }
        const response = await workflowDialog("Изменения заявки", `${diff}<label class="field"><span>Ваше решение</span><select name="decision"><option value="accept">Принять изменения</option><option value="dispute">Оспорить изменения</option></select></label><div class="dispute-fields" hidden><p>Исходные условия заявки сохранятся. Сотрудник получит ваш комментарий.</p><label class="field"><span>Почему вы не согласны?</span><textarea name="comment" maxlength="2000"></textarea></label></div>`, "Принять изменения", (dialog) => {
          const select = dialog.querySelector('[name="decision"]');
          select.addEventListener("change", () => {
            const disputing = select.value === "dispute";
            dialog.querySelector(".dispute-fields").hidden = !disputing;
            dialog.querySelector("textarea").required = disputing;
            dialog.querySelector('[type="submit"]').textContent = disputing ? "Отправить возражение" : "Принять изменения";
          });
        }, async data => {
          const accept = data.get("decision") === "accept";
          await api(`/api/miniapp/bookings/${order.id}/changes/respond`, {method:"POST",body:JSON.stringify({change_id:change.id,accept,comment:accept ? "" : data.get("comment")})});
        });
        if (!response) return;
        await showOrders();
        if (response.get("decision") === "dispute") {
          focusDisclosure(document.querySelector(`.customer-order-card[data-booking-id="${order.id}"] .customer-dispute-details`));
        }
      }));
    }
    const hasPartialIssueDetails = appendEquipmentFeatures(card, order);
    appendHandoverProgress(card, order, false);
    if (order.partial_issue && !hasPartialIssueDetails) { const badge = document.createElement("span"); badge.className="status-pill"; badge.textContent="Частичная выдача"; card.append(badge); }
    if (order.receipt_available || order.receipt_preview_available) card.append(plainButton(
      order.receipt_available ? "Скачать расписку" : "Скачать для подписи",
      () => downloadSecure(`/api/miniapp/bookings/${order.id}/receipt`, `receipt-${(order.human_number || String(order.id)).replace("ТС", "TS")}.docx`)));
    if ((order.status === "issued" || (order.status === "return_inspection" && order.handover?.legacy_issue)) && !order.handover?.returning_at) card.append(plainButton("Сдать оборудование", () => startCustomerReturn(order.id),"primary"));
  }

  function appendAdminWorkflow(actions, order) {
    showStageNotice(order,true);
    const role = state.role?.staff_role || "operator";
    const manager = ["manager","admin"].includes(role);
    if (order.customer_change_request?.status === "pending" && order.status === "confirmed" && state.role?.staff_role) {
      actions.append(actionButton("Рассмотреть запрос на изменения", async () => {
        const request = await api(`/api/miniapp/bookings/${order.id}/change-request`);
        if (!request || request.status !== "pending") throw new Error("Запрос уже обработан. Обновите заявку.");
        await workflowDialog("Запрос клиента на изменения", `<h3>Причина клиента</h3><p>${escapeHtml(request.reason)}</p><label class="field"><span>Решение</span><select name="decision"><option value="approve">Подтвердить запрос</option><option value="reject">Отклонить запрос</option></select></label><p>При подтверждении клиент сможет исправить заявку и отправить её на повторное подтверждение. При отказе заявка останется подтверждённой.</p><label class="field"><span>Комментарий клиенту (необязательно)</span><textarea name="comment" maxlength="2000"></textarea></label>`, "Сохранить решение", null, async data => {
          await api(`/api/miniapp/admin/bookings/${order.id}/change-request/${request.id}/decision`, {method:"POST",body:JSON.stringify({approve:data.get("decision")==="approve",comment:data.get("comment") || ""})});
        });
      }, order.id, "primary"));
    }
    if (manager && ["pending","needs_changes","confirmed","preparing","ready","issued","return_inspection"].includes(order.status)) actions.append(actionButton(order.assignee_id ? "Передать заявку" : "Назначить ответственного", () => chooseAssignee(order), order.id, "secondary lock-exempt"));
    if (order.partial_issue) { const badge = document.createElement("span"); badge.className="status-pill"; badge.textContent="Частичная выдача"; actions.append(badge); }
    if (state.role?.staff_role && ["pending","needs_changes","confirmed","preparing","ready"].includes(order.status)) {
      const style = order.status === "needs_changes" ? "primary workflow-next" : "secondary";
      actions.append(actionButton("Изменить без согласования", () => editRequestDialog(order, true, null, true), order.id, style, false));
    }
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
    if (order.change_status === "disputed") {
      const note = document.createElement("p");
      note.className = "notice";
      note.textContent = "Клиент оспорил предложенные изменения. В заявке сохранены исходные условия.";
      actions.append(note);
      if (state.role?.pii_admin) actions.append(actionButton("Возражение клиента", async () => {
        const change = await api(`/api/miniapp/admin/bookings/${order.id}/changes`);
        await workflowDialog("Возражение клиента", change?.dispute ? `<p>${escapeHtml(change.dispute)}</p>` : '<p>Комментарий недоступен.</p>', "Закрыть");
      }, order.id, "secondary lock-exempt", false));
    }
    if (order.handover?.snapshot && state.role?.pii_admin) actions.append(actionButton("Скачать расписку", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/receipt`,`receipt-${order.id}.docx`),order.id,"secondary lock-exempt",false));
    if (state.role?.pii_admin && order.archived_documents?.includes("issue")) actions.append(actionButton("Архивный акт (устаревший)", () => downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/issue`,`act-${order.id}.docx`),order.id,"ghost lock-exempt",false));
    for(const kind of ["receipt","return","contract"])if(state.role?.pii_admin&&order.archived_documents?.includes(kind))actions.append(actionButton(({receipt:"Архивная расписка DOCX",return:"Архивный акт возврата",contract:"Архивный договор"})[kind],()=>downloadSecure(`/api/miniapp/admin/bookings/${order.id}/documents/${kind==="receipt"?"legacy_receipt":kind}`,`archive-${kind}-${order.id}.docx`),order.id,"ghost lock-exempt",false));
    if (state.role?.pii_admin && ["issued","return_inspection"].includes(order.status) && !order.handover?.snapshot?.length) actions.append(actionButton("Подготовить расписку старой выдачи", async () => {
      if (await workflowDialog("Перенос старой выдачи", "<p>Будет подготовлена PDF-расписка по проверенной анкете. Исторические документы сохранятся. Особенности на момент выдачи неизвестны; при возврате нужна ручная сверка.</p>")) await api(`/api/miniapp/admin/bookings/${order.id}/migrate-receipt`,{method:"POST"});
    },order.id,"secondary lock-exempt"));
    if (order.handover?.issued_by) { const note = document.createElement("p"); note.textContent = `Выдал: ${order.handover.issued_by_name || "Сотрудник"}`; actions.append(note); }
    if (order.handover?.returned_by) { const note = document.createElement("p"); note.textContent = `Принял: ${order.handover.returned_by_name || "Сотрудник"}`; actions.append(note); }
    if (order.status === "ready") actions.append(actionButton("Выдать оборудование", () => api(`/api/miniapp/admin/bookings/${order.id}/transition`,{method:"POST",body:JSON.stringify({action:"issued"})}),order.id,"primary workflow-next handover-action"));
    if (order.status === "return_inspection") for (const asset of order.assets) actions.append(actionButton(`Особенности при возврате: ${asset.name}`, async () => {
      const original = order.handover?.snapshot?.find((item) => item.id === asset.id);
      const data = await workflowDialog("Сравнение особенностей", `<p>При выдаче: ${escapeHtml(original?.features?.map((item) => item.description).join("; ") || (order.handover?.legacy_snapshot_unknown ? "снимок отсутствовал" : "особенностей нет"))}</p><label class="field"><span>Результат</span><select name="kind"><option value="existing">Старая черта, выявлено при возврате</option><option value="damage">Новое повреждение</option><option value="lost">Утеря</option></select></label><label class="field"><span>Описание</span><textarea name="description" maxlength="2000" required></textarea></label>`,"Подтвердить",null,async data=>api(`/api/miniapp/admin/bookings/${order.id}/return-finding`,{method:"POST",body:JSON.stringify({equipment_id:asset.id,kind:data.get("kind"),description:data.get("description")})}));
    },order.id,"secondary handover-action"));
    if (!manager) actions.querySelectorAll("button").forEach((button) => { if (["Изменить заявку"].includes(button.textContent)) button.hidden = true; });
    if (state.role?.pii_only) actions.querySelectorAll("button:not(.lock-exempt)").forEach((button) => { button.hidden=true; });
  }

  let assignmentOpening = false;
  async function manualAssign(order, opener) {
    if (assignmentOpening || document.querySelector('.next-step-assignment')) return;
    if (!order.lines.some(line => line.quantity > 0)) throw new Error('В заявке нет запрошенного оборудования.');
    assignmentOpening = true;
    let catalog;
    try { catalog = await api("/api/miniapp/admin/catalog", {fresh:true}); }
    finally { assignmentOpening = false; }
    if (!opener.isConnected || state.view !== 'admin' || state.adminMode !== 'orders') return;
    const original = order.handover?.exceptions || [];
    const candidates = new Map();
    for (const article of catalog.articles) {
      for (const item of article.equipment) {
        if (item.condition === 'available' && article.active !== false) candidates.set(item.id, {...item, article});
      }
    }
    const slots = order.lines.flatMap(line => {
      const assigned = order.assets.filter(asset => asset.line_id === line.id || (!asset.line_id && asset.article_id === line.article_id));
      const omitted = original.filter(entry => entry.line_id === line.id && !entry.component && entry.reason !== 'replacement');
      return Array.from({length: line.quantity}, (_, index) => ({
        line, asset: assigned[index] || null, omission: omitted[index - assigned.length], components: null,
      }));
    });
    const format = asset => {
      const name = asset.article?.title || asset.article?.name || asset.title || asset.name;
      const code = asset.asset_code || asset.serial;
      return code ? `${name}, № ${code}` : name;
    };
    const slotLabel = (slot, index) => `${slot.line.title || slot.line.name} (позиция ${index + 1})`;
    let slotList;
    let catalogSelect;
    let targetSelect;
    let submit;
    function showChoices() {
      const availableSlots = slots.flatMap((slot, index) => slot.asset ? [] : [index]);
      const previous = targetSelect.value;
      targetSelect.replaceChildren(...availableSlots.map(index => new Option(slotLabel(slots[index], index), index)));
      if (availableSlots.includes(Number(previous)) && previous !== '') targetSelect.value = previous;
      const selected = new Set(slots.flatMap(slot => slot.asset ? [slot.asset.id] : []));
      const keep = catalogSelect.value;
      catalogSelect.replaceChildren(new Option('Выберите экземпляр', ''),
        ...[...candidates.values()].filter(item => !selected.has(item.id)).map(item => new Option(format(item), item.id)));
      if ([...catalogSelect.options].some(option => option.value === keep)) catalogSelect.value = keep;
      targetSelect.disabled = !availableSlots.length;
      targetSelect.closest('label').hidden = !availableSlots.length;
      catalogSelect.disabled = !availableSlots.length;
      catalogSelect.closest('label').hidden = !availableSlots.length;
      const add = catalogSelect.closest('.next-step-add').querySelector('button');
      add.disabled = !availableSlots.length || !catalogSelect.value;
      add.hidden = !availableSlots.length;
      catalogSelect.closest('.next-step-add').querySelector('p').hidden = Boolean(availableSlots.length);
      submit.disabled = slots.every(slot => !slot.asset);
    }

    function makeComponents(slot) {
      const asset = slot.asset;
      const components = document.createElement('div');
      components.className = 'component-slots';
      const names = asset.components?.map(item => item.name) ||
        [...new Set((asset.article?.composition || '').split(/[\n;]+/).map(value => value.trim()).filter(Boolean))];
      for (const name of names) {
        const saved = original.find(entry => entry.equipment_id === asset.id && entry.component === name);
        const row = document.createElement('div');
        row.className = 'component-slot';
        row.dataset.component = name;
        row.innerHTML = `<label class="field"><span>${escapeHtml(name)}</span><select class="component-state"><option value="issued">Выдано</option><option value="missing">Не выдано: отсутствует</option><option value="faulty">Не выдано: неисправность</option><option value="replacement">Заменено</option></select></label><input class="component-replacement" maxlength="200" placeholder="Что выдано взамен" aria-label="Замена элемента комплектации">`;
        const select = row.querySelector('select');
        const input = row.querySelector('input');
        select.value = saved?.reason || 'issued';
        input.value = saved?.replacement_name || '';
        const update = () => { input.hidden = select.value !== 'replacement'; input.required = !input.hidden; };
        select.addEventListener('change', update);
        update();
        components.append(row);
      }
      return components;
    }

    function renderSlot(slot, index) {
      const row = document.createElement('li');
      row.className = 'next-step-row';
      if (!slot.asset) {
        row.innerHTML = `<div class="next-step-line next-step-editor-row"><span class="next-step-slot">${pickupIcon('partial')}</span><div><strong>${escapeHtml(slotLabel(slot, index))}</strong><small>Экземпляр не назначен</small></div></div>`;
        return row;
      }
      const asset = slot.asset;
      const name = format(asset);
      slot.components ||= makeComponents(slot);
      const details = slot.components.childElementCount > 0;
      row.innerHTML = `<div class="next-step-line next-step-editor-row">
        <span class="next-step-slot">${pickupEquipmentIcon({...asset.article, name:asset.name || name})}</span>
        <div><strong>${escapeHtml(name)}</strong></div>
        <button type="button" class="button ghost next-step-icon next-step-remove" aria-label="Удалить: ${escapeHtml(name)}" title="Удалить из состава">${pickupIcon('remove')}</button>
        ${details ? `<button type="button" class="button ghost next-step-icon next-step-arrow" aria-label="Комплектующие: ${escapeHtml(name)}">${pickupIcon('arrow')}</button>` : ''}
        </div>`;
      row.querySelector('.next-step-remove').addEventListener('click', () => {
        const faulty = asset.condition && asset.condition !== 'available' || inspectionFor(order, asset, 'pre_issue')?.result === 'fail';
        slot.omission = {line_id: slot.line.id, reason: faulty ? 'faulty' : 'missing'};
        slot.asset = null;
        slot.components = null;
        row.replaceWith(renderSlot(slot, index));
        showChoices();
        targetSelect.value = String(index);
        catalogSelect.focus();
      });
      if (details) {
        const drawer = document.createElement('div');
        drawer.className = 'next-step-drawer';
        slot.components.classList.add('next-step-drawer-inner');
        drawer.append(slot.components);
        row.append(drawer);
        pickupDisclosure(row, row.querySelector('.next-step-arrow'), drawer, `pickup-editor-${order.id}-${index}`);
      }
      return row;
    }

    const result = await workflowDialog('Редактор состава', `
      <p class="next-step-editor-help">Добавьте экземпляр из каталога в свободную позицию заявки. Пустая позиция будет отмечена как не выданная.</p>
      <ul class="next-step-list next-step-assignment"></ul>
      <div class="next-step-add">
        <p>Чтобы выбрать замену из каталога, удалите экземпляр из состава.</p>
        <label class="field"><span>Позиция заявки</span><select class="next-step-target"></select></label>
        <label class="field"><span>Добавить из каталога</span><select class="next-step-catalog"></select></label>
        <button type="button" class="button secondary">Добавить</button>
      </div>`, 'Сохранить', dialog => {
        dialog.classList.add('next-step-editor');
        slotList = dialog.querySelector('.next-step-assignment');
        catalogSelect = dialog.querySelector('.next-step-catalog');
        targetSelect = dialog.querySelector('.next-step-target');
        submit = dialog.querySelector('[type="submit"]');
        slotList.append(...slots.map(renderSlot));
        catalogSelect.addEventListener('change', showChoices);
        dialog.querySelector('.next-step-add button').addEventListener('click', () => {
          const asset = candidates.get(Number(catalogSelect.value));
          const index = Number(targetSelect.value);
          const slot = slots[index];
          if (!asset || !slot || slot.asset) return;
          slot.asset = asset;
          slot.omission = null;
          const updated = renderSlot(slot, index);
          slotList.children[index].replaceWith(updated);
          window.PolyRentalMotion?.enter(updated);
          showChoices();
          updated.querySelector('.next-step-remove').focus({preventScroll:true});
        });
        showChoices();
        const initial = catalogSelect.disabled ? slotList.querySelector('.next-step-remove') : catalogSelect;
        initial?.setAttribute('data-initial-focus', '');
      }, async () => {
        const assignments = Object.fromEntries(order.lines.map(line => [line.id, []]));
        const exceptions = [];
        for (const {line, asset, omission, components} of slots) {
          if (!asset) {
            exceptions.push(omission || {line_id:line.id, reason:'missing'});
            continue;
          }
          assignments[line.id].push(asset.id);
          if ((asset.article_id ?? asset.article?.id) !== line.article_id) {
            const saved = original.find(entry => entry.line_id === line.id && entry.replacement_id === asset.id && !entry.component);
            exceptions.push(saved || {line_id:line.id, reason:'replacement', replacement_id:asset.id});
          }
          for (const row of components.querySelectorAll('.component-slot')) {
            const reason = row.querySelector('select').value;
            if (reason === 'issued') continue;
            const saved = original.find(entry => entry.equipment_id === asset.id && entry.component === row.dataset.component);
            const replacementName = row.querySelector('input').value;
            if (reason === 'replacement' && !replacementName.trim()) throw new Error(`Укажите замену для элемента «${row.dataset.component}».`);
            exceptions.push({line_id:line.id, equipment_id:asset.id, component:row.dataset.component,
              reason, replacement_name:replacementName, note:saved?.note || ''});
          }
        }
        await api(`/api/miniapp/admin/bookings/${order.id}/assignments`, {method:'PUT', body:JSON.stringify({assignments, exceptions})});
      }, {opener, confirmDiscard: false});
    if (result && state.view === 'admin' && state.adminMode === 'orders') {
      await showAdmin('orders');
      focusDisclosure(document.querySelector(`.request-card[data-booking-id="${order.id}"] .next-step-banner button`));
    }
  }

  function openInspection(order, asset, stage, saved = null, hostRow = null) {
    const content = $("admin-content");
    const targetRow = hostRow || content.querySelector(`.request-card[data-booking-id="${order.id}"] .inspection-row[data-equipment-id="${asset.id}"]`);
    const existing = targetRow?.querySelector(".inspection-editor");
    if (existing) {
      const existingForm = existing.querySelector("form");
      if (!staffFormDirty(existingForm) || window.confirm("Отменить несохранённые изменения?")) {
        existing.remove();
        targetRow.classList.remove("has-inspection-editor");
      }
      return;
    }
    for (const openEditor of content.querySelectorAll(".inspection-editor")) {
      const openForm = openEditor.querySelector("form");
      if (staffFormDirty(openForm) && !window.confirm("Отменить несохранённые изменения?")) return;
      openEditor.closest(".inspection-row")?.classList.remove("has-inspection-editor");
      openEditor.remove();
    }
    const card = document.createElement("article"); card.className = "admin-card inspection-editor";
    card.innerHTML = `<div class="order-head"><div><h3>${stage === "pre_issue" ? "Неисправность перед выдачей" : "Неисправность при возврате"}</h3><p>${escapeHtml(asset.name)} (серийный № ${escapeHtml(asset.serial)})</p></div><button type="button" class="button ghost compact inspection-close">Закрыть</button></div><form class="inspection-form"><div class="form-grid"><label class="field wide"><span>Что произошло</span><textarea name="defect" maxlength="4000" required placeholder="Опишите неисправность"></textarea></label><label class="field wide"><span>Комментарий</span><textarea name="notes" maxlength="2000" placeholder="Дополнительная информация"></textarea></label>${stage === "check_in" ? '<label class="field wide"><span>Фото повреждения (необязательно)</span><input name="damage_photo" type="file" accept="image/*" capture="environment"><small>Фото можно сделать камерой телефона. Новое фото заменит предыдущее.</small></label>' : ""}<label class="field"><span>Оценка ущерба, ₽</span><input name="estimated_cost" type="number" min="0" step="0.01" value="0"></label><label class="check-row"><input name="charge_customer" type="checkbox"><span>Ущерб клиента</span></label></div><div class="action-row"><button class="button primary" type="submit">Сохранить неисправность</button></div></form>`;
    card.querySelector('[name="defect"]').value = saved?.defect || ""; card.querySelector('[name="notes"]').value = saved?.notes || ""; card.querySelector('[name="estimated_cost"]').value = saved?.estimated_cost || "0"; card.querySelector('[name="charge_customer"]').checked = Boolean(saved?.charge_customer);
    card.addEventListener("click", (event) => event.stopPropagation());
    card.addEventListener("keydown", (event) => event.stopPropagation());
    if (targetRow) {
      targetRow.classList.add("has-inspection-editor");
      targetRow.append(card);
      scrollElementIntoView(card);
    } else {
      content.prepend(card); scrollElementIntoView(card);
    }
    registerStaffForm(card.querySelector("form"));
    card.querySelector(".inspection-close").addEventListener("click", () => {
      const form = card.querySelector("form");
      if (!staffFormDirty(form) || window.confirm("Отменить несохранённые изменения?")) {
        targetRow?.classList.remove("has-inspection-editor");
        card.remove();
      }
    });
    card.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      if (!String(data.get("defect") || "").trim()) return showError("Опишите неисправность.");
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      const scrollTop = window.scrollY;
      try {
        const photo = data.get("damage_photo");
        await api(`/api/miniapp/admin/bookings/${order.id}/inspection`, { method: "POST", body: JSON.stringify({ equipment_id: asset.id, stage, result: "fail", checklist: {}, notes: data.get("notes") || "", defect: data.get("defect") || "", estimated_cost: data.get("estimated_cost") || 0, charge_customer: data.get("charge_customer") === "on" }) });
        if (photo instanceof File && photo.size) { const upload = new FormData(); upload.append("equipment_id", String(asset.id)); upload.append("photo", photo); await api(`/api/miniapp/admin/bookings/${order.id}/inspection-photo`, { method: "POST", body: upload }); }
        registerStaffForm(form); await showAdmin("orders"); window.scrollTo(0, scrollTop);
      }
      catch (error) { showError(error.message); submit.disabled = false; }
    });
  }

  function renderRepairs(result) {
    const content = $("admin-content"); content.replaceChildren();
    if (!result.items.length) { content.textContent = "Открытых и завершённых ремонтов нет."; return; }
    for (const ticket of result.items) {
      const card = document.createElement("article"); card.className = "admin-card";
      card.innerHTML = `<h3>Ремонт №${ticket.id}</h3><p>Серийный № ${escapeHtml(ticket.serial)}, ${escapeHtml(ticket.status)}</p><p>${escapeHtml(ticket.defect)}</p>`;
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
    const since = viewportFocus?.checkpoint();
    const button = event.currentTarget; button.disabled = true;
    const status = $("calendar-feed-status"); status.textContent = "Формируем защищённую ссылку…";
    try {
      const result = await api("/api/miniapp/admin/calendar-feed");
      const input = $("calendar-feed-url"); input.value = result.url; $("calendar-feed-field").hidden = false;
      $("calendar-feed-copy").hidden = false;
      scrollElementIntoView($("calendar-feed-field"), {since});
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
  function animateRequestRemoval(card) {
    if (desktopMotion.matches) {
      if (window.PolyRentalMotion) window.PolyRentalMotion.reflow([card.parentElement], () => { card.hidden = true; });
      else card.hidden = true;
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rect = card.getBoundingClientRect();
    if (!reduced && rect.width && rect.height) {
      const layer = document.createElement("div"); layer.className = "request-particles";
      layer.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      layer.setAttribute("aria-hidden", "true"); layer.inert = true;
      const fragment = card.cloneNode(true); fragment.classList.add("request-disintegrating-copy");
      fragment.removeAttribute("id"); fragment.removeAttribute("data-booking-id"); fragment.querySelectorAll("[id], [data-booking-id]").forEach(node => { node.removeAttribute("id"); node.removeAttribute("data-booking-id"); });
      layer.append(fragment);
      const colors = [getComputedStyle(card).backgroundColor, getComputedStyle(card).color, getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()];
      for (let i = 0; i < 72; i++) {
        const particle = document.createElement("i"); const x = Math.random() * rect.width, y = Math.random() * rect.height;
        particle.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--dx:${Math.round(25 + Math.random() * 100)}px;--dy:${Math.round(-45 + Math.random() * 90)}px;--delay:${Math.round(x / rect.width * 160)}ms`; layer.append(particle);
      }
      document.body.append(layer); card.removalParticles = layer; setTimeout(() => layer.remove(), 1000);
    }
    const siblings = [...card.parentElement.children].filter(node => node !== card);
    const before = new Map(siblings.map(node => [node, node.getBoundingClientRect().top]));
    card.hidden = true;
    if (!reduced) for (const node of siblings) {
      const distance = before.get(node) - node.getBoundingClientRect().top;
      if (distance) node.animate([{transform:`translateY(${distance}px)`}, {transform:"translateY(0)"}], {duration:320, easing:"ease-out"});
    }
  }
  function revealDeletedCard(deletion) {
    if (deletion.assetAdjusted) { adjustAssetLine(deletion, 1); deletion.assetAdjusted = false; }
    if (deletion.card?.isConnected) { deletion.card.removalParticles?.remove(); deletion.card.hidden = false; deletion.card.style.visibility = ""; deletion.card.inert = false; deletion.card.removeAttribute("aria-hidden"); updateEquipmentEmpty(deletion.card.parentElement); }
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
    const remaining = order.lines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity) || 0), 0);
    const removed = assetId ? 1 : lineId ? Number(order.lines.find(line => line.id === lineId)?.quantity || 0) : 0;
    if (assetId && remaining <= removed) { showError('Нельзя удалить последнюю единицу оборудования. Замените экземпляр или отмените заявку.'); return; }
    const offset = window.scrollY;
    card.inert = true; card.setAttribute("aria-hidden", "true");
    if (!lineId && !assetId) animateRequestRemoval(card); else card.style.visibility = "hidden";
    updateEquipmentEmpty(card.parentElement);
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
    const form = $("operator-quiet-form");
    const before = staffFormSnapshot(form);
    if (staffFormDirty(form)) return;
    try {
      const settings = await api("/api/miniapp/admin/notification-preferences");
      if (before !== staffFormSnapshot(form)) return;
      form.elements.quiet_start.value = settings.quiet_start || "";
      form.elements.quiet_end.value = settings.quiet_end || "";
      registerStaffForm(form);
    }
    catch (error) { $("operator-quiet-status").textContent = error.message; }
  });
  $("operator-quiet-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    await runButton(form.querySelector('[type="submit"]'), async () => {
      await api("/api/miniapp/admin/notification-preferences", {method:"PUT", body:JSON.stringify({quiet_start:form.elements.quiet_start.value || null, quiet_end:form.elements.quiet_end.value || null})});
      registerStaffForm(form);
      $("operator-quiet-status").textContent = "Сохранено";
    }, error => { $("operator-quiet-status").textContent = error.message; });
  });
  $("main-button").addEventListener("click", next);
  $("clear-cart").addEventListener("click", () => {
    if (cartLocked || state.busy || !state.quantities.size || !window.confirm("Очистить корзину? Все выбранные позиции будут удалены.")) return;
    state.quantities.clear(); state.requestId = null; availabilityFresh = false; nearestProposal = null;
    $('rental-purpose').value = '';
    queueCalendarAvailability(); renderItems(); renderCart(); saveDraft(); render();
  });
  $("client-search-hide-keyboard").addEventListener("click", () => $("client-catalog-search").blur());
  $("client-catalog-back").addEventListener("click", back);
  let searchViewportBaseline = window.visualViewport?.height || innerHeight;
  function updateSearchKeyboard() {
    const active = document.activeElement;
    const searching = active?.matches('#client-catalog-search, .catalog-controls input[type="search"]');
    const viewport = window.visualViewport?.height || innerHeight;
    if (!searching) searchViewportBaseline = Math.max(viewport, innerHeight);
    const keyboardOpen = Boolean(searching && matchMedia('(max-width: 700px)').matches && Math.max(searchViewportBaseline, innerHeight) - viewport > 120);
    document.body.classList.toggle('catalog-keyboard-open', keyboardOpen);
  }
  document.addEventListener('focusin', updateSearchKeyboard);
  document.addEventListener('focusout', () => setTimeout(updateSearchKeyboard, 0));
  window.visualViewport?.addEventListener('resize', updateSearchKeyboard);
  window.addEventListener('resize', updateSearchKeyboard);
  $("client-catalog-search").addEventListener("input", () => {
    $("step-items").querySelector(".category-empty-overlay")?.remove();
    if (clientCatalog.paged === false || preview) { renderItems(); return; }
    clientCatalog.page = 0; availabilitySequence++; clearTimeout(clientCatalog.timer);
    clientCatalog.timer = setTimeout(() => { if (state.view === "flow" && state.step === 0) void loadItems(); }, 300);
  });
  $("client-catalog-prev").addEventListener("click", () => { if (clientCatalog.page > 0) { clientCatalog.page--; void loadItems(); } });
  $("client-catalog-next").addEventListener("click", () => { if ((clientCatalog.page + 1) * clientCatalog.pageSize < clientCatalog.total) { clientCatalog.page++; void loadItems(); } });
  catalogView.layout = "list"; $("client-categories").classList.add("categories-list");
  async function findNearestPeriod() {
    const sequence = ++nearestSearchSequence;
    const since = viewportFocus?.checkpoint();
    const button = $("nearest-search"), key = nearestSelectionKey(); nearestProposal = null; $("nearest-apply").hidden = true;
    $("nearest-status").textContent = "Ищем сроки для всей подборки…"; button.disabled = true;
    try {
      const result = await api("/api/miniapp/availability/nearest", {method:"POST", body:JSON.stringify({start:toIso($("start").value), end:toIso($("end").value), lines:[...state.quantities].map(([article_id, quantity]) => ({article_id, quantity}))})});
      if (sequence !== nearestSearchSequence || key !== nearestSelectionKey() || state.step !== 2) return;
      if (!result.period) { $("nearest-status").textContent = `Для всей подборки не найдено свободных сроков в ближайшие ${result.horizon_days} дней.`; return; }
      nearestProposal = {key, ...result.period};
      $("nearest-status").textContent = `Вся подборка в нужном количестве доступна: ${dateText(result.period.start)} — ${dateText(result.period.end)} МСК. Перед продолжением доступность будет проверена ещё раз.`;
      $("nearest-apply").hidden = false;
      scrollElementIntoView($("nearest-period"), {since});
    } catch (error) { if (sequence === nearestSearchSequence && key === nearestSelectionKey()) $("nearest-status").textContent = `Не удалось найти сроки: ${error.message}`; }
    finally { if (sequence === nearestSearchSequence) button.disabled = false; }
  }
  $("nearest-search").addEventListener("click", findNearestPeriod);
  $("nearest-apply").addEventListener("click", async () => {
    if (!nearestProposal || nearestProposal.key !== nearestSelectionKey()) return;
    const proposal = nearestProposal; nearestProposal = null; $("nearest-apply").hidden = true;
    $("start").value = moscowInput(proposal.start); $("end").value = moscowInput(proposal.end);
    syncDateFields("start"); syncDateFields("end"); rangeCalendar.setRange($("start-date").value, $("end-date").value); periodChanged();
    if (await loadItems(true)) {
      const missing = unavailableSelection();
      if (missing.length) { showAvailabilityShortage(missing); }
      else { $("availability-result").textContent = "Новые сроки выбраны, доступность проверена."; $("availability-result").hidden = false; $("availability-edit-cart").hidden = true; }
    } else { $("items-status").textContent = "Не удалось проверить новые сроки. Повторите проверку."; $("items-status").hidden = false; }
  });
  $("retry-items").addEventListener("click", loadItems);
  $("change-dates").addEventListener("click", () => { state.step = 2; render(); });
  $("availability-edit-cart").addEventListener("click", () => { state.step = 1; renderCart(); render(); });
  $("top-back-button").addEventListener("click", back);
  let settingsReturnScroll = 0;
  function settingsTransition(host, change) {
    if (window.PolyRentalMotion?.surface) window.PolyRentalMotion.surface(host, change, {fade:false}); else change();
  }
  function slideSettingsHeading(text, direction) {
    const heading = $("admin-heading");
    if (window.PolyRentalMotion?.morphText) window.PolyRentalMotion.morphText(heading, text, {direction});
    else heading.textContent = text;
  }
  function selectSettingsTab(name) {
    for (const key of ['notifications', 'calendar', 'booking', 'handover', 'staff']) {
      const selected = key === name, tab = $(`settings-tab-${key}`);
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $(`settings-${key}`).hidden = !selected;
    }
  }
  function closeAdminSettings(restorePosition = true) {
    window.PolyRentalMotion?.cancelSurface($('admin-settings'));
    settingsTransition($('admin-panel'), () => {
      $('admin-settings').hidden = true; $('admin-panel').classList.remove('settings-open');
      $("management-settings").hidden = true;
      slideSettingsHeading('Управление', -1); syncCatalogBackButton();
    });
    if (restorePosition) {
      window.scrollTo(0, settingsReturnScroll); $('admin-settings-open').focus({preventScroll:true});
    }
  }
  function openAdminSettings(reveal = true) {
    if (!guardStaffNavigation() || state.role?.pii_only) return;
    settingsReturnScroll = window.scrollY;
    for (const tab of ['handover', 'staff', 'booking']) $('settings-tab-' + tab).hidden = state.role?.staff_role !== 'admin';
    window.PolyRentalMotion?.cancelSurface($('admin-settings'));
    settingsTransition($('admin-panel'), () => {
      selectSettingsTab('notifications'); $('admin-settings').hidden = false; $('admin-panel').classList.add('settings-open');
      $("management-settings").hidden = false;
      slideSettingsHeading('Настройки', 1); $('operator-notification-settings').open = true;
    });
    syncCatalogBackButton();
    if (reveal) {
      $('admin-heading').focus({preventScroll:true});
      scrollElementIntoView($('admin-heading'), {block:'nearest'});
    }
  }
  for (const name of ['notifications', 'calendar', 'booking', 'handover', 'staff']) {
    $('settings-tab-' + name).addEventListener('click', () => {
      selectSettingsTab(name);
      if (state.role?.staff_role !== 'admin') return;
      if (name === 'handover') void loadHandoverSettings();
      if (name === 'booking') void loadBookingSettings();
    });
  }
  $('admin-settings').querySelector('[role="tablist"]').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden);
    let index = tabs.indexOf(document.activeElement); if (index < 0) return;
    event.preventDefault(); index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click(); tabs[index].focus({preventScroll:true});
  });
  $("admin-back-button").addEventListener("click", () => { if (catalogEditorBackButton() || guardStaffNavigation()) catalogBack(); });
  let supportContext = { screen: "profile", bookingId: null }, supportReturnFocus = null;
  const supportDrafts = new Map();
  const supportDraftKey = context => JSON.stringify([context.screen, context.bookingId]);
  $("support-question").addEventListener("input", () => {
    const key = supportDraftKey(supportContext), value = $("support-question").value;
    if (value) supportDrafts.set(key, value); else supportDrafts.delete(key);
  });
  let releasePending = null, releaseCurrent = null, releaseReturnFocus = null, releaseClosing = null;
  function animateRelease(opening) {
    const card = $("release-dialog").querySelector('.dialog-card');
    const current = getComputedStyle(card);
    const fromCurrent = {transform:current.transform, opacity:current.opacity};
    card.getAnimations().forEach(animation => animation.cancel());
    const from = $("app-version").getBoundingClientRect(), to = card.getBoundingClientRect();
    if (reducedMotion?.matches || !to.width || !to.height) return Promise.resolve();
    const x = from.left + from.width / 2 - (to.left + to.width / 2), y = from.top + from.height / 2 - (to.top + to.height / 2);
    const start = {transform:desktopMotion.matches ? 'scale(.985)' : `translate(${x}px, ${y}px) scale(.08)`, opacity:0};
    const end = {transform:'translate(0, 0) scale(1)',opacity:1};
    return card.animate(opening ? [start,end] : [fromCurrent,start], {duration:desktopMotion.matches ? 160 : 280,easing:'cubic-bezier(.22,1,.36,1)'}).finished.catch(()=>{});
  }
  function showPendingRelease() {
    if (!releasePending || document.hidden || state.onboardingLoading || document.querySelector('.dialog-backdrop:not([hidden])')) return;
    releaseCurrent = releasePending; releasePending = null;
    releaseReturnFocus = document.activeElement;
    $("release-version").textContent = `Версия ${releaseCurrent.version}`;
    $("release-items").replaceChildren();
    for (const item of releaseCurrent.items) {
      const section = document.createElement("section"), title = document.createElement("h3"), text = document.createElement("p");
      title.textContent = item.title; text.textContent = item.text; section.append(title, text); $("release-items").append(section);
    }
    setDialogHidden($("release-dialog"), false); render(); $("release-title").focus({preventScroll:true});
    void animateRelease(true);
    $("release-dialog").querySelector(".dialog-card").scrollTop = 0;
  }
  async function loadReleaseAnnouncement() {
    if (!authorized || preview) return;
    try {
      const {release} = await api("/api/miniapp/release");
      if (!release || !Array.isArray(release.items) || !release.items.length) return;
      releaseCurrent = release;
      if (!release.seen) { releasePending = release; showPendingRelease(); }
    } catch (_) { /* Release notes are optional; a later launch retries. */ }
  }
  function closeRelease() {
    if (releaseClosing) return releaseClosing;
    if ($("release-dialog").hidden) return;
    const version = releaseCurrent.version;
    releaseClosing = animateRelease(false).then(() => {
      setDialogHidden($("release-dialog"), true);
      render();
      if (releaseReturnFocus?.isConnected) releaseReturnFocus.focus({preventScroll:true});
      // A failed acknowledgement never prevents entry or submitting feedback.
      void api("/api/miniapp/release/seen", {method:"POST", body:JSON.stringify({version})}).catch(()=>{});
    }).finally(() => { releaseClosing = null; });
    return releaseClosing;
  }
  $("release-close").addEventListener("click", closeRelease);
  $("app-version").addEventListener("click", async () => {
    try { const {release} = await api('/api/miniapp/release'); if (release?.items?.length) { releasePending = release; showPendingRelease(); } }
    catch (_) { showError('Не удалось загрузить информацию об обновлении.'); }
  });
  $("release-feedback").addEventListener("click", async () => { await closeRelease(); void openSupport("feedback"); });
  $("release-dialog").addEventListener("keydown", event => {
    if (event.key === "Tab" && document.activeElement === $("release-title")) { event.preventDefault(); $(event.shiftKey ? "release-close" : "release-feedback").focus(); }
    else if (event.key === "Tab") trapDialogFocus(event, $("release-dialog"));
    if (event.key === "Escape") { event.preventDefault(); closeRelease(); }
  });

  async function openSupport(screen, bookingId = null) {
    supportContext = {screen, bookingId}; supportReturnFocus = document.activeElement;
    const feedback = screen === "feedback";
    $("support-title").textContent = feedback ? "Предложить изменение" : "Поддержка";
    $("support-question-label").textContent = feedback ? "Что вы хотите изменить в приложении?" : "Написать оператору";
    $("support-submit").textContent = feedback ? "Отправить предложение" : "Отправить вопрос";
    $("support-faq").hidden = feedback; $("support-faq-heading").hidden = feedback;
    setDialogHidden($("support-dialog"), false); $("support-result").textContent = ""; $("support-result").classList.remove("success"); $("support-question").value = supportDrafts.get(supportDraftKey(supportContext)) || ""; render();
    if (feedback) $("support-question").focus({preventScroll:true});
    else { $("support-close").focus({preventScroll:true}); await loadSupportFaq(); }
  }
  let supportFaqSequence = 0;
  async function loadSupportFaq() {
    const sequence = ++supportFaqSequence;
    const host = $("support-faq");
    const visible = () => sequence === supportFaqSequence && !$("support-dialog").hidden && !host.hidden;
    host.setAttribute("aria-busy", "true");
    showLoading(host, "Загружаем частые вопросы…");
    try {
      const result = await api("/api/miniapp/support/faq");
      if (!visible()) return;
      host.replaceChildren();
      for (const item of result.items) { const details = document.createElement("details"); const title = document.createElement("summary"); const answer = document.createElement("p"); title.textContent = item.question; answer.textContent = item.answer; details.append(title, answer); host.append(details); }
    } catch (_) {
      if (!visible()) return;
      host.textContent = "Не удалось загрузить частые вопросы. "; host.append(plainButton("Повторить", loadSupportFaq, "secondary"));
    } finally {
      if (sequence === supportFaqSequence) host.removeAttribute("aria-busy");
    }
  }
  function closeSupport() { setDialogHidden($("support-dialog"), true); render(); if (supportReturnFocus?.isConnected) supportReturnFocus.focus({preventScroll:true}); }
  $("profile-support").addEventListener("click", () => openSupport("profile"));
  $("blocked-support").addEventListener("click", () => openSupport("booking"));
  $("support-close").addEventListener("click", closeSupport);
  $("support-dialog").addEventListener("keydown", (event) => { if (event.key === "Tab") trapDialogFocus(event, $("support-dialog")); if (event.key === "Escape") closeSupport(); });
  $("support-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const activeSupportContext = supportContext, context = {...supportContext}, question = $("support-question").value;
    $("support-result").textContent = ""; $("support-result").classList.remove("success");
    try {
      const result = await api("/api/miniapp/support/questions", { method:"POST", body:JSON.stringify({ question, screen:context.screen, booking_id:context.bookingId }) });
      const key = supportDraftKey(context);
      if (supportDrafts.get(key) === question) supportDrafts.delete(key);
      if (!$("support-dialog").hidden && supportContext === activeSupportContext) {
        if ($("support-question").value === question) $("support-question").value = "";
        $("support-result").textContent = context.screen === "feedback" ? "Спасибо! Мы рассмотрим ваше предложение." : result.status;
        $("support-result").classList.add("success"); $("support-result").focus({preventScroll:true}); scrollElementIntoView($("support-result"), {block:"nearest"});
      }
    }
    catch (error) { if (!$("support-dialog").hidden && supportContext === activeSupportContext) $("support-result").textContent = error.message; }
    finally { button.disabled = false; }
  });
  function renderSupportThreads(result) {
    const content = $("admin-content"); content.replaceChildren();
    if (state.supportFilterId) content.append(plainButton("Показать все обращения", () => { state.supportFilterId = null; state.supportPage = 0; void showAdmin("support"); }, "ghost"));
    const pages = Math.max(1, Math.ceil((result.total ?? result.items.length) / (result.page_size || 20)));
    if (state.supportPage >= pages) { state.supportPage = pages - 1; void showAdmin("support"); return; }
    if (!result.items.length) { const empty=document.createElement("p"); empty.textContent = "Обращений пока нет."; content.append(empty); return; }
    for (const thread of result.items) {
      const card = document.createElement("article"); card.className = "admin-card"; card.dataset.supportThreadId = String(thread.id);
      const heading = document.createElement("h3"); heading.textContent = `Обращение №${thread.id}${thread.request_number ? ` (заявка ${thread.request_number})` : ""}`; card.append(heading);
      const meta = document.createElement("p"); meta.textContent = `${thread.status === "resolved" ? "Закрыто" : thread.owner_id ? `Ответственный: ${thread.owner_name || "Сотрудник"}` : "Без владельца"}, ${dateText(thread.created_at)} МСК`; card.append(meta);
      if (!thread.owner_id && thread.status !== "resolved" && state.role?.pii_admin) {
        card.append(plainButton("Взять обращение", async () => {
          await api(`/api/miniapp/admin/support/${thread.id}/claim`, {method:"POST"});
          await showAdmin("support");
        }));
      }
      if (thread.owner_id === state.role?.id && state.role?.pii_admin) {
        const open = document.createElement("button"); open.type = "button"; open.className = "button secondary"; open.dataset.openSupportMessages = ""; open.textContent = "Открыть сообщения"; card.append(open);
        const body = document.createElement("div"); card.append(body);
        open.addEventListener("click", () => runButton(open, async () => {
          const previousForm = body.querySelector("form");
          if (previousForm && staffFormDirty(previousForm) && !window.confirm("Отменить несохранённые изменения?")) return;
          const result = await api(`/api/miniapp/admin/support/${thread.id}/messages`); body.replaceChildren();
          const context = document.createElement("p"); context.textContent = `${result.customer_name || "Пользователь"}, экран ${result.screen}`; body.append(context);
          for (const message of result.items) {
            const row = document.createElement("p"); row.className = "support-message";
            row.dataset.direction = message.direction === "client" ? "client" : "operator";
            const author = document.createElement("strong");
            author.textContent = message.direction === "client" ? "Клиент" : "Оператор";
            row.append(author, document.createTextNode(message.text)); body.append(row);
          }
          if (thread.status !== "resolved") { const form = document.createElement("form"); form.innerHTML = `<label class="field"><span>Ответ</span><textarea maxlength="3000" required></textarea></label><button class="button primary" type="submit">Ответить в Telegram</button>`;
            registerStaffForm(form);
            form.addEventListener("submit", event => {
              event.preventDefault();
              void runButton(form.querySelector('[type="submit"]'), async () => {
                await api(`/api/miniapp/admin/support/${thread.id}/reply`, {method:"POST", body:JSON.stringify({text:form.querySelector("textarea").value})});
                registerStaffForm(form);
                await showAdmin("support");
              });
            });
            body.append(form);
          }
        }));
      }
      if (state.role?.pii_admin && thread.owner_id === state.role?.id && thread.status !== "resolved") {
        card.append(plainButton("Закрыть обращение", async () => {
          await api(`/api/miniapp/admin/support/${thread.id}/resolve`, {method:"POST"});
          await showAdmin("support");
        }, "ghost"));
      }
      if (thread.status !== "resolved") {
        const form = document.createElement("form");
        form.className = "action-row";
        form.innerHTML = '<label class="field"><span>Сотрудник с доступом к ПД</span><select required></select></label><button class="button ghost" type="submit">Передать</button>';
        const select = form.querySelector("select");
        for (const id of result.eligible_owners || []) {
          const option = document.createElement("option");
          option.value = id;
          option.textContent = (result.eligible_staff || []).find(item => item.id === id)?.name || "Сотрудник";
          select.append(option);
        }
        form.addEventListener("submit", event => {
          event.preventDefault();
          void runButton(form.querySelector('[type="submit"]'), async () => {
            await api(`/api/miniapp/admin/support/${thread.id}/owner`, {method:"PUT", body:JSON.stringify({assignee_id:Number(select.value)})});
            await showAdmin("support");
          });
        });
        card.append(form);
      }
      content.append(card);
      if (state.supportTargetId === thread.id) {
        state.supportTargetId = null;
        card.querySelector("[data-open-support-messages]")?.click();
        scrollElementIntoView(card);
      }
    }
    if (pages > 1) {
      const controls = document.createElement("div"); controls.className = "action-row";
      const previous = plainButton("Назад", () => { state.supportPage--; void showAdmin("support"); }, "secondary"); previous.disabled = state.supportPage === 0;
      const current = document.createElement("span"); current.textContent = `${state.supportPage + 1} / ${pages}`;
      const next = plainButton("Далее", () => { state.supportPage++; void showAdmin("support"); }, "secondary"); next.disabled = state.supportPage + 1 >= pages;
      controls.append(previous, current, next); content.append(controls);
    }
  }

  const onboardingSlides = [
    ["Каталог и подборка", "Выберите оборудование и количество, затем проверьте корзину."],
    ["Выбор дат", "Выберите даты и время получения и возврата. Мы проверим доступность подборки."],
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
    setDialogHidden($("onboarding-dialog"), false); render(); $("onboarding-next").focus({preventScroll:true});
  }
  async function finishOnboarding() {
    setDialogHidden($("onboarding-dialog"), true); render();
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
    finally { state.onboardingLoading = false; showPendingRelease(); }
  }
  function enterClientMode({siteRoute, page} = {}) {
    if (bookingSubmitting) return;
    if (!guardStaffNavigation() || !guardIdentityNavigation()) return;
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
    if (siteRoute) {
      state.step = 0;
      if (siteRoute.category && siteRoute.category !== categoryParent(clientCatalog.category)) {
        try { localStorage.setItem(`${draftKey}:recent-category`, siteRoute.category); } catch (_) {}
      }
      clientCatalog.category = siteRoute.category;
      clientCatalog.page = page || 0;
      clearTimeout(clientCatalog.timer);
      $("client-catalog-search").value = "";
      render(); renderItems();
      return loadItems();
    }
    if (state.step === 0) void revealNavigation(loadItems, () => $("step-items"));
  }
  const catalogSiteRoute = (root, code) => code ? `${root}-${code}` : root;
  function adminSiteRoute() {
    return state.adminMode === "catalog" ? catalogSiteRoute("management-catalog", catalogView.category) : `management-${state.adminMode}`;
  }
  function currentSiteRoute() {
    if (state.view === "flow" && state.step === 0) return catalogSiteRoute("catalog", clientCatalog.category);
    if (state.view === "orders") return "profile";
    if (state.view === "admin" && !$("admin-panel").classList.contains("catalog-editing")) {
      return $("admin-settings").hidden ? adminSiteRoute() : "management-settings";
    }
    return "";
  }
  function readSiteView() {
    if (state.view === "flow") return {page: clientCatalog.page};
    if (state.view === "orders") return {page: state.profilePage, filter: state.profileFilter, sort: state.profileSort};
    const mode = state.adminMode;
    if (mode === "catalog") return {mode, category: catalogView.category, page: catalogView.page, condition: catalogView.status};
    if (mode === "support") return {mode, page: state.supportPage};
    return {mode, page: state.adminPage, filter: state.adminRequestFilter, sort: state.adminSort, status: state.adminStatus};
  }
  function restoreSiteSelect(id, value, fallback) {
    const select = $(id);
    select.value = [...select.options].some(option => option.value === value) ? value : fallback;
    return select.value;
  }
  async function openSiteRoute(route, saved, {valid, reuse}) {
    const existing = $(route);
    if (reuse && existing?.getClientRects().length && !existing.closest("[hidden], [inert]")) return existing;
    const page = Number.isSafeInteger(saved?.page) && saved.page >= 0 ? saved.page : 0;
    const [, catalog, code = ""] = siteNavigationAPI.categoryRoute.exec(route) || [];
    const admin = route === "management" || route.startsWith("management-");
    let message = "";
    if (admin && !state.role?.admin) {
      route = state.profile?.client_allowed === false ? "profile" : "catalog";
      message = "Раздел управления недоступен для вашей роли.";
    }
    if (admin && state.role?.pii_only && route !== "management" && route !== "management-orders") {
      route = "management-orders";
      message = "Этот раздел управления недоступен для вашей роли.";
    }
    if (code && !message) {
      const loaded = await siteCategories;
      if (!valid()) return null;
      if (!clientCatalog.categories.some(category => category.code === code)) {
        route = catalog;
        message = loaded ? "Категория больше недоступна. Открыт каталог." : "Не удалось загрузить категории. Открыт каталог.";
      }
    }
    if (!valid()) return null;
    const category = message ? "" : code;
    const leavingSettings = route !== "management-settings" && !$("admin-settings").hidden;
    if (leavingSettings) closeAdminSettings(false);
    if (route === "profile" || route === "my-requests") {
      state.profileTargetId = null; selectedCustomerOrderId = null;
      state.profileNumber = ""; $("profile-number").value = "";
      state.profilePage = page;
      state.profileFilter = restoreSiteSelect("profile-filter", saved?.filter, "all");
      state.profileSort = restoreSiteSelect("profile-sort", saved?.sort, "date");
      await showOrders();
    } else if (route === "management" || route.startsWith("management-")) {
      if (route === "management-settings") {
        if (state.view !== "admin") await showAdmin("orders");
        if (valid()) openAdminSettings(false);
      } else {
        const preferred = saved?.mode || (state.view === "admin" ? state.adminMode : state.profile?.last_section);
        const mode = route === "management" ? (["orders", "catalog", "repairs", "support"].includes(preferred) ? preferred : "orders")
          : category && catalog === "management-catalog" ? "catalog" : route.slice("management-".length);
        if (mode === "catalog") {
          if (saved?.category) await siteCategories;
          if (!valid()) return null;
          clearTimeout(catalogView.timer);
          const savedCategory = route === "management" && clientCatalog.categories.some(item => item.code === saved?.category) ? saved.category : "";
          catalogView.category = category || savedCategory; catalogView.page = page; catalogView.query = "";
          catalogView.status = ["available", "maintenance", "retired"].includes(saved?.condition) ? saved.condition : "all";
        } else if (mode === "orders") {
          state.adminTargetId = null; selectedRequestId = null;
          state.adminQueue = "all"; $("admin-queue").value = "all"; state.adminPage = page;
          state.adminRequestFilter = restoreSiteSelect("admin-request-filter", saved?.filter, "all");
          state.adminSort = restoreSiteSelect("admin-sort", saved?.sort, "date");
          state.adminStatus = restoreSiteSelect("admin-status", saved?.status, "all");
        } else if (mode === "support") {
          state.supportTargetId = null; state.supportFilterId = null; state.supportPage = page;
        }
        await showAdmin(mode);
        if (leavingSettings && valid() && [document.body, $("main-content"), $("admin-back-button")].includes(document.activeElement)) {
          $("admin-settings-open").focus({preventScroll:true});
        }
      }
    } else if (route !== "main-content") {
      if (state.profile?.client_allowed === false) {
        route = "profile";
        await showOrders();
        message = "Бронирование недоступно для вашей роли.";
      } else {
        await enterClientMode({siteRoute: {category}, page});
      }
    }
    if (!valid()) return null;
    if (message) showError(message);
    document.documentElement.classList.remove("role-pending");
    const target = $(route);
    if (!target || target.closest("[hidden], [inert]")) return null;
    return target;
  }
  function bindSiteLink(control, route, fallback) {
    if (siteNavigation) return siteNavigation.bind(control, route);
    control.addEventListener("click", fallback);
    return control;
  }
  if (siteNavigationAPI && !preview) {
    siteNavigation = siteNavigationAPI.create({
      open: openSiteRoute, current: currentSiteRoute,
      canLeave: () => Boolean(state.role) && !bookingSubmitting && guardStaffNavigation() && guardIdentityNavigation(),
      readView: readSiteView, owner: siteProfile?.id || tg?.initDataUnsafe?.user?.id,
    });
  }
  bindSiteLink($("tab-new"), "booking", () => enterClientMode());
  $("floating-cart-button")?.addEventListener("click", openCartView);
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
  bindSiteLink($("tab-orders"), "profile", () => revealNavigation(showOrders, () => $("orders-panel")));
  let profileSearchTimer;
  function applyProfileSearch() {
    clearTimeout(profileSearchTimer);
    if (state.view !== "orders") return;
    state.profileTargetId = null; state.profileNumber = $("profile-number").value.trim(); state.profilePage = 0; state.profileFilter = "all"; $("profile-filter").value = "all"; void showOrders();
  }
  $("profile-number").addEventListener("input", () => { clearTimeout(profileSearchTimer); profileLoadSequence += 1; profileSearchTimer = setTimeout(applyProfileSearch, 350); });
  $("profile-search").addEventListener("submit", (event) => { event.preventDefault(); applyProfileSearch(); });
  $("profile-avatar-image").addEventListener("error", () => { $("profile-avatar-image").hidden = true; $("profile-avatar-fallback").hidden = false; });
  const profileFieldLabels = {full_name:"ФИО", phone:"Телефон для связи", birth_date:"Дата рождения", passport_series:"Серия паспорта", passport_number:"Номер паспорта", passport_issued_at:"Дата выдачи паспорта", passport_issuer:"Кем выдан паспорт", passport_division_code:"Код подразделения", registration_address:"Адрес регистрации", residential_address:"Адрес проживания", student_id_number:"Номер студенческого", student_institution:"Учебное заведение"};
  function resetProfileIdentity() {
    profileIdentitySequence++; profileIdentityData = null;
    const fields = $("profile-identity-fields"), toggle = $("profile-identity-toggle");
    fields.replaceChildren(); fields.hidden = false; fields.classList.add('profile-fields-masked'); fields.setAttribute('aria-busy','false');
    $("profile-identity-edit").hidden = true; toggle.hidden = true; toggle.disabled = false; toggle.setAttribute('aria-expanded','false');
    $("profile-identity-hint").textContent = 'Нажмите на любое скрытое поле, чтобы показать все данные.';
  }
  function setProfileIdentityMasked(masked) {
    const fields = $("profile-identity-fields"), toggle = $("profile-identity-toggle");
    fields.classList.toggle('profile-fields-masked',masked);
    for (const row of fields.querySelectorAll('.profile-identity-row')) {
      row.querySelector('.profile-identity-value').setAttribute('aria-hidden',String(masked));
      if (masked) { row.setAttribute('role','button'); row.tabIndex=0; row.setAttribute('aria-label',`Показать все данные: ${row.dataset.label}`); }
      else { row.removeAttribute('role'); row.removeAttribute('tabindex'); row.removeAttribute('aria-label'); }
    }
    const hasData=Boolean(Object.keys(profileIdentityData || {}).length);
    toggle.hidden=!hasData; toggle.textContent=masked?'Показать данные':'Скрыть данные'; toggle.setAttribute('aria-expanded',String(!masked));
    $("profile-identity-edit").hidden=!hasData; $("profile-identity-edit").disabled=masked;
  }
  function revealProfileIdentity() {
    if (!profileIdentityData) return;
    setProfileIdentityMasked(false);
    scrollElementIntoView($("profile-identity-fields"));
  }
  async function loadProfileIdentity(masked=true) {
    const fields=$("profile-identity-fields"),sequence=++profileIdentitySequence;
    fields.setAttribute('aria-busy','true'); fields.textContent='Загружаем данные анкеты…';
    try {
      const result=await api('/api/miniapp/profile/identity');
      if(sequence!==profileIdentitySequence || state.view!=='orders' || !$("profile-disclosure").open)return;
      fields.replaceChildren(); profileIdentityData=result.fields || {};
      for(const [key,label] of Object.entries(profileFieldLabels)) {
        if(!profileIdentityData[key])continue;
        const row=document.createElement('p'),title=document.createElement('strong'),value=document.createElement('span');
        row.className='profile-identity-row'; row.dataset.label=label; title.textContent=`${label}:`;
        value.className='profile-identity-value';
        if (formDateNames.has(key)) {
          value.dataset.isoDate = profileIdentityData[key];
          value.textContent = displayFormDate(value.dataset.isoDate);
        } else value.textContent=String(profileIdentityData[key]);
        row.append(title,value);
        row.addEventListener('click',()=>{if(fields.classList.contains('profile-fields-masked'))revealProfileIdentity();});
        row.addEventListener('keydown',event=>{if(fields.classList.contains('profile-fields-masked')&&['Enter',' '].includes(event.key)){event.preventDefault();revealProfileIdentity();}});
        fields.append(row);
      }
      if(!fields.childElementCount)fields.textContent='Сохранённой анкеты пока нет.';
      $("profile-identity-hint").textContent=Object.keys(profileIdentityData).length?'Нажмите на поле, чтобы показать данные. Их можно скрыть кнопкой ниже.':'Анкета заполняется после подтверждения заявки.';
      setProfileIdentityMasked(masked);
    }catch(error){
      if(sequence===profileIdentitySequence&&state.view==='orders'){
        fields.replaceChildren(); const retry=document.createElement('button'); retry.type='button';retry.className='button secondary';retry.textContent='Повторить загрузку';retry.addEventListener('click',()=>loadProfileIdentity());fields.append(retry);showError(error.message);
      }
    }finally{if(sequence===profileIdentitySequence)fields.setAttribute('aria-busy','false');}
  }
  $("profile-disclosure").addEventListener('toggle',()=>{if($("profile-disclosure").open)void loadProfileIdentity();else resetProfileIdentity();});
  $("profile-identity-toggle").addEventListener("click", () => {
    if ($("profile-identity-fields").classList.contains("profile-fields-masked")) revealProfileIdentity();
    else setProfileIdentityMasked(true);
  });
  resetProfileIdentity();
  $("profile-identity-edit").addEventListener("click", async () => {
    if (!profileIdentityData) return;
    const labels = {full_name:"ФИО", phone:"Телефон для связи", birth_date:"Дата рождения", passport_series:"Серия паспорта", passport_number:"Номер паспорта", passport_issued_at:"Дата выдачи паспорта", passport_issuer:"Кем выдан паспорт", passport_division_code:"Код подразделения", registration_address:"Адрес регистрации", residential_address:"Адрес проживания", student_id_number:"Номер студенческого", student_institution:"Учебное заведение"};
    const form = Object.entries(labels).map(([name, label]) => {
      const date = formDateNames.has(name);
      const value = date ? displayFormDate(profileIdentityData[name]) : profileIdentityData[name] || "";
      return `<label class="field"><span>${escapeHtml(label)}</span><input name="${name}" ${date ? `data-form-date inputmode="numeric" maxlength="10" placeholder="${formDatePlaceholder()}"` : 'maxlength="500"'} value="${escapeHtml(value)}" ${name.startsWith("student_") ? "" : "required"}></label>`;
    }).join("");
    const result = await workflowDialog("Редактировать личные данные", `<p>Изменения будут использованы при заполнении следующих заявок.</p>${form}`, "Сохранить", null, async data => {
      const values = Object.fromEntries(Object.keys(labels).map(key => [key, data.get(key) || ""]));
      for (const name of formDateNames) {
        values[name] = parseFormDate(values[name]);
        if (!values[name]) throw new Error(`${labels[name]}. Используйте формат ${formDatePlaceholder()}.`);
      }
      return api("/api/miniapp/profile/identity", {method:"PUT", body:JSON.stringify(values)});
    });
    if (result && state.view === "orders") { resetProfileIdentity(); await loadProfileIdentity(false); }
  });
  $("profile-sort").addEventListener("change", (event) => { state.profileSort = event.target.value; state.profilePage = 0; void showOrders(); });
  $("profile-filter").addEventListener("change", (event) => { state.profileTargetId = null; state.profileFilter = event.target.value; state.profilePage = 0; void showOrders(); });
  $("profile-prev").addEventListener("click", () => { state.profilePage = Math.max(0, state.profilePage - 1); void showOrders(); });
  $("profile-next").addEventListener("click", () => { state.profilePage++; void showOrders(); });
  bindSiteLink($("tab-admin"), "management", () => revealNavigation(() => showAdmin(state.adminMode), () => $("admin-panel")));
  bindSiteLink($("admin-settings-open"), "management-settings", () => openAdminSettings());
  $("identity-close").addEventListener("click", () => { void showOrders(); });
  $("document-viewer-close").addEventListener("click", closeDocumentViewer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("document-viewer").hidden) closeDocumentViewer();  });
  $("document-viewer").addEventListener("keydown", (event) => { if (event.key === "Tab") trapDialogFocus(event, $("document-viewer")); });
  $("document-viewer-prev").addEventListener("click", async () => { if (documentViewerIndex > 0) { documentViewerIndex -= 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("document-viewer-next").addEventListener("click", async () => { if (documentViewerIndex < documentViewerItems.length - 1) { documentViewerIndex += 1; try { await loadDocumentViewerImage(documentViewerBookingId); } catch (error) { showError(error.message); } } });
  $("consent-next").addEventListener("click", async () => {
    const session = identitySession;
    if (!identitySessionCurrent(session)) return;
    if (!state.consent) return showError("Текст согласия не загружен.");
    if (!$("consent-check").checked) return showError("Чтобы продолжить, подтвердите согласие.");
    clearError(); const button = $("consent-next"); button.disabled = true;
    try {
      $("consent-step").hidden = true; $("identity-form").hidden = false;
      scrollElementIntoView($("identity-form"));
      const reusableDocuments = [...state.identityReusableDocuments];
      if (!reusableDocuments.length) return;
      const status = $("identity-status"), submit = $("identity-submit");
      status.textContent = "Подготавливаем фотографии из предыдущей анкеты…"; status.hidden = false;
      submit.disabled = true; submit.textContent = "Подготавливаем фотографии…";
      void restoreReusableIdentityPhotos(session, reusableDocuments).finally(() => {
        if (!identitySessionCurrent(session) || $("identity-form").hidden) return;
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
    const session = identitySession;
    if (!identitySessionCurrent(session)) return;
    const version = (session.photoVersions.get(input.name) || 0) + 1; session.photoVersions.set(input.name, version);
    const file = input.files?.[0] || null; await saveIdentityPhoto(input.name, file, session.bookingId);
    if (!identitySessionCurrent(session) || session.photoVersions.get(input.name) !== version) return;
    const status = input.closest(".field")?.querySelector(".file-draft-status");
    if (status) status.textContent = file ? `Загружено: ${file.name}` : "";
    clearIdentityFieldError(input);
  }));
  document.querySelectorAll('#identity-form input[type="file"]').forEach((input) => {
    const buttons = document.createElement("div"); buttons.className="action-row photo-actions";
    buttons.append(plainButton("Заменить",()=>input.click(),"ghost"));
    const remove = plainButton("🗑",async () => {
      const session = identitySession;
      if (!identitySessionCurrent(session)) return;
      const version = (session.photoVersions.get(input.name) || 0) + 1; session.photoVersions.set(input.name, version);
      input.value="";
      window.PolyRentalFileDrop?.clear(input);
      const needsReplacement = input.name !== "student_front" || state.identityRequiredPhotos.includes(input.name);
      input.required = needsReplacement;
      if (needsReplacement && !state.identityRequiredPhotos.includes(input.name)) state.identityRequiredPhotos.push(input.name);
      const status=input.closest(".field").querySelector(".file-draft-status");
      if (status) status.textContent = needsReplacement ? "Фото удалено. Загрузите новое перед отправкой." : "Фото удалено.";
      await saveIdentityPhoto(input.name, null, session.bookingId);
    },"ghost danger"); remove.setAttribute("aria-label","Удалить фото"); buttons.append(remove);
    input.closest(".field").insertAdjacentElement("afterend", buttons);
  });
  document.querySelectorAll(".admin-mode").forEach(button => bindSiteLink(button, `management-${button.dataset.mode}`, () =>
    revealNavigation(() => showAdmin(button.dataset.mode), () => $("admin-content"))));
  $("admin-queue").addEventListener("change", event => { state.adminQueue = event.target.value; state.adminPage = 0; state.adminTargetId = null; state.adminStatus = "all"; $("admin-status").value = "all"; void showAdmin("orders"); });
  $("admin-request-filter").addEventListener("change", (event) => { state.adminRequestFilter = event.target.value; state.adminTargetId = null; state.adminPage = 0; void showAdmin("orders"); });
  $("admin-status").addEventListener("change", (event) => { state.adminStatus = event.target.value; state.adminQueue = "all"; state.adminTargetId = null; state.adminPage = 0; void showAdmin("orders"); });
  $("admin-sort").addEventListener("change", (event) => { state.adminSort = event.target.value; state.adminTargetId = null; state.adminPage = 0; void showAdmin("orders"); });
  $("admin-clear-target").addEventListener("click", () => { state.adminTargetId = null; state.adminQueue = "all"; state.adminPage = 0; selectedRequestId = null; void showAdmin("orders"); });
  $("admin-prev").addEventListener("click", () => { state.adminTargetId = null; state.adminPage = Math.max(0, state.adminPage - 1); void showAdmin("orders"); });
  $("admin-next").addEventListener("click", () => { state.adminTargetId = null; state.adminPage++; void showAdmin("orders"); });
  $("done-orders").addEventListener("click", showOrders);
  $("done-chat").addEventListener("click", () => tg?.close?.());
  const bookingStartInput = $("start-time");
  bookingStartInput.addEventListener("input", () => {
    if (bookingStartInput.type === "time") normalizePastBookingStart();
    periodChanged();
  });
  const commitBookingStart = () => { if (normalizePastBookingStart()) periodChanged(); };
  bookingStartInput.addEventListener("change", commitBookingStart);
  bookingStartInput.addEventListener("blur", commitBookingStart);
  $("end-time").addEventListener("input", periodChanged);

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
  try { localStorage.removeItem(contactKey); } catch (_) {}
  void pruneExpiredIdentityPhotos();
  installKeyboardBookingTimes();
  syncDateFields("start"); syncDateFields("end");
  const restoredPeriod = ensureBookingPeriod(); applyBookingDateLimits();
  rangeCalendar = new window.PolyRentalCalendar.RangeCalendar($("range-calendar"), {
    minimum: minimumBookingDate(), start: $("start-date").value, end: $("end-date").value,
    isDisabled: scheduleDayDisabled,
    dayState: calendarDayState,
    dayNote: day => availabilityLabels[calendarDayState(day)] || "",
    onMonthChange: queueCalendarAvailability,
    onSelect: calendarImpact,
    onChange: ({start, end}) => { $("start-date").value = start; $("end-date").value = end; normalizePastBookingStart(); periodChanged(); },
  });
  if (!preview) void api("/api/miniapp/schedule").then((policy)=>{ if (!policy.enforced) return; schedulePolicy=policy; rangeCalendar.render(); applyBookingDateLimits(); render(); }).catch(()=>{});
  if (siteProfile) {
    const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'button ghost'; logout.textContent = 'Выйти';
    logout.addEventListener('click', () => {
      if (!guardIdentityNavigation()) return;
      void runButton(logout, async () => {
        const response = await fetch('/site/logout', {method:'POST', headers:{'X-Telegram-Init-Data':''}});
        if (!response.ok && !response.redirected) throw new Error('Не удалось выйти. Повторите попытку.');
        readCache.clear();
        location.assign('/site/login');
      }, error => showError(error instanceof TypeError ? 'Не удалось выйти. Проверьте соединение.' : error.message));
    });
    document.querySelector('.topbar').append(logout);
  }
  const profile = tg?.initDataUnsafe?.user || siteProfile;
  const tabAvatar = $("tab-avatar");
  try {
    const url = new URL(profile?.photo_url); if (url.protocol !== "https:") throw new Error();
    tabAvatar.classList.add("avatar-loading");
    const img = document.createElement("img"); img.alt = "";
    img.addEventListener("load", () => { tabAvatar.classList.remove("avatar-loading", "avatar-placeholder"); });
    img.addEventListener("error", () => { img.remove(); tabAvatar.classList.remove("avatar-loading"); });
    img.src = url.href; tabAvatar.append(img);
  } catch (_) { tabAvatar.classList.remove("avatar-loading"); }
  const siteCategories = preview ? Promise.resolve(false) : api("/api/miniapp/catalog/categories").then(result => {
    setCategories(result.items || []); render(); if (state.view === "flow" && state.step === 0) renderItems();
    return true;
  }).catch(() => false);
  if (preview) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Демонстрация интерфейса: можно пройти шаги, но заявка не отправляется."; }
  else if (!authorized && !keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Чтобы оформить бронь, откройте Mini App через кнопку в Telegram-боте."; }
  else if (keyboardMode) { $("mode-banner").hidden = false; $("mode-banner").textContent = "После отправки приложение закроется, а бот пришлёт номер заявки и статус."; }
  else if (siteProfile) { $("mode-banner").hidden = false; $("mode-banner").textContent = "Вы вошли через Telegram. Чтобы получать уведомления, начните диалог с ботом."; }
  else if (hasDraft && restoredPeriod) {
    const notice = document.createElement("div"); notice.className = "stage-toast"; notice.setAttribute("role", "status");
    const copy = document.createElement("span"); copy.textContent = "Мы восстановили сроки и выбранное оборудование из черновика на этом устройстве.";
    const close = plainButton("×", () => removeNotice(notice), "ghost"); close.setAttribute("aria-label", "Закрыть уведомление");
    notice.append(copy, close); document.body.append(notice); setTimeout(() => removeNotice(notice), 8000);
  }
  tg?.expand?.();
  if (authorized) {
    Promise.all([api("/api/miniapp/me"), api("/api/miniapp/profile").catch(() => null), api("/api/miniapp/cart").catch(() => null)]).then(async ([role, profileState, cart]) => {
      if (startup?.failed()) return;
      state.role = role; state.profile = profileState; $("tab-admin").hidden = !role.admin;
      if (cart && Number.isInteger(cart.version) && Array.isArray(cart.lines)) {
        state.cartVersion = cart.version; cartConfirmed = normalizedCart(cart);
        const pending = readPendingCart();
        if (pending && cartConfirmed && !sameCart(pending, cartConfirmed)) { cartPending = pending; applyCartSnapshot(cartConfirmed); showCartSyncProblem("Найдены несинхронизированные изменения. Показана серверная версия."); }
        else if (cart.start || cart.end || cart.lines.length) {
          if (pending) rememberPendingCart(null);
          $("start").value = cart.start; $("end").value = cart.end;
          state.quantities = new Map(cart.lines.map((line) => [line.article_id, line.quantity]));
          syncDateFields("start"); syncDateFields("end"); ensureBookingPeriod();
          rangeCalendar.setRange($("start-date").value, $("end-date").value); applyBookingDateLimits(); render();
        } else { if (pending) { rememberPendingCart(null); if (cartConfirmed) applyCartSnapshot(cartConfirmed); } if (hasDraft && !pending) saveDraft(); }
      } else {
        const pending = readPendingCart();
        if (pending) { cartPending = pending; showCartSyncProblem("Не удалось проверить серверную подборку. Подключитесь к сети для выбора действия."); }
      }
      void refreshCustomerHome();
      void claimStageNotices();
      const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get("startapp");
      const linkedIdentity = /^identity_(\d+)$/.exec(startParam || "")?.[1] || new URLSearchParams(location.search).get("identity");
      const linkedBooking = /^booking_(\d+)$/.exec(startParam || "")?.[1] || new URLSearchParams(location.search).get("booking");
      if (siteNavigation) {
        const legacy = /^\d+$/.test(linkedIdentity || "") || /^\d+$/.test(linkedBooking || "") ||
          /^(booking|my_bookings|orders|support_\d+)$/.test(startParam || "");
        if (await siteNavigation.start({useFragment: !legacy && profileState?.start_screen !== "blocked"})) return;
      }
      if (linkedIdentity && /^\d+$/.test(linkedIdentity)) { clearIdentityRestoreKey(); return openIdentity(Number(linkedIdentity)); }
      if (linkedBooking && /^\d+$/.test(linkedBooking)) {
        clearIdentityRestoreKey();
        if (role.admin) { selectedRequestId = Number(linkedBooking); state.adminTargetId = selectedRequestId; return showAdmin("orders"); }
        selectedCustomerOrderId = Number(linkedBooking); state.profileTargetId = Number(linkedBooking); state.profileFilter = "all"; $("profile-filter").value = "all"; return showOrders();
      }
      const linkedSupport = /^support_(\d+)$/.exec(startParam || "")?.[1];
      if (linkedSupport && role.admin) { clearIdentityRestoreKey(); state.supportTargetId = Number(linkedSupport); state.supportFilterId = state.supportTargetId; state.supportPage = 0; return showAdmin("support"); }
      if (["my_bookings", "orders"].includes(startParam)) { clearIdentityRestoreKey(); return showOrders(); }
      if (profileState?.start_screen === "blocked") { state.view = "blocked"; render(); return; }
      if (startParam === "booking") { clearIdentityRestoreKey(); if (role.admin) state.view = "admin"; enterClientMode(); return; }
      let identityDraft = null; try { identityDraft = localStorage.getItem("polyrental-identity-booking"); } catch (_) {}
      if (identityDraft && /^\d+$/.test(identityDraft)) return openIdentity(Number(identityDraft));
      if ((profileState?.start_screen || (role.admin ? "management" : "booking")) === "management" && role.admin) {
        let mode = profileState?.last_section || "orders"; if (!profileState?.last_section) try { mode = localStorage.getItem(`polyrental-admin-tab:${role.id}`) || "orders"; } catch (_) {}
        if (!["orders", "catalog", "repairs", "support", ].includes(mode)) mode = "orders";
        return showAdmin(mode);
      }
      if (state.view === "flow") {
        if (siteNavigation) await loadItems();
        else void loadItems();
      }
      void maybeShowOnboarding();
    }).then(() => {
      if (startup?.failed()) return;
      siteNavigation?.save();
      startup?.finish();
      document.documentElement.classList.remove("role-pending");
      void loadReleaseAnnouncement();
    }).catch(error => {
      if (startup?.active()) {
        startup.fail(error.status === 401 || error.status === 403
          ? "Не удалось подтвердить вход. Откройте приложение из Telegram ещё раз."
          : undefined);
      } else {
        document.documentElement.classList.remove("role-pending");
        showError("Не удалось определить права. Откройте приложение через Telegram ещё раз.");
        void loadReleaseAnnouncement();
      }
    });
  }
  tg?.onEvent?.("activated", () => { if (state.view === "orders") showOrders(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "orders") showOrders(); if (!document.hidden) showPendingRelease(); });

  if (!startup?.active()) tg?.ready?.();
  if (!authorized) void loadItems();
  render();
  if (!authorized) startup?.finish();
})();
