import React, { useCallback, useEffect, useState } from 'react';
import { PendingMachine, RunnerInfo, RunnersRead } from '../types';
import { formatAgo } from '../utils/format';

// How often the list is read again: the online count stays current.
export const RUNNERS_POLL_MS = 30_000;
// How often on the Runners page, so a machine that runs agentbus login shows
// up while the person waits to approve it.
export const RUNNERS_PAGE_POLL_MS = 3_000;

// What useRunners holds: undefined before the first read, null when the
// service has no such route, else the list; the machines waiting for
// approval; the last read's error; and a read now, after a decision.
export interface RunnersState {
  runners: RunnerInfo[] | null | undefined;
  error: string | null;
  pending?: PendingMachine[];
  reload?: () => void;
}

// useRunners reads the runners, and again every RUNNERS_POLL_MS (or every
// fast ms when given). No load (a source without the route) reads nothing.
// A load may answer the runners alone, or with the machines waiting.
export function useRunners(load?: () => Promise<RunnerInfo[] | RunnersRead | null>, fast?: number): RunnersState {
  const [runners, setRunners] = useState<RunnerInfo[] | null | undefined>(load ? undefined : null);
  const [pending, setPending] = useState<PendingMachine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!load) {
      setRunners(null);
      return;
    }
    let live = true;
    const read = () =>
      load().then(
        (got) => {
          if (!live) return;
          if (got === null || Array.isArray(got)) {
            setRunners(got);
            setPending([]);
          } else {
            setRunners(got.runners);
            setPending(got.pending);
          }
          setError(null);
        },
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        }
      );
    read();
    const timer = setInterval(read, fast ?? RUNNERS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load, fast, tick]);
  return { runners, error, pending, reload };
}

// The machines control knows, one runner each, as the Runners page's list:
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
