// The cockpit's pages, each at its own address: the cockpit at /, the
// runners at /runners and the settings at /settings. A page is the path, so
// Back, reload and a bookmark all work; vite serves index.html for each.
import { useCallback, useEffect, useState, type MouseEvent } from 'react';

export type Page = 'cockpit' | 'runners' | 'settings';

export const PAGE_PATHS: Record<Page, string> = {
  cockpit: '/',
  runners: '/runners',
  settings: '/settings',
};

// pageOf is the page at path; any other path is the cockpit.
export function pageOf(path: string): Page {
  const p = path.replace(/\/+$/, '');
  if (p === '/runners') return 'runners';
  if (p === '/settings') return 'settings';
  return 'cockpit';
}

// usePage is the page on screen and a way to go to another, which adds an
// entry to the browser's history.
export function usePage(): [Page, (to: Page) => void] {
  const [page, setPage] = useState<Page>(() => pageOf(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPage(pageOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((to: Page) => {
    const path = PAGE_PATHS[to];
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
    setPage(to);
  }, []);
  return [page, go];
}

// follow is a link's click as a move within the cockpit. A click with a
// modifier key, or not the main button, is left to the browser (a new tab).
export function follow(go: () => void) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
}
