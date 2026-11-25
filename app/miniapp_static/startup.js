(() => {
  const root = document.documentElement;
  if (location.pathname === "/site") root.classList.add("site-view");
  if (location.pathname !== "/miniapp" || new URLSearchParams(location.search).get("preview") === "1") return;

  let state = "idle";
  let timers = [];
  let telegramReady = false;
  let failureText = "";

  function notifyTelegram() {
    const telegram = window.Telegram?.WebApp;
    if (!telegramReady && typeof telegram?.ready === "function") {
      telegramReady = true;
      telegram.ready();
    }
  }

  function updateScreen() {
    const screen = document.getElementById("miniapp-startup");
    if (!screen) return;
    screen.hidden = !["visible", "slow", "failed"].includes(state);
    if (screen.hidden) return;
    document.getElementById("startup-status").textContent = failureText || (state === "slow"
      ? "Загрузка занимает больше времени, чем обычно."
      : "Открываем ПолиРентал…");
    const retry = document.getElementById("startup-retry");
    retry.hidden = state !== "failed";
    if (!retry.hidden) retry.focus({ preventScroll: true });
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function fail(message = "Не удалось открыть приложение. Проверьте подключение и попробуйте ещё раз.") {
    if (state === "idle" || state === "ready" || state === "failed") return;
    clearTimers();
    state = "failed";
    failureText = message;
    root.dataset.miniappStartup = "failed";
    updateScreen();
    notifyTelegram();
  }

  function start(telegram) {
    if (state !== "idle") return;
    const params = new URLSearchParams(location.hash.slice(1));
    const fromTelegram = params.has("tgWebAppData") || params.has("tgWebAppVersion") ||
      telegram?.initData || (telegram?.platform && telegram.platform !== "unknown");
    if (!fromTelegram) return;
    state = "pending";
    root.dataset.miniappStartup = "pending";
    if (params.has("tgWebAppData") || telegram?.initData) root.classList.add("role-pending");
    timers = [
      setTimeout(() => { state = "visible"; updateScreen(); notifyTelegram(); }, 300),
      setTimeout(() => { state = "slow"; updateScreen(); }, 5000),
      setTimeout(() => fail("Приложение не успело загрузиться. Попробуйте ещё раз."), 25000),
    ];
  }

  window.PolyRentalStartup = {
    start,
    active: () => state !== "idle",
    failed: () => state === "failed",
    fail,
    finish() {
      if (state === "idle" || state === "failed") return;
      clearTimers();
      state = "ready";
      delete root.dataset.miniappStartup;
      root.classList.remove("role-pending");
      updateScreen();
      notifyTelegram();
    },
  };

  document.addEventListener("load", event => {
    if (event.target.id !== "telegram-sdk") return;
    start(window.Telegram?.WebApp);
    if (["visible", "slow", "failed"].includes(state)) notifyTelegram();
  }, true);
  document.addEventListener("error", event => {
    if (["telegram-sdk", "app-script"].includes(event.target.id)) fail();
  }, true);
  document.addEventListener("click", event => {
    if (event.target.id === "startup-retry") location.reload();
  });
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") updateScreen();
  });
  start(window.Telegram?.WebApp);
})();
