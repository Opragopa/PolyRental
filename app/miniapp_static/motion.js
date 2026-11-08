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
    const animation = element.animate([{opacity: .4, transform: `translateX(${direction * 8}px)`}, {opacity: 1, transform: "none"}], {duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)"});
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
  preference.addEventListener("change", () => {
    if (preference.matches) {
      for (const animation of entries.values()) animation.cancel();
      for (const {animations} of exits.values()) animations.forEach(animation => animation.finish());
    }
  });
  window.PolyRentalMotion = {removeDialog, removeRow: element => removeDialog(element, {collapse: true}), enter};
})();
