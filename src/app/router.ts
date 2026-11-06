import { useSyncExternalStore } from 'react';

/** Hash routes keep the app working on GitHub Pages (no server rewrites) and give the phone's back button real history. */
export type TabKey = 'home' | 'timeline' | 'spending' | 'plan';

export interface Route {
  path: string;
  parts: string[];
  tab: TabKey;
}

function currentPath(): string {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!raw || raw === '/') return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
}

export function parseRoute(path: string): Route {
  const parts = path.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  const tab: TabKey = first === 'timeline' ? 'timeline' : first === 'spending' ? 'spending' : first === 'plan' ? 'plan' : 'home';
  return { path, parts, tab };
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentPath, () => '/');
  return parseRoute(path);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target) return;
  if (opts.replace) {
    window.history.replaceState(window.history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
  window.scrollTo({ top: 0 });
}
