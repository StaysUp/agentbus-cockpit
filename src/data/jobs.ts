// The turn queue, on the same agentbus API as everything else: one address,
// one token. Every action is on a turn. A prompt is POST /api/v0/turns, which
// names the turn at once, even while it waits. A turn that ended can be
// reviewed by another agent: the review is a turn too, of kind review, in a
// session of its own. A queued or running turn can be stopped. The agentbus
// docs/CLIENT_API.md is the contract.

import { Usage } from '../types';
import type { ApiOrigin } from './turns';

export type QueueState = 'queued' | 'running' | 'finished' | 'failed' | 'stopped';
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface Finding {
  severity: string; // P1, P2 or P3
  file?: string;
  line?: number;
  summary: string;
}

// One turn as GET /api/v0/turns and GET /api/v0/turns/{id} send it.
export interface ApiTurn {
  id: string;
  session: string;
  // Its place in its session, from 1.
  number?: number;
  // turn, or review: a turn that reviews another (reviews names it).
  kind?: 'turn' | 'review';
  reviews?: string;
  // For a review that ended.
  verdict?: Verdict;
  findings?: Finding[];
  agent: string;
  agent_id?: string;
  idempotency_key?: string;
  folder: string;
  folder_ref?: string;
  origin?: ApiOrigin;
  prompt: string;
  prompt_truncated?: boolean;
  reply?: string;
  reply_truncated?: boolean;
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
  unsettled?: boolean;
  error?: string;
  outcome?: string;
  exit_code?: number;
  usage?: Usage | null;
  cost_usd?: number;
  cost_complete?: boolean;
}

export interface ReviewRequest {
  agent: string;
  model?: string;
}

// The answer to POST /api/v0/turns and POST /api/v0/turns/{id}/review.
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
  // Asks another agent to review a turn that ended.
  review(turnId: string, req: ReviewRequest): Promise<QueueStarted>;
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

  review(turnId: string, req: ReviewRequest): Promise<QueueStarted> {
    const body: Record<string, unknown> = { agent: req.agent, idempotency_key: newKey('cockpit-review') };
    if (req.model) body.model = req.model;
    return this.call('POST', `/api/v0/turns/${encodeURIComponent(turnId)}/review`, body);
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
// queue, so a passing error never hides Review: the turn list then shows the
// error. A service with the turns API answers 200 here even when it keeps no
// queue; it then refuses a review with 404, and the bar shows its words.
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

// The words and colour for a turn's state. A review reads its verdict; a
// finished review with no verdict reads as no verdict.
export function outcome(t: ApiTurn): { label: string; cls: string } {
  switch (t.state) {
    case 'queued':
      return { label: 'Queued', cls: 'dim' };
    case 'running':
      return { label: 'Running', cls: 'run' };
    case 'stopped':
      return { label: 'Stopped', cls: 'dim' };
    case 'failed':
      return { label: t.error ? `Failed: ${t.error}` : 'Failed', cls: 'bad' };
    case 'finished':
      if (t.kind !== 'review') return { label: 'Finished', cls: 'ok' };
      if (t.verdict === 'pass') return { label: 'Passed', cls: 'ok' };
      if (t.verdict === 'fail') return { label: 'Failed', cls: 'bad' };
      return { label: 'No verdict', cls: 'warn' };
  }
  return { label: t.state, cls: '' };
}

// Who ran a turn: the saved agent, else the harness, and the model when the
// turn names one. A queued turn may name neither yet.
export function agentLabel(t: ApiTurn): string {
  const who = t.agent_id || t.agent || 'agent';
  return t.model ? `${who} · ${t.model}` : who;
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
