// The cockpit's pages, each at its own address: the cockpit at /, the
// runners at /runners and the settings at /settings. A page is the path, so
// Back, reload and a bookmark all work; vite serves index.html for each.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

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

// A page with work not yet saved holds a move away: while it has set a
// guard, the guard gets each move and makes it, or not, once the person has
// answered. One guard at a time.
type LeaveGuard = (leave: () => void) => void;
let guard: LeaveGuard | null = null;

export function setLeaveGuard(g: LeaveGuard | null): void {
  guard = g;
}

// usePage is the page on screen and a way to go to another, which adds an
// entry to the browser's history. A move the leave guard holds does not
// happen until the guard makes it; Back is undone until then.
export function usePage(): [Page, (to: Page) => void] {
  const [page, setPage] = useState<Page>(() => pageOf(window.location.pathname));
  const shown = useRef(page);
  shown.current = page;
  useEffect(() => {
    const onPop = () => {
      const to = pageOf(window.location.pathname);
      if (to !== shown.current && guard) {
        window.history.pushState(null, '', PAGE_PATHS[shown.current]);
        guard(() => {
          window.history.pushState(null, '', PAGE_PATHS[to]);
          setPage(to);
        });
        return;
      }
      setPage(to);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((to: Page) => {
    const move = () => {
      const path = PAGE_PATHS[to];
      if (window.location.pathname !== path) {
        window.history.pushState(null, '', path);
      }
      setPage(to);
    };
    if (to !== shown.current && guard) guard(move);
    else move();
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
