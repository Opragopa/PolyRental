/* Fit labelled controls proportionally; wrap only after the readable limit.
   Observe widths rather than heights so fitting cannot trigger resize loops. */
(() => {
  "use strict";
  const root = document.documentElement;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const buttons = new Set();
  const widths = new WeakMap();
  let frame;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const observer = new ResizeObserver(entries => {
    for (const {target, contentRect} of entries) {
      if (target.matches(".tabs, .action-bar") || widths.get(target) !== contentRect.width) {
        widths.set(target, contentRect.width);
        schedule();
      }
    }
  });
  function update() {
    frame = 0;
    const writes = [];
    for (const button of buttons) {
      if (!button.isConnected) {
        observer.unobserve(button);
        buttons.delete(button);
        continue;
      }
      if (!button.getClientRects().length || !context) continue;
      const style = getComputedStyle(button);
      const previous = parseFloat(style.getPropertyValue("--button-fit")) || 1;
      const fontSize = parseFloat(style.fontSize);
      context.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      const text = button.textContent.trim().replace(/\s+/g, " ");
      const icons = [...button.querySelectorAll(".icon")];
      const iconWidth = icons.reduce((sum, icon) => sum + icon.getBoundingClientRect().width, 0);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const gap = (parseFloat(style.columnGap) || 0) * icons.length;
      const natural = (context.measureText(text).width + iconWidth + padding + gap) / previous;
      const available = button.clientWidth;
      if (!available || !natural) continue;
      const scale = Math.min(1, Math.max(.78, 11 / (fontSize / previous), (available - 1) / natural));
      if (Math.abs(scale - previous) > .005) writes.push(() => button.style.setProperty("--button-fit", scale.toFixed(3)));
    }
    const tabs = document.querySelector(".tabs");
    const footer = document.querySelector(".action-bar");
    if (tabs) {
      const style = getComputedStyle(tabs);
      const height = tabs.getBoundingClientRect().height - parseFloat(style.paddingBottom);
      writes.push(() => root.style.setProperty("--nav-height", `${height}px`));
    }
    if (footer) {
      const height = footer.getBoundingClientRect().height;
      writes.push(() => root.style.setProperty("--footer-height", `${height}px`));
    }
    writes.forEach(write => write());
  }
  function discover() {
    document.querySelectorAll(".button").forEach(button => {
      if (buttons.has(button) || !button.textContent.trim() || button.closest(".quantity-control") || button.matches(".admin-mode, .icon-action, .catalog-layout-icon")) return;
      buttons.add(button);
      observer.observe(button);
    });
    schedule();
  }
  document.querySelectorAll(".tabs, .action-bar").forEach(node => observer.observe(node));
  new MutationObserver(discover).observe(document.body, {subtree: true, childList: true, characterData: true});
  window.addEventListener("resize", schedule, {passive: true});
  document.fonts?.ready.then(schedule);
  discover();
})();
