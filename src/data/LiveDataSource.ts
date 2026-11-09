import {
  QueuedJob,
  AgentSummary,
  CallContext,
  CockpitEvent,
  DataSource,
  AgentFields,
  Harness,
  SavedAgent,
  RunRequest,
  SessionList,
  SessionSummary,
  Started,
  Turn,
  TurnDetail,
  TurnList,
  TurnState,
  Usage,
} from '../types';
import { ApiOrigin, buildAgents, extractCleanPrompt, sessionGroup, turnDetail, turnOrigin } from './turns';

export interface LiveDataSourceConfig {
  baseUrl?: string; // defaults to http://127.0.0.1:8787
  token?: string;
  retryBaseMs?: number; // first reconnect wait, doubled each failure; default 1000
  retryMaxMs?: number; // longest reconnect wait; default 30000
}

interface Snapshot {
  store: string;
  seq: number;
  sessions: SessionSummary[];
}

// One turn as GET /api/v0/turns sends it (store.Turn in the framework).
interface ApiTurn {
  id: string;
  session: string;
  agent: string;
  agent_id?: string;
  idempotency_key?: string;
  folder: string;
  origin?: ApiOrigin;
  prompt: string;
  prompt_truncated?: boolean;
  // The reply to the turn's last model call (first 500 characters), the
  // model that call asked for, and how many calls the turn made. Absent from
  // a service older than these fields.
  reply?: string;
  reply_truncated?: boolean;
  model?: string;
  model_calls?: number;
  started_seq: number;
  started: string;
  ended?: string;
  state: TurnState;
  stopped?: boolean;
  outcome?: string;
  exit_code?: number;
  usage: Usage | null;
  cost_usd: number;
  cost_complete: boolean;
}

// A listed turn as the screens read it. n is its number, oldest first.
function turnRow(t: ApiTurn, n: number): Turn {
  const startMs = new Date(t.started).getTime();
  const endMs = t.ended ? new Date(t.ended).getTime() : NaN;
  return {
    id: t.id,
    turnNumber: n,
    sessionId: t.session,
    startedAt: t.started,
    endedAt: t.ended,
    durationMs: isNaN(endMs - startMs) ? undefined : Math.max(0, endMs - startMs),
    prompt: extractCleanPrompt(t.prompt),
    promptTruncated: t.prompt_truncated === true,
    reply: t.reply || undefined,
    replyTruncated: t.reply_truncated === true,
    model: t.model || undefined,
    modelCalls: typeof t.model_calls === 'number' ? t.model_calls : undefined,
    agent: t.agent || undefined,
    agentId: t.agent_id || undefined,
    key: t.idempotency_key || undefined,
    folder: t.folder || undefined,
    origin: turnOrigin(t.origin),
    state: t.state,
    stopped: t.stopped === true || undefined,
    outcome: t.outcome,
    usage: t.usage ?? null,
    costUsd: t.cost_usd,
    costComplete: t.cost_complete,
    startedSeq: t.started_seq,
  };
}

// Uses the client API (docs/CLIENT_API.md in the AgentBus repository).
export class LiveDataSource implements DataSource {
  private baseUrl: string;
  private token?: string;
  private retryBaseMs: number;
  private retryMaxMs: number;

  constructor(config: LiveDataSourceConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:8787';
    this.token = config.token;
    this.retryBaseMs = config.retryBaseMs ?? 1000;
    this.retryMaxMs = config.retryMaxMs ?? 30000;
  }

