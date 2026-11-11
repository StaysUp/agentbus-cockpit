import {
  QueuedTurn,
  ConnectView,
  SubscriptionList,
  SubscriptionState,
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
  ApplyState,
  Turn,
  TurnDiff,
  TurnDetail,
  TurnList,
} from '../types';
import { FolderInfo } from './folders';
import { ApiTurn } from './jobs';
import { buildAgents, extractCleanPrompt, sessionGroup, turnDetail, turnOrigin } from './turns';

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

// The service's words for why a turn failed: a string, or an object with a
// message. Anything else, or only spaces, is no words.
export function turnError(v: unknown): string | undefined {
  const msg = typeof v === 'string' ? v : (v as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : undefined;
}

// A session's closed field: true, or the time it was closed.
export function isClosed(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v !== '');
}

// A listed turn as the screens read it. n is its place, oldest first; the
// turn's own number is used when the service gives it.
function turnRow(t: ApiTurn, n: number): Turn {
  const startMs = new Date(t.started ?? '').getTime();
  const endMs = t.ended ? new Date(t.ended).getTime() : NaN;
  return {
    id: t.id,
    turnNumber: typeof t.number === 'number' && t.number > 0 ? t.number : n,
    sessionId: t.session,
    startedAt: t.started ?? '',
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
    folderRef: t.folder_ref || undefined,
    origin: turnOrigin(t.origin),
    state: t.state,
    error: turnError((t as { error?: unknown }).error),
    stopped: t.stopped === true || t.state === 'stopped' || undefined,
    outcome: t.outcome,
    usage: t.usage ?? null,
    costUsd: typeof t.cost_usd === 'number' ? t.cost_usd : null,
    costComplete: t.cost_complete !== false,
    startedSeq: t.started_seq,
  };
}

