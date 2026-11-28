// @vitest-environment jsdom
// Starting sessions and continuing them from the cockpit, against a fake
// client API (GET /agents, POST /turns, with session for a next turn).
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { TOO_LATE } from '../components/ConvoColumn';
import { checkConnection } from '../data/connection';
import { LiveDataSource } from '../data/LiveDataSource';
import { buildTurns } from '../data/turns';
import { CockpitEvent } from '../types';
import { choose as chooseOpt, click, continuedLine, ev, flush, optionsOf, panelOpen, render, rowSession, selectIn, shownSession } from './helpers';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function row(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    agent: 'claude',
    folder: '/w',
    started: '2026-11-05T09:00:00Z',
    last: '2026-11-05T09:10:00Z',
    open: false,
    turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...fields,
  };
}

function oneTurn(session: string, prompt: string, n = 1): CockpitEvent[] {
  const t = `T${n}-${session}`;
  return [
    ev({ session, kind: 'turn.started', turn: t, exchange: `x${n}`, text: prompt }),
    ev({ session, kind: 'model.requested', turn: t, exchange: `x${n}` }),
    ev({ session, kind: 'model.responded', turn: t, exchange: `x${n}`, status: 200, text: 'ok', stop_reason: 'end_turn' }),
    ev({ session, kind: 'turn.completed', turn: t, exchange: `x${n}`, outcome: 'finished' }),
  ];
}

// The idempotency_key of the last message the cockpit sent: its turn's
// turn.started carries it, as the service stores it.
function sentKey(svc: { reqs: Req[] }): string {
  const posts = svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/turns');
  return (posts[posts.length - 1]?.body as { idempotency_key?: string } | undefined)?.idempotency_key ?? '';
}

// The body of the last POST /api/v0/turns.
function sentBody(svc: { reqs: Req[] }): unknown {
  const posts = svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/turns');
  return posts[posts.length - 1]?.body;
}

// The body of the last POST /api/v0/workspaces and POST /api/v0/sessions: the
// first two of the three calls a new session makes.
function workspaceBody(svc: { reqs: Req[] }): unknown {
  const posts = svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/workspaces');
  return posts[posts.length - 1]?.body;
}
function sessionBody(svc: { reqs: Req[] }): unknown {
  const posts = svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/sessions');
  return posts[posts.length - 1]?.body;
}

// GET /api/v0/turns rows for one session's events, newest first: the
// service's own rules, as the replay source applies them.
function apiTurns(events: CockpitEvent[]) {
  const session = events[0]?.session ?? '';
  return buildTurns(session, events)
    .filter((t) => t.detail!.events.some((e) => e.kind === 'turn.started'))
    .map((t) => ({
      id: t.id,
      session,
      agent: t.agent ?? '',
      folder: t.folder ?? '',
      model: t.model,
      model_calls: t.modelCalls,
      idempotency_key: t.detail!.events.find((e) => e.kind === 'turn.started')?.idempotency_key,
      started_seq: t.startedSeq!,
      started: t.startedAt,
      ended: t.endedAt,
      state: t.state,
      outcome: t.outcome,
      usage: t.usage,
      cost_usd: t.costUsd ?? 0,
      cost_complete: t.costComplete,
    }))
    .reverse();
}

interface Req {
  method: string;
  path: string;
  query?: string;
  body: unknown;
}

// A fake service. `sessions` and `events` can be changed during a test; the
// stream sends whatever push() is given.
function fakeService(opts: {
  sessions: ReturnType<typeof row>[];
  events?: Record<string, CockpitEvent[]>;
  // GET /harnesses. GET /agents lists `saved`, and POST, PUT and DELETE
  // under /agents change it.
  agents?: unknown[];
  saved?: Record<string, unknown>[];
  // POST /turns for a new session's first turn (its session is 'new1').
  runs?: (body: unknown) => Response | Promise<Response>;
  // POST /workspaces: the first of the three calls. Without it, a workspace
  // ws_new1 is made from the body.
  workspaces?: (body: unknown) => Response | Promise<Response>;
  // POST /sessions: the second call. Without it, session 'new1' is made.
  makeSession?: (body: { workspace?: string; title?: string }) => Response | Promise<Response>;
  // POST /turns with session: a session's next turn.
  messages?: (id: string, body: unknown) => Response | Promise<Response>;
  // POST /turns/<id>/stop. Without it the service answers 404.
  stop?: (turn: string) => Response | Promise<Response>;
  // Turns per page of GET /turns.
  turnPage?: number;
  // PATCH /sessions/<id>: a rename. Without it the row's title changes.
  rename?: (id: string, body: unknown) => Response | Promise<Response>;
  // GET /folders. Without it the service has no such path (404).
  folders?: unknown[];
  // GET /runners: the machines, one runner each. Without it, 404.
  runners?: unknown[];
  // GET /sessions/<id>. Without it the service answers 404.
  oneSession?: (id: string) => Response;
  // Fields added to a turn's GET /turns row, by turn id.
  turnFields?: Record<string, Record<string, unknown>>;
}) {
  const reqs: Req[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let seq = 100;
  const state: { sessions: typeof opts.sessions; events: Record<string, CockpitEvent[]>; saved: Record<string, unknown>[] } = {
    sessions: opts.sessions,
    events: opts.events ?? {},
    saved: opts.saved ?? SAVED.map((a) => ({ ...a })),
  };
  // Stored events have a seq: number the ones the test gave in order.
  let stored = 0;
  for (const list of Object.values(state.events)) for (const e of list) e.seq ??= ++stored;
  // As a real store's, a later event's seq is above every stored one.
  seq = Math.max(seq, stored);
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    reqs.push({ method, path: url.pathname, query: url.search, body });
    const p = url.pathname;
    if (p === '/api/v0/sessions' && method === 'GET') return json({ store: 'st_1', seq, sessions: state.sessions });
    if (p === '/api/v0/harnesses') return json({ harnesses: opts.agents ?? [] });
    if (p === '/api/v0/folders' && opts.folders) return json({ folders: opts.folders });
    if (p === '/api/v0/runners' && opts.runners) return json({ runners: opts.runners });
    if (p === '/api/v0/agents' && method === 'GET') return json({ agents: state.saved });
    if (p === '/api/v0/agents' && method === 'POST') {
      const f = body as Record<string, unknown>;
      if (state.saved.some((a) => String(a.name).toLowerCase() === String(f.name).toLowerCase()))
        return json({ error: `an agent named "${f.name}" already exists` }, 400);
      const made = { id: `a_${state.saved.length + 1}`, ...f };
      state.saved.push(made);
      return json(made, 201);
    }
    const am = p.match(/^\/api\/v0\/agents\/([^/]+)$/);
    if (am && method === 'PUT') {
      const i = state.saved.findIndex((a) => a.id === am[1]);
      state.saved[i] = { id: am[1], ...(body as object) };
      return json(state.saved[i]);
    }
    if (am && method === 'DELETE') {
      state.saved = state.saved.filter((a) => a.id !== am[1]);
      return new Response(null, { status: 204 });
    }
    const sm = p.match(/^\/api\/v0\/sessions\/([^/]+)$/);
    if (sm && method === 'GET' && opts.oneSession) return opts.oneSession(sm[1]);
    if (sm && method === 'PATCH') {
      if (opts.rename) return opts.rename(sm[1], body);
      const title = (body as { title: string }).title;
      state.sessions = state.sessions.map((x) => (x.id === sm[1] ? { ...x, title } : x));
      return json({ seq: ++seq, id: 'evt_r', title });
    }
    const session = (body as { session?: string } | undefined)?.session;
    if (p === '/api/v0/runs') return json({ error: 'no such API path' }, 404);
    // A new session is three calls: POST /workspaces, POST /sessions, then
    // POST /turns with the created session. The workspace owns the folder and
    // the mode; the first turn of a fresh session names 'new1'.
    if (p === '/api/v0/workspaces' && method === 'POST') {
      if (opts.workspaces) return opts.workspaces(body);
      const b = body as { folder?: string; folder_ref?: string; machine?: string; sandbox?: boolean };
      return json({ workspace: 'ws_new1', folder: b.folder, folder_ref: b.folder_ref, machine: b.machine, sandbox: b.sandbox !== false }, 201);
    }
    if (p === '/api/v0/sessions' && method === 'POST') {
      const b = body as { workspace?: string; title?: string };
      return opts.makeSession ? opts.makeSession(b) : json({ session: 'new1', workspace: b.workspace, title: b.title }, 201);
    }
    const stopAt = /^\/api\/v0\/turns\/([^/]+)\/stop$/.exec(p);
    if (stopAt && method === 'POST' && opts.stop) return opts.stop(decodeURIComponent(stopAt[1]));
    if (p === '/api/v0/turns' && method === 'POST') {
      // The freshly created session is 'new1'; its first turn is 'Tn'. An
      // existing session's next turn is 'Tnext' (or the messages hook).
      const isFirst = session === 'new1';
      if (isFirst && opts.runs) return opts.runs(body);
      if (!isFirst && opts.messages) return opts.messages(session!, body);
      const turn = isFirst ? 'Tn' : 'Tnext';
      return json({ session, turn, state: 'running', base_url: `${BASE}/s/${session}/t/${turn}` }, 202);
    }
    if (p === '/api/v0/turns' && method === 'GET') {
      // Newest first, opts.turnPage turns a page, paged by before.
      const all = apiTurns(state.events[url.searchParams.get('session') ?? ''] ?? []).map((t) => ({ ...t, ...opts.turnFields?.[t.id] }));
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const older = all.filter((t) => t.started_seq < before);
      const page = older.slice(0, opts.turnPage ?? 100);
      const more = older.length > page.length;
      return json({ store: 'st_1', seq, turns: page, next_before: more ? page[page.length - 1].started_seq : null });
    }
    // GET /api/v0/turns/<id>: the single turn, with its whole prompt and reply
    // (the list carries neither). The cockpit loads each shown turn's text here.
    const tm = p.match(/^\/api\/v0\/turns\/([^/]+)$/);
    if (tm && method === 'GET') {
      const turnId = tm[1];
      const named = url.searchParams.get('session');
      for (const s of named ? [named] : Object.keys(state.events)) {
        const t = buildTurns(s, state.events[s] ?? []).find((x) => x.id === turnId);
        if (t) {
          return json({
            store: 'st_1',
            seq,
            turn: {
              id: t.id,
              session: s,
              state: t.state,
              started_seq: t.startedSeq,
              prompt: t.detail!.rawPrompt ?? '',
              reply: t.detail!.agentResponse,
              model: t.model,
              model_calls: t.modelCalls,
              ...opts.turnFields?.[t.id],
            },
          });
        }
      }
      return json({ error: 'no such turn' }, 404);
    }
    const m = p.match(/^\/api\/v0\/sessions\/([^/]+)\/events$/);
    if (m && method === 'GET' && url.searchParams.has('turn')) {
      const turn = url.searchParams.get('turn')!;
      const list = Object.values(state.events).flat().filter((e) => e.turn === turn);
      return json({ store: 'st_1', events: list, next_after: null });
    }
    if (p === '/api/v0/events') {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streams.push(c);
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ error: 'not found' }, 404);
  });
  const push = async (e: CockpitEvent) => {
    e.seq = ++seq;
    const list = (state.events[e.session] ??= []);
    list.push(e);
    await act(async () => {
      for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    });
  };
  // Streams an event as it is, seq and all, without storing it.
  const send = async (e: CockpitEvent) => {
    await act(async () => {
      for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    });
  };
  return { fn, reqs, push, send, state };
}

