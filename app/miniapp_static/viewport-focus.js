/* Keep user-initiated reveals in view without moving keyboard focus or taking over scrolling. */
(() => {
  "use strict";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const root = () => document.scrollingElement || document.documentElement;
  const modal = '[role="dialog"][aria-modal="true"]';
  let active = null;
  let interaction = 0;

  function scrollOwner(element) {
    const dialog = element.closest(modal);
    for (let parent = element.parentElement; parent && parent !== root(); parent = parent.parentElement) {
      if (dialog && !dialog.contains(parent)) return null;
      if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) &&
          parent.scrollHeight > parent.clientHeight + 1) return parent;
      if (parent === dialog) return null;
    }
    return dialog ? null : root();
  }

  function viewport(owner, element) {
    const style = getComputedStyle(owner);
    const page = owner === root();
    const screenTop = window.visualViewport?.offsetTop || 0;
    const screenBottom = screenTop + (window.visualViewport?.height || window.innerHeight);
    const ownerTop = page ? screenTop : owner.getBoundingClientRect().top + owner.clientTop;
    const visibleTop = Math.max(screenTop, ownerTop);
    const visibleBottom = page ? screenBottom : Math.min(screenBottom, ownerTop + owner.clientHeight);
    let top = visibleTop + (parseFloat(style.scrollPaddingTop) || 0);
    let bottom = visibleBottom;
    const rect = element.getBoundingClientRect();
    const scope = page ? document : owner;
    scope.querySelectorAll("header, [data-scroll-obstruction], .tabs, .action-bar, .equipment-preview-dialog .action-row").forEach(node => {
      if (node.contains(element) || node.closest("[hidden], [inert]")) return;
      const obstruction = getComputedStyle(node);
      if (!["sticky", "fixed"].includes(obstruction.position) || obstruction.visibility === "hidden") return;
      if (node.matches('.tabs') && obstruction.flexDirection === 'column') return;
      const box = node.getBoundingClientRect();
      if (!box.height || box.right <= rect.left || box.left >= rect.right) return;
      const bottomEdge = node.matches('.tabs, .action-bar, [data-scroll-obstruction="bottom"], .equipment-preview-dialog .action-row');
      if (obstruction.position === "fixed") {
        if (box.bottom <= visibleTop || box.top >= visibleBottom) return;
        if (bottomEdge || (!node.matches('header, [data-scroll-obstruction="top"]') &&
            box.top + box.bottom > visibleTop + visibleBottom)) bottom = Math.min(bottom, box.top);
        else top = Math.max(top, box.bottom);
      } else if (bottomEdge || obstruction.top === "auto") {
        bottom = Math.min(bottom, visibleBottom - (parseFloat(obstruction.bottom) || 0) - box.height);
      } else {
        top = Math.max(top, ownerTop + (parseFloat(obstruction.top) || 0) + box.height);
      }
    });
    return [top, Math.min(bottom, visibleBottom - (parseFloat(style.scrollPaddingBottom) || 0))];
  }

  function scroll(owner, top, behavior) {
    if (owner === root()) window.scrollTo({top, left: window.scrollX, behavior});
    else owner.scrollTo({top, left: owner.scrollLeft, behavior});
  }

  function finish(request, interrupted = false) {
    if (active !== request) return;
    active = null;
    cancelAnimationFrame(request.frame);
    if (interrupted && request.owner) scroll(request.owner, request.owner.scrollTop, "instant");
    request.resolve(!interrupted);
  }

  function cancel() {
    if (active) finish(active, true);
  }

  function move(request, owner, destination, instant = false) {
    const limit = owner.scrollHeight - owner.clientHeight;
    const target = Math.max(0, Math.min(destination, limit));
    if (Math.abs(owner.scrollTop - target) < 1) return finish(request);
    if (instant || reduced.matches) {
      scroll(owner, target, "instant");
      return finish(request);
    }
    request.owner = owner;
    request.destination = target;
    scroll(owner, target, "smooth");
    const started = performance.now();
    let previous = owner.scrollTop, still = 0;
    const monitor = now => {
      if (active !== request) return;
      if (!request.valid()) return finish(request, true);
      still = Math.abs(owner.scrollTop - previous) < .25 ? still + 1 : 0;
      previous = owner.scrollTop;
      if (Math.abs(previous - target) < 1 || (now - started > 180 && still >= 6)) return finish(request);
      request.frame = requestAnimationFrame(monitor);
    };
    request.frame = requestAnimationFrame(monitor);
  }

  function requestScroll(valid, prepare) {
    cancel();
    return new Promise(resolve => {
      const request = {valid, resolve, frame: 0, owner: null};
      active = request;
      prepare(request);
    });
  }

  /**
   * @param {Element | null | undefined} element
   * @param {{block?: "center" | "start" | "nearest", valid?: () => boolean, since?: number,
   *   after?: PromiseLike<unknown>, instant?: boolean}} [options]
   */
  function reveal(element, {block = "center", valid = () => true, since = interaction, after, instant = false} = {}) {
    if (!element || since !== interaction) return Promise.resolve(false);
    const visible = () => element.isConnected && !element.closest("[hidden], [inert]") && valid();
    return requestScroll(visible, request => {
      function measure() {
        const deadline = performance.now() + 2000;
        let previous, stable = 0;
        const tick = () => {
          if (active !== request) return;
          if (!visible() || !element.getClientRects().length) return finish(request, true);
          const rect = element.getBoundingClientRect();
          const geometry = [rect.top, rect.height, window.visualViewport?.height || window.innerHeight];
          stable = previous && geometry.every((value, index) => Math.abs(value - previous[index]) < .5) ? stable + 1 : 0;
          previous = geometry;
          const moving = node => node.getAnimations?.().some(animation =>
            (animation.pending || animation.playState === "running") &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime));
          const loading = [...element.querySelectorAll('[aria-busy="true"]')]
            .some(node => node.getClientRects().length);
          if (performance.now() < deadline && (stable < 3 || moving(element) || moving(element.parentElement) || loading)) {
            request.frame = requestAnimationFrame(tick);
            return;
          }
          const owner = scrollOwner(element);
          if (!owner) return finish(request);
          const [top, bottom] = viewport(owner, element);
          const inset = block === "start" ? (parseFloat(getComputedStyle(element).scrollMarginBlockStart) || 12) : 12;
          const available = bottom - top - 2 * inset;
          if (available <= 0) return finish(request);
          if (block === "nearest" && rect.top >= top && rect.bottom <= bottom) return finish(request);
          const destination = rect.height > available || block === "start" ? top + inset :
            top + (bottom - top - rect.height) / 2;
          move(request, owner, owner.scrollTop + rect.top - destination, instant);
        };
        request.frame = requestAnimationFrame(tick);
      }
      if (after) Promise.resolve(after).then(() => { if (active === request) measure(); }, () => finish(request, true));
      else measure();
    });
  }

  function interrupt() {
    interaction++;
    cancel();
  }
  for (const name of ["wheel", "touchmove", "pointerdown", "click"]) {
    document.addEventListener(name, interrupt, {capture: true, passive: true});
  }
  document.addEventListener("keydown", event => {
    if (["Tab", "Escape", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) interrupt();
  }, true);
  reduced.addEventListener("change", () => {
    const request = active;
    if (reduced.matches && request?.owner) {
      scroll(request.owner, request.destination, "instant");
      finish(request);
    }
  });
  Object.assign(window, {PolyRentalViewportFocus: {
    reveal, cancel, checkpoint: () => interaction, inProgress: () => active !== null,
    restore: (top, valid = () => true, {instant = false} = {}) => requestScroll(valid, request => {
      if (!valid()) return finish(request, true);
      move(request, root(), top, instant);
    }),
  }});
})();
