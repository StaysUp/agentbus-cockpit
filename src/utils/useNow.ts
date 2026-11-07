import { useEffect, useReducer } from 'react';
import { eventsNow } from '../data/liveStatus';

// One clock for every live line on screen, so the session card, the chat and
// the panel always show the same elapsed time. It ticks once a second while
// any of them is running, and stops when none is.
let shared = eventsNow();
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

// Read the clock again now: on each tick, and when an event arrives.
export function refreshNow(): void {
  shared = eventsNow();
  subscribers.forEach((f) => f());
}

function subscribe(f: () => void): () => void {
  subscribers.add(f);
  if (!timer) timer = setInterval(refreshNow, 1000);
  return () => {
    subscribers.delete(f);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// The time on the events' clock. While `active`, it is the shared clock and
// the component renders again each second; otherwise it is read once.
export function useNow(active: boolean): number {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => (active ? subscribe(rerender) : undefined), [active]);
  // The shared reading is at most a second old while something ticks; a
  // reading older than that (nothing ticked for a while) is taken again.
  if (Math.abs(eventsNow() - shared) > 1500) shared = eventsNow();
  return active ? shared : eventsNow();
}
