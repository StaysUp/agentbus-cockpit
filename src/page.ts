// The cockpit's pages, each at its own address: the cockpit at /, the
// runners at /runners and the settings at /settings. A page is the path, so
// Back, reload and a bookmark all work; vite serves index.html for each.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

export type Page = 'cockpit' | 'guide' | 'apps' | 'runners' | 'settings';

export const PAGE_PATHS: Record<Page, string> = {
  cockpit: '/',
  guide: '/guide',
  apps: '/apps',
  runners: '/runners',
  settings: '/settings',
};

// pageOf is the page at path; any other path is the cockpit.
export function pageOf(path: string): Page {
  const p = path.replace(/\/+$/, '');
  if (p === '/guide') return 'guide';
  if (p === '/apps') return 'apps';
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
    // Set while a held Back is let go: the browser goes back once more, to
    // where Back went, and that move needs no asking.
    let leaving = false;
    const onPop = () => {
      const to = pageOf(window.location.pathname);
      if (leaving) {
        leaving = false;
        setPage(to);
        return;
      }
      if (to !== shown.current && guard) {
        // The page stays: its address goes back on, as one entry after the
        // one Back went to. Leaving goes back over it, adding none.
        window.history.pushState(null, '', PAGE_PATHS[shown.current]);
        guard(() => {
          leaving = true;
          window.history.back();
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
