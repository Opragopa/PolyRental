(() => {
  "use strict";

  const path = location.pathname;
  if (path !== "/site" && path !== "/site/login") return;
  const baseRoutes = new Set([
    "main-content", "booking", "catalog", "profile", "my-requests", "management",
    "management-orders", "management-catalog", "management-repairs",
    "management-support", "management-settings",
  ]);
  const categoryRoute = /^(catalog|management-catalog)-([\w-]{1,100})$/;
  const loginKey = "polyrental:site-return";
  const stateKey = "polyrentalSite";
  const isRoute = route => baseRoutes.has(route) || categoryRoute.test(route || "");
  const fragment = () => {
    const route = location.hash.slice(1).split(":~:", 1)[0];
    return isRoute(route) ? route : "";
  };
  function takeLoginRoute() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(loginKey));
      sessionStorage.removeItem(loginKey);
      return saved?.expires > Date.now() && isRoute(saved.route) ? saved.route : "";
    } catch (_) { return ""; }
  }
  function rememberLoginRoute() {
    const route = fragment();
    if (!route) return;
    try { sessionStorage.setItem(loginKey, JSON.stringify({route, expires: Date.now() + 600000})); } catch (_) {}
  }
  if (path === "/site/login") {
    rememberLoginRoute();
    return;
  }

  const initialY = window.scrollY;
  const initialInput = window.PolyRentalViewportFocus?.checkpoint();
  const topBars = [...document.querySelectorAll(".topbar, [data-scroll-obstruction='top']")];
  function measureTopBars() {
    let bottom = 0;
    for (const bar of topBars) {
      if (bar.closest("[hidden], [inert]") || !bar.offsetHeight) continue;
      const style = getComputedStyle(bar);
      if (style.position === "fixed" || style.position === "sticky") {
        bottom = Math.max(bottom, (parseFloat(style.top) || 0) + bar.offsetHeight);
      }
    }
    document.documentElement.style.setProperty("--site-top-obstruction", `${bottom}px`);
  }
  const barObserver = new ResizeObserver(measureTopBars);
  topBars.forEach(bar => barObserver.observe(bar));
  window.addEventListener("resize", measureTopBars);
  measureTopBars();
  const legacyParams = ["booking", "identity", "startapp"];
  function urlFor(route) {
    const url = new URL(location.href);
    const legacy = legacyParams.some(key => url.searchParams.has(key));
    if (!legacy) return `#${route}`;
    legacyParams.forEach(key => url.searchParams.delete(key));
    return `${url.pathname}${url.search}#${route}`;
  }

  function create({open, current, canLeave, readView, owner}) {
    const viewport = window.PolyRentalViewportFocus;
    let entry = history.state?.[stateKey] || null;
    let pending = false;
    let generation = 0;
    let saveTimer = 0;
    let canceledTraversal = "";
    const newEntry = (index, route, from = "") => ({key: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, index, route, from});
    const recordKey = key => `polyrental:site-scroll:${key}`;
    function read(savedEntry) {
      if (!savedEntry?.key) return null;
      try {
        const value = JSON.parse(sessionStorage.getItem(recordKey(savedEntry.key)));
        return value?.owner === owner && isRoute(value.route) ? value : null;
      } catch (_) { return null; }
    }
    function save() {
      clearTimeout(saveTimer);
      saveTimer = 0;
      if (!entry || pending) return;
      const route = current();
      if (!route) return;
      if (entry.route && entry.route !== route && !(
        entry.route === "main-content" ||
        (entry.route === "booking" && route.startsWith("catalog")) ||
        (entry.route === "my-requests" && route === "profile") ||
        (entry.route === "management" && route.startsWith("management-"))
      )) return;
      try {
        sessionStorage.setItem(recordKey(entry.key), JSON.stringify({
          owner, route: entry.route || route, top: window.scrollY, view: readView(),
        }));
      } catch (_) {}
    }
    function write(method, next, url) {
      const state = {...history.state, [stateKey]: next};
      if (url) history[method](state, "", url);
      else history[method](state, "");
      history.scrollRestoration = "manual";
      entry = next;
    }
    async function show(route, {saved, focus, reuse = false, initial = false, since = viewport?.checkpoint()} = {}) {
      const token = ++generation;
      pending = true;
      clearTimeout(saveTimer);
      viewport?.cancel();
      try {
        const target = await open(route, saved?.view, {reuse, valid: () => token === generation});
        if (!target || token !== generation || since !== viewport?.checkpoint()) return;
        if (focus) {
          const headings = (target.matches(".site-anchor") ? target.parentElement : target).querySelectorAll("h1, h2, h3");
          const heading = [...headings].find(node => node.getClientRects().length);
          const focusTarget = heading || target;
          if (!focusTarget.hasAttribute("tabindex")) focusTarget.tabIndex = -1;
          focusTarget.focus({preventScroll: true});
        }
        if (Number.isFinite(saved?.top)) {
          await viewport?.restore(saved.top, () => token === generation, {instant: true});
        } else if (!initial || (initialY === 0 && window.scrollY === initialY)) {
          await viewport?.reveal(target, {block: "start", since, instant: initial, valid: () => token === generation});
        }
      } finally {
        if (token === generation) {
          pending = false;
          save();
        }
      }
    }
    function go(route, {focus = false, replace = false} = {}) {
      if (!isRoute(route) || !canLeave()) return;
      save();
      const same = fragment() === route && entry?.route === route;
      if (!same) {
        const next = newEntry((entry?.index ?? 0) + (replace ? 0 : 1), route, replace ? entry?.from : current() || entry?.route);
        write(replace ? "replaceState" : "pushState", next, urlFor(route));
      }
      return show(route, {focus, reuse: same});
    }
    function onLink(event) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.currentTarget;
      event.preventDefault();
      if (link.getAttribute("aria-disabled") !== "true") void go(link.dataset.siteRoute, {focus: event.detail === 0});
    }
    function bind(control, route) {
      if (!isRoute(route)) return control;
      if (control.dataset.siteRoute === route) return control;
      const link = document.createElement("a");
      for (const {name, value} of control.attributes) if (name !== "type") link.setAttribute(name, value);
      link.append(...control.childNodes);
      link.href = urlFor(route);
      link.dataset.siteRoute = route;
      link.addEventListener("click", onLink);
      control.replaceWith(link);
      return link;
    }
    async function start({useFragment = true} = {}) {
      const saved = read(entry);
      const loggedInRoute = takeLoginRoute();
      const route = useFragment ? fragment() || loggedInRoute || saved?.route : "";
      if (route && loggedInRoute === route && !fragment()) {
        write("replaceState", newEntry(entry?.index ?? 0, route), urlFor(route));
      } else if (!entry) {
        write("replaceState", newEntry(0, useFragment ? fragment() : ""));
      } else {
        history.scrollRestoration = "manual";
      }
      if (route) await show(route, {saved: saved?.route === route ? saved : null, initial: true, since: initialInput});
      return Boolean(route);
    }
    window.addEventListener("scroll", () => {
      if (!saveTimer && !pending) saveTimer = setTimeout(save, 100);
    }, {passive: true});
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
    window.addEventListener("popstate", event => {
      let next = event.state?.[stateKey];
      if (next?.key === canceledTraversal) { canceledTraversal = ""; return; }
      if (next?.key === entry?.key && next) return;
      if (!canLeave()) {
        if (entry && (!next || next.index !== entry.index)) {
          canceledTraversal = entry.key;
          history.go(next ? entry.index - next.index : -1);
        }
        return;
      }
      save();
      const saved = read(next);
      const route = next?.route || fragment() || saved?.route || entry?.from || current();
      if (!next) {
        next = newEntry((entry?.index ?? 0) + 1, fragment(), entry?.route || current());
        write("replaceState", next);
      } else {
        entry = next;
        history.scrollRestoration = "manual";
      }
      if (route) void show(route, {saved, since: viewport?.checkpoint()});
    });
    return {
      bind, go, start, save,
      backTo(route) {
        if (entry?.index > 0 && (entry.from === route || (route === "catalog" && entry.from === "booking"))) history.back();
        else void go(route, {replace: true});
      },
    };
  }
  window.PolyRentalSiteNavigation = {create, rememberLoginRoute, categoryRoute};
})();
