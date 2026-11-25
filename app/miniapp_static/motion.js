/* Dynamic dialogs leave the DOM after their exit. Hidden static dialogs use
   CSS discrete transitions, preserving immediate application/focus semantics. */
(() => {
  "use strict";
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const desktop = matchMedia("(min-width: 769px)");
  const exits = new Map();
  const entries = new Map();
  const feedbackAnimations = new Map();
  const presses = new Map();
  function feedbackAnimation(element, frames, options = {}) {
    if (!element || preference.matches || typeof element.animate !== "function") return;
    feedbackAnimations.get(element)?.cancel();
    const animation = element.animate(frames, {duration:240, easing:"cubic-bezier(.22,1,.36,1)", ...options});
    feedbackAnimations.set(element, animation);
    void animation.finished.catch(()=>{}).then(()=>{ if (feedbackAnimations.get(element) === animation) feedbackAnimations.delete(element); });
  }
  function quantityFeedback(value, target) {
    if (desktop.matches) {
      feedbackAnimation(value, [{opacity:.65}, {opacity:1}], {duration:140});
      feedbackAnimation(target, [{boxShadow:"0 0 0 2px var(--accent)"}, {boxShadow:"0 0 0 2px transparent"}], {duration:180});
      return;
    }
    // Only the number deforms; neither the text around it nor the hit area moves.
    feedbackAnimation(value, [{transform:"scale(1)"}, {transform:"scale(1.16,.84)",offset:.22}, {transform:"scale(.94,1.09)",offset:.6}, {transform:"scale(1)"}]);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    feedbackAnimation(target, [{boxShadow:"0 0 0 0 transparent"}, {boxShadow:`0 0 0 3px ${color}`,offset:.35}, {boxShadow:"0 0 0 0 transparent"}], {duration:280, delay:80});
  }
  function stage(element, direction = 1) {
    if (desktop.matches) { enter(element); return; }
    feedbackAnimation(element, [{opacity:.5,transform:`translateY(${direction * 10}px)`}, {opacity:1,transform:"translateY(0)"}], {duration:220});
  }
  function result(element) {
    if (desktop.matches) {
      feedbackAnimation(element, [{opacity:.6,transform:"scale(.97)"}, {opacity:1,transform:"none"}], {duration:160});
      return;
    }
    feedbackAnimation(element, [{transform:"perspective(600px) rotateX(12deg) scale(.82)"}, {transform:"perspective(600px) rotateX(-2deg) scale(1.08)",offset:.65}, {transform:"perspective(600px) rotateX(0) scale(1)"}], {duration:320});
  }
  function startPress(key, button) {
    if (preference.matches || !button || button.disabled || presses.has(key)) return;
    const rect = button.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const layer = document.createElement('div'); layer.className='press-feedback'; layer.inert=true; layer.setAttribute('aria-hidden','true');
    layer.style.cssText=`left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border-radius:${getComputedStyle(button).borderRadius}`;
    document.body.append(layer);
    const animation=layer.animate(desktop.matches ? [{opacity:.02},{opacity:.10}] : [{transform:'scale(.94)',opacity:.04},{transform:'scale(1)',opacity:.14}],{duration:desktop.matches ? 70 : 90,easing:'ease-out',fill:'forwards'});
    presses.set(key,{layer,animation});
  }
  function endPress(key, cancelled = false) {
    const state=presses.get(key); if (!state) return; presses.delete(key); state.animation.cancel();
    if (cancelled || preference.matches) { state.layer.remove(); return; }
    const animation=state.layer.animate(desktop.matches ? [{opacity:.10},{opacity:0}] : [{transform:'scale(1)',opacity:.14},{transform:'scale(1.035)',opacity:0}],{duration:desktop.matches ? 100 : 140,easing:'ease-out'});
    state.animation=animation;
    // Keep releasing cues tracked so navigation and reduced motion remove them.
    const releaseKey=Symbol('release'); presses.set(releaseKey,state);
    void animation.finished.catch(()=>{}).then(()=>{state.layer.remove();presses.delete(releaseKey);});
  }
  document.addEventListener('pointerdown',event=>{ if (event.button===0) startPress(event.pointerId,event.target.closest?.('button')); },true);
  document.addEventListener('pointerup',event=>endPress(event.pointerId),true);
  document.addEventListener('pointercancel',event=>endPress(event.pointerId,true),true);
  document.addEventListener('keydown',event=>{if (!event.repeat && ['Enter',' '].includes(event.key)) startPress('keyboard',event.target.closest?.('button'));},true);
  document.addEventListener('keyup',event=>{if (['Enter',' '].includes(event.key)) endPress('keyboard');},true);
  window.addEventListener('blur',()=>{for(const key of presses.keys())endPress(key,true);});
  function enter(element) {
    if (!element || preference.matches || typeof element.animate !== "function") return;
    entries.get(element)?.cancel();
    const animation = element.animate([{opacity: desktop.matches ? .82 : .55}, {opacity: 1}], {duration: desktop.matches ? 160 : 300, easing: "cubic-bezier(.22, 1, .36, 1)"});
    entries.set(element, animation);
    void animation.finished.catch(() => {}).then(() => {if (entries.get(element) === animation) entries.delete(element);});
  }
  function removeDialog(dialog, {collapse = false} = {}) {
    if (exits.has(dialog)) return exits.get(dialog).promise;
    dialog.setAttribute("data-modal-closing", "");
    dialog.inert = true;
    dialog.style.pointerEvents = "none";
    if (preference.matches || typeof dialog.animate !== "function") {
      dialog.remove();
      return Promise.resolve();
    }
    const card = dialog.querySelector(".dialog-card");
    const current = card && getComputedStyle(card);
    const frames = card && [{opacity: current.opacity, transform: current.transform}, {opacity: 0, transform: desktop.matches ? "scale(.985)" : "translateY(8px) scale(.99)"}];
    const opacity = getComputedStyle(dialog).opacity;
    dialog.getAnimations({subtree: true}).forEach(animation => animation.cancel());
    const style = getComputedStyle(dialog);
    const exitFrames = collapse ? [
      {height: `${dialog.getBoundingClientRect().height}px`, opacity, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom},
      {height: "0px", minHeight: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px"}
    ] : [{opacity}, {opacity: 0}];
    if (collapse) dialog.style.overflow = "clip";
    const animations = [dialog.animate(exitFrames, {duration: 160, easing: "ease-out", fill: "forwards"})];
    if (card) animations.push(card.animate(frames, {duration: 160, easing: "ease-out", fill: "forwards"}));
    let exitTimeout;
    const deadline = new Promise(resolve => { exitTimeout = setTimeout(resolve, 400); });
    const promise = Promise.race([Promise.allSettled(animations.map(animation => animation.finished)), deadline]).then(() => {
      clearTimeout(exitTimeout);
      dialog.remove();
      animations.forEach(animation => animation.cancel());
      exits.delete(dialog);
    });
    exits.set(dialog, {animations, promise});
    return promise;
  }
  function morphEquipmentPreview(dialog, source, radius, close) {
    if (preference.matches) {
      close.focus({preventScroll:true});
      return;
    }
    if (desktop.matches) {
      feedbackAnimation(dialog.querySelector(".dialog-card"), [{opacity:.7,transform:"scale(.985)"}, {opacity:1,transform:"none"}], {duration:160});
      close.focus({preventScroll:true});
      return;
    }
    if (typeof dialog.animate !== "function" || !source.width || !source.height) return;
    const card = dialog.querySelector(".dialog-card");
    const destination = card.getBoundingClientRect();
    if (!destination.width || !destination.height) return;
    const shell = document.createElement("div");
    shell.className = "equipment-preview-morph";
    shell.setAttribute("aria-hidden", "true");
    const shade = document.createElement("div");
    shade.className = "equipment-preview-shade";
    shade.setAttribute("aria-hidden", "true");
    shade.style.backgroundColor = getComputedStyle(dialog).backgroundColor;
    const background = dialog.style.backgroundColor;
    dialog.style.backgroundColor = "transparent";
    const style = getComputedStyle(card);
    Object.assign(shell.style, {
      left: `${destination.left}px`, top: `${destination.top}px`, width: `${destination.width}px`,
      height: `${destination.height}px`, borderRadius: style.borderRadius || radius,
      backgroundColor: style.backgroundColor, borderColor: style.borderColor,
    });
    const translation = `translate(${source.left - destination.left}px, ${source.top - destination.top}px)`;
    const scale = `scale(${source.width / destination.width}, ${source.height / destination.height})`;
    dialog.classList.add("is-preview-morphing");
    dialog.append(shade, shell);
    dialog.tabIndex = -1;
    dialog.focus({preventScroll:true});
    const timing = {duration:340, easing:"cubic-bezier(.22, 1, .36, 1)"};
    const animation = shell.animate([{transform:`${translation} ${scale}`}, {transform:"none"}], {...timing, fill:"both"});
    const fade = shade.animate([{opacity:0}, {opacity:1}], {...timing, fill:"both"});
    const reduce = () => { if (preference.matches) animation.finish(); };
    preference.addEventListener("change", reduce);
    void animation.finished.catch(() => {}).then(() => {
      preference.removeEventListener("change", reduce);
      fade.cancel();
      shade.remove();
      shell.remove();
      dialog.style.backgroundColor = background;
      dialog.classList.remove("is-preview-morphing");
      if (!dialog.isConnected || dialog.hasAttribute("data-modal-closing")) return;
      if (!preference.matches) {
        for (const child of card.children) child.animate([{opacity:0}, {opacity:1}], {duration:130, easing:"ease-out"});
      }
      close.focus({preventScroll:true});
    });
  }

  const headingAnimations = new Map();
  function morphText(element, nextText, {direction = 0} = {}) {
    if (!element || element.textContent === nextText) return;
    const old = headingAnimations.get(element);
    const current = old && direction ? getComputedStyle(element) : null;
    const outgoingOpacity = current?.opacity || 1;
    const outgoingTransform = current?.transform || "none";
    const returning = direction && old?.layer.textContent === nextText ? getComputedStyle(old.layer) : null;
    const incomingOpacity = returning?.opacity || 0;
    const incomingTransform = returning?.transform;
    old?.animations.forEach(animation=>animation.cancel()); old?.layer.remove();
    if (desktop.matches && !direction) {
      element.textContent = nextText;
      feedbackAnimation(element, [{opacity:.75}, {opacity:1}], {duration:140});
      return;
    }
    const previous = element.textContent;
    const previousRect = element.getBoundingClientRect();
    element.textContent = nextText;
    if (preference.matches || typeof element.animate !== "function" || !element.isConnected || !element.getClientRects().length) return;
    const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const layer = element.cloneNode(false); layer.removeAttribute("id"); layer.removeAttribute("tabindex");
    layer.setAttribute("aria-hidden","true"); layer.inert = true; layer.textContent = previous;
    let exit, entry;
    if (direction) {
      const distance = Math.min(56, rect.width / 4) * direction;
      const options = {duration:260, easing:"cubic-bezier(.3, .1, .25, 1)"};
      layer.classList.add("admin-heading-copy"); element.before(layer);
      exit = layer.animate([{opacity:outgoingOpacity,transform:outgoingTransform},
        {opacity:0,transform:`translateX(${-distance}px)`}], {...options, fill:"forwards"});
      entry = element.animate([{opacity:incomingOpacity,transform:incomingTransform || `translateX(${distance}px)`},
        {opacity:1,transform:"translateX(0px)"}], options);
    } else {
      layer.classList.add("heading-morph-copy");
      layer.style.cssText = `left:${previousRect.left}px;top:${previousRect.top}px;width:${previousRect.width}px;height:${previousRect.height}px`;
      document.body.append(layer);
      exit = layer.animate([{opacity:1,transform:"scaleX(1)"},{opacity:0,transform:"scaleX(1.02)"}],{duration:160,easing:"ease-in",fill:"forwards"});
      entry = element.animate([{opacity:0,transform:"scaleX(.98)"},{opacity:1,transform:"scaleX(1)"}],{duration:240,easing:"cubic-bezier(.22, 1, .36, 1)"});
    }
    const state = {animations:[exit,entry], layer}; headingAnimations.set(element,state);
    void Promise.allSettled(state.animations.map(animation=>animation.finished)).then(()=>{layer.remove(); if(headingAnimations.get(element)===state) headingAnimations.delete(element);});
  }
  let categoryAnimation = null, categoryLayer = null;
  let categoryEntries = [];
  function captureCategoryView(panel) {
    if (!panel || preference.matches) return null;
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (desktop.matches) return {};
    const copy = panel.cloneNode(true);
    copy.querySelectorAll('.category-empty-overlay').forEach(node => node.remove());
    copy.inert = true;
    return {copy, left:rect.left, top:rect.top, width:rect.width, height:rect.height};
  }
  function transitionCategoryView(snapshot, panel, direction) {
    categoryAnimation?.cancel(); categoryLayer?.remove();
    categoryEntries.forEach(animation => animation.cancel()); categoryEntries = [];
    categoryAnimation = null; categoryLayer = null;
    if (!snapshot || !panel || preference.matches) return;
    if (desktop.matches) {
      const current = panel.animate([{opacity:.82},{opacity:1}], {duration:160,easing:'ease-out'});
      categoryAnimation = current;
      void current.finished.catch(()=>{}).then(()=>{if (categoryAnimation === current) categoryAnimation = null;});
      return;
    }
    if (!snapshot.copy) return;
    const layer = document.createElement('div');
    layer.className = 'category-level-transition'; layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
    layer.style.cssText = `left:${snapshot.left}px;top:${snapshot.top}px;width:${snapshot.width}px;height:${snapshot.height}px`;
    const moving = document.createElement('div'); moving.className = 'category-level-outgoing'; layer.append(moving);
    const shadow = moving.attachShadow({mode:'closed'});
    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => shadow.append(link.cloneNode()));
    const style = document.createElement('style'); style.textContent = ':host > *:not(link):not(style){width:100% !important;min-height:100%;margin:0 !important;pointer-events:none}'; shadow.append(style, snapshot.copy);
    document.body.append(layer); categoryLayer = layer;
    const offset = Math.round(snapshot.width) * (direction < 0 ? -1 : 1);
    const options = {duration:340, easing:'cubic-bezier(.25, .1, .25, 1)'};
    categoryAnimation = moving.animate([{transform:'translateX(0)'},{transform:`translateX(${-offset}px)`}], options);
    for (const child of panel.children) {
      if (child.hidden) continue;
      const targets = child.matches('#items-grid, .admin-catalog-items') ? [...child.children] : [child];
      for (const target of targets) {
        if (target.matches('.category-empty-overlay') || target.querySelector('.category-empty-overlay')) continue;
        categoryEntries.push(target.animate([{transform:`translateX(${offset}px)`},{transform:'translateX(0)'}], options));
      }
    }
    const current = categoryAnimation;
    void current.finished.catch(()=>{}).then(()=>{layer.remove(); if(categoryAnimation===current){categoryAnimation=null;categoryLayer=null;categoryEntries=[];}});
  }
  function captureCategory(element) {
    if (!element || preference.matches) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const copy = element.cloneNode(true); copy.removeAttribute('id'); copy.removeAttribute('data-category-code'); copy.querySelectorAll('[id], [data-category-code]').forEach(node => { node.removeAttribute('id'); node.removeAttribute('data-category-code'); });
    return {left:rect.left, top:rect.top, width:rect.width, height:rect.height, copy};
  }
  function cancelTransient() {
    for (const host of surfaces.keys()) cancelSurface(host);
    for (const animation of feedbackAnimations.values()) animation.cancel(); feedbackAnimations.clear();
    for (const key of presses.keys()) endPress(key,true);
    for (const state of headingAnimations.values()) { state.animations.forEach(animation=>animation.cancel()); state.layer.remove(); } headingAnimations.clear();
    categoryAnimation?.cancel(); categoryLayer?.remove(); categoryAnimation = null; categoryLayer = null;
    categoryEntries.forEach(animation=>animation.cancel()); categoryEntries = [];
    for (const flight of cartFlights) { flight.animation.cancel(); flight.layer.remove(); } cartFlights.clear();
  }
  function categoryMorph(snapshot, destination) {
    categoryAnimation?.cancel(); categoryLayer?.remove(); categoryAnimation = null; categoryLayer = null;
    if (!snapshot || !destination || preference.matches) return;
    const end = destination.getBoundingClientRect();
    if (!end.width || !end.height) return;
    const layer = document.createElement('div'); layer.className = 'category-transition-shape'; layer.setAttribute('aria-hidden','true');
    snapshot.copy.classList.add('category-transition-copy'); snapshot.copy.inert = true; layer.append(snapshot.copy); document.body.append(layer); categoryLayer = layer;
    // Keep the cloned contents at their original size while the mask changes.
    // Otherwise grid/list labels reflow on every animation frame.
    snapshot.copy.style.setProperty('width', `${snapshot.width}px`, 'important');
    snapshot.copy.style.setProperty('height', `${snapshot.height}px`, 'important');
    const middleLeft = (snapshot.left + end.left) / 2;
    const middleTop = (snapshot.top + end.top) / 2 - Math.min(18, Math.abs(snapshot.top-end.top) * .08);
    const frames = [{left:`${snapshot.left}px`,top:`${snapshot.top}px`,width:`${snapshot.width}px`,height:`${snapshot.height}px`,borderRadius:'14px',opacity:.96},
      {left:`${middleLeft}px`,top:`${middleTop}px`,width:`${(snapshot.width+end.width)/2}px`,height:`${(snapshot.height+end.height)/2}px`,borderRadius:'11px',opacity:.68,offset:.5},
      {left:`${end.left}px`,top:`${end.top}px`,width:`${end.width}px`,height:`${end.height}px`,borderRadius:'8px',opacity:0}];
    categoryAnimation = layer.animate(frames,{duration:320,easing:'cubic-bezier(.45, 0, .25, 1)',fill:'forwards'});
    const current = categoryAnimation; void current.finished.catch(()=>{}).then(()=>{layer.remove(); if(categoryAnimation===current){categoryAnimation=null;categoryLayer=null;}});
  }
  const cartFlights = new Set();
  function flyToCart(card, target) {
    if (preference.matches || !card || !target || target.hidden) return;
    if (desktop.matches) return; // quantityFeedback already highlights the counter and cart button.
    const source = card.querySelector('.catalog-media') || card;
    const start = source.getBoundingClientRect(), end = target.getBoundingClientRect();
    if (!start.width || !start.height || !end.width || !end.height) return;
    while (cartFlights.size >= 3) { const oldest = cartFlights.values().next().value; oldest.animation.cancel(); oldest.layer.remove(); cartFlights.delete(oldest); }
    const layer = document.createElement('div'); layer.className = 'cart-flight'; layer.setAttribute('aria-hidden','true'); layer.inert = true;
    layer.style.cssText = `left:${start.left}px;top:${start.top}px;width:${start.width}px;height:${start.height}px`;
    const copy = source.cloneNode(true); copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id')); layer.append(copy); document.body.append(layer);
    const dx = end.left + end.width/2 - (start.left + start.width/2), dy = end.top + end.height/2 - (start.top + start.height/2);
    const bend = Math.min(50, Math.max(16, Math.abs(dx) * .18));
    const animation = layer.animate([{transform:'translate(0,0) scale(1)',opacity:.9},{transform:`translate(${dx*.48}px,${dy*.48-bend}px) scale(.6)`,opacity:.72,offset:.5},{transform:`translate(${dx}px,${dy}px) scale(.12)`,opacity:0}],{duration:420,easing:'cubic-bezier(.42, 0, .2, 1)',fill:'forwards'});
    const flight = {layer,animation}; cartFlights.add(flight);
    void animation.finished.catch(()=>{}).then(()=>{layer.remove();cartFlights.delete(flight);});
  }
  const reflows = new Map();
  const surfaces = new Map();
  function cancelSurface(host) {
    const state = surfaces.get(host);
    if (!state) return;
    surfaces.delete(host); state.observer?.disconnect(); cancelAnimationFrame(state.resizeFrame); state.animation?.cancel();
    host.style.overflow = state.overflow;
  }
  function surface(host, change, {fade = true} = {}) {
    const height = host.getBoundingClientRect().height;
    const opacity = fade ? (surfaces.has(host) ? getComputedStyle(host).opacity : .65) : 1;
    cancelSurface(host);
    change();
    if (preference.matches || !host.getClientRects().length || typeof host.animate !== 'function') return;
    const state = {overflow:host.style.overflow};
    surfaces.set(host, state);
    host.style.overflow = 'clip';
    const animate = (from, fromOpacity = getComputedStyle(host).opacity) => {
      state.animation?.cancel();
      const target = host.getBoundingClientRect().height;
      state.animation = host.animate([{height:`${from}px`,opacity:fromOpacity},{height:`${target}px`,opacity:1}],
        {duration:desktop.matches ? 170 : 220,easing:'cubic-bezier(.22,1,.36,1)'});
      const current = state.animation;
      void current.finished.catch(()=>{}).then(()=>{
        if (surfaces.get(host) === state && state.animation === current) cancelSurface(host);
      });
    };
    animate(height, opacity);
    // Loading a form while entering must not leave a stale fixed end height.
    if (typeof ResizeObserver === 'function') {
      const sizes = new Map([...host.children].map(node=>[node,`${node.getBoundingClientRect().width}:${node.getBoundingClientRect().height}`]));
      state.observer = new ResizeObserver(entries=>{
        let changed = false;
        for (const {target} of entries) {
          const rect = target.getBoundingClientRect(), size = `${rect.width}:${rect.height}`;
          if (sizes.get(target) !== size) changed = true;
          sizes.set(target,size);
        }
        if (changed && !state.resizeFrame) state.resizeFrame = requestAnimationFrame(() => {
          state.resizeFrame = 0;
          if (surfaces.get(host) === state) animate(host.getBoundingClientRect().height);
        });
      });
      for (const child of host.children) state.observer.observe(child);
    }
  }
  function cancelReflow(containers) {
    for (const host of containers.filter(Boolean)) { for (const animation of reflows.get(host) || []) animation.cancel(); reflows.delete(host); }
  }
  function reflow(containers, change) {
    const hosts = containers.filter(host => host && !host.hidden);
    const before = hosts.map(host => ({host, height:host.getBoundingClientRect().height, children:[...host.children].map(node => [node, node.getBoundingClientRect()])}));
    cancelReflow(hosts);
    if (preference.matches || !hosts.length) { change(); return; }
    change();
    for (const {host, height, children} of before) {
      const animations = [], nextHeight = host.getBoundingClientRect().height;
      if (!desktop.matches && height && nextHeight && height !== nextHeight) animations.push(host.animate([{height:`${height}px`},{height:`${nextHeight}px`}], {duration:300,easing:"cubic-bezier(.22, 1, .36, 1)"}));
      for (const [node, old] of children) {
        const current = node.getBoundingClientRect(), x = old.left-current.left, y = old.top-current.top;
        if ((x || y) && old.width && current.width) {
          const ratio = desktop.matches ? Math.min(1, 12 / Math.hypot(x, y)) : 1;
          animations.push(node.animate([{transform:`translate(${x * ratio}px, ${y * ratio}px)`,opacity:.85},{transform:"none",opacity:1}], {duration:desktop.matches ? 160 : 340,easing:"cubic-bezier(.22, 1, .36, 1)"}));
        }
      }
      reflows.set(host, animations);
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => { if (reflows.get(host) === animations) reflows.delete(host); });
    }
  }
  function resetViewportMotion() {
    cancelTransient();
    cancelReflow([...reflows.keys()]);
    for (const animation of entries.values()) animation.cancel();
  }
  desktop.addEventListener("change", resetViewportMotion);
  matchMedia("(min-width: 1024px)").addEventListener("change", resetViewportMotion);
  preference.addEventListener("change", () => {
    if (preference.matches) {
      for (const host of surfaces.keys()) cancelSurface(host);
      for (const animation of feedbackAnimations.values()) animation.cancel(); feedbackAnimations.clear();
      for (const key of presses.keys()) endPress(key,true);
      for (const state of headingAnimations.values()) { state.animations.forEach(animation=>animation.cancel()); state.layer.remove(); } headingAnimations.clear();
      for (const animation of entries.values()) animation.cancel();
      for (const animations of reflows.values()) animations.forEach(animation => animation.cancel());
      for (const flight of cartFlights) { flight.animation.cancel(); flight.layer.remove(); } cartFlights.clear();
      reflows.clear(); categoryAnimation?.cancel(); categoryLayer?.remove(); categoryAnimation = null; categoryLayer = null; categoryEntries.forEach(animation=>animation.cancel()); categoryEntries = [];
      for (const {animations} of exits.values()) animations.forEach(animation => animation.finish());
    }
  });
  window.PolyRentalMotion = {surface, cancelSurface, removeDialog, removeRow: element => removeDialog(element, {collapse: true}), enter, reflow, cancelReflow, captureCategory, categoryMorph, captureCategoryView, transitionCategoryView, waitCategory: () => categoryAnimation?.finished.catch(()=>{}), flyToCart, cancelTransient, morphText, morphEquipmentPreview, quantityFeedback, stage, result};
})();
