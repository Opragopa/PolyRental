(() => {
  const host = document.getElementById("login-widget");
  const fallback = document.getElementById("login-fallback");
  const button = document.getElementById("login-retry");
  if (!host || !fallback || !button) return;
  let attempt = 0;
  let timer;
  function loadWidget() {
    const current = ++attempt;
    clearTimeout(timer);
    host.replaceChildren();
    fallback.hidden = true;
    button.hidden = false;
    button.textContent = "Войти через Telegram";
    button.setAttribute("aria-busy", "true");
    const fail = () => {
      if (current !== attempt) return;
      fallback.hidden = false;
      button.textContent = "Повторить загрузку";
      button.removeAttribute("aria-busy");
      host.replaceChildren();
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.dataset.telegramLogin = host.dataset.bot;
    script.dataset.size = "large";
    script.dataset.authUrl = host.dataset.callback;
    script.dataset.requestAccess = "write";
    script.onload = () => {
      if (current !== attempt) return;
      const frame = host.querySelector("iframe");
      if (!frame) return;
      frame.hidden = true;
      frame.addEventListener("load", () => {
        if (current !== attempt) return;
        clearTimeout(timer);
        frame.hidden = false;
        button.hidden = true;
        button.removeAttribute("aria-busy");
      }, {once: true});
    };
    timer = setTimeout(fail, 10000);
    host.append(script);
  }
  button.addEventListener("click", () => { if (!fallback.hidden) loadWidget(); });
  loadWidget();
})();