async function settle() {
  for (let i = 0; i < 6; i++) await flush();
}

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(form: Element | null) {
  if (!form) throw new Error('no form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function mount(svc: ReturnType<typeof fakeService>) {
  vi.stubGlobal('fetch', svc.fn);
  const r = await render(<App dataSource={new LiveDataSource({ baseUrl: BASE, token: 't' })} />);
  await settle();
  return r;
}

const ACCESS = (subModels: string[]) => [
  { kind: 'subscription', label: 'Subscription', models: subModels },
  { kind: 'openrouter', label: 'OpenRouter key', models: ['deepseek/deepseek-v4.1-flash'], any_model: true, key_env: 'OPENROUTER_API_KEY' },
  { kind: 'api', label: 'API key', disabled: true, models: [] },
];
const AGENTS = [
  { name: 'claude', label: 'Claude Code', found: true, version: '2.1.318', signed_in: true, access: ACCESS(['sonnet', 'opus', 'haiku']) },
  { name: 'codex', label: 'Codex', found: false, access: ACCESS(['gpt-5.5']) },
  { name: 'opencode', label: 'opencode', disabled: true, found: false, access: [] },
];
const SAVED = [
  { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' },
  { id: 'codex', name: 'Codex', harness: 'codex', access: 'subscription' },
];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('New session', () => {
  it('the dialog lists the saved agents and disables the ones whose harness is not installed', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(dialog).not.toBeNull();
    const options = await optionsOf(dialog, 'agent');
    expect(options.map((o) => o[0])).toEqual(['claude', 'codex']);
    expect(options[0][2]).toBe(false);
    expect(options[1][2]).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // An agent and a folder, then an optional name and first message.
    expect(Array.from(dialog.querySelectorAll('input, [role="combobox"], textarea')).map((e) => e.getAttribute('name'))).toEqual(['agent', 'folder', 'name', 'prompt']);
    // No browser-drawn select anywhere in the dialog.
    expect(dialog.querySelector('select')).toBeNull();
    expect(dialog.textContent).toContain('Claude Code · default model · subscription');
    r.unmount();
  });

  it('submit posts /turns with the body, remembers the folder, and selects the new session when it streams in', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);

    // The three calls, in order: the folder and mode on the workspace, the
    // workspace on the session, the message on the turn. The turn carries no
    // folder or mode.
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: true });
    expect(sessionBody(svc)).toEqual({ workspace: 'ws_new1' });
    const run = svc.reqs.find((q) => q.path === '/api/v0/turns' && q.method === 'POST');
    expect(run?.method).toBe('POST');
    expect(run?.body).toEqual({ session: 'new1', agent: 'claude', prompt: 'read the README' });
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/x']);
    // Recent folders and the remembered Sandbox choice: nothing else is kept.
    expect(Object.keys(localStorage).sort()).toEqual(['agentbus.folders', 'agentbus.sandbox']);
    expect(localStorage.getItem('agentbus.sandbox')).toBe('1');

    // The new session appears in the stream; the cockpit selects it.
    svc.state.sessions = [row('new1', { open: true, resumable: false, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'session.registered', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', exchange: 'xn', text: 'read the README' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe('new1');
    expect(r.container.querySelector('.tb .bubble')?.textContent).toBe('read the README');
    r.unmount();
  });

  it('a queued first message shows in the new session at once, and stays until its turn starts', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runs: () => json({ session: 'new1', turn: 'Tq', state: 'queued', ahead: 0 }, 202),
    });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'fix the build');
    await submitForm(dialog);
    await settle();
    // Not listed yet, no turn started: the message is already there, queued.
    const queued = () => r.container.querySelector('#convo .tb.pending.queued');
    expect(queued()?.querySelector('.bubble')?.textContent).toBe('fix the build');
    // The session is listed; its turn is still queued (left out of the turn
    // list): the same message stays, queued.
    svc.state.sessions = [row('new1', { open: true, resumable: true, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'session.registered', agent: 'claude', folder: '/Users/ana/x' }));
    await settle();
    expect(r.container.querySelector('#convo')?.getAttribute('data-session')).toBe('new1');
    expect(queued()?.querySelector('.bubble')?.textContent).toBe('fix the build');
    // Its turn starts: the turn shows the message, and the queued copy goes.
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tq', exchange: 'xq', text: 'fix the build' }));
    await settle();
    expect(queued()).toBeNull();
    expect([...r.container.querySelectorAll('#convo .bubble')].map((b) => b.textContent)).toEqual(['fix the build']);
    r.unmount();
  });

  it('on a service that lists folders, none is picked for the person; the one picked goes by folder_ref and connector', async () => {
    const folders = [
      { ref: 'fld_00000000000000a1', name: 'app', machine: 'con_1', runner: 'run_1' },
      { ref: 'fld_00000000000000b2', name: 'site', machine: 'con_2', runner: 'run_2' },
    ];
    localStorage.setItem('agentbus.folders', JSON.stringify(['/Users/ana/old']));
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const picks = Array.from(dialog.querySelectorAll('.nd-recent button')) as HTMLButtonElement[];
    expect(picks.map((b) => b.textContent)).toEqual(['app', 'site', '/Users/ana/old']);
    // Nothing is picked until the person picks. Start with no folder says
    // which field is missing, and starts nothing.
    expect(dialog.querySelector('.nd-recent button.on')).toBeNull();
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('');
    expect(dialog.textContent).not.toContain('Pick a folder to start.');
    await click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(dialog.querySelector('.nd-missing')?.textContent).toBe('Pick a folder to start.');
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    await click(picks[1]);
    expect(picks[1].classList.contains('on')).toBe(true);
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    // A listed folder goes by its reference and machine, on the workspace.
    expect(workspaceBody(svc)).toEqual({ folder_ref: 'fld_00000000000000b2', machine: 'con_2', sandbox: true });
    expect(sentBody(svc)).toEqual({ session: 'new1', agent: 'claude', prompt: 'read the README' });
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    // A folder by reference is not a path to remember.
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/old']);
    r.unmount();
  });

  it('a path typed over a listed folder is sent as a path', async () => {
    const folders = [{ ref: 'fld_00000000000000a1', name: 'app', machine: 'con_1' }];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    expect(dialog.querySelector('.nd-recent button.on')).toBeNull();
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: true });
    expect(sentBody(svc)).toEqual({ session: 'new1', agent: 'claude', prompt: 'x' });
    r.unmount();
  });

  it('a refused run shows the API message and keeps the dialog open', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runs: () => json({ error: 'no saved agent named claude' }, 400),
    });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/nope');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(r.container.querySelector('.new-dialog .form-error')?.textContent).toBe('no saved agent named claude');
    expect(localStorage.getItem('agentbus.folders')).toBeNull();
    r.unmount();
  });

  it('with no sessions, the column shows a short line and + Session; the chat says the first step', async () => {
    const svc = fakeService({ sessions: [], agents: AGENTS });
    const r = await mount(svc);
    expect(r.container.querySelector('#sessions .empty')?.textContent).toBe('No sessions yet.');
    expect(r.container.querySelector('#sessions .colhead button.new-session')).not.toBeNull();
    expect(r.container.querySelector('#convo')!.textContent).toContain('Start one with + Session.');
    r.unmount();
  });

  it('with no agent saved, + Session waits and the chat says to add one first', async () => {
    const svc = fakeService({ sessions: [], agents: AGENTS, saved: [] });
    const r = await mount(svc);
    expect(r.container.querySelector('#sessions button.new-session')).toBeNull();
    expect(r.container.querySelector('#convo')!.textContent).toContain('First add an agent with + Agent. Then start a session.');
    r.unmount();
  });
});

describe('The mode selector', () => {
  const mode = (dialog: Element, v: string) => dialog.querySelector(`[data-mode="${v}"]`) as HTMLButtonElement;

  it('defaults to Copy, so the workspace is created as a sandbox', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(mode(dialog, 'copy').getAttribute('aria-checked')).toBe('true');
    expect(mode(dialog, 'direct').getAttribute('aria-checked')).toBe('false');
    // Locked is shown but cannot be picked yet.
    expect(mode(dialog, 'locked').disabled).toBe(true);
    expect(mode(dialog, 'locked').getAttribute('title')).toContain('Coming later');
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: true });
    r.unmount();
  });

  it('Direct creates a direct workspace and remembers the choice for next time', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await click(mode(dialog, 'direct'));
    expect(mode(dialog, 'direct').getAttribute('aria-checked')).toBe('true');
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: false });
    expect(localStorage.getItem('agentbus.sandbox')).toBe('0');
    r.unmount();
  });

  it('starts from the remembered choice', async () => {
    localStorage.setItem('agentbus.sandbox', '0');
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    expect(mode(r.container.querySelector('.new-dialog')!, 'direct').getAttribute('aria-checked')).toBe('true');
    r.unmount();
  });
});

describe('The Sandbox mark', () => {
  it('a sandbox session carries the Sandbox shield in its row; a direct one does not', async () => {
    const svc = fakeService({
      sessions: [row('box', { sandbox: true }), row('plain', { sandbox: false, last: '2026-11-05T09:01:00Z' })],
      events: { box: oneTurn('box', 'hi'), plain: oneTurn('plain', 'hi') },
      agents: AGENTS,
    });
    const r = await mount(svc);
    const rowOf = (id: string) => Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => rowSession(b) === id)!;
    expect(rowOf('box').querySelector('.s-sandbox[aria-label="Sandbox"]')).not.toBeNull();
    expect(rowOf('plain').querySelector('.s-sandbox')).toBeNull();
    r.unmount();
  });
});

describe('The Discarded mark', () => {
  const marks = (r: { container: HTMLElement }) =>
    Array.from(r.container.querySelectorAll('#convo .tb-discarded')).map((e) => e.textContent);

  it('marks a turn the record says a discard dropped', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { discarded: true } },
    });
    const r = await mount(svc);
    expect(marks(r)).toEqual(['Discarded']);
    r.unmount();
  });

  it('marks a turn when a workspace.discarded event names it, live', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true })], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    expect(marks(r)).toEqual([]);
    await svc.push(ev({ session: 's1', kind: 'workspace.discarded', discarded: { dropped_turns: ['T1-s1'] } }));
    await settle();
    expect(marks(r)).toEqual(['Discarded']);
    r.unmount();
  });
});

describe('The started turn', () => {
  // POST /turns names the turn it starts; the cockpit selects that turn,
  // not just its session, once the turn is on screen.
  it('starting a session selects its turn when it arrives', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    // The panel is open, so the selection shows.
    await click(r.container.querySelector('#convo .tb'));
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);

    svc.state.sessions = [row('new1', { open: true, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'run.started', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', text: 'read the README' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe('new1');
    const marked = r.container.querySelector('#convo .tb.lvl-sel');
    expect(marked?.querySelector('.bubble')?.textContent).toBe('read the README');
    expect(r.container.querySelectorAll('#convo .lvl-sel')).toHaveLength(1);
    r.unmount();
  });

  // Only a click on a turn or a call opens the panel; a turn that arrives does not.
  it('a started turn arriving leaves a closed panel closed', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    expect(panelOpen(r.container)).toBe(false);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    svc.state.sessions = [row('new1', { open: true, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'run.started', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', text: 'read the README' }));
    await settle();
    expect(shownSession(r.container)).toBe('new1');
    expect(panelOpen(r.container)).toBe(false);
    expect(r.container.querySelectorAll('#convo .lvl-sel')).toHaveLength(0);
    r.unmount();
  });

  it('sending a message selects the new turn when it arrives', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true })], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    // Opened on the session panel, so selecting the turn is a change.
    await click(r.container.querySelector('#convo .tb'));
    await click(r.container.querySelector('#p-head .crumb'));
    expect(r.container.querySelector('#convo .tb.lvl-sel')).toBeNull();
    await setValue(r.container.querySelector('#c-reply textarea'), 'and now the tests');
    await submitForm(r.container.querySelector('#c-reply form'));
    // Not yet arrived: nothing is selected for it.
    expect(r.container.querySelector('#convo .tb.lvl-sel')).toBeNull();

    await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'Tnext', text: 'and now the tests' }));
    await settle();
    const marked = r.container.querySelector('#convo .tb.lvl-sel');
    expect(marked?.querySelector('.bubble')?.textContent).toBe('and now the tests');
    r.unmount();
  });

  // Send in A, switch to B, send again; B's
  // reply lands first, then A's, then B's turn streams in. A's late reply must
  // not take the selection from B's turn.
  it('a late reply from a session left behind does not take the selection', async () => {
    const replies: Record<string, (r: Response) => void> = {};
    const svc = fakeService({
      sessions: [row('A', { resumable: true }), row('B', { resumable: true, last: '2026-11-05T09:05:00Z' })],
      events: { A: oneTurn('A', 'first in A'), B: oneTurn('B', 'first in B') },
      messages: (id) => new Promise<Response>((resolve) => (replies[id] = resolve)),
    });
    const r = await mount(svc);
    // Open the panel so the selected turn is marked.
    await click(r.container.querySelector('#convo .tb'));
    const pick = async (id: string) => {
      const rowEl = Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => rowSession(b) === id);
      // The selected card is not a button; picking it again changes nothing.
      if (rowEl && !rowEl.classList.contains('on')) await click(rowEl);
      await settle();
    };
    const send = async (text: string) => {
      await setValue(r.container.querySelector('#c-reply textarea'), text);
      await submitForm(r.container.querySelector('#c-reply form'));
    };
    await pick('A');
    await send('second in A');
    await pick('B');
    expect(shownSession(r.container)).toBe('B');
    await send('second in B');
    await act(async () => replies.B(json({ session: 'B', turn: 'TB2', state: 'running', base_url: `${BASE}/s/B/t/TB2` }, 202)));
    await settle();
    await act(async () => replies.A(json({ session: 'A', turn: 'TA2', state: 'running', base_url: `${BASE}/s/A/t/TA2` }, 202)));
    await settle();
    await svc.push(ev({ session: 'B', kind: 'turn.started', turn: 'TB2', text: 'second in B' }));
    await settle();
    const marked = r.container.querySelector('#convo .tb.lvl-sel');
    expect(marked?.querySelector('.bubble')?.textContent).toBe('second in B');
    r.unmount();
  });

  // A start whose reply lands after the person picked another session must
  // not pull them to the new session when it is listed. A pick of an agent
  // changes no session, so the new session is still opened.
  for (const how of ['session', 'agent'] as const) {
    it(`a start whose reply lands after a pick of another ${how} ${how === 'session' ? 'leaves the selection where it was put' : 'still opens the new session'}`, async () => {
      let reply: ((r: Response) => void) | null = null;
      const svc = fakeService({
        sessions: [row('s1'), row('s2', { agent: 'codex', last: '2026-11-05T09:05:00Z' }), row('s3', { last: '2026-11-05T09:01:00Z' })],
        events: { s1: oneTurn('s1', 'one'), s2: oneTurn('s2', 'two'), s3: oneTurn('s3', 'three') },
        agents: AGENTS,
        runs: () => new Promise<Response>((resolve) => (reply = resolve)),
      });
      const r = await mount(svc);
      await click(r.container.querySelector('#sessions button.new-session'));
      await settle();
      const dialog = r.container.querySelector('.new-dialog')!;
      await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
      await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
      await submitForm(dialog);

      // Before the reply, the person picks something else.
      let want: string;
      if (how === 'session') {
        const other = Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => rowSession(b) === 's3');
        await click(other ?? null);
        want = 's3';
      } else {
        const codex = Array.from(r.container.querySelectorAll('#agents .agent, .side-chat.agent')).find(
          (b) => b.querySelector('b')?.textContent?.toLowerCase().includes('codex')
        );
        await click(codex ?? null);
        want = 's1';
      }
      await settle();
      expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe(want);
      if (how === 'agent') want = 'new1';

      // The reply lands, and the new session is listed.
      await act(async () => reply!(json({ session: 'new1', turn: 'Tn', state: 'running', base_url: `${BASE}/s/new1/t/Tn` }, 202)));
      await settle();
      svc.state.sessions = [row('new1', { open: true, last: '2026-11-05T10:00:00Z' }), ...svc.state.sessions];
      await svc.push(ev({ session: 'new1', kind: 'run.started', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
      await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', text: 'go' }));
      await settle();
      expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe(want);
      expect(shownSession(r.container)).toBe(want);
      r.unmount();
    });
  }

  it('a turn whose agent exited 1 shows failed, as the turn list says, and the box takes a message again', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true })], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    await setValue(r.container.querySelector('#c-reply textarea'), 'go');
    await submitForm(r.container.querySelector('#c-reply form'));
    await svc.push(ev({ session: 's1', kind: 'run.started', hold: 'h2', turn: 'Tnext' }));
    await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'Tnext', text: 'go', idempotency_key: sentKey(svc) }));
    await settle();
    // A running turn never blocks the box: a message would queue behind it.
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    // The agent exits 1 before any model call: the turn is over.
    await svc.push(ev({ session: 's1', kind: 'run.ended', hold: 'h2', turn: 'Tnext', exit_code: 1 }));
    await settle();
    const states = Array.from(r.container.querySelectorAll('#convo .tb')).map((t) => t.querySelector('.tb-state')?.textContent ?? '');
    expect(states).toEqual(['', 'failed']);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    r.unmount();
  });
});

