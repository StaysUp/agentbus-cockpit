// @vitest-environment jsdom
// Starting sessions and continuing them from the cockpit, against a fake
// client API (GET /agents, POST /turns, with session for a next turn).
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
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
      prompt: t.detail!.rawPrompt ?? '',
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
  runs?: (body: unknown) => Response | Promise<Response>;
  // POST /turns with session: a session's next turn.
  messages?: (id: string, body: unknown) => Response | Promise<Response>;
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
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    reqs.push({ method, path: url.pathname, query: url.search, body });
    const p = url.pathname;
    if (p === '/api/v0/sessions') return json({ store: 'st_1', seq, sessions: state.sessions });
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
    if (p === '/api/v0/turns' && method === 'POST' && session) {
      return opts.messages
        ? opts.messages(session, body)
        : json({ session: session, turn: 'Tnext', state: 'running', base_url: `${BASE}/s/${session}/t/Tnext` }, 202);
    }
    if (p === '/api/v0/turns' && method === 'POST')
      return opts.runs ? opts.runs(body) : json({ session: 'new1', turn: 'Tn', state: 'running', base_url: `${BASE}/s/new1/t/Tn` }, 202);
    if (p === '/api/v0/turns' && method === 'GET') {
      // Newest first, opts.turnPage turns a page, paged by before.
      const all = apiTurns(state.events[url.searchParams.get('session') ?? ''] ?? []).map((t) => ({ ...t, ...opts.turnFields?.[t.id] }));
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const older = all.filter((t) => t.started_seq < before);
      const page = older.slice(0, opts.turnPage ?? 100);
      const more = older.length > page.length;
      return json({ store: 'st_1', seq, turns: page, next_before: more ? page[page.length - 1].started_seq : null });
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
  { kind: 'openrouter', label: 'OpenRouter key', models: ['deepseek/deepseek-v4.1-flash'], any_model: true, key_env: 'OPENROUTER_API_KEY', key_set: true },
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

    const run = svc.reqs.find((q) => q.path === '/api/v0/turns' && q.method === 'POST');
    expect(run?.method).toBe('POST');
    expect(run?.body).toEqual({ agent: 'claude', folder: '/Users/ana/x', prompt: 'read the README' });
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/x']);
    // Folders only: nothing else is kept in localStorage.
    expect(Object.keys(localStorage)).toEqual(['agentbus.folders']);

    // The new session appears in the stream; the cockpit selects it.
    svc.state.sessions = [row('new1', { open: true, resumable: false, last: '2026-11-05T10:00:00Z' }), row('s1')];
    await svc.push(ev({ session: 'new1', kind: 'session.registered', agent: 'claude', folder: '/Users/ana/x' }));
    await svc.push(ev({ session: 'new1', kind: 'turn.started', turn: 'Tn', exchange: 'xn', text: 'read the README' }));
    await settle();
    expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe('new1');
    expect(r.container.querySelector('.tb .bubble')?.textContent).toBe('read the README');
    r.unmount();
  });

  it('on a service that lists folders, none is picked for the person; the one picked goes by folder_ref and connector', async () => {
    const folders = [
      { ref: 'fld_00000000000000a1', name: 'app', connector: 'con_1', runner: 'run_1' },
      { ref: 'fld_00000000000000b2', name: 'site', connector: 'con_2', runner: 'run_2' },
    ];
    localStorage.setItem('agentbus.folders', JSON.stringify(['/Users/ana/old']));
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    const picks = Array.from(dialog.querySelectorAll('.nd-recent button')) as HTMLButtonElement[];
    expect(picks.map((b) => b.textContent)).toEqual(['app', 'site', '/Users/ana/old']);
    // Nothing is picked until the person picks: Start waits for a folder.
    expect(dialog.querySelector('.nd-recent button.on')).toBeNull();
    expect((dialog.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('');
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.textContent).toContain('Pick a folder to start.');
    await click(picks[1]);
    expect(picks[1].classList.contains('on')).toBe(true);
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    expect(sentBody(svc)).toEqual({ agent: 'claude', folder_ref: 'fld_00000000000000b2', connector: 'con_2', isolate: true, prompt: 'read the README' });
    expect(r.container.querySelector('.new-dialog')).toBeNull();
    // A folder by reference is not a path to remember.
    expect(JSON.parse(localStorage.getItem('agentbus.folders') ?? '[]')).toEqual(['/Users/ana/old']);
    r.unmount();
  });

  it('a path typed over a listed folder is sent as a path', async () => {
    const folders = [{ ref: 'fld_00000000000000a1', name: 'app', connector: 'con_1' }];
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    expect(dialog.querySelector('.nd-recent button.on')).toBeNull();
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(sentBody(svc)).toEqual({ agent: 'claude', folder: '/Users/ana/x', prompt: 'x' });
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

  it('with no sessions, the columns show a short line and the New session button', async () => {
    const svc = fakeService({ sessions: [], agents: AGENTS });
    const r = await mount(svc);
    const empty = r.container.querySelector('.empty-state');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No sessions yet');
    expect(empty?.querySelector('button.new-session')).not.toBeNull();
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
    await svc.push(ev({ session: 'new1', kind: 'session.opened', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
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
    await svc.push(ev({ session: 'new1', kind: 'session.opened', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
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
      await svc.push(ev({ session: 'new1', kind: 'session.opened', hold: 'h1', turn: 'Tn', agent: 'claude', folder: '/Users/ana/x' }));
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
    await svc.push(ev({ session: 's1', kind: 'session.opened', hold: 'h2', turn: 'Tnext' }));
    await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'Tnext', text: 'go', idempotency_key: sentKey(svc) }));
    await settle();
    // A running turn never blocks the box: a message would queue behind it.
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    // The agent exits 1 before any model call: the turn is over.
    await svc.push(ev({ session: 's1', kind: 'session.closed', hold: 'h2', turn: 'Tnext', exit_code: 1 }));
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
    expect(sentBody(svc)).toEqual({ agent: 'claude', folder: '/Users/ana/x', prompt: 'read the README' });
    expect(patches(svc).map((q) => [q.path, q.body])).toEqual([['/api/v0/sessions/new1', { title: 'Login fix' }]]);
    r.unmount();
  });

  it('with no name, nothing renames the session', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'read the README');
    await submitForm(dialog);
    await settle();
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
      agent: 'claude',
      folder: '/Users/ana/x',
      prompt: 'read the README',
      read_only: false,
      idempotency_key: expect.stringMatching(/^cockpit-msg-/),
    });
    expect(patches(svc).map((q) => [q.path, q.body])).toEqual([['/api/v0/sessions/new1', { title: 'Login fix' }]]);
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
    const folders = [{ ref: 'fld_00000000000000a1', name: 'app', connector: 'con_1' }];
    const answers = [
      'folder must be an absolute path to an existing directory, at most 4096 bytes',
      'this server has no folders of its own: name folder_ref and connector from GET /api/v0/folders, which lists the folders its runners own',
    ];
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      folders,
      runs: () => json({ error: answers.shift() }, 400),
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
    expect(sent?.body).toEqual({ session: 's1', prompt: 'and now the tests', read_only: false, idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
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
      'The first turn did not start: the agent could not be started. Start a new conversation.'
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
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('This conversation cannot take another message. Start a new one.');
    r.unmount();
  });

  it('is disabled for a closed session, which the list and the header mark', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true, closed: '2026-11-11T09:00:00Z' })], events: { s1: oneTurn('s1', 'first') } });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('This conversation is closed; start a new one.');
    expect(r.container.querySelector('#c-head .c-closed')?.textContent).toBe('closed');
    expect(r.container.querySelector('#sessions [data-session="s1"] .s-m')?.textContent).toMatch(/^closed · /);
    r.unmount();
  });

  it('marks a session closed when only GET /sessions/<id> says so, on its copy', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      oneSession: (id) => json({ store: 'st_1', seq: 1, session: row(id), copy: { runner: 'run_1', kind: 'copy', name: id, closed: '2026-11-11T09:00:00Z' } }),
    });
    const r = await mount(svc);
    expect(svc.reqs.some((q) => q.method === 'GET' && q.path === '/api/v0/sessions/s1')).toBe(true);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('This conversation is closed; start a new one.');
    expect(r.container.querySelector('#sessions [data-session="s1"] .s-m')?.textContent).toMatch(/^closed · /);
    r.unmount();
  });

  it('keeps Send for a session whose copy is not closed', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      oneSession: (id) => json({ store: 'st_1', seq: 1, session: row(id), copy: { runner: 'run_1', kind: 'copy', name: id } }),
    });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
    expect(r.container.querySelector('#c-head .c-closed')).toBeNull();
    r.unmount();
  });

  it("shows a failed turn's error text on the turn", async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      turnFields: { 'T1-s1': { state: 'failed', error: 'the relay refused: quota reached' } },
    });
    const r = await mount(svc);
    expect(r.container.querySelector('.tb .turn-error')?.textContent).toBe('the relay refused: quota reached');
    expect(r.container.querySelector('.tb .tb-state')?.textContent).toBe('failed');
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

  // A turn whose reply is stored but whose session.closed is not: the service
  // holds it open for its last writes, so Send must wait.
  const closing = (session: string) => [
    ev({ session, kind: 'session.opened', turn: `T1-${session}`, hold: 'h1' }),
    ...oneTurn(session, 'first').slice(0, 3).map((e) => ({ ...e, session, turn: `T1-${session}` })),
  ];
  const sendBtn = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply button.go') as HTMLButtonElement;
  const box = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;

  it('between the reply and session.closed a message queues; after it, Send', async () => {
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

    // session.closed arrives: the row is no longer open, the turn is finished.
    svc.state.sessions = [row('s1', { resumable: true, open: false })];
    await svc.push(ev({ session: 's1', kind: 'session.closed', turn: 'T1-s1', hold: 'h1', exit_code: 0 }));
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

  it('+ Agent opens the form: Harness, Access, Model, Name, then the extras, disabled', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    expect(formLabels(r)).toEqual([
      'Harness',
      'Access',
      'Model',
      'Name',
      'Models this agent can use',
      'MCP servers',
      'Skills',
      'Instruction files',
      'Programs that run on it',
    ]);
    const form = r.container.querySelector('.agent-form')!;
    // opencode is listed and cannot be picked; the API key is shown and disabled.
    expect((form.querySelector('[data-harness="opencode"]') as HTMLButtonElement).disabled).toBe(true);
    expect((form.querySelector('[data-access="api"]') as HTMLButtonElement).disabled).toBe(true);
    expect(Array.from(form.querySelectorAll('.f-off [role="combobox"]')).every((x) => (x as HTMLButtonElement).disabled)).toBe(true);
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
    // The key variable is an advanced field, closed and empty: control adds
    // the key set in Settings, or reads the default variable.
    expect((form().querySelector('input[name="key_env"]') as HTMLInputElement).value).toBe('');
    expect((form().querySelector('details.ad-advanced') as HTMLDetailsElement).open).toBe(false);
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
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
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

  it('while a remove is in flight, Edit and Remove wait; then the row is gone', async () => {
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
    expect((r.container.querySelector('#agents [data-agent="codex"] .ag-edit') as HTMLButtonElement).disabled).toBe(true);
    expect((r.container.querySelector('#agents [data-agent="codex"] .ag-remove') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await settle();
    expect(svc.reqs.find((q) => q.method === 'DELETE')?.path).toBe('/api/v0/agents/codex');
    expect(r.container.querySelector('#agents [data-agent="codex"]')).toBeNull();
    r.unmount();
  });

  it('a row edits its agent with PUT, and one click on Remove removes it', async () => {
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
    await expect(result).resolves.toBe('agentbus at http://127.0.0.1:8787 did not answer within 10 seconds');
  });

  it('a fetch that never answers gives the same error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const result = checkConnection({ address: 'http://127.0.0.1:8787', token: 't' }, 'http://localhost:5173');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('agentbus at http://127.0.0.1:8787 did not answer within 10 seconds');
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
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.m-live')?.textContent).toMatch(/^Starting the agent · \d+s$/);

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
  const machine = (name: string, connector: string, online: boolean) => ({
    id: `run_${name}`,
    name,
    role: 'runner',
    connector,
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
    { ref: 'fld_00000000000000a1', name: 'app', connector: 'con_a', runner: 'run_mac' },
    { ref: 'fld_00000000000000c1', name: 'infra', connector: 'con_c', runner: 'run_vm' },
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
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('a typed path goes with the machine picked, and is remembered for that machine', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS, folders: FOLDERS, runners: MACHINES });
    const { r, dialog } = await openDialog(svc);
    await choose(dialog, 'con_c');
    await setValue(dialog.querySelector('input[name="folder"]'), '/work/new');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(sentBody(svc)).toEqual({ agent: 'claude', folder: '/work/new', connector: 'con_c', prompt: 'x' });
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
    expect(dialog.textContent).toContain('No machine is online. Start agentbus runner on one.');
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('a machine gone offline is said in plain words', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runners: MACHINES,
      runs: () => json({ error: 'machine con_a is offline; start agentbus runner there, or name another' }, 503),
    });
    const { r, dialog } = await openDialog(svc);
    await setValue(dialog.querySelector('input[name="folder"]'), '/x');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    await settle();
    expect(dialog.querySelector('.form-error')?.textContent).toBe('That machine is offline. Start agentbus runner on it, or pick another machine.');
    r.unmount();
  });
});
