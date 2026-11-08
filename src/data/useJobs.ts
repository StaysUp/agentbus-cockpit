import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentAttempt, ended, Job, JobsSource, resultRef, TurnRef, turnFromEvents } from './jobs';

// How often the jobs are read again. The jobs API has no stream, so the
// CI/CD view is live by reading the list every POLL_MS.
export const POLL_MS = 2000;

// The jobs, tied to the framework turns they ran.
export interface JobsView {
  jobs: Job[];
  // The turn job that ran a framework turn, by "session/turn".
  turnJob(session: string, turn: string): Job | undefined;
  // Where a turn job's turn ran, once known.
  refOf(job: Job): TurnRef | undefined;
  // The reviews of a job, oldest first.
  reviewsOf(jobId: string): Job[];
  // Every job of a framework session, turns and reviews, oldest first.
  ofSession(session: string): Job[];
  // The last read's failure, in the API's words; null after a good read.
  error: string | null;
  // Read again now (after a click made a job).
  refresh(): void;
}

const key = (r: TurnRef) => `${r.session}/${r.turn}`;
const byCreated = (a: Job, b: Job) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id);

// Builds the view from a list and the turns found in attempt events.
export function jobsView(jobs: Job[], found: Record<string, TurnRef>, error: string | null, refresh: () => void): JobsView {
  const refs = new Map<string, TurnRef>();
  const byTurn = new Map<string, Job>();
  const reviews = new Map<string, Job[]>();
  const sessions = new Map<string, Job[]>();
  const add = (s: string, j: Job) => {
    const list = sessions.get(s);
    if (list) list.push(j);
    else sessions.set(s, [j]);
  };
  for (const j of jobs) {
    if (j.kind === 'turn') {
      const ref = resultRef(j) ?? found[j.id];
      if (ref) {
        refs.set(j.id, ref);
        byTurn.set(key(ref), j);
      }
      const s = ref?.session ?? j.session ?? j.spec.session;
      if (s) add(s, j);
    } else if (j.kind === 'review') {
      const of = j.links?.reviews_job;
      if (of) {
        const list = reviews.get(of);
        if (list) list.push(j);
        else reviews.set(of, [j]);
      }
      if (j.session) add(j.session, j);
    }
  }
  for (const l of reviews.values()) l.sort(byCreated);
  for (const l of sessions.values()) l.sort(byCreated);
  return {
    jobs,
    turnJob: (session, turn) => byTurn.get(`${session}/${turn}`),
    refOf: (job) => refs.get(job.id),
    reviewsOf: (id) => reviews.get(id) ?? [],
    ofSession: (s) => sessions.get(s) ?? [],
    error,
    refresh,
  };
}

// Reads the jobs every POLL_MS while mounted. A turn job that runs but has
// not ended has no result yet, so its turn is read once from its attempt's
// events (turn.created).
export function useJobs(src: JobsSource | undefined): JobsView | undefined {
  const pollMs = src?.pollMs ?? POLL_MS;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [found, setFound] = useState<Record<string, TurnRef>>({});
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // Attempts whose events were read, so each is read at most until it names
  // its turn.
  const asked = useRef<Set<string>>(new Set());
  const foundRef = useRef(found);
  foundRef.current = found;

  useEffect(() => {
    if (!src) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const list = await src.listJobs();
        if (!active) return;
        setJobs(list);
        setError(null);
        for (const j of list) {
          if (j.kind !== 'turn' || resultRef(j) || foundRef.current[j.id] || ended(j) || j.state === 'queued') continue;
          const at = currentAttempt(j);
          if (!at || asked.current.has(at.id)) continue;
          asked.current.add(at.id);
          src
            .attemptEvents(at.id)
            .then((evs) => {
              const ref = turnFromEvents(evs);
              if (ref && active) setFound((f) => ({ ...f, [j.id]: ref }));
              // Not named yet: ask again on a later read.
              else asked.current.delete(at.id);
            })
            .catch(() => asked.current.delete(at.id));
        }
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

  return useMemo(() => (src ? jobsView(jobs, found, error, refresh) : undefined), [src, jobs, found, error, refresh]);
}