describe('New session: name, no first message, folders', () => {
  const patches = (svc: { reqs: Req[] }) => svc.reqs.filter((q) => q.method === 'PATCH');
  const posts = (svc: { reqs: Req[] }) => svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/turns');
  async function openDialog(svc: ReturnType<typeof fakeService>) {
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    return { r, dialog: r.container.querySelector('.new-dialog')! };
  }

  it('a name given with a first message names the session right after it starts', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('input[name="name"]'), '  Login fix ');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    await settle();
    // The name goes on the session (POST /sessions), its own noun; no PATCH.
    expect(sentBody(svc)).toEqual({ session: 'new1', agent: 'claude', prompt: 'read the README' });
    expect(sessionBody(svc)).toEqual({ workspace: 'ws_new1', title: 'Login fix' });
    expect(patches(svc)).toEqual([]);
    r.unmount();
  });

  it('with no name, the session is created with no title', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    await settle();
    expect(sessionBody(svc)).toEqual({ workspace: 'ws_new1' });
    expect(patches(svc)).toEqual([]);
    r.unmount();
  });

  it('with no first message, the conversation opens empty and its first message starts the session', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('input[name="name"]'), 'Login fix');
    const start = dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await submitForm(dialog);
    await settle();
    // Nothing is sent yet: a session starts with its first turn.
    expect(posts(svc)).toEqual([]);
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    expect(r.container.querySelector('#c-head .colhead-title')?.textContent).toBe('Login fix');
    expect(r.container.querySelectorAll('#c-msgs .tb').length).toBe(0);
    expect(r.container.querySelector('#sessions .sess.on')).toBeNull();
    const input = r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect((r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement).value).toBe('claude');

    await setValue(input, 'read the README');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(sentBody(svc)).toEqual({
      session: 'new1',
      agent: 'claude',
      prompt: 'read the README',
      idempotency_key: expect.stringMatching(/^cockpit-msg-/),
    });
    // The name is on the session; the one key covers all three calls.
    expect(sessionBody(svc)).toEqual({ workspace: 'ws_new1', title: 'Login fix', idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
    expect(patches(svc)).toEqual([]);
    expect(r.container.querySelector('.tb.pending .bubble')?.textContent).toBe('read the README');
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/x']);

    // A second message goes to the session the first one opened.
    await setValue(r.container.querySelector('#c-reply textarea'), 'and the tests');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(posts(svc).length).toBe(2);
    expect(sentBody(svc)).toMatchObject({ session: 'new1', prompt: 'and the tests' });

    // The session arrives: it replaces the draft.
    svc.state.sessions = [row('new1', { open: true, last: '2026-11-05T10:00:00Z', title: 'Login fix' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'session.registered', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', exchange: 'xn', text: 'read the README' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe('new1');
    expect(r.container.querySelector('.tb .bubble')?.textContent).toBe('read the README');
    r.unmount();
  });

  const workspacePosts = (svc: { reqs: Req[] }) => svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/workspaces');

  it('a bad folder for an empty-draft session is refused at the form: the dialog stays with the input and the refusal, and nothing is created', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      // The folder is checked when the workspace is created, which now happens
      // while the form is still open.
      workspaces: () => json({ error: 'folder must be an absolute path to an existing directory, at most 4096 bytes' }, 400),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/config/Sites/temp');
    await setValue(dialog.querySelector('input[name="name"]'), 'Fix login');
    // No first message: a session opened empty. The workspace is still made now.
    await submitForm(dialog);
    await settle();

    // The dialog stays open with the folder and name kept and the refusal in
    // plain words. No draft conversation and no session were made.
    const back = r.container.querySelector('.new-dialog')!;
    expect(back).not.toBeNull();
    expect((back.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('/config/Sites/temp');
    expect((back.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Fix login');
    expect(back.querySelector('.form-error')?.textContent).toBe('That folder does not exist.');
    expect(workspacePosts(svc)).toHaveLength(1);
    expect(sessionBody(svc)).toBeUndefined();
    expect(posts(svc)).toEqual([]);
    // No message card anywhere: the failure never reached a conversation.
    expect(r.container.querySelector('.tb.pending')).toBeNull();
    r.unmount();
  });

  it('an empty-draft session makes its workspace up front; the first message adds the session and turn to it', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('input[name="name"]'), 'Fix login');
    await submitForm(dialog);
    await settle();
    // The workspace was made as the draft opened (the folder checked then), and
    // the folder is remembered. No session or turn yet.
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: true });
    expect(workspacePosts(svc)).toHaveLength(1);
    expect(sessionBody(svc)).toBeUndefined();
    expect(posts(svc)).toEqual([]);
    expect(r.container.querySelector('#c-head .colhead-title')?.textContent).toBe('Fix login');
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/x']);

    // The first message adds the session and turn to the workspace already
    // made; it is not re-created.
    await setValue(r.container.querySelector('#c-reply textarea'), 'read the README');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(workspacePosts(svc)).toHaveLength(1);
    expect(sessionBody(svc)).toEqual({ workspace: 'ws_new1', title: 'Fix login', idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
    expect(sentBody(svc)).toEqual({ session: 'new1', agent: 'claude', prompt: 'read the README', idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
    r.unmount();
  });

  it("a draft's first message refused at the turn stays a failed card and does not disturb a newer draft", async () => {
    let failTurn: ((r: Response) => void) | null = null;
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      // The workspace and session succeed; the first turn is held, then refused
      // (an agent problem, not the folder).
      runs: () => new Promise<Response>((resolve) => (failTurn = resolve)),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await submitForm(dialog);
    await settle();
    await setValue(r.container.querySelector('#c-reply textarea'), 'first in A');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    // Open a second empty draft while the first turn is still in flight.
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const d2 = r.container.querySelector('.new-dialog')!;
    await setValue(d2.querySelector('input[name="folder"]'), '/Users/ana/y');
    await submitForm(d2);
    await settle();
    expect(r.container.querySelector('.new-dialog')).toBeNull();

    // The first turn is refused now. The form does not reopen, and the second
    // draft and its box are untouched.
    await act(async () => failTurn!(json({ error: 'no saved agent named claude' }, 400)));
    await settle();
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    expect(r.container.querySelector('#c-head .colhead-title')?.textContent).toBe('New session');
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    r.unmount();
  });

  it("a draft's first turn refused keeps a second pending message rather than losing it", async () => {
    let failTurn: ((r: Response) => void) | null = null;
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runs: () => new Promise<Response>((resolve) => (failTurn = resolve)),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await submitForm(dialog);
    await settle();
    // Two messages before the first turn resolves: the second rides on it.
    await setValue(r.container.querySelector('#c-reply textarea'), 'first');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    await setValue(r.container.querySelector('#c-reply textarea'), 'second');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();

    // The first turn is refused. Both messages stay as failed cards, each
    // recoverable with Edit; nothing is torn down, so no input is lost.
    await act(async () => failTurn!(json({ error: 'no saved agent named claude' }, 400)));
    await settle();
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    const bubbles = Array.from(r.container.querySelectorAll('.tb.pending.failed .bubble')).map((b) => b.textContent);
    expect(bubbles.sort()).toEqual(['first', 'second']);
    r.unmount();
  });

  it('a refused second empty-draft folder does not strand the first draft\'s awaited turn', async () => {
    let releaseTurn: ((r: Response) => void) | null = null;
    let badFolder = false;
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      // The first draft's turn is held in flight; the second draft's workspace
      // is refused while it is still pending.
      runs: () => new Promise<Response>((resolve) => (releaseTurn = resolve)),
      workspaces: (body) => {
        if (badFolder) return json({ error: 'folder must be an absolute path to an existing directory, at most 4096 bytes' }, 400);
        const b = body as { folder?: string; folder_ref?: string; machine?: string; sandbox?: boolean };
        return json({ workspace: 'ws_new1', folder: b.folder, folder_ref: b.folder_ref, machine: b.machine, sandbox: b.sandbox !== false }, 201);
      },
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await submitForm(dialog);
    await settle();
    // First draft's first message: its turn hangs, so its awaited-turn is still
    // pending.
    await setValue(r.container.querySelector('#c-reply textarea'), 'go');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    // A second empty session with a bad folder is refused at its workspace call.
    badFolder = true;
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const d2 = r.container.querySelector('.new-dialog')!;
    await setValue(d2.querySelector('input[name="folder"]'), '/bad');
    await submitForm(d2);
    await settle();
    expect(d2.querySelector('.form-error')?.textContent).toBe('That folder does not exist.');

    // The first draft's turn now completes and its session streams in: it must
    // still be selected, not stranded by the refused second draft.
    await act(async () => releaseTurn!(json({ session: 'new1', turn: 'Tn', state: 'running', base_url: `${BASE}/s/new1/t/Tn` }, 202)));
    await settle();
    svc.state.sessions = [row('new1', { open: true, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'session.registered', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', text: 'go' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe('new1');
    r.unmount();
  });

  it('picking a session drops the draft', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await submitForm(dialog);
    await settle();
    expect(r.container.querySelector('#c-head .colhead-title')?.textContent).toBe('New session');
    await click(r.container.querySelector('#sessions .sess'));
    await settle();
    expect(r.container.querySelector('#convo')?.getAttribute('data-session')).toBe('s1');
    expect(posts(svc)).toEqual([]);
    r.unmount();
  });

  it('shows at most five recent folders, newest first', async () => {
    localStorage.setItem('agentbus.folders', JSON.stringify(['/a1', '/a2', '/a3', '/a4', '/a5', '/a6', '/a7']));
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    expect(Array.from(dialog.querySelectorAll('.nd-recent button')).map((b) => b.textContent)).toEqual(['/a1', '/a2', '/a3', '/a4', '/a5']);
    await setValue(dialog.querySelector('input[name="folder"]'), '/b');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/b', '/a1', '/a2', '/a3', '/a4']);
    r.unmount();
  });

  it('a refused typed folder shows plain words, never the service text, and the field stays', async () => {
    const folders = [{ ref: 'fld_00000000000000a1', name: 'app', machine: 'con_1' }];
    const answers = [
      'folder must be an absolute path to an existing directory, at most 4096 bytes',
      'this server has no folders of its own: name folder_ref and machine from GET /api/v0/folders, which lists the folders its runners own',
    ];
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      folders,
      // The folder is checked when the workspace is created, the first call.
      workspaces: () => json({ error: answers.shift() }, 400),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/config/Sites/');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    await settle();
    expect(dialog.querySelector('.form-error')?.textContent).toBe('That folder does not exist.');
    await submitForm(dialog);
    await settle();
    expect(dialog.querySelector('.form-error')?.textContent).toBe('This service cannot use that folder. Pick one of the folders listed under the field.');
    // One field: a typed path, with the listed folders under it.
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('/config/Sites/');
    expect(Array.from(dialog.querySelectorAll('.nd-recent button')).map((b) => b.textContent)).toEqual(['app']);
    expect(dialog.textContent).not.toContain('-folder');
    r.unmount();
  });
});

describe('The prompt box', () => {
  it('is enabled when the session is resumable, and sends to /turns with session and a pending message', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
    });
    const r = await mount(svc);
    const input = r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    await setValue(input, 'and now the tests');
    await submitForm(r.container.querySelector('#c-reply form'));

    expect(svc.reqs.some((q) => q.path.endsWith('/messages'))).toBe(false);
    const sent = svc.reqs.find((q) => q.path === '/api/v0/turns' && q.method === 'POST');
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toEqual({ session: 's1', prompt: 'and now the tests', idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
    const pending = r.container.querySelector('.tb.pending .bubble');
    expect(pending?.textContent).toBe('and now the tests');
    // While it is pending the box still takes a message: it would queue.
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);

    // The turn fills in from the stream and the pending copy goes.
    const key = sentKey(svc);
    for (const e of oneTurn('s1', 'and now the tests', 2))
      await svc.push(e.kind === 'turn.started' ? { ...e, idempotency_key: key } : e);
    await settle();
    expect(r.container.querySelector('.tb.pending')).toBeNull();
    const bubbles = Array.from(r.container.querySelectorAll('.tb .bubble')).map((b) => b.textContent);
    expect(bubbles).toEqual(['first', 'and now the tests']);
    r.unmount();
  });

  it('is disabled for a session started in a terminal, with the reason', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: false })], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('Started in a terminal. Continue it there.');
    r.unmount();
  });

  it('says why when a cockpit session’s first turn did not start', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: false })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { agent: 'claude', state: 'failed', error: 'the agent could not be started.' } },
    });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe(
      'The first turn did not start: the agent could not be started. Start a new session.'
    );
    r.unmount();
  });

  it('never says terminal for a cockpit session that cannot continue', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: false })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { agent: 'claude' } },
    });
    const r = await mount(svc);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('This session cannot take another message. Start a new one.');
    r.unmount();
  });

  it("shows a failed turn's reason on its state label, with no error box", async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { state: 'failed', error: 'the relay refused: quota reached' } },
    });
    const r = await mount(svc);
    expect(r.container.querySelector('.tb .turn-error')).toBeNull();
    expect(r.container.querySelector('.tb .tb-state')?.textContent).toBe('failed · the relay refused: quota reached');
    r.unmount();
  });

  it('shows a failed turn with no error as failed alone', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { state: 'failed', error: '  ' } },
    });
    const r = await mount(svc);
    expect(r.container.querySelector('.tb .turn-error')).toBeNull();
    expect(r.container.querySelector('.tb .tb-state')?.textContent).toBe('failed');
    r.unmount();
  });

  it('takes a message while a turn is running, as Queue', async () => {
    const running = oneTurn('s1', 'first').slice(0, 2); // started and requested, no reply yet
    const svc = fakeService({ sessions: [row('s1', { resumable: false, open: true })], events: { s1: running } });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    expect(r.container.querySelector('#c-reply .reply-why')).toBeNull();
    await setValue(r.container.querySelector('#c-reply textarea'), 'after that');
    expect((r.container.querySelector('#c-reply button.go') as HTMLButtonElement).textContent).toBe('Queue');
    r.unmount();
  });

  // A turn whose reply is stored but whose run.ended is not: the service
  // holds it open for its last writes, so Send must wait.
  const closing = (session: string) => [
    ev({ session, kind: 'run.started', turn: `T1-${session}`, hold: 'h1' }),
    ...oneTurn(session, 'first').slice(0, 3).map((e) => ({ ...e, session, turn: `T1-${session}` })),
  ];
  const sendBtn = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply button.go') as HTMLButtonElement;
  const box = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;

  it('between the reply and run.ended a message queues; after it, Send', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true, open: true })], events: { s1: closing('s1') } });
    const r = await mount(svc);
    // The reply is on screen; the turn is not closed.
    expect(r.container.querySelector('#convo .m-agent')?.textContent).toContain('ok');
    expect(box(r).disabled).toBe(false);
    await setValue(box(r), 'next');
    expect(sendBtn(r).textContent).toBe('Queue');
    expect(sendBtn(r).disabled).toBe(false);
    expect(r.container.querySelector('#c-reply .reply-why')).toBeNull();
    await setValue(box(r), '');

    // run.ended arrives: the row is no longer open, the turn is finished.
    svc.state.sessions = [row('s1', { resumable: true, open: false })];
    await svc.push(ev({ session: 's1', kind: 'run.ended', turn: 'T1-s1', hold: 'h1', exit_code: 0 }));
    await settle();
    expect(box(r).disabled).toBe(false);
    expect(sendBtn(r).textContent).toBe('Send');
    await setValue(box(r), 'next');
    expect(sendBtn(r).disabled).toBe(false);
    r.unmount();
  });

  it('a message sent while a turn runs shows as queued, then as its turn', async () => {
    const running = oneTurn('s1', 'first').slice(0, 2);
    let key = '';
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      messages: (_id, body) => {
        key = String((body as Record<string, unknown>).idempotency_key);
        return json({ session: 's1', turn: 't_2', state: 'queued', ahead: 1 }, 202);
      },
    });
    const r = await mount(svc);
    await setValue(box(r), 'after that');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    const p = r.container.querySelector('.tb.pending.queued');
    expect(p?.querySelector('.bubble')?.textContent).toBe('after that');
    expect(p?.querySelector('.tb-state')?.textContent).toBe('queued · runs after the running turn');
    expect(box(r).value).toBe('');
    // A second one queues beside it.
    await setValue(box(r), 'and then this');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(r.container.querySelectorAll('.tb.pending.queued').length).toBe(2);
    expect(svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/turns').length).toBe(2);
    expect(key).toMatch(/^cockpit-msg-/);
    r.unmount();
  });

  it('a failed send stays on screen with the reason and Edit, and goes when its own turn is listed', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () => json({ error: 'the store could not be written' }, 500),
    });
    const r = await mount(svc);
    await setValue(box(r), 'first message');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    const failed = () => r.container.querySelector('.tb.pending.failed');
    expect(failed()?.querySelector('.bubble')?.textContent).toBe('first message');
    expect(failed()?.querySelector('.form-error')?.textContent).toBe('the store could not be written');
    expect(failed()?.querySelector('.pend-back')?.textContent).toBe('Edit');
    // The service had taken it after all: its turn arrives with its key, and
    // the failed copy goes.
    const key = sentKey(svc);
    for (const e of oneTurn('s1', 'first message', 2)) await svc.push(e.kind === 'turn.started' ? { ...e, idempotency_key: key } : e);
    await settle();
    expect(failed()).toBeNull();
    r.unmount();
  });

  it('every message names the agent picked for it', async () => {
    const running = oneTurn('s1', 'first')
      .slice(0, 2)
      .map((e) => (e.kind === 'turn.started' ? { ...e, agent: 'claude', agent_id: 'claude' } : e));
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      agents: AGENTS,
      messages: (id) => json({ session: id, turn: 't_q', state: 'queued', ahead: 1 }, 202),
    });
    const r = await mount(svc);
    const pick = () => r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement;
    const choose = async (v: string) => {
      if (pick().value === v) return;
      await click(pick());
      await click(document.querySelector(`[role="listbox"] [data-value="${v}"]`));
    };
    for (const [agent, text] of [['claude', 'one'], ['codex', 'two'], ['codex', 'three'], ['claude', 'four']]) {
      await choose(agent);
      await setValue(box(r), text);
      await submitForm(r.container.querySelector('#c-reply form'));
      await settle();
      expect((sentBody(svc) as { agent?: string }).agent).toBe(agent);
    }
    r.unmount();
  });

  it('a queued turn that started is not offered for a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = oneTurn('s1', 'first').slice(0, 2);
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      messages: (id) => json({ session: id, turn: 't_s', state: 'queued', ahead: 1 }, 202),
    });
    const inner = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/api/v0/turns/t_s')
        return json({ store: 'st_1', seq: 1, turn: { id: 't_s', session: 's1', agent: 'codex', folder: '/w', prompt: 'p', state: 'failed', started_seq: 5, error: 'agent' } });
      return inner(input, init);
    });
    const r = await mount(svc);
    await setValue(box(r), 'ran, then failed');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await settle();
    expect(r.container.querySelector('.tb.pending.failed')).toBeNull();
    r.unmount();
  });

  it('a queued message is still there after a switch to another session and back', async () => {
    const running = oneTurn('s1', 'first').slice(0, 2);
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true }), row('s2', { resumable: true })],
      events: { s1: running, s2: oneTurn('s2', 'other') },
      messages: (id) => json({ session: id, turn: 't_q', state: 'queued', ahead: 1 }, 202),
    });
    const r = await mount(svc);
    await setValue(box(r), 'wait for me');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(r.container.querySelector('.tb.pending.queued')).not.toBeNull();
    await click(r.container.querySelector('#sessions [data-session="s2"]'));
    await settle();
    expect(r.container.querySelector('.tb.pending')).toBeNull();
    await click(r.container.querySelector('#sessions [data-session="s1"]'));
    await settle();
    expect(r.container.querySelector('.tb.pending.queued .bubble')?.textContent).toBe('wait for me');
    r.unmount();
  });

  it('a message queued behind nothing waits like any message, and names the runner only after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: (id) => json({ session: id, turn: 't_q', state: 'queued' }, 202),
    });
    const r = await mount(svc);
    await setValue(box(r), 'go');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    const state = () => r.container.querySelector('.tb.pending .tb-state')?.textContent;
    // The same line as a message the service took at once.
    expect(state()).toBe('waiting for the agent');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(state()).toBe('waiting for the agent');
    // Still queued a few seconds on: no runner has taken it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(state()).toBe('queued · waiting for a runner');
    r.unmount();
  });

  describe('a message still queued', () => {
    const queuedSvc = (stop: (turn: string) => Response) =>
      fakeService({
        sessions: [row('s1', { resumable: true })],
        events: { s1: oneTurn('s1', 'first') },
        messages: (id) => json({ session: id, turn: 't_q', state: 'queued', ahead: 1 }, 202),
        stop,
      });
    const sendQueued = async (svc: ReturnType<typeof fakeService>) => {
      const r = await mount(svc);
      await setValue(box(r), 'make it blue');
      await submitForm(r.container.querySelector('#c-reply form'));
      await settle();
      return r;
    };
    const row_ = (r: { container: HTMLElement }) => r.container.querySelector('.tb.pending.queued');
    const stops = (svc: ReturnType<typeof fakeService>) => svc.reqs.filter((q) => q.method === 'POST' && q.path.endsWith('/stop')).map((q) => q.path);

    it('Cancel stops its turn before it starts, and the message goes', async () => {
      const svc = queuedSvc(() => json({}, 202));
      const r = await sendQueued(svc);
      expect(row_(r)!.querySelector('.bubble')!.textContent).toBe('make it blue');
      await click(row_(r)!.querySelector('.pend-cancel'));
      await settle();
      expect(stops(svc)).toEqual(['/api/v0/turns/t_q/stop']);
      expect(row_(r)).toBeNull();
      expect(box(r).value).toBe('');
      r.unmount();
    });

    it('Edit stops it and puts its text back in the box, to send again as a new turn', async () => {
      const svc = queuedSvc(() => json({}, 202));
      const r = await sendQueued(svc);
      await click(row_(r)!.querySelector('.pend-edit'));
      await settle();
      expect(stops(svc)).toEqual(['/api/v0/turns/t_q/stop']);
      expect(row_(r)).toBeNull();
      expect(box(r).value).toBe('make it blue');
      r.unmount();
    });

    it('a Cancel that comes after the turn started leaves the message and says so', async () => {
      const svc = queuedSvc(() => json({ error: 'the turn has ended' }, 409));
      const r = await sendQueued(svc);
      await click(row_(r)!.querySelector('.pend-cancel'));
      await settle();
      expect(row_(r)!.textContent).toContain(TOO_LATE);
      r.unmount();
    });
  });

  it('what was typed stays in its own session’s box across a switch and back', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true }), row('s2', { resumable: true })],
      events: { s1: oneTurn('s1', 'first'), s2: oneTurn('s2', 'other') },
      messages: (id) => json({ session: id, turn: 't_n', state: 'running' }, 202),
    });
    const r = await mount(svc);
    await setValue(box(r), 'half a thought');
    await click(r.container.querySelector('#sessions [data-session="s2"]'));
    await settle();
    expect(box(r).value).toBe('');
    await setValue(box(r), 'for two');
    await click(r.container.querySelector('#sessions [data-session="s1"]'));
    await settle();
    expect(box(r).value).toBe('half a thought');
    await click(r.container.querySelector('#sessions [data-session="s2"]'));
    await settle();
    expect(box(r).value).toBe('for two');
    // A sent message leaves the box, and does not come back to it.
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    await click(r.container.querySelector('#sessions [data-session="s1"]'));
    await settle();
    await click(r.container.querySelector('#sessions [data-session="s2"]'));
    await settle();
    expect(box(r).value).toBe('');
    r.unmount();
  });

  it('after a switch whose answer was lost, the next message still names its agent', async () => {
    const running = oneTurn('s1', 'first')
      .slice(0, 2)
      .map((e) => (e.kind === 'turn.started' ? { ...e, agent: 'claude', agent_id: 'claude' } : e));
    let n = 0;
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      agents: AGENTS,
      messages: (id) => (++n === 1 ? json({ error: 'gateway timeout' }, 504) : json({ session: id, turn: 't_q', state: 'queued', ahead: 2 }, 202)),
    });
    const r = await mount(svc);
    const pick = () => r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement;
    const choose = async (v: string) => {
      await chooseOpt(r.container, 'next_agent', v);
      expect(pick().value).toBe(v);
    };
    await choose('codex');
    await setValue(box(r), 'on codex');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(r.container.querySelector('.tb.pending.failed')).not.toBeNull();
    await choose('claude');
    await setValue(box(r), 'on claude');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect((sentBody(svc) as { agent?: string }).agent).toBe('claude');
    r.unmount();
  });

  it('a turn another client sent does not clear a failed or a queued message', async () => {
    const running = oneTurn('s1', 'first').slice(0, 2);
    let n = 0;
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      messages: (id) => (++n === 1 ? json({ error: 'no' }, 400) : json({ session: id, turn: 't_q', state: 'queued', ahead: 1 }, 202)),
    });
    const r = await mount(svc);
    await setValue(box(r), 'will fail');
    await submitForm(r.container.querySelector('#c-reply form'));
    await setValue(box(r), 'will queue');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    // A turn with no key, from elsewhere.
    for (const e of oneTurn('s1', 'from a terminal', 2)) await svc.push(e);
    await settle();
    expect(r.container.querySelector('.tb.pending.failed .bubble')?.textContent).toBe('will fail');
    expect(r.container.querySelector('.tb.pending.queued .bubble')?.textContent).toBe('will queue');
    r.unmount();
  });

  it('Edit takes a failed message back into the box', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () => json({ error: 'no' }, 400),
    });
    const r = await mount(svc);
    await setValue(box(r), 'lost?');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    await setValue(box(r), 'typed since');
    await click(r.container.querySelector('.tb.pending.failed .pend-back'));
    expect(box(r).value).toBe('typed since\nlost?');
    expect(r.container.querySelector('.tb.pending')).toBeNull();
    r.unmount();
  });

  it('a queued message whose turn ends without starting shows as failed, with why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = oneTurn('s1', 'first').slice(0, 2);
    const svc = fakeService({
      sessions: [row('s1', { resumable: false, open: true })],
      events: { s1: running },
      messages: (id) => json({ session: id, turn: 't_q', state: 'queued', ahead: 1 }, 202),
    });
    const inner = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/api/v0/turns/t_q')
        return json({ store: 'st_1', seq: 1, turn: { id: 't_q', session: 's1', agent: '', folder: '', prompt: 'p', state: 'failed', error: 'this session cannot be continued from here' } });
      return inner(input, init);
    });
    const r = await mount(svc);
    await setValue(box(r), 'after that');
    await submitForm(r.container.querySelector('#c-reply form'));
    await settle();
    expect(r.container.querySelector('.tb.pending.queued')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await settle();
    const failed = r.container.querySelector('.tb.pending.failed');
    expect(failed?.querySelector('.form-error')?.textContent).toBe('this session cannot be continued from here');
    r.unmount();
  });

  it('on a 409 shows the service reason on the message, which stays', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () => json({ error: 'a turn is already running in this session' }, 409),
    });
    const r = await mount(svc);
    await setValue(box(r), 'again');
    await submitForm(r.container.querySelector('#c-reply form'));
    const failed = r.container.querySelector('.tb.pending.failed');
    expect(failed?.querySelector('.form-error')?.textContent).toBe('a turn is already running in this session');
    expect(failed?.querySelector('.bubble')?.textContent).toBe('again');
    expect(sendBtn(r).textContent).toBe('Send');
    expect(svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/turns').length).toBe(1);
    r.unmount();
  });

  it('shows the reason of a 409 that cannot be continued', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () => json({ error: 'this session cannot be continued from here' }, 409),
    });
    const r = await mount(svc);
    await setValue(box(r), 'again');
    await submitForm(r.container.querySelector('#c-reply form'));
    expect(r.container.querySelector('.tb.pending.failed .form-error')?.textContent).toBe('this session cannot be continued from here');
    expect(r.container.querySelector('.tb.pending.failed .bubble')?.textContent).toBe('again');
    r.unmount();
  });
});

