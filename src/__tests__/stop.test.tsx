// @vitest-environment jsdom
// Stopping a running turn from the message box, against a fake client API
// (POST /api/v0/turns/<id>/stop).
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { LiveDataSource } from '../data/LiveDataSource';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { buildTurns } from '../data/turns';
import { CockpitEvent, DataSource } from '../types';
import { click, ev, flush, jsonl, render } from './helpers';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function row(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    agent: 'codex',
    folder: '/w',
    started: '2026-11-07T09:00:00Z',
    last: '2026-11-07T09:10:00Z',
    open: true,
    resumable: true,
    turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...fields,
  };
}

// A turn a run started: its agent is running and has asked the model once.
function runningTurn(session: string, agent = 'codex'): CockpitEvent[] {
  return [
    ev({ session, kind: 'session.opened', turn: 'T1', hold: 'h1' }),
    ev({ session, kind: 'turn.started', turn: 'T1', text: 'sleep 120', agent, folder: '/w' }),
    ev({ session, kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ];
}

// GET /api/v0/turns rows, newest first, by the service's rules as the replay
// source applies them.
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
      started_seq: t.startedSeq!,
      started: t.startedAt,
      ended: t.endedAt,
      state: t.state,
      stopped: t.stopped,
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
  body: unknown;
}

function fakeService(opts: { sessions: ReturnType<typeof row>[]; events: Record<string, CockpitEvent[]>; stop?: () => Response }) {
  const reqs: Req[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let seq = 100;
  const state = { sessions: opts.sessions, events: opts.events };
  let stored = 0;
  for (const list of Object.values(state.events)) for (const e of list) e.seq ??= ++stored;
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    reqs.push({ method, path: url.pathname, body: init?.body });
    const p = url.pathname;
    if (p === '/api/v0/sessions') return json({ store: 'st_1', seq, sessions: state.sessions });
    if (p === '/api/v0/turns' && method === 'GET') {
      const all = apiTurns(state.events[url.searchParams.get('session') ?? ''] ?? []);
      return json({ store: 'st_1', seq, turns: all, next_before: null });
    }
    const stop = p.match(/^\/api\/v0\/turns\/([^/]+)\/stop$/);
    if (stop && method === 'POST') {
      return opts.stop ? opts.stop() : json({ id: 's1', turn: decodeURIComponent(stop[1]) }, 202);
    }
    const m = p.match(/^\/api\/v0\/turns\/([^/]+)\/events$/);
    if (m && method === 'GET') {
      const turn = decodeURIComponent(m[1]);
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
  // Store an event, then stream it.
  const push = async (e: CockpitEvent) => {
    e.seq = ++seq;
    (state.events[e.session] ??= []).push(e);
    await act(async () => {
      for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    });
  };
  return { fn, reqs, push, state };
}

async function settle() {
  for (let i = 0; i < 6; i++) await flush();
}

async function mount(svc: ReturnType<typeof fakeService>) {
  vi.stubGlobal('fetch', svc.fn);
  const r = await render(<App dataSource={new LiveDataSource({ baseUrl: BASE, token: 't' })} />);
  await settle();
  return r;
}

const goBtn = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply button.go') as HTMLButtonElement;
const footState = (r: { container: HTMLElement }) => r.container.querySelector('#convo .tb .tb-state');
// A running turn shows its live line where the reply will be, in place of the foot's "running".
const liveLine = (r: { container: HTMLElement }) => r.container.querySelector('#convo .tb .m-live');
const stops = (svc: ReturnType<typeof fakeService>) => svc.reqs.filter((q) => q.method === 'POST' && q.path.endsWith('/stop'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('The Stop button', () => {
  it('takes the place of Send only while a turn a run started is running', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: runningTurn('s1') } });
    const r = await mount(svc);
    expect(goBtn(r).textContent).toBe('Stop');
    expect(goBtn(r).type).toBe('button');
    expect(goBtn(r).disabled).toBe(false);

    // The turn ends on its own: Send comes back.
    svc.state.sessions = [row('s1', { open: false })];
    await svc.push(ev({ session: 's1', kind: 'session.closed', turn: 'T1', hold: 'h1', exit_code: 0 }));
    await settle();
    expect(goBtn(r).textContent).toBe('Send');
    expect(r.container.querySelector('#c-reply button.stop')).toBeNull();
    r.unmount();
  });

  it('is not shown for a running turn no run started (traffic pointed at the gateway by hand)', async () => {
    const handPointed = [
      ev({ session: 's1', kind: 'turn.started', turn: 'T1', text: 'hello' }),
      ev({ session: 's1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
    ];
    const svc = fakeService({ sessions: [row('s1', { resumable: false })], events: { s1: handPointed } });
    const r = await mount(svc);
    expect(liveLine(r)?.textContent).toMatch(/^Waiting on the model · call 1 · \d+s$/);
    // No Stop: a message typed here would queue behind it.
    expect(goBtn(r).textContent).toBe('Queue');
    r.unmount();
  });

  it('calls the API once however fast it is clicked, then shows Stopping… until the turn ends', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: runningTurn('s1') } });
    const r = await mount(svc);
    const btn = goBtn(r);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(stops(svc).length).toBe(1);
    expect(stops(svc)[0].path).toBe('/api/v0/turns/T1/stop');
    expect(stops(svc)[0].body).toBeUndefined();
    expect(goBtn(r).textContent).toBe('Stopping…');
    expect(goBtn(r).disabled).toBe(true);
    expect(footState(r)?.textContent).toBe('stopping…');
    // A click on the disabled button sends nothing more.
    await click(goBtn(r));
    expect(stops(svc).length).toBe(1);

    // Events of the turn still arriving keep it stopping.
    await svc.push(ev({ session: 's1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: '' }));
    await settle();
    expect(goBtn(r).textContent).toBe('Stopping…');
    r.unmount();
  });

  it('shows a stopped turn as "Stopped by you", not as a red failure, and Send comes back', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: runningTurn('s1') } });
    const r = await mount(svc);
    await click(goBtn(r));
    await settle();
    svc.state.sessions = [row('s1', { open: false })];
    await svc.push(ev({ session: 's1', kind: 'session.closed', turn: 'T1', hold: 'h1', exit_code: 143, stopped: true }));
    await settle();
    const state = footState(r)!;
    expect(state.textContent).toBe('Stopped by you');
    expect(state.classList.contains('bad')).toBe(false);
    expect(goBtn(r).textContent).toBe('Send');
    expect(r.container.querySelector('#c-reply .form-error')).toBeNull();
    r.unmount();
  });

  it('on a 409 (the turn had ended) reads the turns again and shows no error', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: runningTurn('s1') },
      stop: () => json({ error: 'the turn is not running' }, 409),
    });
    const r = await mount(svc);
    // The turn ends at the service before the list shows it.
    svc.state.sessions = [row('s1', { open: false })];
    svc.state.events.s1.push({
      ...ev({ session: 's1', kind: 'session.closed', turn: 'T1', hold: 'h1', exit_code: 0 }),
      seq: 99,
    });
    const listReads = () => svc.reqs.filter((q) => q.method === 'GET' && q.path === '/api/v0/turns').length;
    const before = listReads();
    await click(goBtn(r));
    await settle();
    expect(stops(svc).length).toBe(1);
    expect(listReads()).toBeGreaterThan(before);
    expect(r.container.querySelector('#c-reply .form-error')).toBeNull();
    expect(footState(r)).toBeNull(); // finished turns show no state
    expect(goBtn(r).textContent).toBe('Send');
    r.unmount();
  });

  it('shows the API words of any other refusal and offers Stop again', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: runningTurn('s1') },
      stop: () => json({ error: 'the main token only' }, 403),
    });
    const r = await mount(svc);
    await click(goBtn(r));
    await settle();
    expect(r.container.querySelector('#c-reply .form-error')?.textContent).toBe('the main token only');
    expect(goBtn(r).textContent).toBe('Stop');
    expect(goBtn(r).disabled).toBe(false);
    expect(liveLine(r)).not.toBeNull();
    r.unmount();
  });

  it('is never shown for recorded data, which has no stopTurn', async () => {
    const replay = new ReplayDataSource(jsonl(runningTurn('s1')));
    expect((replay as DataSource).stopTurn).toBeUndefined();
    const r = await render(<App dataSource={replay} />);
    await settle();
    expect(footState(r)?.textContent).toBe('running');
    expect(r.container.querySelector('#c-reply button.stop')).toBeNull();
    r.unmount();
  });

  it('a recorded session.closed with stopped reads as stopped', () => {
    const events = [...runningTurn('s1'), ev({ session: 's1', kind: 'session.closed', turn: 'T1', hold: 'h1', exit_code: 143, stopped: true })];
    const [turn] = buildTurns('s1', events);
    expect(turn.state).toBe('failed');
    expect(turn.stopped).toBe(true);
  });
});

