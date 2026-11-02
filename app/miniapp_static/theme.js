(() => {
  const key = 'polyrental-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  try { choice = localStorage.getItem(key) || 'auto'; } catch (_) {}
  if (!['light', 'dark', 'auto'].includes(choice)) choice = 'auto';
  function apply() {
    const telegram = window.Telegram?.WebApp;
    const automatic = telegram?.initData && ['light', 'dark'].includes(telegram.colorScheme) ? telegram.colorScheme : (media.matches ? 'dark' : 'light');
    const theme = choice === 'auto' ? automatic : choice;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelectorAll('.theme-switch input').forEach(input => { input.checked = input.value === choice; });
  }
  window.polyRentalApplyTheme = apply;
  apply();
  media.addEventListener?.('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('.theme-switch input').forEach(input => input.addEventListener('change', () => {
      choice = input.value;
      try { localStorage.setItem(key, choice); } catch (_) {}
      apply();
    }));
  });
})();