describe('Agents', () => {
  const formLabels = (r: { container: HTMLElement }) =>
    Array.from(r.container.querySelectorAll('.agent-form .ad-set > label > span:first-child')).map((x) => x.textContent);

  it('+ Agent opens the form: Harness, Access, Model, Name, and nothing that does not work', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    expect(formLabels(r)).toEqual([
      'Harness',
      'Access',
      'Model',
      'Name',
    ]);
    const form = r.container.querySelector('.agent-form')!;
    // A harness or an access the service marks not available is left out, not shown disabled.
    expect(form.querySelector('[data-harness="opencode"]')).toBeNull();
    expect(form.querySelector('[data-access="api"]')).toBeNull();
    expect(form.textContent).not.toMatch(/Not available yet|coming soon/i);
    expect(form.querySelector('select')).toBeNull();
    // A subscription agent starts with no model, so the harness picks its
    // own; the name follows harness and model.
    expect((form.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Claude Code');
    const models = (await optionsOf(form, 'model')).map((o) => o[0]);
    expect(models).toEqual(['sonnet', 'opus', 'haiku', '']);
    r.unmount();
  });

  // A subscription that takes any model name: the field is free text, a
  // new agent names none (the tool's default), and none is saved when the
  // field stays empty.
  it('a subscription agent starts with no model and takes a typed name', async () => {
    const codex = {
      name: 'codex',
      label: 'Codex',
      found: true,
      access: [{ kind: 'subscription', label: 'ChatGPT sign-in', models: [], any_model: true }, ...ACCESS([]).slice(1)],
    };
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: [codex] });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    const form = () => r.container.querySelector('.agent-form')!;
    expect(selectIn(form(), 'model')).toBeNull();
    const model = form().querySelector('input[name="model"]') as HTMLInputElement;
    expect(model.value).toBe('');
    expect(model.placeholder).toBe("empty: Codex's default");
    expect((form().querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Codex');
    await submitForm(form());
    const post = svc.reqs.find((q) => q.path === '/api/v0/agents' && q.method === 'POST');
    expect(post?.body).toEqual({ name: 'Codex', harness: 'codex', access: 'subscription' });
    r.unmount();
  });

  it('an OpenRouter agent takes any model id, asks for no key variable, and is saved', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    const form = () => r.container.querySelector('.agent-form')!;
    await click(form().querySelector('[data-access="openrouter"]'));
    expect(selectIn(form(), 'model')).toBeNull();
    const model = form().querySelector('input[name="model"]') as HTMLInputElement;
    expect(model.value).toBe('deepseek/deepseek-v4.1-flash');
    await setValue(model, 'qwen/qwen3-coder:free');
    expect((form().querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Claude Code · qwen/qwen3-coder:free');
    // No key variable field: the OpenRouter key is pasted in Settings only.
    expect(form().querySelector('input[name="key_env"]')).toBeNull();
    expect(form().querySelector('details.ad-advanced')).toBeNull();
    await submitForm(form());
    const post = svc.reqs.find((q) => q.path === '/api/v0/agents' && q.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Claude Code · qwen/qwen3-coder:free',
      harness: 'claude',
      access: 'openrouter',
      model: 'qwen/qwen3-coder:free',
    });
    // The form closes, and the new agent is a row of the Agents column, with
    // no session yet.
    expect(r.container.querySelector('.agent-form')).toBeNull();
    await settle();
    const rows = Array.from(r.container.querySelectorAll('#agents [data-agent]')).map((x) => x.textContent);
    expect(rows.some((t) => t!.includes('Claude Code · qwen/qwen3-coder:free') && t!.includes('OpenRouter · qwen/qwen3-coder:free'))).toBe(true);
    r.unmount();
  });

  it('a name the person typed stays when the model changes; a refused save shows the API words', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    const form = () => r.container.querySelector('.agent-form')!;
    await setValue(form().querySelector('input[name="name"]'), 'Codex');
    await chooseOpt(form(), 'model', 'haiku');
    expect((form().querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Codex');
    await submitForm(form());
    expect(r.container.querySelector('.agent-form .form-error')?.textContent).toBe('an agent named "Codex" already exists');
    r.unmount();
  });

  // A save in flight cannot be left: its answer would close whatever form
  // came next and lose its edits.
  it('while a save is in flight, Cancel and Escape do nothing', async () => {
    let finish: (r: Response) => void = () => {};
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const inner = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/api/v0/agents' && init?.method === 'POST') return new Promise<Response>((res) => (finish = res));
      return inner(input, init);
    });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    await submitForm(r.container.querySelector('.agent-form'));
    // Every field, choice and button, Cancel too, sits in one disabled
    // fieldset (a browser disables all of them; jsdom does not say so per
    // control).
    const set = r.container.querySelector('.agent-form > fieldset') as HTMLFieldSetElement;
    expect(set.disabled).toBe(true);
    expect(set.querySelectorAll('input, button').length).toBe(r.container.querySelectorAll('.agent-form input, .agent-form button').length);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(r.container.querySelector('.agent-form')).not.toBeNull();
    await act(async () => finish(json({ id: 'a_9', name: 'Claude Code · sonnet', harness: 'claude', access: 'subscription', model: 'sonnet' }, 201)));
    await settle();
    expect(r.container.querySelector('.agent-form')).toBeNull();
    r.unmount();
  });

  it('lists every saved agent in the Agents column, with no Saved button', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await settle();
    expect(r.container.querySelector('#agents .manage-agents')).toBeNull();
    const ids = Array.from(r.container.querySelectorAll('#agents [data-agent]')).map((x) => x.getAttribute('data-agent'));
    expect(ids).toEqual(['claude', 'codex']);
    r.unmount();
  });

  // A session is a list of turns, each naming its agent: no session belongs
  // to an agent, so the Agents column lists only the saved agents.
  it('the saved agents list holds no sessions, and no row for a removed agent', async () => {
    const svc = fakeService({
      sessions: [
        // Started on a saved agent since removed, then switched to codex.
        row('s2', { agent: 'codex', first_agent: 'claude', first_agent_id: 'a_gone', last: '2026-11-05T09:20:00Z' }),
        row('s1', { first_agent: 'claude', first_agent_id: 'claude' }),
      ],
      events: { s1: oneTurn('s1', 'one'), s2: oneTurn('s2', 'two') },
      agents: AGENTS,
    });
    const r = await mount(svc);
    await settle();
    const rows = Array.from(r.container.querySelectorAll('#agents [data-agent]'));
    expect(rows.map((x) => x.getAttribute('data-agent'))).toEqual(['claude', 'codex']);
    for (const x of rows) expect(x.textContent).not.toMatch(/session|running/);
    expect(r.container.querySelector('#agents [data-session], #agents .sess')).toBeNull();
    expect(r.container.textContent).not.toContain('removed agent');
    // Both sessions are in the Sessions column, each with its agents.
    const ran = (id: string) => r.container.querySelector(`#sessions [data-session="${id}"] .s-ag`)?.textContent;
    expect(ran('s2')).toBe('Claude Code, Codex');
    expect(ran('s1')).toBe('Claude Code');
    r.unmount();
  });

  it('opens on the newest session\'s agent even when the saved agents arrive first', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const svc = fakeService({ sessions: [row('s1', { first_agent: 'claude', first_agent_id: 'claude' })], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS,
      saved: [{ id: 'a_empty', name: 'Empty', harness: 'codex', access: 'subscription' }, ...SAVED] });
    const inner = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/api/v0/sessions') await gate;
      return inner(input, init);
    });
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<App dataSource={new LiveDataSource({ baseUrl: BASE, token: 't' })} />);
    await settle();
    await act(async () => release());
    await settle();
    expect(r.container.querySelector('#agents .agent.on')?.getAttribute('data-agent')).toBe('claude');
    expect(r.container.querySelector('#sessions [data-session="s1"]')).not.toBeNull();
    r.unmount();
  });

  it('while a remove is in flight, its confirm waits; then the row is gone', async () => {
    let finish: () => void = () => {};
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const inner = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      // The DELETE answers only when the test says, as the service would.
      if (init?.method === 'DELETE') return new Promise<Response>((res) => (finish = () => res(inner(input, init))));
      return inner(input, init);
    });
    const r = await mount(svc);
    await settle();
    await click(r.container.querySelector('#agents [data-agent="codex"]'));
    await click(r.container.querySelector('#agents [data-agent="codex"] .ag-remove'));
    // Remove asks first; while the remove is in flight the confirm waits.
    await click(r.container.querySelector('.ag-remove-ask .confirm-go'));
    expect((r.container.querySelector('.ag-remove-ask .confirm-go') as HTMLButtonElement).disabled).toBe(true);
    expect((r.container.querySelector('.ag-remove-ask .dlg-cancel') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await settle();
    expect(svc.reqs.find((q) => q.method === 'DELETE')?.path).toBe('/api/v0/agents/codex');
    expect(r.container.querySelector('#agents [data-agent="codex"]')).toBeNull();
    r.unmount();
  });

  it('a row edits its agent with PUT, and Remove removes it after the cockpit\'s own confirm', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await settle();
    await click(r.container.querySelector('#agents [data-agent="claude"]'));
    await click(r.container.querySelector('#agents [data-agent="claude"] .ag-edit'));
    await settle();
    const form = () => r.container.querySelector('.agent-form')!;
    expect((form().querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Claude Code');
    await chooseOpt(form(), 'model', 'opus');
    await submitForm(form());
    const put = svc.reqs.find((q) => q.method === 'PUT');
    expect(put?.path).toBe('/api/v0/agents/claude');
    expect(put?.body).toEqual({ name: 'Claude Code', harness: 'claude', access: 'subscription', model: 'opus' });
    expect(r.container.querySelector('.agent-form')).toBeNull();

    await click(r.container.querySelector('#agents [data-agent="codex"]'));
    const confirm = vi.spyOn(window, 'confirm');
    await click(r.container.querySelector('#agents [data-agent="codex"] .ag-remove'));
    expect(svc.reqs.filter((q) => q.method === 'DELETE')).toEqual([]);
    expect(r.container.querySelector('.ag-remove-ask')!.getAttribute('role')).toBe('alertdialog');
    await click(r.container.querySelector('.ag-remove-ask .confirm-go'));
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
    expect(svc.reqs.filter((q) => q.method === 'DELETE').map((q) => q.path)).toEqual(['/api/v0/agents/codex']);
    expect(r.container.querySelector('#agents [data-agent="codex"]')).toBeNull();
    r.unmount();
  });
});