describe('LiveDataSource.stopTurn', () => {
  it('posts to /turns/<id>/stop with the token and no body; 202 is stopping, 409 is not running, others reject with the API words', async () => {
    const answers = [
      json({ id: 's1', turn: 'T1' }, 202),
      json({ error: 'the turn is not running' }, 409),
      json({ error: 'no such turn' }, 404),
    ];
    const fn = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fn);
    const src = new LiveDataSource({ baseUrl: BASE, token: 'tok' });
    await expect(src.stopTurn('T1')).resolves.toBe('stopping');
    await expect(src.stopTurn('T1')).resolves.toBe('not-running');
    await expect(src.stopTurn('T/2')).rejects.toThrow('no such turn');
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe(`${BASE}/api/v0/turns/T1/stop`);
    expect(calls[2][0]).toBe(`${BASE}/api/v0/turns/T%2F2/stop`);
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].body).toBeUndefined();
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('reads stopped from the turn list', async () => {
    const turn = {
      id: 'T1', session: 's1', agent: 'codex', folder: '/w', prompt: 'p', started_seq: 1,
      started: '2026-11-07T09:00:00Z', ended: '2026-11-07T09:00:05Z', state: 'failed', stopped: true,
      exit_code: 143, usage: null, cost_usd: 0, cost_complete: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => json({ store: 'st', seq: 2, turns: [turn], next_before: null })));
    const list = await new LiveDataSource({ baseUrl: BASE }).getTurns('s1');
    expect(list.turns[0].stopped).toBe(true);
    expect(list.turns[0].state).toBe('failed');
  });
});
