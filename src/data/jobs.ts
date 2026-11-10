// The job queue, on the same agentbus API as everything else: one address,
// one token. A prompt becomes a turn job that a runner runs as a turn, and a
// finished turn can be reviewed by another agent as a review job. A job's
// attempt is its turn: the attempt id is the turn id. The agentbus README and
// docs/CLIENT_API.md are the contract.

export type JobState = 'queued' | 'taken' | 'running' | 'finished' | 'failed' | 'cancelled';
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface Finding {
  severity: string; // P1, P2 or P3
  file?: string;
  line?: number;
  summary: string;
}

export interface JobSpec {
  // A saved agent's id. The service fills in its harness, access and model.
  agent?: string;
  folder?: string;
  // A folder another machine owns, by its reference and its connector (GET
  // /api/v0/folders), in place of folder.
  folder_ref?: string;
  connector?: string;
  // With folder: the session's own copy of the folder, as the service's
  // isolation setting makes it; false uses the folder as it is.
  isolate?: boolean;
  repo?: string;
  base?: string;
  // Words a runner must have (agentbus runner -labels).
  labels?: string[];
  session?: string;
  // Empty for an apply or snapshot job: they start no turn.
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
  // The runner started this attempt's turn: the attempt id is then a turn in
  // the record.
  turn_started?: boolean;
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
  // apply and snapshot run on a folder's connector and start no turn.
  kind: 'turn' | 'review' | 'apply' | 'snapshot';
  state: JobState;
  spec: JobSpec;
  // applies_turn: for an apply job, the turn whose changes it applies.
  links?: { reviews_job?: string; continues_turn?: string; redo_of?: string; applies_turn?: string; applies_job?: string };
  attempt?: string;
  reason?: string;
  verdict: Verdict | null;
  findings?: Finding[];
  result?: JobResult;
  session?: string;
  workspace?: Workspace;
  attempts?: JobAttempt[];
  created: string;
  updated: string;
  ended?: string;
}

// Where a session's turns run, on its runner. space: a copy or worktree, by
// its id on the runner. folder_ref: a folder used as it is. folder: a path on
// the runner, only for a session made before these ids. The cockpit reads no
// file through any of them.
export interface Workspace {
  session: string;
  runner: string;
  kind: string; // worktree, copy or folder
  space?: string;
  folder_ref?: string;
  folder?: string;
  repo?: string;
  base?: string;
  // The snapshot id of the copy as it was made.
  snapshot?: string;
  created?: string;
  closed?: string;
  removed?: string;
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

// What the screens call. One implementation talks to the agentbus API; the
// tests give their own.
export interface JobsSource {
  // The service's address.
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

// A key the queue takes as idempotency_key: a retry of the same click
// makes no second job.
export function newKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

export class JobsClient implements JobsSource {
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
  return text.trim() || `agentbus answered ${res.status}`;
}

export const CHECK_TIMEOUT_MS = 10_000;

// Whether the service keeps a job queue. Only a 404 from GET /api/v0/jobs
// says it does not: a runner's own service answers that. Any other answer,
// a failure included, counts as a queue, so a passing error never hides
// Review; the jobs list then shows the error.
export async function probeJobs(address: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${address}/api/v0/jobs?limit=1`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return res.status !== 404;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// The turn a turn job ran. The job names its session when it is made, and its
// attempt is its turn: the newest attempt whose turn the runner reported
// started (turn_started). An attempt that never started its turn names none.
// A result that names a turn itself, as older services wrote, is read first.
export function resultRef(job: Job): TurnRef | null {
  const r = job.result;
  if (r?.session && r.turn) return { session: r.session, turn: r.turn };
  if (job.kind !== 'turn' || !job.session) return null;
  const started = (job.attempts ?? []).filter((a) => a.turn_started);
  const at = started[started.length - 1];
  return at ? { session: job.session, turn: at.id } : null;
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
  // After waitingMs with no turn started, onWaiting is called once with the
  // job, which stays in the queue. The wait goes on.
  waitingMs?: number;
  onWaiting?: (job: Job) => void;
}

// Makes a turn job and waits until its runner has started the turn: then the
// framework knows the session and turn, and the screens can show it. Rejects
// with the API's words, or with why the job ended. A job no runner takes is
// waited for as long as it is queued: giving up while it stays queued would
// let a retry make a second job, and both would run.
export async function startTurnJob(src: JobsSource, spec: JobSpec, wait: StartWait = {}): Promise<{ job: Job; ref: TurnRef }> {
  const intervalMs = wait.intervalMs ?? 500;
  const waitingAt = Date.now() + (wait.waitingMs ?? 30_000);
  let told = false;
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
    if (!told && Date.now() > waitingAt) {
      told = true;
      wait.onWaiting?.(job);
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