describe('Connect check timeout', () => {
  it('a service that never finishes the body gives a plain error after 10 seconds', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ start() {} }); // never closes
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const result = checkConnection({ address: 'http://127.0.0.1:8787', token: 't' }, 'http://localhost:5173');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('AgentBus at http://127.0.0.1:8787 did not answer within 10 seconds.');
  });

  it('a fetch that never answers gives the same error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const result = checkConnection({ address: 'http://127.0.0.1:8787', token: 't' }, 'http://localhost:5173');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('AgentBus at http://127.0.0.1:8787 did not answer within 10 seconds.');
  });
});

describe('Startup quota checks', () => {
  // Claude Code's quota check: a model call with no turn id, flagged as a probe.
  const check = (session: string) => [
    ev({ seq: 1, session, kind: 'turn.started', exchange: 'q1', text: 'quota', probe: true }),
    ev({ seq: 2, session, kind: 'model.requested', exchange: 'q1', probe: true }),
    ev({ seq: 3, session, kind: 'model.responded', exchange: 'q1', status: 200, probe: true }),
  ];

  it('create no turn in a session that has turns', () => {
    const events = [...check('s9'), ...oneTurn('s9', 'real').map((e, i) => ({ ...e, seq: 10 + i }))];
    const turns = buildTurns('s9', events);
    expect(turns.map((t) => t.prompt)).toEqual(['real']);
  });

  it('a session whose only events are checks shows no turns', () => {
    expect(buildTurns('s9', check('s9'))).toEqual([]);
  });
});

