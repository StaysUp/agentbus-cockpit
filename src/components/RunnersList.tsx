import React, { useEffect, useState } from 'react';
import { RunnerInfo } from '../types';
import { formatAgo } from '../utils/format';

// How often the list is read again: the online count stays current.
export const RUNNERS_POLL_MS = 30_000;

// What useRunners holds: undefined before the first read, null when the
// service has no such route, else the list; and the last read's error.
export interface RunnersState {
  runners: RunnerInfo[] | null | undefined;
  error: string | null;
}

// useRunners reads the runners, and again every RUNNERS_POLL_MS. No load
// (a source without the route) reads nothing.
export function useRunners(load?: () => Promise<RunnerInfo[] | null>): RunnersState {
  const [runners, setRunners] = useState<RunnerInfo[] | null | undefined>(load ? undefined : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!load) {
      setRunners(null);
      return;
    }
    let live = true;
    const read = () =>
      load().then(
        (list) => {
          if (!live) return;
          setRunners(list);
          setError(null);
        },
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        }
      );
    read();
    const timer = setInterval(read, RUNNERS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);
  return { runners, error };
}

// The runners and connectors control knows, as the Runners page's list:
// each one's name, an online dot, its role, when it was last seen, and the
// harnesses it found. A click picks one.
export const RunnersList: React.FC<RunnersState & { selected?: string; onSelect?: (id: string) => void }> = ({
  runners,
  error,
  selected,
  onSelect,
}) => {
  // A service without the route shows nothing; so does the first read.
  if (runners === null || (runners === undefined && !error)) return null;
  return (
    <div className="runners" aria-label="Runners">
      {error && <p className="dim runners-err">{error}</p>}
      {runners && runners.length === 0 && <p className="dim runners-none">No runner has enrolled.</p>}
      {runners?.map((r) => {
        const found = r.harnesses.filter((h) => h.found);
        const on = selected === r.id;
        return (
          <button
            type="button"
            key={r.id}
            className={`prow runner ${r.online ? 'online' : 'offline'}${on ? ' on' : ''}`}
            data-runner={r.id}
            aria-current={on}
            title={r.id}
            onClick={() => onSelect?.(r.id)}
          >
            <span className="pr-n">
              <span>
                <i className={`rn-dot ${r.online ? 'online' : 'offline'}`} aria-label={r.online ? 'online' : 'offline'} />
                {r.name}
              </span>
            </span>
            <span className="pr-m2">
              <span className="rn-role">{r.role}</span>
              <span className="sep">·</span>
              {r.online ? 'online' : `last seen ${formatAgo(r.last_seen) || 'never'}`}
              {r.role !== 'connector' && (
                <>
                  <span className="sep">·</span>
                  <span className="rn-h">
                    {found.length > 0 ? found.map((h) => h.name).join(', ') : 'no harness found'}
                  </span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
};
