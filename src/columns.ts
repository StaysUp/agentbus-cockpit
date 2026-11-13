// The cockpit on a narrow screen: one column at a time. Sessions first, then
// the open conversation, then the turn panel. Opening a conversation or a turn
// moves forward and adds a browser history entry, so the browser's Back and
// the back buttons in the column headers both move one column back.
import { useEffect, useRef, useState } from 'react';

// Under this width the columns are shown one at a time (styles/narrow.css).
export const NARROW_QUERY = '(max-width: 900px)';

export type Column = 'sessions' | 'convo' | 'turn';

// useMedia is whether the media query matches now. Without matchMedia (jsdom)
// it never matches, so the cockpit keeps its wide layout.
export function useMedia(query: string): boolean {
  const get = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

// The column a history entry was made for, or undefined for any other entry.
function columnOf(state: unknown): Column | undefined {
  const c = (state as { column?: unknown } | null)?.column;
  return c === 'convo' || c === 'turn' ? c : undefined;
}

// useColumns keeps which column a narrow screen shows. panelOpen is the turn
// panel's state, which App owns: the turn column is the panel when it is open.
// forward and back change history only on a narrow screen; on a wide one they
// only set the state, so a wide screen's Back is as it was.
export function useColumns(panelOpen: boolean, setPanelOpen: (open: boolean) => void) {
  const narrow = useMedia(NARROW_QUERY);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const [view, setView] = useState<'sessions' | 'convo'>('sessions');
  const setPanelRef = useRef(setPanelOpen);
  setPanelRef.current = setPanelOpen;

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (!narrowRef.current) return;
      const col = columnOf(e.state);
      setView(col ? 'convo' : 'sessions');
      setPanelRef.current(col === 'turn');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // forward shows col and, on a narrow screen, adds a history entry for it.
  // The entry keeps the address, so the page stays the cockpit.
  const forward = (col: 'convo' | 'turn') => {
    if (col === 'turn') setPanelOpen(true);
    setView('convo');
    if (narrowRef.current && columnOf(window.history.state) !== col) {
      window.history.pushState({ column: col }, '', window.location.href);
    }
  };

  // back leaves col for the column before it. When the entry on screen was
  // made for col, it is the browser's Back, so history stays in step.
  const back = (col: 'convo' | 'turn') => {
    if (narrowRef.current && columnOf(window.history.state) === col) {
      window.history.back();
      return;
    }
    if (col === 'turn') setPanelOpen(false);
    else setView('sessions');
  };

  const column: Column = panelOpen ? 'turn' : view;
  return { narrow, column, forward, back };
}
