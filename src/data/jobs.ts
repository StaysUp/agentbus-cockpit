import { STATE } from '../words';
// The turn queue, on the same agentbus API as everything else: one address,
// one token. Every action is on a turn. A prompt is POST /api/v0/turns, which
// names the turn at once, even while it waits. A queued or running turn can be
// stopped. agentbus's OpenAPI description (/api/v0/openapi.json) is the
// contract.

import { Usage } from '../types';
import type { ApiOrigin } from './turns';

export type QueueState = 'queued' | 'running' | 'finished' | 'failed' | 'stopped';

// One turn as GET /api/v0/turns and GET /api/v0/turns/{id} send it.
export interface ApiTurn {
  id: string;
  session: string;
  // Its place in its session, from 1.
  number?: number;
  // turn, or review: a turn that reviews another (reviews names it).
  kind?: 'turn' | 'review';
  reviews?: string;
  agent: string;
  agent_id?: string;
  idempotency_key?: string;
  folder: string;
  folder_ref?: string;
  origin?: ApiOrigin;
  // The whole prompt and reply are not on the list: GET /api/v0/turns/{id}
  // serves them, read from the record. The list carries facts only.
  prompt?: string;
  reply?: string;
  model?: string;
  model_calls?: number;
  started_seq?: number;
  // When it was asked for, and when a runner started it. A queued turn has
  // not started.
  asked?: string;
  started?: string;
  ended?: string;
  state: QueueState;
  // For a queued turn: how many of its session's turns are before it.
  ahead?: number;
  stopped?: boolean;
  // True when a Discard dropped this turn's file changes, from the record.
  discarded?: boolean;
  unsettled?: boolean;
  error?: string;
  outcome?: string;
  exit_code?: number;
  usage?: Usage | null;
  cost_usd?: number;
  cost_complete?: boolean;
}

// The answer to POST /api/v0/turns.
export interface QueueStarted {
  session: string;
  turn: string;
  state: 'running' | 'queued';
  ahead?: number;
  existing?: boolean;
  base_url?: string;
}

// What the screens call. One implementation talks to the agentbus API; the
// tests give their own.
export interface QueueSource {
  // The service's address.
  address: string;
  // How often to read the turns again, in ms. Tests set it low.
  pollMs?: number;
  // The newest turns of every session, queued ones first.
  listTurns(): Promise<ApiTurn[]>;
  // Stops a queued or running turn.
  stop(turnId: string): Promise<void>;
}

export const ENDED: ReadonlySet<QueueState> = new Set(['finished', 'failed', 'stopped']);

export function ended(t: { state: string }): boolean {
  return ENDED.has(t.state as QueueState);
}

// A key the API takes as idempotency_key: a retry of the same click makes
// no second turn.
export function newKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

// How many turns one read of the queue asks for.
export const LIST_LIMIT = 200;

export class TurnsClient implements QueueSource {
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

  async listTurns(): Promise<ApiTurn[]> {
    const data = await this.call<{ turns?: ApiTurn[] }>('GET', `/api/v0/turns?limit=${LIST_LIMIT}`);
    return Array.isArray(data.turns) ? data.turns : [];
  }

  async stop(turnId: string): Promise<void> {
    await this.call('POST', `/api/v0/turns/${encodeURIComponent(turnId)}/stop`);
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

// Whether the service keeps a turn queue, read from GET /api/v0/turns. Only
// a 404 says it does not. Any other answer, a failure included, counts as a
// queue, so a passing error never hides the turn list: it then shows the
// error.
export async function probeQueue(address: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${address}/api/v0/turns?limit=1`, {
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

// The words and colour for a turn's state.
export function outcome(t: ApiTurn): { label: string; cls: string } {
  switch (t.state) {
    case 'queued':
      return { label: STATE.queued, cls: 'dim' };
    case 'running':
      return { label: STATE.running, cls: 'run' };
    case 'stopped':
      return { label: STATE.stopped, cls: 'dim' };
    case 'failed':
      return { label: t.error ? `${STATE.failed} · ${t.error}` : STATE.failed, cls: 'bad' };
    case 'finished':
      return { label: STATE.finished, cls: 'ok' };
  }
  return { label: t.state, cls: '' };
}

// Who ran a turn: the saved agent, else the harness, and the model when the
// turn names one. A queued turn may name neither yet.
export function agentLabel(t: ApiTurn): string {
  const who = t.agent_id || t.agent || 'agent';
  return t.model ? `${who} · ${t.model}` : who;
}

// m:ss from milliseconds.
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// How long the turn waited to start, and how long it ran (so far, while it
// runs). Undefined when it has not reached that point.
export function turnTimes(t: ApiTurn, now: number): { waitedMs?: number; ranMs?: number } {
  const ms = (s?: string) => (s ? new Date(s).getTime() : NaN);
  const out: { waitedMs?: number; ranMs?: number } = {};
  const asked = ms(t.asked);
  const started = t.state === 'queued' ? NaN : ms(t.started);
  if (!isNaN(asked) && !isNaN(started)) out.waitedMs = Math.max(0, started - asked);
  else if (t.state === 'queued' && !isNaN(asked)) out.waitedMs = Math.max(0, now - asked);
  if (!isNaN(started)) {
    const end = ms(t.ended);
    out.ranMs = Math.max(0, (isNaN(end) ? now : end) - started);
  }
  return out;
}
