/* Dynamic dialogs leave the DOM after their exit. Hidden static dialogs use
   CSS discrete transitions, preserving immediate application/focus semantics. */
(() => {
  "use strict";
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const exits = new Map();
  const entries = new Map();
  function enter(element, direction = 1) {
    if (!element || preference.matches || typeof element.animate !== "function") return;
    entries.get(element)?.cancel();
    const animation = element.animate([{opacity: .55}, {opacity: 1}], {duration: 300, easing: "cubic-bezier(.22, 1, .36, 1)"});
    entries.set(element, animation);
    void animation.finished.catch(() => {}).then(() => {if (entries.get(element) === animation) entries.delete(element);});
  }
  function removeDialog(dialog, {collapse = false} = {}) {
    if (exits.has(dialog)) return exits.get(dialog).promise;
    dialog.setAttribute("data-modal-closing", "");
    dialog.inert = true;
    if (preference.matches || typeof dialog.animate !== "function") {
      dialog.remove();
      return Promise.resolve();
    }
    const card = dialog.querySelector(".dialog-card");
    const current = card && getComputedStyle(card);
    const frames = card && [{opacity: current.opacity, transform: current.transform}, {opacity: 0, transform: "translateY(8px) scale(.99)"}];
    const opacity = getComputedStyle(dialog).opacity;
    dialog.getAnimations({subtree: true}).forEach(animation => animation.cancel());
    const style = getComputedStyle(dialog);
    const exitFrames = collapse ? [
      {height: `${dialog.getBoundingClientRect().height}px`, opacity, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom},
      {height: "0px", minHeight: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px"}
    ] : [{opacity}, {opacity: 0}];
    if (collapse) dialog.style.overflow = "hidden";
    const animations = [dialog.animate(exitFrames, {duration: 160, easing: "ease-out", fill: "forwards"})];
    if (card) animations.push(card.animate(frames, {duration: 160, easing: "ease-out", fill: "forwards"}));
    const promise = Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      dialog.remove();
      animations.forEach(animation => animation.cancel());
      exits.delete(dialog);
    });
    exits.set(dialog, {animations, promise});
    return promise;
  }
  const headingAnimations = new Map();
  function morphText(element, nextText) {
    if (!element || element.textContent === nextText) return;
    const old = headingAnimations.get(element); old?.animations.forEach(animation=>animation.cancel()); old?.layer.remove();
    const previous = element.textContent;
    const previousRect = element.getBoundingClientRect();
    element.textContent = nextText;
    if (preference.matches || typeof element.animate !== "function" || !element.isConnected || !element.getClientRects().length) return;
    const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const layer = element.cloneNode(false); layer.removeAttribute("id"); layer.classList.add("heading-morph-copy"); layer.setAttribute("aria-hidden","true"); layer.textContent = previous;
    layer.style.cssText = `left:${previousRect.left}px;top:${previousRect.top}px;width:${previousRect.width}px;height:${previousRect.height}px`; document.body.append(layer);
    const exit = layer.animate([{opacity:1,transform:"scaleX(1)"},{opacity:0,transform:"scaleX(1.06)"}],{duration:240,easing:"ease-in",fill:"forwards"});
    const entry = element.animate([{opacity:0,transform:"scaleX(.95)"},{opacity:1,transform:"scaleX(1)"}],{duration:340,easing:"cubic-bezier(.22, 1, .36, 1)"});
    const state = {animations:[exit,entry], layer}; headingAnimations.set(element,state);
    void Promise.allSettled(state.animations.map(animation=>animation.finished)).then(()=>{layer.remove(); if(headingAnimations.get(element)===state) headingAnimations.delete(element);});
  }
  let categoryAnimation = null, categoryLayer = null;
  let categoryEntries = [];
  function captureCategoryView(panel) {
    if (!panel || preference.matches) return null;
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
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
    categoryAnimation = layer.animate(frames,{duration:480,easing:'cubic-bezier(.45, 0, .25, 1)',fill:'forwards'});
    const current = categoryAnimation; void current.finished.catch(()=>{}).then(()=>{layer.remove(); if(categoryAnimation===current){categoryAnimation=null;categoryLayer=null;}});
  }
  const cartFlights = new Set();
  function flyToCart(card, target) {
    if (preference.matches || !card || !target || target.hidden) return;
    const start = card.getBoundingClientRect(), end = target.getBoundingClientRect();
    if (!start.width || !start.height || !end.width || !end.height) return;
    while (cartFlights.size >= 3) { const oldest = cartFlights.values().next().value; oldest.animation.cancel(); oldest.layer.remove(); cartFlights.delete(oldest); }
    const layer = document.createElement('div'); layer.className = 'cart-flight'; layer.setAttribute('aria-hidden','true'); layer.inert = true;
    layer.style.cssText = `left:${start.left}px;top:${start.top}px;width:${start.width}px;height:${start.height}px`;
    const copy = card.cloneNode(true); copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id')); layer.append(copy); document.body.append(layer);
    const dx = end.left + end.width/2 - (start.left + start.width/2), dy = end.top + end.height/2 - (start.top + start.height/2);
    const bend = Math.min(50, Math.max(16, Math.abs(dx) * .18));
    const animation = layer.animate([{transform:'translate(0,0) scale(1)',opacity:.9},{transform:`translate(${dx*.48}px,${dy*.48-bend}px) scale(.6)`,opacity:.72,offset:.5},{transform:`translate(${dx}px,${dy}px) scale(.12)`,opacity:0}],{duration:580,easing:'cubic-bezier(.42, 0, .2, 1)',fill:'forwards'});
    const flight = {layer,animation}; cartFlights.add(flight);
    void animation.finished.catch(()=>{}).then(()=>{layer.remove();cartFlights.delete(flight);});
  }
  const reflows = new Map();
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
      if (height && nextHeight && height !== nextHeight) animations.push(host.animate([{height:`${height}px`},{height:`${nextHeight}px`}], {duration:300,easing:"cubic-bezier(.22, 1, .36, 1)"}));
      for (const [node, old] of children) {
        const current = node.getBoundingClientRect(), x = old.left-current.left, y = old.top-current.top;
        if ((x || y) && old.width && current.width) animations.push(node.animate([{transform:`translate(${x}px, ${y}px)`,opacity:.85},{transform:"none",opacity:1}], {duration:340,easing:"cubic-bezier(.22, 1, .36, 1)"}));
      }
      reflows.set(host, animations);
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => { if (reflows.get(host) === animations) reflows.delete(host); });
    }
  }
  preference.addEventListener("change", () => {
    if (preference.matches) {
      for (const state of headingAnimations.values()) { state.animations.forEach(animation=>animation.cancel()); state.layer.remove(); } headingAnimations.clear();
      for (const animation of entries.values()) animation.cancel();
      for (const animations of reflows.values()) animations.forEach(animation => animation.cancel());
      for (const flight of cartFlights) { flight.animation.cancel(); flight.layer.remove(); } cartFlights.clear();
      reflows.clear(); categoryAnimation?.cancel(); categoryLayer?.remove(); categoryAnimation = null; categoryLayer = null; categoryEntries.forEach(animation=>animation.cancel()); categoryEntries = [];
      for (const {animations} of exits.values()) animations.forEach(animation => animation.finish());
    }
  });
  window.PolyRentalMotion = {removeDialog, removeRow: element => removeDialog(element, {collapse: true}), enter, reflow, cancelReflow, captureCategory, categoryMorph, captureCategoryView, transitionCategoryView, waitCategory: () => categoryAnimation?.finished.catch(()=>{}), flyToCart, cancelTransient, morphText};
})();
