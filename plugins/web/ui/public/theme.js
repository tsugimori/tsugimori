(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const key = 'tsugimori-color-mode';
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'dark' || saved === 'light') preference = saved;
  } catch {
    // Storage can be unavailable in a restricted browsing context.
  }

  function apply() {
    const dark =
      preference === 'dark' || (preference === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
  }

  apply();
  media.addEventListener('change', apply);
  window.tsugimoriTheme = {
    get preference() {
      return preference;
    },
    set(value) {
      preference = value;
      try {
        localStorage.setItem(key, value);
      } catch {
        // The preference still applies for the current page.
      }
      apply();
    },
  };
})();
