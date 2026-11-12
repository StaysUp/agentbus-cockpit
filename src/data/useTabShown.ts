import { useEffect, useState } from 'react';

// How long a tab may stay hidden before it gives its event stream back. A
// quick look at another tab keeps the stream; a tab left in the background
// lets it go, and reads everything again when it is shown.
export const STREAM_HIDDEN_MS = 5_000;

// useTabShown is false once the tab has been hidden for hiddenMs, and true
// again as soon as it is shown.
//
// Why: a browser opens at most six connections to one host over HTTP/1.1,
// and each cockpit tab's event stream holds one for as long as it is open.
// Six tabs on one control left a seventh with no connection to read
// Settings with: its page stayed on "Reading…". A tab that is not seen
// needs no stream.
export function useTabShown(hiddenMs = STREAM_HIDDEN_MS): boolean {
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const [shown, setShown] = useState(() => !hidden());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!hidden()) setShown(true);
      else timer = setTimeout(() => setShown(false), hiddenMs);
    };
    document.addEventListener('visibilitychange', update);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [hiddenMs]);
  return shown;
}