describe('The turn list from the API', () => {
  const turnReads = (svc: ReturnType<typeof fakeService>) =>
    svc.reqs.filter((q) => q.path === '/api/v0/turns' && q.method === 'GET').length;
  const eventReads = (svc: ReturnType<typeof fakeService>, turn: string) =>
    svc.reqs.filter((q) => /^\/api\/v0\/sessions\/[^/]+\/events$/.test(q.path) && new URLSearchParams(q.query).get('turn') === turn).length;

  it('reads every page by next_before and shows the turns oldest first, never the session events', async () => {
    const events = [...oneTurn('s1', 'one', 1), ...oneTurn('s1', 'two', 2), ...oneTurn('s1', 'three', 3)];
    const svc = fakeService({ sessions: [row('s1', { turns: 3 })], events: { s1: events }, turnPage: 2 });
    const r = await mount(svc);
    // Two pages: two turns, then one.
    expect(turnReads(svc)).toBe(2);
    const bubbles = Array.from(r.container.querySelectorAll('#convo .tb .bubble')).map((b) => b.textContent);
    expect(bubbles).toEqual(['one', 'two', 'three']);
    expect(Array.from(r.container.querySelectorAll('#convo .tb-h b')).map((b) => b.textContent)).toEqual([
      'Turn 1',
      'Turn 2',
      'Turn 3',
    ]);
    // Turn 1 is open: its events were read, and only its.
    expect(eventReads(svc, 'T1-s1')).toBe(1);
    expect(eventReads(svc, 'T2-s1')).toBe(0);
    // Every read of a session's events names one turn, or only its "!"
    // commands from before 0.5 (the command.* kinds).
    expect(
      svc.reqs.some((q) => {
        const p = new URLSearchParams(q.query);
        return /\/sessions\/[^/]+\/events$/.test(q.path) && !p.has('turn') && !(p.get('kind') ?? '').startsWith('command.');
      })
    ).toBe(false);
    r.unmount();
  });

  it('a turn arriving on the stream shows without a reload; events of the open turn join it', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    const before = turnReads(svc);
    const bubbles = () => Array.from(r.container.querySelectorAll('#convo .tb .bubble')).map((b) => b.textContent);
    expect(bubbles()).toEqual(['first']);

    // A new turn: the list is read again and the turn is shown, with its state.
    await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'T9', exchange: 'x9', text: 'from elsewhere' }));
    await settle();
    expect(turnReads(svc)).toBe(before + 1);
    expect(bubbles()).toEqual(['first', 'from elsewhere']);
    // While it runs, one live line stands where its reply will be.
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.m-live')?.textContent).toMatch(/^starting the agent · \d+s$/);

    // A tool call of the open turn (turn 1) joins its events from the stream:
    // no read of its events, and no read of the list (a tool call changes no row).
    const reads = turnReads(svc);
    await svc.push(ev({ session: 's1', kind: 'tool.requested', turn: 'T1-s1', exchange: 'x1', tool_id: 'z', tool_name: 'Zed' }));
    await settle();
    expect(eventReads(svc, 'T1-s1')).toBe(1);
    expect(turnReads(svc)).toBe(reads);
    await click(r.container.querySelectorAll('#convo .tb')[0]);
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Tools'));
    expect(Array.from(r.container.querySelectorAll('#d-body .tcard .k')).map((k) => k.textContent)).toEqual(['Zed']);

    // The new turn ends: the list is read again and its state follows.
    await svc.push(ev({ session: 's1', kind: 'turn.completed', turn: 'T9', exchange: 'x9', outcome: 'finished' }));
    await settle();
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.tb-state')).toBeNull();
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.m-live')).toBeNull();
    r.unmount();
  });

  it('an event the list already counts (seq at or below its seq) reads nothing again', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    const before = turnReads(svc);
    // The fake's list is computed at seq 100; this event is older than that.
    await svc.send(ev({ seq: 50, session: 's1', kind: 'model.responded', turn: 'T1-s1', exchange: 'x1', status: 200 }));
    await settle();
    expect(turnReads(svc)).toBe(before);
    r.unmount();
  });

});

// A second turn whose turn.started carries the given extra fields.
function nextTurn(session: string, extra: Record<string, unknown>, more: CockpitEvent[] = []): CockpitEvent[] {
  const t = `T2-${session}`;
  return [
    ev({ session, kind: 'turn.started', turn: t, exchange: 'x2', text: 'next one', ...extra }),
    ev({ session, kind: 'model.requested', turn: t, exchange: 'x2' }),
    ...more.map((e) => ({ ...e, turn: t })),
    ev({ session, kind: 'model.responded', turn: t, exchange: 'x2', status: 200, text: 'ok', stop_reason: 'end_turn' }),
    ev({ session, kind: 'turn.completed', turn: t, exchange: 'x2', outcome: 'finished' }),
  ];
}

async function openTurn2(events: CockpitEvent[]) {
  const svc = fakeService({ sessions: [row('s1', { resumable: true, turns: 2 })], events: { s1: events } });
  const r = await mount(svc);
  const blocks = r.container.querySelectorAll('.tb');
  await click(blocks[blocks.length - 1]);
  await settle();
  return { svc, r };
}

// How a turn continued is in the turn panel, under its strip; the chat never shows it.
const chatNotes = (r: { container: HTMLElement }) => r.container.querySelectorAll('#convo .tb-cont').length;

describe('How a turn continued', () => {
  it('is in the turn panel, never in the chat', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true, turns: 2 })],
      events: { s1: [...oneTurn('s1', 'first'), ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' })] },
    });
    const r = await mount(svc);
    expect(chatNotes(r)).toBe(0);
    const blocks = () => r.container.querySelectorAll('.tb');
    await click(blocks()[1]);
    await settle();
    expect(chatNotes(r)).toBe(0);
    expect(continuedLine(r.container)).toBe('Continued from turn 1 (replay)');
    // Turn 1 started fresh: no line.
    await click(blocks()[0]);
    await settle();
    expect(continuedLine(r.container)).toBeNull();
    r.unmount();
  });

  it('shows "Continued from turn N (replay)" for own replay', async () => {
    const { r } = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' }),
    ]);
    expect(continuedLine(r.container)).toBe('Continued from turn 1 (replay)');
    expect(chatNotes(r)).toBe(0);
    r.unmount();
  });

  it('shows "Resumed (vendor resume)" for the vendor resume, and nothing without continuity', async () => {
    const a = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', { continuity: 'resume' })]);
    expect(continuedLine(a.r.container)).toBe('Resumed (vendor resume)');
    a.r.unmount();
    const b = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', {})]);
    expect(continuedLine(b.r.container)).toBeNull();
    b.r.unmount();
  });

  it('shows "Continued after turn N was interrupted (reason)" from recovered_from and recovered_reason', async () => {
    const a = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1', recovered_from: ' T1-s1 ', recovered_reason: 'the agent stopped' }),
    ]);
    expect(continuedLine(a.r.container)).toBe('Continued after turn 1 was interrupted (the agent stopped)');
    a.r.unmount();
    const b = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', { recovered_from: 'T1-s1' })]);
    expect(continuedLine(b.r.container)).toBe('Continued after turn 1 was interrupted');
    b.r.unmount();
  });

  it.each([['{}', {}], ['[]', []], ['{foo}', { foo: 'bar' }], ['blank', '   '], ['number', 42]])(
    'ignores a recovered_from of %s and shows the replay line',
    async (_n, value) => {
      const { r } = await openTurn2([
        ...oneTurn('s1', 'first'),
        ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1', recovered_from: value }),
      ]);
      expect(continuedLine(r.container)).toBe('Continued from turn 1 (replay)');
      r.unmount();
    }
  );
});

