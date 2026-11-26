import {
  QueuedTurn,
  ConnectView,
  SubscriptionList,
  SubscriptionState,
  CallContext,
  CockpitEvent,
  DataSource,
  AgentFields,
  Harness,
  ModelList,
  ModelOption,
  SavedAgent,
  RunRequest,
  RunnerInfo,
  RunnersRead,
  VersionInfo,
  HeldApproval,
  ApprovalGone,
  ApprovalDecision,
  SessionList,
  SessionSummary,
  ShellRun,
  Started,
  ApplyPreview,
  ApplyState,
  DiscardState,
  UpdateState,
  WorkspaceInfo,
  WorkspaceRow,
  CloseState,
  Turn,
  TurnDiff,
  TurnChangesPage,
  TurnContext,
  SessionContext,
  TurnDetail,
  TurnList,
  AppSummary,
  AppDef,
} from '../types';
import { FolderInfo } from './folders';
import { ConfigFound, FoundPath, Policy, SettingsInfo, Versioned } from './settings';
import { COMMAND_KINDS, shellRun } from './shell';
import { ApiTurn } from './jobs';
import { extractCleanPrompt, turnDetail, turnOrigin } from './turns';

export interface LiveDataSourceConfig {
  baseUrl?: string; // defaults to http://127.0.0.1:8787
  token?: string;
  retryBaseMs?: number; // first reconnect wait, doubled each failure; default 1000
  retryMaxMs?: number; // longest reconnect wait; default 30000
  // How long an open stream may stay silent before it counts as gone and is
  // opened again. The service sends a ping every 15 seconds; default 45000.
  idleMs?: number;
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
    // The list carries facts only. The whole prompt and reply come from the
    // single turn (getTurnText), loaded for each turn the cockpit shows.
    prompt: '',
    reply: undefined,
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
    discarded: t.discarded === true || undefined,
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
    rejected: data.rejected === true,
    cancelled: data.cancelled === true,
    error: data.error,
  };
}

// Uses the client API, as its OpenAPI description (/api/v0/openapi.json) says.
export class LiveDataSource implements DataSource {
  private baseUrl: string;
  private token?: string;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private idleMs: number;

  constructor(config: LiveDataSourceConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:8787';
    this.token = config.token;
    this.retryBaseMs = config.retryBaseMs ?? 1000;
    this.retryMaxMs = config.retryMaxMs ?? 30000;
    this.idleMs = config.idleMs ?? 45000;
  }

