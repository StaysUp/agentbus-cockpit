import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiTurn, QueueSource } from './jobs';

// How often the turns are read again. The turn list has no stream of its
// own, so the CI/CD view is live by reading the list every POLL_MS.
export const POLL_MS = 2000;

// The turns of the queue, tied together: each turn, and the reviews of it.
export interface QueueView {
  turns: ApiTurn[];
  // The listed row of one turn, when the last read had it.
  turnOf(session: string, turn: string): ApiTurn | undefined;
  // The reviews of a turn, oldest first. A review runs in a session of its
  // own and names the turn it reviews.
  reviewsOf(turnId: string): ApiTurn[];
  // A session's turns and the reviews of them, oldest first.
  ofSession(session: string): ApiTurn[];
  // The last read's failure, in the API's words; null after a good read.
  error: string | null;
  // Read again now (after a click asked for a turn).
  refresh(): void;
}

// Asked, else started: a queued turn has only asked.
const when = (t: ApiTurn) => t.asked || t.started || '';
const byAsked = (a: ApiTurn, b: ApiTurn) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id);

// Builds the view from one read of the list.
export function queueView(turns: ApiTurn[], error: string | null, refresh: () => void): QueueView {
  const rows = new Map<string, ApiTurn>();
  const reviews = new Map<string, ApiTurn[]>();
  const sessions = new Map<string, ApiTurn[]>();
  const push = <K>(m: Map<K, ApiTurn[]>, k: K, t: ApiTurn) => {
    const list = m.get(k);
    if (list) list.push(t);
    else m.set(k, [t]);
  };
  for (const t of turns) {
    if (t.kind === 'review') {
      if (t.reviews) push(reviews, t.reviews, t);
      continue;
    }
    rows.set(`${t.session}/${t.id}`, t);
    push(sessions, t.session, t);
  }
  // A review is listed with the session of the turn it reviews.
  for (const t of turns) {
    if (t.kind !== 'review' || !t.reviews) continue;
    const of = turns.find((x) => x.id === t.reviews && x.kind !== 'review');
    if (of) push(sessions, of.session, t);
  }
  for (const l of reviews.values()) l.sort(byAsked);
  for (const l of sessions.values()) l.sort(byAsked);
  return {
    turns,
    turnOf: (session, turn) => rows.get(`${session}/${turn}`),
    reviewsOf: (id) => reviews.get(id) ?? [],
    ofSession: (s) => sessions.get(s) ?? [],
    error,
    refresh,
  };
}

// Reads the turns every POLL_MS while mounted.
export function useQueue(src: QueueSource | undefined): QueueView | undefined {
  const pollMs = src?.pollMs ?? POLL_MS;
  const [turns, setTurns] = useState<ApiTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!src) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const list = await src.listTurns();
        if (!active) return;
        setTurns(list);
        setError(null);
      } catch (err) {
        if (active) setError((err as Error).message);
      } finally {
        if (active) timer = setTimeout(read, pollMs);
      }
    };
    read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [src, pollMs, tick]);

  return useMemo(() => (src ? queueView(turns, error, refresh) : undefined), [src, turns, error, refresh]);
}
