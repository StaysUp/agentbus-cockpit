// The control plane: a job queue and runners (agentbus-ci). It is
// optional. With it, a prompt becomes a turn job that a runner runs as an
// AgentBus turn, and a finished turn can be reviewed by another agent as a
// review job. Its README is the contract.

export type JobState = 'queued' | 'taken' | 'running' | 'finished' | 'failed' | 'cancelled';
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface Finding {
  severity: string; // P1, P2 or P3
  file?: string;
  line?: number;
  summary: string;
}

export interface JobSpec {
  agent?: string;
  folder?: string;
  repo?: string;
  base?: string;
  session?: string;
  prompt: string;
  model?: string;
  read_only?: boolean;
}

export interface JobAttempt {
  id: string;
  number: number;
  runner: string;
  state: string;
  taken: string;
  started?: string;
  ended?: string;
  reason?: string;
}

export interface FileChange {
  path: string;
  change?: string;
  [key: string]: unknown;
}

export interface JobResult {
  session?: string;
  turn?: string;
  state?: string;
  exit_code?: number;
  reply?: string;
  reply_text?: string;
  cost_usd?: number;
  error?: string;
  refused?: string;
  may_still_run?: boolean;
  changes?: { kind?: string; count?: number; files?: FileChange[] };
}

export interface Job {
  id: string;
  kind: 'turn' | 'review';
  state: JobState;
  spec: JobSpec;
  links?: { reviews_job?: string; continues_turn?: string; redo_of?: string };
  attempt?: string;
  reason?: string;
  verdict: Verdict | null;
  findings?: Finding[];
  result?: JobResult;
  session?: string;
  workspace?: { session: string; runner: string; kind: string; folder: string };
  attempts?: JobAttempt[];
  created: string;
  updated: string;
  ended?: string;
}

export interface JobEvent {
  seq: number;
  time: string;
  kind: string;
  data?: Record<string, unknown>;
}

// Where a turn job's turn ran: the framework session and turn.
export interface TurnRef {
  session: string;
  turn: string;
}

export interface ReviewRequest {
  agent: string;
  model?: string;
}

// What the screens call. One implementation talks to the control plane; the
// tests give their own.
export interface JobsSource {
  // The control plane's address, for the foot of the Agents column.
  address: string;
  // How often to read the jobs again, in ms. Tests set it low.
  pollMs?: number;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  createTurnJob(spec: JobSpec): Promise<Job>;
  review(jobId: string, req: ReviewRequest): Promise<Job>;
  cancel(jobId: string): Promise<void>;
  attemptEvents(attemptId: string): Promise<JobEvent[]>;
}

export const ENDED: ReadonlySet<JobState> = new Set(['finished', 'failed', 'cancelled']);

export function ended(job: Job): boolean {
  return ENDED.has(job.state);
}

// A key the control plane takes as idempotency_key: a retry of the same click
// makes no second job.
export function newKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

export class ControlPlane implements JobsSource {
  constructor(
    public address: string,
    private token: string
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.address}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  async listJobs(): Promise<Job[]> {
    const data = await this.call<{ jobs?: Job[] }>('GET', '/api/v0/jobs?limit=200');
    return Array.isArray(data.jobs) ? data.jobs : [];
  }

  getJob(id: string): Promise<Job> {
    return this.call('GET', `/api/v0/jobs/${encodeURIComponent(id)}`);
  }

  createTurnJob(spec: JobSpec): Promise<Job> {
    return this.call('POST', '/api/v0/jobs', { kind: 'turn', idempotency_key: newKey('cockpit-turn'), spec });
  }

  review(jobId: string, req: ReviewRequest): Promise<Job> {
    const body: Record<string, unknown> = { agent: req.agent, idempotency_key: newKey('cockpit-review') };
    if (req.model) body.model = req.model;
    return this.call('POST', `/api/v0/jobs/${encodeURIComponent(jobId)}/review`, body);
  }

