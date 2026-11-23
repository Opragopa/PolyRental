/* Share focus isolation and scroll ownership across static and dynamic modals. */
(() => {
  "use strict";
  const isolated = new Map();
  const selector = '[role="dialog"][aria-modal="true"]';
  let active = null;
  let openDialogs = new Set();
  let scrollLock = null;
  let opener = null;
  document.addEventListener('click', event => {
    opener = event.target.closest?.('button, a[href], input, select, textarea') || document.activeElement;
  }, true);
  function focusables(dialog) {
    return [...dialog.querySelectorAll('button, input, textarea, select, summary, a[href], [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [inert]') && node.getClientRects().length);
  }
  function focus(dialog, last = false, reveal = false) {
    if (!dialog || dialog.inert) return;
    const controls = focusables(dialog);
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    const target = (last ? controls.at(-1) : controls[0]) || dialog;
    target.focus({preventScroll: true});
    if (reveal && target !== dialog) window.PolyRentalViewportFocus?.reveal(target, {block: 'nearest'});
  }
  function refresh() {
    const dialogs = [...document.querySelectorAll(selector)]
      .filter(node => !node.closest('[hidden], [data-modal-closing]') &&
        !node.closest('details:not([open])') && node.getClientRects().length &&
        getComputedStyle(node).visibility === 'visible')
      .sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
    active = dialogs.at(-1) || null;
    const newlyOpened = active && !openDialogs.has(active);
    openDialogs = new Set(dialogs);
    const outside = new Set();
    for (let branch = active; branch?.parentElement && branch !== document.body; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && !/^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) outside.add(sibling);
      }
    }
    for (const [node, inert] of isolated) {
      if (outside.has(node)) continue;
      node.inert = inert;
      isolated.delete(node);
    }
    for (const node of outside) {
      if (isolated.has(node)) continue;
      isolated.set(node, node.inert);
      node.inert = true;
    }
    const lockBackground = dialogs.some(dialog => dialog.dataset.modalScroll !== 'overlay');
    if (lockBackground) {
      if (!scrollLock) {
        const body = document.body, root = document.documentElement;
        scrollLock = {x: scrollX, y: scrollY, body: body.getAttribute('style'), overflow: root.style.overflow};
        root.style.overflow = 'hidden';
        Object.assign(body.style, {position: 'fixed', top: `${-scrollLock.y}px`, left: `${-scrollLock.x}px`, width: '100%', overflow: 'hidden'});
      }
    } else if (scrollLock) {
      const saved = scrollLock;
      scrollLock = null;
      if (saved.body === null) document.body.removeAttribute('style');
      else document.body.setAttribute('style', saved.body);
      document.documentElement.style.overflow = saved.overflow;
      window.scrollTo({left: saved.x, top: saved.y, behavior: 'instant'});
    }
    if (active && !active.contains(document.activeElement)) focus(active);
    if (newlyOpened) {
      const card = active.querySelector(".dialog-card, .document-viewer-card");
      if (card) window.PolyRentalViewportFocus?.reveal(card);
    }
  }
  const containsDialog = node => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches(selector) || node.querySelector(selector));
  new MutationObserver(records => {
    if (records.some(({type, target, addedNodes, removedNodes}) => type === 'attributes'
      ? target.contains(active) || containsDialog(target)
      : (active && target !== active && target.contains(active)) ||
        [...addedNodes, ...removedNodes].some(containsDialog))) refresh();
  }).observe(document.documentElement, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'open', 'role', 'aria-modal', 'data-modal-closing', 'class', 'style']});
  for (const event of ['transitionend', 'transitioncancel']) {
    document.addEventListener(event, ({target}) => {
      if (containsDialog(target)) refresh();
    }, true);
  }
  window.addEventListener('pageshow', refresh);
  window.addEventListener('resize', refresh);
  document.addEventListener('focusin', event => {
    if (active && !active.contains(event.target)) focus(active);
  });
  function trap(event, dialog = active) {
    if (event.defaultPrevented || event.key !== 'Tab' || !active || dialog !== active) return;
    const controls = focusables(active), first = controls[0], last = controls.at(-1);
    if (!controls.length || !active.contains(document.activeElement) || document.activeElement === active ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      focus(active, event.shiftKey, true);
    }
  }
  document.addEventListener('keydown', trap, true);
  function restoreFocus(node) {
    refresh();
    if (node?.isConnected && !node.disabled && !node.closest('[inert]') && (!active || active.contains(node))) node.focus({preventScroll: true});
  }
  window.PolyRentalDialogs = {refresh, focus, trap, restoreFocus, opener: () => opener?.isConnected ? opener : document.activeElement};
  refresh();
})();
