export function createRouter() {
  let location = $state(new URL('http://localhost/'));

  function start() {
    const update = () => {
      location = new URL(window.location.href);
    };
    const click = (event: MouseEvent) => {
      const link =
        event.target instanceof Element && event.target.closest('a[href]');
      if (
        !(link instanceof HTMLAnchorElement) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target ||
        link.hasAttribute('download')
      )
        return;
      const next = new URL(link.href);
      if (next.origin !== window.location.origin) return;
      if (next.hash && next.href === window.location.href) return;
      event.preventDefault();
      if (next.href !== window.location.href) {
        if (
          next.pathname !== location.pathname ||
          next.search !== location.search
        )
          window.scrollTo(0, 0);
        history.pushState(null, '', next);
      }
      update();
    };
    update();
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
      document.removeEventListener('click', click);
    };
  }

  return {
    get location() {
      return location;
    },
    start,
  };
}

export function segments(path: string) {
  try {
    return path.split('/').slice(1).map(decodeURIComponent);
  } catch {
    return [];
  }
}
