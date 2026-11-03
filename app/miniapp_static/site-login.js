(() => {
  const host = document.getElementById("login-widget");
  const fallback = document.getElementById("login-fallback");
  const retry = document.getElementById("login-retry");
  if (!host || !fallback || !retry) return;
  let attempt = 0;
  let timer;
  function loadWidget() {
    const current = ++attempt;
    clearTimeout(timer);
    host.replaceChildren();
    fallback.hidden = true;
    retry.disabled = true;
    const fail = () => {
      if (current !== attempt) return;
      clearTimeout(timer);
      fallback.hidden = false;
      retry.disabled = false;
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.dataset.telegramLogin = host.dataset.bot;
    script.dataset.size = "large";
    script.dataset.authUrl = host.dataset.callback;
    script.dataset.requestAccess = "write";
    script.onerror = fail;
    script.onload = () => {
      if (current !== attempt) return;
      const frame = host.querySelector("iframe");
      if (!frame) return fail();
      frame.addEventListener("error", fail, {once: true});
      frame.addEventListener("load", () => {
        if (current !== attempt) return;
        clearTimeout(timer);
        retry.disabled = false;
      }, {once: true});
    };
    timer = setTimeout(fail, 10000);
    host.append(script);
  }
  retry.addEventListener("click", loadWidget);
  loadWidget();
})();
