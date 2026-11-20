(() => {
  const key = 'polyrental-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  let visualStyle = 'classic';
  try { visualStyle = localStorage.getItem('polyrental-visual-style') || 'classic'; } catch (_) {}
  if (!['classic', 'studio', 'frame'].includes(visualStyle)) visualStyle = 'classic';
  document.documentElement.dataset.style = visualStyle;
  try { choice = localStorage.getItem(key) || 'auto'; } catch (_) {}
  if (!['light', 'dark', 'auto'].includes(choice)) choice = 'auto';
  function apply() {
    const telegram = window.Telegram?.WebApp;
    const automatic = telegram?.initData && ['light', 'dark'].includes(telegram.colorScheme) ? telegram.colorScheme : (media.matches ? 'dark' : 'light');
    const theme = choice === 'auto' ? automatic : choice;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelectorAll('.theme-switch input[name=theme]').forEach(input => { input.checked = input.value === choice; });
  }
  window.polyRentalApplyTheme = apply;
  apply();
  media.addEventListener?.('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('.style-switch input').forEach(input => {
      input.checked = input.value === visualStyle;
      input.addEventListener('change', () => {
        visualStyle = input.value;
        document.documentElement.dataset.style = visualStyle;
        try { localStorage.setItem('polyrental-visual-style', visualStyle); } catch (_) {}
      });
    });
    document.querySelectorAll('.theme-switch input[name=theme]').forEach(input => input.addEventListener('change', () => {
      choice = input.value;
      try { localStorage.setItem(key, choice); } catch (_) {}
      apply();
    }));
  });
})();