describe('Failures in a turn', () => {
  it('shows the error of a replay.failed event in the turn', async () => {
    const failed = ev({ session: 's1', kind: 'replay.failed', error: 'the request is not in the layout the gateway knows' });
    const { r } = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' }, [failed]),
    ]);
    const errs = Array.from(r.container.querySelectorAll('.tb .turn-error')).map((e) => e.textContent);
    expect(errs).toEqual(['The earlier turns could not be replayed: the request is not in the layout the gateway knows']);
    r.unmount();
  });

  it('an error line stays on its turn when another turn is picked or the panel closes', async () => {
    const failed = ev({ session: 's1', kind: 'replay.failed', error: 'history unreadable' });
    const { r } = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' }, [failed]),
    ]);
    const errs = () => Array.from(r.container.querySelectorAll('.tb')).map((t) => t.querySelector('.turn-error')?.textContent ?? null);
    const want = [null, 'The earlier turns could not be replayed: history unreadable'];
    expect(errs()).toEqual(want);
    // Turn 1 picked: turn 2's error stays.
    await click(r.container.querySelectorAll('.tb')[0]);
    await settle();
    expect(errs()).toEqual(want);
    // The panel closed: still there.
    await click(r.container.querySelector('#p-head .p-close'));
    expect(errs()).toEqual(want);
    r.unmount();
  });

  it('shows a replay.failed streamed into an open turn', async () => {
    const { svc, r } = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' })]);
    expect(r.container.querySelector('.turn-error')).toBeNull();
    await svc.push(ev({ session: 's1', kind: 'replay.failed', turn: 'T2-s1', error: 'history unreadable' }));
    await settle();
    expect(r.container.querySelector('.turn-error')?.textContent).toContain('history unreadable');
    r.unmount();
  });

  it('shows the service reason for a plain-text error on the message, which stays', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () =>
        new Response('session s1 was continued by own replay, and no turn of it has a finished reply to replay', { status: 409 }),
    });
    const r = await mount(svc);
    await setValue(r.container.querySelector('#c-reply textarea'), 'try again');
    await submitForm(r.container.querySelector('#c-reply form'));
    // The message stays, failed, with the service's words.
    const failed = r.container.querySelector('.tb.pending.failed');
    expect(failed?.querySelector('.form-error')?.textContent).toBe(
      'session s1 was continued by own replay, and no turn of it has a finished reply to replay'
    );
    expect(failed?.querySelector('.bubble')?.textContent).toBe('try again');
    r.unmount();
  });
});

// The Sessions column lists every session, newest first, whatever agent is
// selected; a session is renamed from its row or the conversation's header.
describe('The sessions list and rename', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  const titles = (c: HTMLElement) => Array.from(c.querySelectorAll('#sessions .sess')).map((b) => rowSession(b));

  it('lists every session newest first, and picking an agent filters nothing', async () => {
    const svc = fakeService({
      sessions: [
        row('s3', { agent: 'codex', first_agent: 'codex', last: '2026-11-05T09:30:00Z' }),
        row('s2', { first_agent: 'claude', last: '2026-11-05T09:20:00Z' }),
        row('s1', { agent: 'codex', first_agent: 'claude', last: '2026-11-05T09:10:00Z' }),
      ],
      events: { s1: oneTurn('s1', 'one'), s2: oneTurn('s2', 'two'), s3: oneTurn('s3', 'three') },
      agents: AGENTS,
    });
    const r = await mount(svc);
    expect(titles(r.container)).toEqual(['s3', 's2', 's1']);
    for (const a of Array.from(r.container.querySelectorAll('#agents .agent'))) {
      await click(a);
      await settle();
      expect(titles(r.container)).toEqual(['s3', 's2', 's1']);
    }
    r.unmount();
  });

  // jsdom has no layout: this checks every row is rendered, oldest last.
  // That the column scrolls to it was checked in a browser.
  it('a long list renders every session, the oldest last', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`s${i}`, { last: `2026-11-05T09:${String(59 - i).padStart(2, '0')}:00Z` }));
    const svc = fakeService({ sessions: many, events: { s0: oneTurn('s0', 'zero') } });
    const r = await mount(svc);
    expect(titles(r.container)).toHaveLength(60);
    expect(titles(r.container)[59]).toBe('s59');
    r.unmount();
  });

  it('the pencil on a row renames it: Enter saves through PATCH, and the row shows the name', async () => {
    const svc = fakeService({
      sessions: [row('s1', { title: 'first words' }), row('s2', { title: 'other', last: '2026-11-05T09:05:00Z' })],
      events: { s1: oneTurn('s1', 'one'), s2: oneTurn('s2', 'two') },
    });
    const r = await mount(svc);
    const s2 = r.container.querySelector('#sessions .sess[data-session="s2"]')!.closest('.sess-row')!;
    await click(s2.querySelector('.s-rename'));
    const box = r.container.querySelector('#sessions .title-edit input') as HTMLInputElement;
    expect(box.value).toBe('other');
    await setValue(box, '  Login fix  ');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const patch = svc.reqs.filter((q) => q.method === 'PATCH');
    expect(patch).toEqual([{ method: 'PATCH', path: '/api/v0/sessions/s2', query: '', body: { title: 'Login fix' } }]);
    expect(r.container.querySelector('#sessions .title-edit')).toBeNull();
    expect(r.container.querySelector('#sessions .sess[data-session="s2"] .s-tt')?.textContent).toBe('Login fix');
    // The rename selects nothing: s1 stays on screen.
    expect(shownSession(r.container)).toBe('s1');
    r.unmount();
  });

  it('Escape cancels a rename and sends nothing; a refusal shows the API words and keeps the box', async () => {
    const svc = fakeService({
      sessions: [row('s1', { title: 'first words' })],
      events: { s1: oneTurn('s1', 'one') },
      rename: () => json({ error: 'title is at most 120 characters' }, 400),
    });
    const r = await mount(svc);
    // The selected row's name starts a rename when clicked.
    await click(r.container.querySelector('#sessions .sess.on .s-tt'));
    let box = r.container.querySelector('#sessions .title-edit input') as HTMLInputElement;
    await setValue(box, 'something');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(r.container.querySelector('#sessions .title-edit')).toBeNull();
    expect(svc.reqs.some((q) => q.method === 'PATCH')).toBe(false);
    expect(r.container.querySelector('#sessions .sess.on .s-tt')?.textContent).toBe('first words');

    await click(r.container.querySelector('#sessions .sess.on .s-tt'));
    box = r.container.querySelector('#sessions .title-edit input') as HTMLInputElement;
    await setValue(box, 'x'.repeat(10));
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(r.container.querySelector('#sessions .title-edit .form-error')?.textContent).toBe('title is at most 120 characters');
    expect(r.container.querySelector('#sessions .title-edit input')).not.toBeNull();
    r.unmount();
  });

  it("the conversation's header renames the session too", async () => {
    const svc = fakeService({ sessions: [row('s1', { title: 'first words' })], events: { s1: oneTurn('s1', 'one') } });
    const r = await mount(svc);
    await click(r.container.querySelector('#c-head .c-rename'));
    const box = r.container.querySelector('#c-head .title-edit input') as HTMLInputElement;
    await setValue(box, 'Header name');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(svc.reqs.filter((q) => q.method === 'PATCH').map((q) => q.body)).toEqual([{ title: 'Header name' }]);
    expect(r.container.querySelector('#c-head .colhead-title')?.textContent).toBe('Header name');
    expect(r.container.querySelector('#sessions .sess.on .s-tt')?.textContent).toBe('Header name');
    r.unmount();
  });

  it('a refusal in the header shows the API words; a long name of emoji is sent whole', async () => {
    const svc = fakeService({
      sessions: [row('s1', { title: 'first words' })],
      events: { s1: oneTurn('s1', 'one') },
      rename: () => json({ error: 'title is at most 120 characters' }, 400),
    });
    const r = await mount(svc);
    await click(r.container.querySelector('#c-head .c-rename'));
    const box = r.container.querySelector('#c-head .title-edit input') as HTMLInputElement;
    // 80 emoji are 80 characters to the API and 160 UTF-16 units: the box keeps them all.
    const emoji = '\u{1F600}'.repeat(80);
    expect(box.maxLength).toBe(-1);
    await setValue(box, emoji);
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(svc.reqs.filter((q) => q.method === 'PATCH').map((q) => q.body)).toEqual([{ title: emoji }]);
    expect(r.container.querySelector('#c-head .title-edit .form-error')?.textContent).toBe('title is at most 120 characters');
    expect(r.container.querySelector('#c-head .title-edit')?.classList.contains('colhead-title')).toBe(false);
    r.unmount();
  });

  it('a session.renamed from the stream reads the list again', async () => {
    const svc = fakeService({ sessions: [row('s1', { title: 'first words' })], events: { s1: oneTurn('s1', 'one') } });
    const r = await mount(svc);
    svc.state.sessions = [row('s1', { title: 'Named elsewhere' })];
    await svc.push(ev({ session: 's1', kind: 'session.renamed', title: 'Named elsewhere', old_title: 'first words' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on .s-tt')?.textContent).toBe('Named elsewhere');
    r.unmount();
  });
});

describe('New session: the machine, then a folder on it', () => {
  const machine = (name: string, id: string, online: boolean) => ({
    id: `run_${name}`,
    name,
    role: 'runner',
    machine: id,
    online,
    last_seen: '2026-11-12T08:00:00Z',
    labels: [],
    harnesses: [],
  });
  const MACHINES = [
    machine('mac', 'con_a', true),
    machine('vm', 'con_c', true),
    machine('box', 'con_b', false),
    // A connector from before 0.5 is never a machine to pick.
    { ...machine('old', 'con_d', true), role: 'connector' },
  ];
  const FOLDERS = [
    { ref: 'fld_00000000000000a1', name: 'app', machine: 'con_a', runner: 'run_mac' },
    { ref: 'fld_00000000000000c1', name: 'infra', machine: 'con_c', runner: 'run_vm' },
  ];
  async function openDialog(svc: ReturnType<typeof fakeService>) {
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    return { r, dialog: r.container.querySelector('.new-dialog')! };
  }
  const picks = (dialog: Element) => Array.from(dialog.querySelectorAll('.nd-recent button')).map((b) => b.textContent);
  const choose = (dialog: Element, v: string) => chooseOpt(dialog, 'machine', v);

  it('lists the machines, offline ones disabled, and shows only the picked machine\'s folders and recents', async () => {
    localStorage.setItem('agentbus.folders.con_a', JSON.stringify(['/Users/ana/web']));
    localStorage.setItem('agentbus.folders.con_c', JSON.stringify(['/work/ops']));
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders: FOLDERS, runners: MACHINES });
    const { r, dialog } = await openDialog(svc);
    const options = await optionsOf(dialog, 'machine');
    expect(options).toEqual([
      ['con_a', 'mac', false],
      ['con_c', 'vm', false],
      ['con_b', 'box', true],
    ]);
    expect(selectIn(dialog, 'machine')!.value).toBe('con_a');
    expect(picks(dialog)).toEqual(['app', '/Users/ana/web']);
    // A folder picked on one machine is dropped when the machine changes.
    await click(dialog.querySelector('.nd-recent button'));
    expect(dialog.querySelector('.nd-recent button.on')?.textContent).toBe('app');
    await choose(dialog, 'con_c');
    expect(picks(dialog)).toEqual(['infra', '/work/ops']);
    expect(dialog.querySelector('.nd-recent button.on')).toBeNull();
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('');
    r.unmount();
  });

  it('a typed path goes with the machine picked, and is remembered for that machine', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders: FOLDERS, runners: MACHINES });
    const { r, dialog } = await openDialog(svc);
    await choose(dialog, 'con_c');
    await setValue(dialog.querySelector('input[name="folder"]'), '/work/new');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    // The folder and the machine go on the workspace; the turn names only the session.
    expect(workspaceBody(svc)).toEqual({ folder: '/work/new', machine: 'con_c', sandbox: true });
    expect(sentBody(svc)).toEqual({ session: 'new1', agent: 'claude', prompt: 'x' });
    expect(JSON.parse(localStorage.getItem('agentbus.folders.con_c') ?? '[]')).toEqual(['/work/new']);
    expect(localStorage.getItem('agentbus.folders')).toBeNull();
    expect(localStorage.getItem('agentbus.machine')).toBe('con_c');
    r.unmount();
  });

  it('offers the machine used last first, while it is online', async () => {
    localStorage.setItem('agentbus.machine', 'con_c');
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders: FOLDERS, runners: MACHINES });
    const { r, dialog } = await openDialog(svc);
    expect(selectIn(dialog, 'machine')!.value).toBe('con_c');
    r.unmount();
  });

  it('with no machine online, it says so and Start stays off', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runners: [machine('box', 'con_b', false)],
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/x');
    expect(dialog.textContent).toContain('No machine is online. Run agentbus runner on one.');
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('a machine gone offline is said in plain words', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runners: MACHINES,
      // The machine is checked when the workspace is created, the first call.
      workspaces: () => json({ error: 'machine con_a is offline; start agentbus runner there, or name another' }, 503),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    await settle();
    expect(dialog.querySelector('.form-error')?.textContent).toBe('That machine is offline. Run agentbus runner on it, or pick another machine.');
    r.unmount();
  });
});

