// Synchronous FOUC-free color-scheme bootstrap (MV3 CSP-safe external script).
(() => {
  const apply = () => {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) return;
    let stored = null;
    try { stored = localStorage.getItem('color-scheme'); } catch (_) {}
    meta.content = (stored === 'light' || stored === 'dark') ? stored : 'light dark';
  };
  apply();
  window.addEventListener('storage', (e) => {
    if (e.key === 'color-scheme' || e.key === null) apply();
  });
})();