// A connect as the API answers it, its output always a list.
export function connectView(data: Partial<ConnectView>): ConnectView {
  return {
    harness: data.harness ?? '',
    state: data.state ?? 'failed',
    output: Array.isArray(data.output) ? data.output : [],
    code: data.code,
    paste: data.paste === true,
    error: data.error,
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
      closed: isClosed((s as { closed?: unknown }).closed) || undefined,
    }));
    return { store: data.store, seq: data.seq, sessions };
  }

  // GET /api/v0/sessions/<id>: closed on the session, or on its copy (where
  // the service says it before the list does). A failed read is not closed.
  async sessionClosed(sessionId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/v0/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return isClosed(data?.session?.closed) || isClosed(data?.copy?.closed);
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
  // at a time. The first page starts with the turns still queued: they are
  // left out here, since the conversation shows a queued message as its own
  // pending copy until its turn starts. Every page is read (before = next_before until it is null), so
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
      const turns = rows
        .filter((t) => t.state !== 'queued')
        .reverse()
        .map((t, i) => turnRow(t, i + 1));
      return { store: first!.store, seq: first!.seq, turns };
    }
    throw new Error(`Store changed while reading the turns of ${sessionId}; try again`);
  }

  // GET /api/v0/sessions/<id>/events?turn=<turn>: one turn's events, paged
  // by next_after until it is null. A 409 means the store changed: start
  // over once. A turn id is unique only within its session, so the session
  // is in the path.
  async getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null> {
    const path = `${this.baseUrl}/api/v0/sessions/${encodeURIComponent(sessionId)}/events`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: CockpitEvent[] = [];
      let cursor: { store: string; after: number } | null = null;
      let restart = false;
      for (;;) {
        const params = new URLSearchParams({ turn: turnId, limit: '1000' });
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

  // GET /api/v0/turns/<turn>/calls/<exchange>?full=<bool>: one call's
  // request, piece by piece, and its reply. The call must belong to the
  // turn. A 404 means no body is stored for it.
  async getCallContext(turn: string, exchange: string, full: boolean): Promise<CallContext> {
    const url = `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turn)}/calls/${encodeURIComponent(exchange)}?full=${full}`;
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

  // GET /api/v0/turns/<id>?session=<id>: a queued message's turn. A turn
  // that ended without ever starting (stopped while queued, or refused) did
  // not run the message, and says why when it can. A turn that started is
  // in the session's list, which shows it.
  async queuedTurn(session: string, turn: string): Promise<QueuedTurn> {
    const params = new URLSearchParams({ session });
    const res = await fetch(`${this.baseUrl}/api/v0/turns/${encodeURIComponent(turn)}?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const t = ((await res.json()) as { turn?: ApiTurn }).turn;
    if (!t) return { ended: false, failed: false };
    const ended = t.state === 'finished' || t.state === 'failed' || t.state === 'stopped';
    const started = !!t.started_seq;
    const failed = ended && !started && t.state !== 'finished';
    const why = t.error || (t.state === 'stopped' ? 'stopped before it started' : `the turn ${t.state}`);
    return { ended, failed, why: failed ? why : undefined };
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

  // GET /api/v0/subscriptions: null when the service connects none (404).
  async listSubscriptions(): Promise<SubscriptionList | null> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiError(res));
    const data = await res.json();
    const subs: SubscriptionState[] = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    return { on: data.on === true, subscriptions: subs.map((s) => (s.connect ? { ...s, connect: connectView(s.connect) } : s)) };
  }

  // POST /api/v0/subscriptions/<harness>/connect: 202 with the login started
  // on control, or the one already running.
  async connectSubscription(harness: string): Promise<ConnectView> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(harness)}/connect`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return connectView(await res.json());
  }

  // GET /api/v0/subscriptions/<harness>/connect: the login as it is now.
  async getConnect(harness: string): Promise<ConnectView> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(harness)}/connect`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return connectView(await res.json());
  }

  // POST /api/v0/subscriptions/<harness>/connect/input: one line for the
  // login, such as the code the browser showed. 204.
  async connectInput(harness: string, line: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(harness)}/connect/input`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ line }),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // subscriptions_on_runners = "own": the policy read, that one key
  // changed, and written back with the version it was read at.
  async subscriptionsOn(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/settings/permissions`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const policy = await res.json();
    const put = await fetch(`${this.baseUrl}/api/v0/settings/permissions`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json', 'If-Match': res.headers.get('ETag') ?? '*' },
      body: JSON.stringify({ ...policy, subscriptions_on_runners: 'own' }),
    });
    if (!put.ok) throw new Error(await apiError(put));
  }

  // PATCH /api/v0/sessions/<id>: a new name for the session. It answers with
  // the session.renamed it stored; the list names the session by it.
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.send('PATCH', `/api/v0/sessions/${encodeURIComponent(sessionId)}`, { title });
  }

  // POST /api/v0/turns: start an agent with a first prompt, in a new session.
  // 202 {session, turn, state}: the turn's id is there even while it waits.
  async startRun(req: RunRequest): Promise<Started> {
    return this.post('/api/v0/turns', req);
  }

  // POST /api/v0/turns with session: the next turn of a session, in its own
  // folder, on its latest agent or the saved agent req.agent names. 202
  // {session, turn, state}, with state queued and ahead when it waits behind
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

  // POST /api/v0/turns/<id>/stop: 202 when the service stops the turn (a
  // queued one at once), or is stopping it already; 409 when the turn has
  // ended.
  async stopTurn(turnId: string): Promise<'stopping' | 'not-running'> {
    const res = await fetch(`${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/stop`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.status === 409) return 'not-running';
    if (!res.ok) throw new Error(await apiError(res));
    return 'stopping';
  }

  // GET /api/v0/turns/<id>/diff: the turn's files, calls and commands.
  async getTurnDiff(sessionId: string, turnId: string): Promise<TurnDiff> {
    const res = await fetch(
      `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/diff?session=${encodeURIComponent(sessionId)}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // POST /api/v0/turns/<id>/apply: 200 applied (or already), 202 still
  // running, 409 refused with each file and why. All three are answers. A
  // 409 with no state (an apply of an earlier turn has not ended) is an
  // error in the API's words.
  async applyTurn(turnId: string): Promise<ApplyState> {
    const res = await fetch(`${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/apply`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.ok) return res.json();
    if (res.status === 409) {
      const text = await res.text().catch(() => '');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the text is the error.
      }
      if (body && typeof (body as ApplyState).state === 'string') return body as ApplyState;
      const msg = (body as { error?: unknown } | undefined)?.error;
      throw new Error(typeof msg === 'string' && msg ? msg : text.trim() || 'agentbus answered 409');
    }
    throw new Error(await apiError(res));
  }

  // GET /api/v0/folders: the folders the runners own, by reference.
  async listFolders(): Promise<FolderInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/folders`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const body = await res.json();
    return Array.isArray(body?.folders) ? body.folders : [];
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