  private headers(accept = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  // GET /api/v0/sessions: the sessions and the store and seq they were taken at.
  private async snapshot(): Promise<Snapshot> {
    const res = await fetch(`${this.baseUrl}/api/v0/sessions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const sessions: SessionSummary[] = (data.sessions || []).map((s: SessionSummary) => ({
      ...s,
      title: s.title || s.id,
    }));
    return { store: data.store, seq: data.seq, sessions };
  }

  async getAgents(): Promise<AgentSummary[]> {
    return buildAgents(await this.getSessions());
  }

  // The list with the store and seq it was computed at, so the screen can
  // order it against the stream.
  async getSessionList(): Promise<SessionList> {
    return this.snapshot();
  }

  async getSessions(agentId?: string): Promise<SessionSummary[]> {
    const { sessions } = await this.snapshot();
    return agentId === undefined ? sessions : sessions.filter((s) => sessionGroup(s) === agentId);
  }

  // GET /api/v0/turns?session=<id>: one session's turns, newest first, a page
  // at a time. Every page is read (before = next_before until it is null), so
  // the turns can be numbered from the oldest. The list's cursor is the first
  // page's: later pages are computed at that seq or after it. A page from
  // another store means the store changed mid-read: read the list again once.
  async getTurns(sessionId: string): Promise<TurnList> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const rows: ApiTurn[] = [];
      let first: { store: string; seq: number } | null = null;
      let before: number | null = null;
      let restart = false;
      for (;;) {
        const params = new URLSearchParams({ session: sessionId });
        if (before !== null) params.set('before', String(before));
        const res = await fetch(`${this.baseUrl}/api/v0/turns?${params}`, { headers: this.headers() });
        if (!res.ok) throw new Error(`Failed to fetch turns: ${await apiError(res)}`);
        const data = await res.json();
        if (first === null) first = { store: data.store, seq: data.seq };
        else if (data.store !== first.store) {
          restart = true;
          break;
        }
        rows.push(...(data.turns || []));
        if (data.next_before === null || data.next_before === undefined) break;
        before = data.next_before;
      }
      if (restart) continue;
      const turns = rows.reverse().map((t, i) => turnRow(t, i + 1));
      return { store: first!.store, seq: first!.seq, turns };
    }
    throw new Error(`Store changed while reading the turns of ${sessionId}; try again`);
  }

  // GET /api/v0/turns/<id>/events?session=<id>: one turn's events, paged by
  // next_after until it is null. A 409 means the store changed: start over
  // once. session asks for this session's events only: a turn id is unique
  // only within its session.
  async getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null> {
    const path = `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/events`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: CockpitEvent[] = [];
      let cursor: { store: string; after: number } | null = null;
      let restart = false;
      for (;;) {
        const params = new URLSearchParams({ session: sessionId, limit: '1000' });
        if (cursor) {
          params.set('store', cursor.store);
          params.set('after', String(cursor.after));
        }
        const res = await fetch(`${path}?${params}`, { headers: this.headers() });
        if (res.status === 404) return null;
        if (res.status === 409) {
          restart = true;
          break;
        }
        if (!res.ok) throw new Error(`Failed to fetch turn events: ${await apiError(res)}`);
        const data = await res.json();
        events.push(...((data.events || []) as CockpitEvent[]));
        if (data.next_after === null || data.next_after === undefined) {
          return events.length > 0 ? turnDetail(events) : null;
        }
        cursor = { store: data.store, after: data.next_after };
      }
      if (!restart) break;
    }
    throw new Error(`Store changed twice while reading turn ${turnId}`);
  }

  // GET /api/v0/calls/<exchange>/context?full=<bool>: one call's request,
  // piece by piece, and its reply. A 404 means no body is stored for it.
  async getCallContext(exchange: string, full: boolean): Promise<CallContext> {
    const url = `${this.baseUrl}/api/v0/calls/${encodeURIComponent(exchange)}/context?full=${full}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`${res.status}: ${await apiError(res)}`);
    const data = await res.json();
    return { ...data, pieces: Array.isArray(data.pieces) ? data.pieces : [] } as CallContext;
  }

  // GET /api/v0/harnesses: the harnesses the service can run an agent on,
  // whether it finds each, and the access and models each offers.
  async getHarnesses(): Promise<Harness[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/harnesses`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const data = await res.json();
    return Array.isArray(data.harnesses) ? data.harnesses : [];
  }

  // GET /api/v0/jobs/<id>: a queued message's turn job. A job that ended
  // failed or cancelled before its turn started says why, in the refusal the
  // runner recorded when there is one.
  async queuedJob(job: string): Promise<QueuedJob> {
    const res = await fetch(`${this.baseUrl}/api/v0/jobs/${encodeURIComponent(job)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const j = await res.json();
    const ended = j.state === 'finished' || j.state === 'failed' || j.state === 'cancelled';
    // A job whose turn started ran the message, whatever its end: only one
    // that ended before any attempt started its turn did not.
    const started = Array.isArray(j.attempts) && j.attempts.some((a: { turn_started?: boolean }) => a.turn_started === true);
    const failed = !started && (j.state === 'failed' || j.state === 'cancelled');
    const refused = j.result && typeof j.result.refused === 'string' ? (j.result.refused as string) : '';
    return { ended, failed, why: failed ? refused || `the job ${j.state}${j.reason ? `: ${j.reason}` : ''}` : undefined };
  }

  // GET /api/v0/agents: the saved agents, in the order they were made.
  async listAgents(): Promise<SavedAgent[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/agents`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const data = await res.json();
    return Array.isArray(data.agents) ? data.agents : [];
  }

  // POST /api/v0/agents: 201 with the new agent; 400 with why a field is refused.
  async createAgent(f: AgentFields): Promise<SavedAgent> {
    return this.send('POST', '/api/v0/agents', f);
  }

  // PUT /api/v0/agents/<id>: the agent's fields replaced, its id kept.
  async updateAgent(id: string, f: AgentFields): Promise<SavedAgent> {
    return this.send('PUT', `/api/v0/agents/${encodeURIComponent(id)}`, f);
  }

  // DELETE /api/v0/agents/<id>: 204. Its sessions stay.
  async removeAgent(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // PATCH /api/v0/sessions/<id>: a new name for the session. It answers with
  // the session.renamed it stored; the list names the session by it.
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.send('PATCH', `/api/v0/sessions/${encodeURIComponent(sessionId)}`, { title });
  }

  // POST /api/v0/turns: start an agent with a first prompt, in a new session.
  // 202 {id, turn, base_url}: id is the session, turn the new turn.
  async startRun(req: RunRequest): Promise<Started> {
    return this.post('/api/v0/turns', req);
  }

  // POST /api/v0/turns with session: the next turn of a session, in its own
  // folder, on its latest agent or the saved agent req.agent names. 202
  // {id, turn, base_url}, or {id, job, queued, ahead} when it waits behind
  // the session's running turn; 404 for an unknown session; 409 when the
  // session cannot be continued from here.
  async sendMessage(
    sessionId: string,
    req: { prompt: string; read_only?: boolean; model?: string; agent?: string; idempotency_key?: string }
  ): Promise<Started> {
    const body: Record<string, unknown> = { session: sessionId, prompt: req.prompt, read_only: req.read_only };
    if (req.model) body.model = req.model;
    if (req.agent) body.agent = req.agent;
    if (req.idempotency_key) body.idempotency_key = req.idempotency_key;
    return this.post('/api/v0/turns', body);
  }

  // POST /api/v0/turns/<id>/stop: 202 when the service stops the turn, or
  // is stopping it already; 409 when the turn is not running (it has ended).
  async stopTurn(turnId: string): Promise<'stopping' | 'not-running'> {
    const res = await fetch(`${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/stop`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.status === 409) return 'not-running';
    if (!res.ok) throw new Error(await apiError(res));
    return 'stopping';
  }

  private async post(path: string, body: unknown): Promise<Started> {
    return this.send('POST', path, body);
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(await apiError(res)), { status: res.status });
    return res.json();
  }

  // Startup per the spec: take a snapshot, then stream everything after its
  // store and seq, handing the snapshot's sessions to onSnapshot. On 409 the
  // store changed: take a new snapshot, hand it over, and stream from there. Any other failure (a
  // rejected fetch, a broken or closed stream) waits and reconnects from the
  // last store and seq seen; the wait doubles from retryBaseMs to retryMaxMs and
  // goes back to the start once a connection delivers. Unsubscribing stops it.
  subscribe(
    onEvent: (event: CockpitEvent) => void,
    onSnapshot?: (sessions: SessionSummary[], cursor?: { store: string; seq: number }) => void
  ): () => void {
    const controller = new AbortController();
    const signal = controller.signal;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });

    const run = async () => {
      let cursor: { store: string; after: number } | null = null;
      let delay = this.retryBaseMs;
      let resets = 0;
      while (!signal.aborted) {
        try {
          if (!cursor) {
            // One snapshot gives both the list the screen shows and the cursor.
            const snap = await this.snapshot();
            if (signal.aborted) return;
            cursor = { store: snap.store, after: snap.seq };
            onSnapshot?.(snap.sessions, { store: snap.store, seq: snap.seq });
          }
          const params = new URLSearchParams({ store: cursor.store, after: String(cursor.after) });
          const res = await fetch(`${this.baseUrl}/api/v0/events?${params}`, {
            headers: this.headers('text/event-stream'),
            signal,
          });
          if (res.status === 409) {
            cursor = null; // the next snapshot is handed over with onSnapshot
            // Start over at once; a second 409 in a row waits like a failure.
            resets++;
            if (resets === 1) continue;
            throw new Error('store changed again');
          }
          if (!res.ok || !res.body) throw new Error(`Event stream failed: ${res.status}`);
          const c: { store: string; after: number } = cursor;
          await readStream(res.body, (e) => {
            if (typeof e.seq === 'number') c.after = e.seq;
            delay = this.retryBaseMs;
            resets = 0;
            onEvent(e);
          });
        } catch (err) {
          if (signal.aborted) return;
          console.warn('Event stream interrupted, reconnecting:', err);
        }
        if (signal.aborted) return;
        await wait(delay);
        delay = Math.min(delay * 2, this.retryMaxMs);
      }
    };

    run();
    return () => controller.abort();
  }
}

// The API's own words for a refusal: the body's error (or message) field,
// else its text, else the status.
async function apiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    const msg = body?.error ?? body?.message;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // Not JSON: use the text.
  }
  return text.trim() || `agentbus answered ${res.status}`;
}

// Reads a text/event-stream body and calls onEvent for each `data:` message.
async function readStream(body: ReadableStream<Uint8Array>, onEvent: (e: CockpitEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        // A blank line ends one message.
        if (data.length > 0) {
          try {
            onEvent(JSON.parse(data.join('\n')));
          } catch {
            console.error('Malformed event in stream');
          }
        }
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
      // id:, event: and ": ping" comments need nothing here.
    }
  }
}