  private headers(accept = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  // GET /api/v0/sessions: the sessions and the store and seq they were taken at.
  // GET /api/v0/sessions: every session, newest activity first, a page at a
  // time, as GET /turns does. Later pages pass the first page's store and seq
  // (after) to pin the snapshot and before = the previous page's next_before,
  // so a session that gains activity meanwhile keeps its place and none is
  // skipped. A page from another store means the store changed mid-read: read
  // the list again once.
  private async snapshot(): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessions: SessionSummary[] = [];
      let first: { store: string; seq: number } | null = null;
      let before: number | null = null;
      let restart = false;
      for (;;) {
        const params = new URLSearchParams();
        // Fetch archived sessions too; the screen hides them by default and a
        // "Show archived" toggle reveals them, filtering by the archived flag.
        params.set('archived', 'true');
        if (first !== null) {
          params.set('store', first.store);
          params.set('after', String(first.seq));
        }
        if (before !== null) params.set('before', String(before));
        const q = params.toString();
        const res = await fetch(`${this.baseUrl}/api/v0/sessions${q ? `?${q}` : ''}`, { headers: this.headers() });
        // The pinned store changed: the service answers 409, so read again from
        // the new store's first page rather than failing the whole read.
        if (res.status === 409 && first !== null) {
          restart = true;
          break;
        }
        if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status} ${res.statusText}`);
        const data = await res.json();
        if (first === null) first = { store: data.store, seq: data.seq };
        else if (data.store !== first.store) {
          restart = true;
          break;
        }
        for (const s of (data.sessions || []) as SessionSummary[]) {
          sessions.push({
            ...s,
            title: s.title || s.id,
            archived: isClosed((s as { archived?: unknown }).archived) || undefined,
          });
        }
        if (data.next_before === null || data.next_before === undefined) break;
        before = data.next_before;
      }
      if (restart) continue;
      return { store: first!.store, seq: first!.seq, sessions };
    }
    throw new Error('Store changed while reading the sessions; try again');
  }

  // The list with the store and seq it was computed at, so the screen can
  // order it against the stream.
  async getSessionList(): Promise<SessionList> {
    return this.snapshot();
  }

  async getSessions(): Promise<SessionSummary[]> {
    return (await this.snapshot()).sessions;
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

  // GET /api/v0/harnesses/<harness>/models?access=<access>: the models an
  // access can use now. Only ids and labels of the right shape are kept.
  async getModels(harness: string, access: string, refresh = false): Promise<ModelList> {
    const params = new URLSearchParams({ access });
    if (refresh) params.set('refresh', 'true');
    const res = await fetch(`${this.baseUrl}/api/v0/harnesses/${encodeURIComponent(harness)}/models?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const data = await res.json();
    const models: ModelOption[] = Array.isArray(data.models)
      ? data.models
          .filter((m: unknown): m is { id: string; label?: unknown } => !!m && typeof (m as { id?: unknown }).id === 'string')
          .map((m: { id: string; label?: unknown }) => (typeof m.label === 'string' && m.label ? { id: m.id, label: m.label } : { id: m.id }))
      : [];
    return {
      harness,
      access,
      models,
      source: typeof data.source === 'string' ? data.source : '',
      ...(typeof data.fetched_at === 'string' ? { fetched_at: data.fetched_at } : {}),
      ...(typeof data.error === 'string' && data.error ? { error: data.error } : {}),
    };
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

  // GET /api/v0/turns/<id>?session=<id>: the whole prompt and reply of one
  // turn, read from the record. The turn list carries neither, so the cockpit
  // loads each shown turn's text from here. The prompt has system reminders
  // taken out, as the former list preview did.
  async getTurnText(session: string, turn: string): Promise<{ prompt: string; reply?: string }> {
    const params = new URLSearchParams({ session });
    const res = await fetch(`${this.baseUrl}/api/v0/turns/${encodeURIComponent(turn)}?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const t = ((await res.json()) as { turn?: ApiTurn }).turn;
    return { prompt: extractCleanPrompt(t?.prompt ?? ''), reply: t?.reply || undefined };
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

  // The apps control serves: the list as facts only, then one app's full
  // definition from the single tool route.
  async listApps(): Promise<AppSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/tools`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const body = (await res.json()) as { tools?: AppSummary[] };
    return body.tools ?? [];
  }

  async getApp(name: string): Promise<AppDef> {
    const res = await fetch(`${this.baseUrl}/api/v0/tools/${encodeURIComponent(name)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    return (await res.json()) as AppDef;
  }

  async addApp(def: AppDef): Promise<AppDef> {
    const res = await fetch(`${this.baseUrl}/api/v0/tools`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return (await res.json()) as AppDef;
  }

  async removeApp(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/tools/${encodeURIComponent(name)}`, {
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
    const out: SubscriptionList = { subscriptions: subs.map((s) => (s.connect ? { ...s, connect: connectView(s.connect) } : s)) };
    const ak = data.api_keys;
    if (ak && typeof ak === 'object') {
      out.api_keys = {};
      for (const [name, v] of Object.entries(ak as Record<string, { set?: unknown; set_at?: unknown }>)) {
        if (v && typeof v === 'object' && typeof v.set === 'boolean') {
          out.api_keys[name] = { set: v.set, ...(typeof v.set_at === 'string' ? { set_at: v.set_at } : {}) };
        }
      }
    }
    const ek = data.env_keys;
    if (ek && typeof ek === 'object') {
      out.env_keys = {};
      for (const [name, v] of Object.entries(ek as Record<string, unknown>)) {
        if (typeof v === 'boolean') out.env_keys[name] = v;
      }
    }
    return out;
  }

  // PUT /api/v0/subscriptions/openrouter/key: 204. The key goes in the body
  // only, never in a URL, and nothing of it comes back.
  async setOpenRouterKey(key: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/openrouter/key`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // DELETE /api/v0/subscriptions/openrouter/key: 204.
  async removeOpenRouterKey(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/openrouter/key`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // PUT /api/v0/subscriptions/<name>/key for a vendor's API key: 204. The
  // key goes in the body only.
  async setAPIKey(name: string, key: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(name)}/key`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // DELETE /api/v0/subscriptions/<name>/key: 204.
  async removeAPIKey(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(name)}/key`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
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

  // DELETE /api/v0/subscriptions/<harness>/connect: stop the running login.
  // 204; 409 when none runs.
  async cancelConnect(harness: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/subscriptions/${encodeURIComponent(harness)}/connect`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // The settings routes, each with the ETag its answer carried. A write
  // sends it back in If-Match: a change made elsewhere since is a 412.
  private async versioned<T>(method: string, path: string, etag?: string, body?: unknown): Promise<Versioned<T>> {
    const headers: Record<string, string> = { ...this.headers() };
    if (etag !== undefined) headers['If-Match'] = etag;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(await apiError(res)), { status: res.status });
    // Never '*' in its place: that would overwrite a change made elsewhere.
    const tag = res.headers.get('ETag');
    if (!tag) throw new Error('agentbus sent no ETag (an older AgentBus, or a proxy that drops it)');
    return { value: await res.json(), etag: tag };
  }

  async getSettings(): Promise<Versioned<SettingsInfo>> {
    return this.versioned('GET', '/api/v0/settings');
  }

  async getPolicy(): Promise<Versioned<Policy>> {
    return this.versioned('GET', '/api/v0/settings/permissions');
  }

  async putPolicy(p: Policy, etag: string): Promise<Versioned<Policy>> {
    return this.versioned('PUT', '/api/v0/settings/permissions', etag, p);
  }

  async patchPolicy(change: Policy, etag: string): Promise<Versioned<Policy>> {
    return this.versioned('PATCH', '/api/v0/settings/permissions', etag, change);
  }

  async getInstructions(): Promise<Versioned<string>> {
    const r = await this.versioned<{ text: string }>('GET', '/api/v0/settings/instructions');
    return { value: r.value.text ?? '', etag: r.etag };
  }

  async putInstructions(text: string, etag: string): Promise<Versioned<string>> {
    const r = await this.versioned<{ text: string }>('PUT', '/api/v0/settings/instructions', etag, { text });
    return { value: r.value.text ?? text, etag: r.etag };
  }

  // Use my config: the usual config paths in the home of the folders'
  // machine. It asks with the first folder GET /api/v0/folders lists, on its
  // machine (GET /api/v0/folders/{ref}/home-files); with folders on several
  // machines it says which one it looked on. A refusal throws the API's
  // words; an older control without the route says so.
  async findConfig(): Promise<ConfigFound> {
    const folders = await this.listFolders();
    if (folders.length === 0) throw new Error('Add a folder first; AgentBus looks in the home of the machine that holds it.');
    const first = folders[0];
    const machines = new Set(folders.map((f) => f.machine ?? f.runner ?? ''));
    const q = first.machine ? `?machine=${encodeURIComponent(first.machine)}` : '';
    const res = await fetch(`${this.baseUrl}/api/v0/folders/${encodeURIComponent(first.ref)}/home-files${q}`, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let words = '';
      try {
        const body = JSON.parse(text);
        const msg = body?.error ?? body?.message;
        if (typeof msg === 'string') words = msg;
      } catch {
        // Not JSON.
      }
      // A 404 with no words of the API's own is a control without the route.
      if (!words && res.status === 404) words = `This AgentBus cannot list your config: ${text.trim() || 'agentbus answered 404'}`;
      throw Object.assign(new Error(words || text.trim() || `agentbus answered ${res.status}`), { status: res.status });
    }
    const body = (await res.json()) as { files?: FoundPath[] };
    const paths = Array.isArray(body?.files) ? body.files : [];
    return machines.size > 1 ? { paths, from: first.runner ?? first.machine } : { paths };
  }

  // PATCH /api/v0/sessions/<id>: a new name for the session. It answers with
  // the session.renamed it stored; the list names the session by it.
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.send('PATCH', `/api/v0/sessions/${encodeURIComponent(sessionId)}`, { title });
  }

  // PATCH /api/v0/sessions/<id> archived: true|false. Only a view: it hides or
  // un-hides the session and removes nothing. 'running' when the session has
  // not finished a turn on this service yet (409), so there is no record to
  // carry the flag. Any other refusal rejects with the API's words.
  async archiveSession(sessionId: string, archived: boolean): Promise<'ok' | 'running'> {
    try {
      await this.send('PATCH', `/api/v0/sessions/${encodeURIComponent(sessionId)}`, { archived });
      return 'ok';
    } catch (err) {
      if ((err as { status?: number }).status === 409) return 'running';
      throw err;
    }
  }

  // GET /api/v0/sessions/<id>/events: every event of the session, oldest
  // first, 1000 a page, paged by next_after until it is null. A 409 means
  // the store changed: start over once.
  async getSessionEvents(sessionId: string): Promise<unknown[]> {
    const path = `${this.baseUrl}/api/v0/sessions/${encodeURIComponent(sessionId)}/events`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: unknown[] = [];
      let cursor: { store: string; after: number } | null = null;
      for (;;) {
        const params = new URLSearchParams({ limit: '1000' });
        if (cursor) {
          params.set('store', cursor.store);
          params.set('after', String(cursor.after));
        }
        const res = await fetch(`${path}?${params}`, { headers: this.headers() });
        if (res.status === 409) break;
        if (!res.ok) throw new Error(await apiError(res));
        const data = await res.json();
        events.push(...((data.events || []) as unknown[]));
        if (data.next_after === null || data.next_after === undefined) return events;
        cursor = { store: data.store, after: data.next_after };
      }
    }
    throw new Error(`Store changed twice while reading session ${sessionId}; try again`);
  }

  // GET /api/v0/sessions/<id>/events?kind=<the command kinds>: the session's
  // "!" command events from before AgentBus 0.5, read-only, oldest first,
  // paged by next_after until it is null.
  async getCommands(sessionId: string): Promise<ShellRun[]> {
    const out: ShellRun[] = [];
    let cursor: { store: string; after: number } | null = null;
    for (;;) {
      const params = new URLSearchParams({ kind: COMMAND_KINDS.join(','), limit: '1000' });
      if (cursor) {
        params.set('store', cursor.store);
        params.set('after', String(cursor.after));
      }
      const res = await fetch(`${this.baseUrl}/api/v0/sessions/${encodeURIComponent(sessionId)}/events?${params}`, {
        headers: this.headers(),
      });
      if (!res.ok) throw new Error(await apiError(res));
      const data = await res.json();
      for (const e of (data.events || []) as CockpitEvent[]) {
        const r = shellRun(e);
        if (r) out.push(r);
      }
      if (data.next_after === null || data.next_after === undefined) return out;
      cursor = { store: data.store, after: data.next_after };
    }
  }

  // POST /api/v0/workspaces: the folder (or folder_ref) and the mode. The
  // runner checks the folder here, so a bad one is refused at this call, before
  // any session exists. Returns the workspace's id.
  async createWorkspace(req: RunRequest): Promise<string> {
    const key = req.idempotency_key;
    const wsBody: Record<string, unknown> = {};
    if (req.folders && req.folders.length > 1) wsBody.folders = req.folders;
    else if (req.folder_ref) wsBody.folder_ref = req.folder_ref;
    else if (req.folder) wsBody.folder = req.folder;
    if (req.machine) wsBody.machine = req.machine;
    // Sent explicitly, both ways, so the record carries the person's choice.
    wsBody.sandbox = req.sandbox !== false;
    if (key) wsBody.idempotency_key = key;
    const ws = await this.send<{ workspace: string }>('POST', '/api/v0/workspaces', wsBody);
    return ws.workspace;
  }

  // POST /api/v0/sessions then POST /api/v0/turns in a workspace already made:
  // the name goes on the session, the first message on its turn. The folder is
  // not re-checked -- createWorkspace did that.
  async startInWorkspace(workspace: string, req: RunRequest): Promise<Started> {
    const key = req.idempotency_key;
    const sBody: Record<string, unknown> = { workspace };
    if (req.title) sBody.title = req.title;
    if (key) sBody.idempotency_key = key;
    const session = await this.send<{ session: string }>('POST', '/api/v0/sessions', sBody);

    const tBody: Record<string, unknown> = { session: session.session, agent: req.agent, prompt: req.prompt };
    if (req.model) tBody.model = req.model;
    if (key) tBody.idempotency_key = key;
    return this.post('/api/v0/turns', tBody);
  }

  // A new session with a first message is three calls in order, each noun
  // created by its own POST (his API rules, 2026-11-21): workspace -> session
  // -> turn. The turn carries no folder or mode; its workspace owns them. One
  // idempotency_key covers all three (kept apart by noun on the service), so a
  // retry reuses the same workspace, session and turn instead of making new
  // ones. 202 {session, turn, state} from the turn. A session opened empty
  // instead makes the workspace up front (createWorkspace) and these last two
  // when its first message is sent (startInWorkspace).
  async startRun(req: RunRequest): Promise<Started> {
    const workspace = await this.createWorkspace(req);
    return this.startInWorkspace(workspace, req);
  }

  // POST /api/v0/turns with session: the next turn of a session, in its own
  // folder, on the saved agent req.agent names (the service requires one). 202
  // {session, turn, state}, with state queued and ahead when it waits behind
  // the session's running turn; 404 for an unknown session; 409 when the
  // session cannot be continued from here.
  async sendMessage(
    sessionId: string,
    req: { prompt: string; model?: string; agent?: string; idempotency_key?: string }
  ): Promise<Started> {
    const body: Record<string, unknown> = { session: sessionId, prompt: req.prompt };
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

  // GET /api/v0/turns/<id>/diff: the turn's summary (counts, cost, apply).
  async getTurnDiff(sessionId: string, turnId: string): Promise<TurnDiff> {
    const res = await fetch(
      `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/diff?session=${encodeURIComponent(sessionId)}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // GET /api/v0/turns/<id>/changes: a page of the turn's changed files. before
  // is the previous page's next_before; absent for the newest page.
  async getTurnChanges(sessionId: string, turnId: string, before?: number): Promise<TurnChangesPage> {
    const q = new URLSearchParams({ session: sessionId });
    if (before != null) q.set('before', String(before));
    const res = await fetch(
      `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/changes?${q.toString()}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // GET /api/v0/turns/<id>/context: the turn's context size, cache split and
  // what its largest prompt was made of. Read from the record, nothing stored.
  async getTurnContext(sessionId: string, turnId: string): Promise<TurnContext> {
    const res = await fetch(
      `${this.baseUrl}/api/v0/turns/${encodeURIComponent(turnId)}/context?session=${encodeURIComponent(sessionId)}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // GET /api/v0/sessions/<id>/context: the session's token totals and a page of
  // its turns, newest first, so the context's growth is visible. before is the
  // previous page's next_before; absent for the newest page.
  async getSessionContext(sessionId: string, before?: number): Promise<SessionContext> {
    const q = new URLSearchParams();
    if (before != null) q.set('before', String(before));
    const qs = q.toString();
    const res = await fetch(
      `${this.baseUrl}/api/v0/sessions/${encodeURIComponent(sessionId)}/context${qs ? `?${qs}` : ''}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // GET /api/v0/workspaces/<id>: the workspace's record, its folders.
  async getWorkspace(workspace: string): Promise<WorkspaceInfo> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  // GET /api/v0/workspaces: every workspace, newest first. null on a service
  // without the route (404).
  async listWorkspaces(): Promise<WorkspaceRow[] | null> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiError(res));
    const body = await res.json();
    return Array.isArray(body?.workspaces) ? body.workspaces : [];
  }

  // POST /api/v0/workspaces/<id>/close: removes the workspace's copy. 200
  // closed, 202 still waiting behind a turn. A 409 (another apply, discard,
  // update or close in flight) and every other refusal reject with the API's
  // words.
  async closeWorkspace(workspace: string): Promise<CloseState> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}/close`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.ok) return res.json().catch(() => ({}));
    throw new Error(await apiError(res));
  }

  // GET /api/v0/workspaces/<id>/changes: the apply preview, on the session's
  // workspace. The runner answers within 30 s. A machine that is offline or
  // does not answer is said plainly; other refusals are in the API's words.
  async getWorkspaceChanges(workspace: string, fresh?: boolean): Promise<ApplyPreview> {
    const path = `${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}/changes`;
    const q = new URLSearchParams({ limit: '1000' });
    if (fresh) q.set('fresh', 'true');
    const res = await fetch(`${path}?${q.toString()}`, { headers: this.headers() });
    if (!res.ok) {
      if (res.status === 503) throw new Error('The machine with this folder is offline.');
      if (res.status === 504) throw new Error('The machine with this folder did not answer in 30 seconds.');
      throw new Error(await apiError(res));
    }
    const preview: ApplyPreview = await res.json();
    // Page the rest of the stored preview's files, pinned to its event so every
    // page is of the same snapshot, until next_before is null. Without this the
    // files after the first page -- which the record kept -- never reach the
    // panel. A page that fails leaves what was read; the panel's "more not
    // listed" line still names the remainder.
    const files = [...(preview.files || [])];
    let before = preview.next_before;
    // A later page can report the preview stale (the session changed since it
    // was taken, runner offline) even when the first did not: carry that status
    // out, so the panel still shows the out-of-date warning.
    let stale = preview.stale;
    let why = preview.why;
    while (before !== null && before !== undefined && preview.event) {
      const pq = new URLSearchParams({ limit: '1000', event: preview.event, before: String(before) });
      const pr = await fetch(`${path}?${pq.toString()}`, { headers: this.headers() });
      if (!pr.ok) break;
      const page: ApplyPreview = await pr.json();
      files.push(...(page.files || []));
      if (page.stale) {
        stale = true;
        why = page.why ?? why;
      }
      before = page.next_before;
    }
    return { ...preview, files, next_before: null, stale, why };
  }

  // POST /api/v0/workspaces/<id>/apply: writes the workspace's unapplied
  // changes to the person's folder, up to `turn` when given. 200 applied (or
  // already), 202 still running, 409 refused with each file and why. All three
  // are answers; any other status is an error in the API's words.
  async applyWorkspace(workspace: string, turn?: string): Promise<ApplyState> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}/apply`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(turn ? { turn } : {}),
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

  // POST /api/v0/workspaces/<id>/discard: drops the workspace's unapplied
  // changes. 200 with the changes dropped (or already, nothing to drop); 202
  // still running; 409 when a turn or apply is in flight. The conversation
  // stays; dropped_turns names the turns whose file changes went.
  async discardWorkspace(workspace: string): Promise<DiscardState> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}/discard`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.ok) return res.json().catch(() => ({}));
    throw new Error(await apiError(res));
  }

  // POST /api/v0/workspaces/<id>/update: merges the person's folder as it is
  // now into the copy. 200 with state updated (the folder was merged in) or
  // conflict (the files that changed on both sides; nothing changed); 202 still
  // running; 409 when an apply, discard or update is in flight.
  // mode merge leaves both sides in conflicting files for the agent (merged).
  async updateWorkspace(workspace: string, mode?: 'merge'): Promise<UpdateState> {
    const res = await fetch(`${this.baseUrl}/api/v0/workspaces/${encodeURIComponent(workspace)}/update`, {
      method: 'POST',
      ...(mode
        ? { headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }
        : { headers: this.headers() }),
    });
    if (res.ok) return res.json().catch(() => ({}));
    throw new Error(await apiError(res));
  }

  // GET /api/v0/folders: the folders the runners own, by reference.
  async listFolders(): Promise<FolderInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/folders`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    const body = await res.json();
    return Array.isArray(body?.folders) ? body.folders : [];
  }

  // GET /api/v0/runners: the machines control knows, one runner each. null
  // on a service that has no such route (404).
  async listRunners(): Promise<RunnerInfo[] | null> {
    const res = await fetch(`${this.baseUrl}/api/v0/runners`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiError(res));
    const body = await res.json();
    return Array.isArray(body?.runners) ? body.runners : [];
  }

  // GET /api/v0/runners whole: the runners and the machines waiting for
  // approval. null on a service that has no such route (404).
  async readRunners(): Promise<RunnersRead | null> {
    const res = await fetch(`${this.baseUrl}/api/v0/runners`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiError(res));
    const body = await res.json();
    return {
      runners: Array.isArray(body?.runners) ? body.runners : [],
      pending: Array.isArray(body?.pending) ? body.pending : [],
    };
  }

  // POST /api/v0/runners/pending/{id}/approve, with the code the machine shows.
  async approveMachine(id: string, code: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/runners/pending/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // POST /api/v0/runners/pending/{id}/refuse
  async refuseMachine(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/runners/pending/${encodeURIComponent(id)}/refuse`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // POST /api/v0/runners/{id}/remove: an offline runner leaves the list, and
  // its token works no more.
  async removeRunner(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/runners/${encodeURIComponent(id)}/remove`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await apiError(res));
  }

  // GET /api/v0/approvals: the commands waiting for a person.
  async listApprovals(): Promise<HeldApproval[] | null> {
    const res = await fetch(`${this.baseUrl}/api/v0/approvals`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiError(res));
    const data = await res.json();
    return Array.isArray(data.approvals) ? (data.approvals as HeldApproval[]) : [];
  }

  // POST /api/v0/approvals/{id}: once, always or refuse. 409 or 404 means
  // another answer already took it.
  async decideApproval(id: string, decision: ApprovalDecision): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (res.status === 409 || res.status === 404) throw new Error(ApprovalGone);
    if (!res.ok) throw new Error(await apiError(res));
  }

  async getVersion(): Promise<VersionInfo> {
    const res = await fetch(`${this.baseUrl}/api/v0/version`, { headers: this.headers() });
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
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
    onSnapshot?: (sessions: SessionSummary[], cursor?: { store: string; seq: number }) => void,
    onState?: (up: boolean) => void
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
          // Each connection has its own abort, so a silent one is closed and
          // opened again without ending the subscription.
          const conn = new AbortController();
          const stopConn = () => conn.abort();
          signal.addEventListener('abort', stopConn);
          let res: Response;
          try {
            res = await fetch(`${this.baseUrl}/api/v0/events?${params}`, {
              headers: this.headers('text/event-stream'),
              signal: conn.signal,
            });
          } catch (err) {
            signal.removeEventListener('abort', stopConn);
            throw err;
          }
          if (res.status === 409) {
            signal.removeEventListener('abort', stopConn);
            cursor = null; // the next snapshot is handed over with onSnapshot
            // Start over at once; a second 409 in a row waits like a failure.
            resets++;
            if (resets === 1) continue;
            throw new Error('store changed again');
          }
          if (!res.ok || !res.body) {
            signal.removeEventListener('abort', stopConn);
            throw new Error(`Event stream failed: ${res.status}`);
          }
          onState?.(true);
          const c: { store: string; after: number } = cursor;
          // A stream that sends nothing, not even its ping, for idleMs is a
          // connection that is gone without closing (the service restarted
          // behind a proxy, the laptop slept): close it and reconnect.
          let idle: ReturnType<typeof setTimeout> | null = null;
          let silent = false;
          const heard = () => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => {
              silent = true;
              conn.abort();
            }, this.idleMs);
          };
          heard();
          try {
            await readStream(
              res.body,
              (e) => {
                if (typeof e.seq === 'number') c.after = e.seq;
                delay = this.retryBaseMs;
                resets = 0;
                onEvent(e);
              },
              heard,
              conn.signal
            );
          } finally {
            if (idle) clearTimeout(idle);
            signal.removeEventListener('abort', stopConn);
          }
          if (silent) throw new Error(`no data for ${this.idleMs} ms`);
        } catch (err) {
          if (signal.aborted) return;
          console.warn('Event stream interrupted, reconnecting:', err);
        }
        if (signal.aborted) return;
        onState?.(false);
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
// onData, when given, is called for every chunk read, a ping included. An
// abort of `stop` cancels the read, whatever the fetch does with its body.
async function readStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: CockpitEvent) => void,
  onData?: () => void,
  stop?: AbortSignal
) {
  const reader = body.getReader();
  stop?.addEventListener('abort', () => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onData?.();
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
