/* Share focus isolation and scroll ownership across static and dynamic modals. */
(() => {
  "use strict";
  const isolated = new Map();
  let active = null;
  let scrollLock = null;
  let opener = null;
  document.addEventListener('click', event => {
    opener = event.target.closest?.('button, a[href], input, select, textarea') || document.activeElement;
  }, true);
  function focusables(dialog) {
    return [...dialog.querySelectorAll('button, input, textarea, select, summary, a[href], [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [inert]') && node.getClientRects().length);
  }
  function focus(dialog, last = false) {
    if (!dialog || dialog.inert) return;
    const controls = focusables(dialog);
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    (last ? controls.at(-1) : controls[0] || dialog)?.focus({preventScroll: true});
    if (!controls.length) dialog.focus({preventScroll: true});
  }
  function refresh() {
    for (const [node, inert] of isolated) node.inert = inert;
    isolated.clear();
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .filter(node => !node.hidden && node.getClientRects().length)
      .sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
    for (const dialog of dialogs) dialog.inert = dialog.hasAttribute('data-modal-closing');
    active = dialogs.at(-1) || null;
    if (active) {
      if (!scrollLock) {
        const body = document.body, root = document.documentElement;
        scrollLock = {x: scrollX, y: scrollY, body: body.getAttribute('style'), overflow: root.style.overflow};
        root.style.overflow = 'hidden';
        Object.assign(body.style, {position: 'fixed', top: `${-scrollLock.y}px`, left: `${-scrollLock.x}px`, width: '100%', overflow: 'hidden'});
      }
      let branch = active;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
          isolated.set(sibling, sibling.inert);
          sibling.inert = true;
        }
        if (branch.parentElement === document.body) break;
        branch = branch.parentElement;
      }
      if (!active.contains(document.activeElement)) focus(active);
    } else if (scrollLock) {
      const saved = scrollLock;
      scrollLock = null;
      if (saved.body === null) document.body.removeAttribute('style');
      else document.body.setAttribute('style', saved.body);
      document.documentElement.style.overflow = saved.overflow;
      window.scrollTo({left: saved.x, top: saved.y, behavior: 'instant'});
    }
  }
  new MutationObserver(refresh).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden']});
  document.addEventListener('focusin', event => {
    if (active && !active.contains(event.target)) focus(active);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !active) return;
    const controls = focusables(active), first = controls[0], last = controls.at(-1);
    if (!controls.length || !active.contains(document.activeElement) || document.activeElement === active ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      focus(active, event.shiftKey);
    }
  }, true);
  function restoreFocus(node) {
    refresh();
    if (node?.isConnected && !node.disabled && !node.closest('[inert]') && (!active || active.contains(node))) node.focus({preventScroll: true});
  }
  window.PolyRentalDialogs = {refresh, focus, restoreFocus, opener: () => opener?.isConnected ? opener : document.activeElement};
  refresh();
})();