  async cancel(jobId: string): Promise<void> {
    await this.call('POST', `/api/v0/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async attemptEvents(attemptId: string): Promise<JobEvent[]> {
    const data = await this.call<{ events?: JobEvent[] }>('GET', `/api/v0/attempts/${encodeURIComponent(attemptId)}/events`);
    return Array.isArray(data.events) ? data.events : [];
  }
}

// The API's own words for a refusal: the body's error field, else its text,
// else the status.
async function apiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const msg = JSON.parse(text)?.error;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // Not JSON.
  }
  return text.trim() || `the control plane answered ${res.status}`;
}

export const CHECK_TIMEOUT_MS = 10_000;

// Checks a control plane's address and token with GET /api/v0/jobs?limit=1.
// null when they work, else a plain sentence.
export async function checkControlPlane(address: string, token: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${address}/api/v0/jobs?limit=1`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch {
      return `cannot reach the control plane at ${address}`;
    }
    if (res.status === 401) return 'the control plane refused the token';
    if (!res.ok) return `the control plane at ${address} answered ${res.status}`;
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { jobs?: unknown }).jobs)) {
      return `${address} did not answer like a control plane`;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The turn a turn job ran, from its result once it ended. A running job's
// turn is in its attempt's turn.created event (turnFromEvents).
export function resultRef(job: Job): TurnRef | null {
  const r = job.result;
  return r?.session && r.turn ? { session: r.session, turn: r.turn } : null;
}

export function turnFromEvents(events: JobEvent[]): TurnRef | null {
  for (const e of events) {
    if (e.kind !== 'turn.created' || !e.data) continue;
    const { session, turn } = e.data as { session?: unknown; turn?: unknown };
    if (typeof session === 'string' && session && typeof turn === 'string' && turn) return { session, turn };
  }
  return null;
}

// The current attempt: the one the job names, else its newest.
export function currentAttempt(job: Job): JobAttempt | undefined {
  const list = job.attempts ?? [];
  return list.find((a) => a.id === job.attempt) ?? list[list.length - 1];
}

export interface StartWait {
  intervalMs?: number;
  timeoutMs?: number;
}

// Makes a turn job and waits until its runner has started the turn: then the
// framework knows the session and turn, and the screens can show it. Rejects
// with the API's words, with why the job ended, or after timeoutMs while no
// runner has taken it (the job stays in the queue).
export async function startTurnJob(src: JobsSource, spec: JobSpec, wait: StartWait = {}): Promise<{ job: Job; ref: TurnRef }> {
  const intervalMs = wait.intervalMs ?? 500;
  const deadline = Date.now() + (wait.timeoutMs ?? 180_000);
  let job = await src.createTurnJob(spec);
  for (;;) {
    const ref = resultRef(job);
    if (ref) return { job, ref };
    const at = currentAttempt(job);
    if (at && job.state !== 'queued') {
      const found = turnFromEvents(await src.attemptEvents(at.id));
      if (found) return { job, ref: found };
    }
    if (ended(job)) throw new Error(`the job ${job.state}${job.reason ? `: ${job.reason}` : ''}`);
    if (Date.now() > deadline) {
      throw new Error(
        job.state === 'queued'
          ? `no runner took job ${job.id} yet; it stays in the queue`
          : `job ${job.id} has not started its turn yet`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    job = await src.getJob(job.id);
  }
}

// The reviewer offered first: another vendor than the author's.
export function defaultReviewer(author: string | undefined, available: string[]): string {
  const prefer = author === 'codex' ? ['claude', 'opencode', 'agy'] : ['codex', 'opencode', 'agy', 'claude'];
  for (const p of prefer) if (p !== author && available.includes(p)) return p;
  return available.find((a) => a !== author) ?? available[0] ?? 'claude';
}

// A model to start from for each reviewer; empty means the agent's default.
export function defaultModel(agent: string): string {
  return agent === 'claude' ? 'sonnet' : '';
}

export function modelHints(agent: string): string[] {
  switch (agent) {
    case 'claude':
      return ['sonnet', 'opus', 'haiku'];
    case 'codex':
      return ['gpt-5.5'];
    case 'opencode':
      return ['opencode/big-pickle'];
    default:
      return [];
  }
}

// The words and colour for a job's outcome. A review reads its verdict; a
// verdict of null on a finished review cannot happen, but reads as unknown.
export function outcome(job: Job): { label: string; cls: string } {
  switch (job.state) {
    case 'queued':
      return { label: 'Queued', cls: 'dim' };
    case 'taken':
      return { label: 'Starting', cls: 'run' };
    case 'running':
      return { label: 'Running', cls: 'run' };
    case 'cancelled':
      return { label: 'Cancelled', cls: 'dim' };
    case 'failed':
      return { label: job.reason ? `Failed: ${job.reason}` : 'Failed', cls: 'bad' };
    case 'finished':
      if (job.kind !== 'review') return { label: 'Finished', cls: 'ok' };
      if (job.verdict === 'pass') return { label: 'Passed', cls: 'ok' };
      if (job.verdict === 'fail') return { label: 'Failed', cls: 'bad' };
      return { label: 'No verdict', cls: 'warn' };
  }
  return { label: job.state, cls: '' };
}

export function reviewerLabel(job: Job): string {
  return job.spec.model ? `${job.spec.agent ?? 'agent'} · ${job.spec.model}` : (job.spec.agent ?? 'agent');
}

export function findingPlace(f: Finding): string {
  if (!f.file) return '';
  return f.line ? `${f.file}:${f.line}` : f.file;
}

// The message Fix puts in the message box after a failed review: each
// finding with its severity and place, as a prompt the person can edit before
// they send it. Nothing is sent by itself. It names the reviewed turn, which
// need not be the session's newest: a review can end after the next turn was
// sent.
export function fixPrompt(findings: Finding[], turnNumber: number): string {
  if (findings.length === 0) {
    return `A review of turn ${turnNumber} failed without naming a problem. Read that change again and fix what is wrong.`;
  }
  const lines = findings.map((f) => {
    const place = findingPlace(f);
    return `- ${f.severity}${place ? ` ${place}` : ''}: ${f.summary.trim()}`;
  });
  return `A review of turn ${turnNumber} found these problems. Fix them:\n\n${lines.join('\n')}`;
}

// m:ss from milliseconds.
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// How long the job waited for a runner, and how long it ran (so far, while it
// runs). Undefined when it has not reached that point.
export function jobTimes(job: Job, now: number): { waitedMs?: number; ranMs?: number } {
  const at = currentAttempt(job);
  const t = (s?: string) => (s ? new Date(s).getTime() : NaN);
  const out: { waitedMs?: number; ranMs?: number } = {};
  const created = t(job.created);
  const taken = t(at?.taken);
  if (!isNaN(created) && !isNaN(taken)) out.waitedMs = Math.max(0, taken - created);
  else if (job.state === 'queued' && !isNaN(created)) out.waitedMs = Math.max(0, now - created);
  const started = t(at?.started);
  if (!isNaN(started)) {
    const end = t(at?.ended ?? job.ended);
    out.ranMs = Math.max(0, (isNaN(end) ? now : end) - started);
  }
  return out;
}

export function shortRunner(id: string | undefined): string {
  if (!id) return '';
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}