describe('Several folders', () => {
  const mode = (dialog: Element, v: string) => dialog.querySelector(`[data-mode="${v}"]`) as HTMLButtonElement;

  it('+ Add folder takes a second folder, sent as folders on one machine; Direct waits for one folder', async () => {
    const folders = [
      { ref: 'fld_00000000000000a1', name: 'framework', machine: 'con_1', runner: 'run_1' },
      { ref: 'fld_00000000000000b2', name: 'cockpit', machine: 'con_1', runner: 'run_1' },
    ];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const picks = () => Array.from(dialog.querySelectorAll('.nd-recent button')) as HTMLButtonElement[];
    await click(picks()[0]);
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    expect(dialog.querySelector('input[name="folder-2"]')).not.toBeNull();
    expect(mode(dialog, 'direct').disabled).toBe(true);
    // An empty second row stops Start and says so.
    await click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(dialog.querySelector('.nd-missing')?.textContent).toBe('Pick a folder for each row, or remove it.');
    // The new row has focus and the picks: a pick fills it.
    await click(picks()[1]);
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('framework');
    expect((dialog.querySelector('input[name="folder-2"]') as HTMLInputElement).value).toBe('cockpit');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({
      folders: [{ folder_ref: 'fld_00000000000000a1' }, { folder_ref: 'fld_00000000000000b2' }],
      machine: 'con_1',
      sandbox: true,
    });
    r.unmount();
  });

  it('Remove takes a folder back out, and one folder is sent as before', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    await setValue(dialog.querySelector('input[name="folder-2"]'), '/Users/ana/y');
    await click(dialog.querySelector('button[aria-label="Remove folder 2"]') as HTMLButtonElement);
    expect(dialog.querySelector('input[name="folder-2"]')).toBeNull();
    expect(mode(dialog, 'direct').disabled).toBe(false);
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({ folder: '/Users/ana/x', sandbox: true });
    r.unmount();
  });

  it('the same folder in two rows, or folders of two machines, start nothing and say why', async () => {
    const folders = [
      { ref: 'fld_00000000000000a1', name: 'framework', machine: 'con_1', runner: 'run_1' },
      { ref: 'fld_00000000000000c3', name: 'other', machine: 'con_2', runner: 'run_2' },
    ];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const picks = () => Array.from(dialog.querySelectorAll('.nd-recent button')) as HTMLButtonElement[];
    const posts = () => svc.reqs.filter((q) => q.method === 'POST' && q.path === '/api/v0/workspaces').length;
    await click(picks()[0]);
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    await click(picks()[0]);
    // Refused in place, before Start: the second row says so and is marked.
    expect(dialog.querySelector('.nd-dup')?.textContent).toBe('This folder is already in the list.');
    expect((dialog.querySelector('input[name="folder-2"]') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).getAttribute('aria-invalid')).toBeNull();
    await click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(posts()).toBe(0);
    await click(picks()[1]);
    expect(dialog.querySelector('.nd-dup')).toBeNull();
    await click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(dialog.querySelector('.nd-missing')?.textContent).toBe('All folders of a session are on one machine.');
    expect(posts()).toBe(0);
    expect(dialog.querySelector('button[aria-label="Remove folder 2"]')).not.toBeNull();
    r.unmount();
  });

  it('two typed paths that clean the same are one folder; a listed folder in a later row names the machine', async () => {
    const folders = [{ ref: 'fld_00000000000000c3', name: 'other', machine: 'con_2', runner: 'run_2' }];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/work/project');
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    await setValue(dialog.querySelector('input[name="folder-2"]'), '/work/./project/');
    expect(dialog.querySelector('.nd-dup')?.textContent).toBe('This folder is already in the list.');
    await act(async () => (dialog.querySelector('input[name="folder-2"]') as HTMLInputElement).focus());
    await click(dialog.querySelector('.nd-recent button') as HTMLButtonElement);
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'go');
    await submitForm(dialog);
    expect(workspaceBody(svc)).toEqual({
      folders: [{ folder: '/work/project' }, { folder_ref: 'fld_00000000000000c3' }],
      machine: 'con_2',
      sandbox: true,
    });
    r.unmount();
  });

  it('one Folders label; the picks sit under the focused row only and fill it', async () => {
    const folders = ['one', 'two', 'three'].map((n, i) => ({ ref: `fld_000000000000000${i + 1}`, name: n, machine: 'con_1', runner: 'run_1' }));
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const picks = () => Array.from(dialog.querySelectorAll('.nd-recent button')) as HTMLButtonElement[];
    const rows = () => Array.from(dialog.querySelectorAll('input[name^="folder"]')).map((e) => (e as HTMLInputElement).value);
    // The list follows the row with focus: it is the next sibling of that row.
    const listAfter = (name: string) => dialog.querySelector(`input[name="${name}"]`)!.closest('.nd-frow')!.nextElementSibling?.classList.contains('nd-recent');
    // One folder: the one label, and a listed folder shows by its name.
    expect(dialog.querySelector('#nd-folders-label')?.textContent).toBe('Folder');
    await click(picks()[0]);
    expect(rows()).toEqual(['one']);
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    expect(dialog.querySelector('#nd-folders-label')?.textContent).toBe('Folders');
    expect(dialog.textContent).not.toMatch(/Folder \d/);
    // One list, under the row added last (it has focus).
    expect(dialog.querySelectorAll('.nd-recent').length).toBe(1);
    expect(listAfter('folder-3')).toBe(true);
    await click(picks()[2]);
    expect(rows()).toEqual(['one', '', 'three']);
    // Focus on row 2 moves the list there, and a pick fills row 2.
    await act(async () => (dialog.querySelector('input[name="folder-2"]') as HTMLInputElement).focus());
    expect(dialog.querySelectorAll('.nd-recent').length).toBe(1);
    expect(listAfter('folder-2')).toBe(true);
    expect(picks().filter((b) => b.classList.contains('on'))).toEqual([]);
    await click(picks()[1]);
    expect(rows()).toEqual(['one', 'two', 'three']);
    r.unmount();
  });

  it('a remove icon on every row only when there are two or more', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const removes = () => Array.from(dialog.querySelectorAll('button.nd-remove')).map((b) => b.getAttribute('aria-label'));
    expect(removes()).toEqual([]);
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    expect(removes()).toEqual(['Remove folder 1', 'Remove folder 2']);
    await setValue(dialog.querySelector('input[name="folder-2"]'), '/Users/ana/y');
    // The first row can go too; the other row is left, with no icon.
    await click(dialog.querySelector('button[aria-label="Remove folder 1"]') as HTMLButtonElement);
    expect(removes()).toEqual([]);
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('/Users/ana/y');
    expect(document.activeElement).toBe(dialog.querySelector('input[name="folder"]'));
    r.unmount();
  });

  it('the picks show each folder once: one recent path in two spellings, and a recent path of a listed folder', async () => {
    localStorage.setItem('agentbus.folders', JSON.stringify(['/Users/ana/Sites/app', '/Users/ana/x', '/Users/ana/x/', '/Users/ana/y']));
    const folders = [{ ref: 'fld_00000000000000a1', name: 'app' }];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(Array.from(dialog.querySelectorAll('.nd-recent button')).map((b) => b.textContent)).toEqual(['app', '/Users/ana/x', '/Users/ana/y']);
    r.unmount();
  });

  it('focus stays in the dialog when a row is added or removed', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await click(dialog.querySelector('button.nd-add-folder') as HTMLButtonElement);
    expect(document.activeElement).toBe(dialog.querySelector('input[name="folder-2"]'));
    await click(dialog.querySelector('button[aria-label="Remove folder 2"]') as HTMLButtonElement);
    expect(document.activeElement).toBe(dialog.querySelector('input[name="folder"]'));
    r.unmount();
  });

  it('Direct shows no + Add folder', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await click(mode(dialog, 'direct'));
    expect(dialog.querySelector('button.nd-add-folder')).toBeNull();
    r.unmount();
  });
});

describe('what the cockpit asks the service for (performance, 2026-11-28)', () => {
  // A 200-turn session opened after a restart (no text cached), then a running
  // turn whose stream makes the list be read again every 2 s for 60 s.
  it('a 200-turn session after a restart, then 60 s of a running turn', async () => {
    // The browser tells the chat which turns are near the screen; here the
    // test does, as a scroll would.
    const observed: { cb: IntersectionObserverCallback; els: Element[] }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        els: Element[] = [];
        constructor(public cb: IntersectionObserverCallback) {
          observed.push(this);
        }
        observe(el: Element) {
          this.els.push(el);
        }
        disconnect() {}
      }
    );
    const events: CockpitEvent[] = [];
    for (let n = 1; n <= 200; n++) events.push(...oneTurn('s1', `message ${n}`, n));
    const svc = fakeService({ sessions: [row('s1', { turns: 200, resumable: true })], events: { s1: events } });
    const r = await mount(svc);
    await settle();
    const lists = () => svc.reqs.filter((q) => q.method === 'GET' && q.path === '/api/v0/turns' && (q.query ?? '').includes('session=s1')).length;
    const texts = () => svc.reqs.filter((q) => q.method === 'GET' && /^\/api\/v0\/turns\/[^/]+$/.test(q.path)).length;
    // Opened: both pages of the list once, and the text of the newest 20 turns.
    expect({ lists: lists(), texts: texts() }).toEqual(CALLS.open);
    const bubbles = () => [...r.container.querySelectorAll('#convo .tb')].map((t) => t.querySelector('.m-user .bubble')?.textContent ?? '');
    expect(bubbles().length).toBe(200);
    expect(bubbles().slice(-20)).toEqual(Array.from({ length: 20 }, (_, i) => `message ${181 + i}`));
    // Scrolled to the top: the first turns come near the screen, and their text is read.
    const io = observed[observed.length - 1];
    await act(async () => {
      io.cb(io.els.slice(0, 3).map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), io as never);
      await new Promise((done) => setTimeout(done, 80));
    });
    await settle();
    expect(bubbles().slice(0, 3)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(texts()).toBe(CALLS.open.texts + 3);
    const before = { lists: lists(), texts: texts() };
    // 60 s of a running turn: one stream event every 2 s, each re-reading the list.
    // The end-poll reads that same turn on a wall clock (queuedTurn is
    // GET /turns/<id>, the text read). How many of those land depends on how
    // long this loop takes, so the count is not the list. Hold the clock
    // still; the budget below is one text read of the running turn per list read.
    vi.stubGlobal('setInterval', () => 0);
    vi.stubGlobal('clearInterval', () => {});
    try {
      await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'T201-s1', exchange: 'x201', text: 'message 201' }));
      for (let i = 0; i < 29; i++) {
        await svc.push(ev({ session: 's1', kind: i % 2 ? 'model.responded' : 'model.requested', turn: 'T201-s1', exchange: 'x201', status: 200, text: 'ok' }));
        await settle();
      }
      await settle();
      expect({ lists: lists() - before.lists, texts: texts() - before.texts }).toEqual(CALLS.poll);
      expect(r.container.querySelector('#convo')!.textContent).toContain('message 201');
    } finally {
      vi.unstubAllGlobals();
    }
    r.unmount();
  }, 30_000);
});

// What the counting test above measured. Before (0.6.7): opening read 2 list
// pages and 200 texts; 60 s of a running turn read 90 list pages and 32 texts.
// The busy stream now re-reads the running turn once per list read. The 2s
// end-poll is the same GET and is held still above, so it is not in this count.
const CALLS = { open: { lists: 2, texts: 20 }, poll: { lists: 30, texts: 30 } };
