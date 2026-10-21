(() => {
  let theme;
  try { theme = localStorage.getItem('pasa-theme'); } catch { /* Preference storage is optional. */ }
  if (theme !== 'light' && theme !== 'dark') {
    try { theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { theme = 'light'; }
  }
  document.documentElement.dataset.theme = theme;

  document.addEventListener('DOMContentLoaded', () => {
    const link = document.getElementById('continue-link');
    if (!link) return;
    const timer = setTimeout(() => window.location.assign(link.href), 3000);
    link.addEventListener('click', () => clearTimeout(timer), { once: true });
  }, { once: true });
})();
