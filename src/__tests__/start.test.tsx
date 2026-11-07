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
import { click, ev, flush, panelOpen, render, rowSession, showDetails, shownSession } from './helpers';

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
  body: unknown;
}

// A fake service. `sessions` and `events` can be changed during a test; the
// stream sends whatever push() is given.
function fakeService(opts: {
  sessions: ReturnType<typeof row>[];
  events?: Record<string, CockpitEvent[]>;
  agents?: unknown[];
  runs?: (body: unknown) => Response | Promise<Response>;
  // POST /turns with session: a session's next turn.
  messages?: (id: string, body: unknown) => Response | Promise<Response>;
  // Turns per page of GET /turns.
  turnPage?: number;
}) {
  const reqs: Req[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let seq = 100;
  const state = { sessions: opts.sessions, events: opts.events ?? {} };
  // Stored events have a seq: number the ones the test gave in order.
  let stored = 0;
  for (const list of Object.values(state.events)) for (const e of list) e.seq ??= ++stored;
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    reqs.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (p === '/api/v0/sessions') return json({ store: 'st_1', seq, sessions: state.sessions });
    if (p === '/api/v0/agents') return json({ agents: opts.agents ?? [] });
    const session = (body as { session?: string } | undefined)?.session;
    if (p === '/api/v0/runs') return json({ error: 'no such API path' }, 404);
    if (p === '/api/v0/turns' && method === 'POST' && session) {
      return opts.messages
        ? opts.messages(session, body)
        : json({ id: session, turn: 'Tnext', base_url: `${BASE}/s/${session}/t/Tnext` }, 202);
    }
    if (p === '/api/v0/turns' && method === 'POST')
      return opts.runs ? opts.runs(body) : json({ id: 'new1', turn: 'Tn', base_url: `${BASE}/s/new1/t/Tn` }, 202);
    if (p === '/api/v0/turns' && method === 'GET') {
      // Newest first, opts.turnPage turns a page, paged by before.
      const all = apiTurns(state.events[url.searchParams.get('session') ?? ''] ?? []);
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const older = all.filter((t) => t.started_seq < before);
      const page = older.slice(0, opts.turnPage ?? 100);
      const more = older.length > page.length;
      return json({ store: 'st_1', seq, turns: page, next_before: more ? page[page.length - 1].started_seq : null });
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

const AGENTS = [
  { name: 'claude', found: true, version: '2.1.318', signed_in: true },
  { name: 'codex', found: false },
];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('New session', () => {
  it('the dialog lists agents from /agents and disables the ones not installed', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(dialog).not.toBeNull();
    const options = Array.from(dialog.querySelectorAll('select[name="agent"] option')) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['claude', 'codex']);
    expect(options[0].disabled).toBe(false);
    expect(options[1].disabled).toBe(true);
    expect(options[1].textContent).toContain('not installed');
    // Read only is off by default, with a line saying what that means.
    const ro = dialog.querySelector('input[name="read_only"]') as HTMLInputElement;
    expect(ro.checked).toBe(false);
    expect(dialog.textContent).toMatch(/follows its own permission settings/);
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
    expect(run?.body).toEqual({ agent: 'claude', folder: '/Users/ana/x', prompt: 'read the README', read_only: false });
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

  it('a refused run shows the API message and keeps the dialog open', async () => {
    const svc = fakeService({
      sessions: [row('s1')],
      events: { s1: oneTurn('s1', 'hi') },
      agents: AGENTS,
      runs: () => json({ error: 'folder is not an existing directory' }, 400),
    });
    const r = await mount(svc);
    await click(r.container.querySelector('#sessions button.new-session'));
    await settle();
    const dialog = r.container.querySelector('.new-dialog')!;
    await setValue(dialog.querySelector('input[name="folder"]'), '/nope');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'x');
    await submitForm(dialog);
    expect(r.container.querySelector('.new-dialog .form-error')?.textContent).toBe('folder is not an existing directory');
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
    await act(async () => replies.B(json({ id: 'B', turn: 'TB2', base_url: `${BASE}/s/B/t/TB2` }, 202)));
    await settle();
    await act(async () => replies.A(json({ id: 'A', turn: 'TA2', base_url: `${BASE}/s/A/t/TA2` }, 202)));
    await settle();
    await svc.push(ev({ session: 'B', kind: 'turn.started', turn: 'TB2', text: 'second in B' }));
    await settle();
    const marked = r.container.querySelector('#convo .tb.lvl-sel');
    expect(marked?.querySelector('.bubble')?.textContent).toBe('second in B');
    r.unmount();
  });

  // A start whose reply lands after the person picked something
  // else must not pull them to the new session when it is listed.
  for (const how of ['session', 'agent'] as const) {
    it(`a start whose reply lands after a pick of another ${how} leaves the selection where it was put`, async () => {
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
        want = 's2';
      }
      await settle();
      expect(r.container.querySelector('#sessions .sess.on code')?.textContent).toBe(want);

      // The reply lands, and the new session is listed.
      await act(async () => reply!(json({ id: 'new1', turn: 'Tn', base_url: `${BASE}/s/new1/t/Tn` }, 202)));
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
    await svc.push(ev({ session: 's1', kind: 'turn.started', turn: 'Tnext', text: 'go' }));
    await settle();
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    // The agent exits 1 before any model call: the turn is over.
    await svc.push(ev({ session: 's1', kind: 'session.closed', hold: 'h2', turn: 'Tnext', exit_code: 1 }));
    await settle();
    const states = Array.from(r.container.querySelectorAll('#convo .tb')).map((t) => t.querySelector('.tb-state')?.textContent ?? '');
    expect(states).toEqual(['', 'failed']);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(false);
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
    expect(sent?.body).toEqual({ session: 's1', prompt: 'and now the tests', read_only: false });
    const pending = r.container.querySelector('.tb.pending .bubble');
    expect(pending?.textContent).toBe('and now the tests');
    // While it is pending, the box waits.
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);

    // The turn fills in from the stream and the pending copy goes.
    for (const e of oneTurn('s1', 'and now the tests', 2)) await svc.push(e);
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
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('started in a terminal; continue it there');
    r.unmount();
  });

  it('is disabled while a turn is running, with the reason', async () => {
    const running = oneTurn('s1', 'first').slice(0, 2); // started and requested, no reply yet
    const svc = fakeService({ sessions: [row('s1', { resumable: true, open: true })], events: { s1: running } });
    const r = await mount(svc);
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('a turn is running');
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

  it('keeps Send disabled between the reply and session.closed, and enables it after', async () => {
    const svc = fakeService({ sessions: [row('s1', { resumable: true, open: true })], events: { s1: closing('s1') } });
    const r = await mount(svc);
    // The reply is on screen; the turn is not closed.
    expect(r.container.querySelector('#convo .m-agent')?.textContent).toContain('ok');
    expect(box(r).disabled).toBe(true);
    expect(sendBtn(r).disabled).toBe(true);
    expect(sendBtn(r).textContent).toBe('finishing…');
    expect(r.container.querySelector('#c-reply .reply-why')?.textContent).toBe('finishing the last turn');
    expect(r.container.querySelector('#c-reply .form-error')).toBeNull();

    // A reply event alone does not enable it.
    await svc.push(ev({ session: 's1', kind: 'turn.completed', turn: 'T1-s1', exchange: 'x1', outcome: 'finished' }));
    await settle();
    expect(sendBtn(r).disabled).toBe(true);

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

  it('on a 409 shows the service reason and keeps the typed text', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () => json({ error: 'a turn is already running in this session' }, 409),
    });
    const r = await mount(svc);
    await setValue(box(r), 'again');
    await submitForm(r.container.querySelector('#c-reply form'));
    expect(r.container.querySelector('#c-reply .form-error')?.textContent).toBe('a turn is already running in this session');
    expect(r.container.querySelector('.tb.pending')).toBeNull();
    expect(box(r).value).toBe('again');
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
    expect(r.container.querySelector('#c-reply .form-error')?.textContent).toBe('this session cannot be continued from here');
    expect(box(r).value).toBe('again');
    r.unmount();
  });
});

describe('Add agent', () => {
  it('lists agents from /agents: version and signed-in state, or not installed', async () => {
    const svc = fakeService({ sessions: [row('s1')], events: { s1: oneTurn('s1', 'hi') }, agents: AGENTS });
    const r = await mount(svc);
    await click(r.container.querySelector('#agents button.add-agent'));
    await settle();
    const items = Array.from(r.container.querySelectorAll('.agent-list li')).map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('claude');
    expect(items[0]).toContain('2.1.318');
    expect(items[0]).toContain('signed in');
    expect(items[1]).toContain('codex');
    expect(items[1]).toContain('not installed');
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
    svc.reqs.filter((q) => q.path === `/api/v0/turns/${turn}/events`).length;

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
    expect(svc.reqs.some((q) => /\/sessions\/[^/]+\/events$/.test(q.path))).toBe(false);
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
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.tb-state')?.textContent).toBe('running');

    // A tool call of the open turn (turn 1) joins its events from the stream:
    // no read of its events, and no read of the list (a tool call changes no row).
    const reads = turnReads(svc);
    await svc.push(ev({ session: 's1', kind: 'tool.requested', turn: 'T1-s1', exchange: 'x1', tool_id: 'z', tool_name: 'Zed' }));
    await settle();
    expect(eventReads(svc, 'T1-s1')).toBe(1);
    expect(turnReads(svc)).toBe(reads);
    await showDetails(r.container);
    expect(Array.from(r.container.querySelectorAll('#convo .wl.tool .wk')).map((w) => w.textContent)).toEqual(['Zed']);

    // The new turn ends: the list is read again and its state follows.
    await svc.push(ev({ session: 's1', kind: 'turn.completed', turn: 'T9', exchange: 'x9', outcome: 'finished' }));
    await settle();
    expect(r.container.querySelectorAll('#convo .tb')[1].querySelector('.tb-state')).toBeNull();
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

const headers = (r: { container: HTMLElement }) =>
  Array.from(r.container.querySelectorAll('.tb .tb-h')).map((h) => h.querySelector('.tb-cont')?.textContent ?? null);

describe('How a turn continued', () => {
  it('shows how a turn continued only while that turn is selected', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true, turns: 2 })],
      events: { s1: [...oneTurn('s1', 'first'), ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' })] },
    });
    const r = await mount(svc);
    // Nothing picked: a plain chat.
    expect(headers(r)).toEqual([null, null]);
    const blocks = () => r.container.querySelectorAll('.tb');
    await click(blocks()[1]);
    await settle();
    expect(headers(r)).toEqual([null, 'continued from turn 1']);
    // Another turn picked: the note goes with the selection.
    await click(blocks()[0]);
    await settle();
    expect(headers(r)).toEqual([null, null]);
    // The panel closed: none.
    await click(blocks()[1]);
    await settle();
    await click(r.container.querySelector('#p-head .p-close'));
    expect(headers(r)).toEqual([null, null]);
    r.unmount();
  });

  it('shows "continued from turn N" for own replay, quietly in the header', async () => {
    const { r } = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1' }),
    ]);
    expect(headers(r)).toEqual([null, 'continued from turn 1']);
    r.unmount();
  });

  it('shows "resumed" for the vendor resume, and nothing without continuity', async () => {
    const a = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', { continuity: 'resume' })]);
    expect(headers(a.r)).toEqual([null, 'resumed']);
    a.r.unmount();
    const b = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', {})]);
    expect(headers(b.r)).toEqual([null, null]);
    b.r.unmount();
  });

  it('shows "continued after turn N was interrupted (reason)" from recovered_from and recovered_reason', async () => {
    const a = await openTurn2([
      ...oneTurn('s1', 'first'),
      ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1', recovered_from: ' T1-s1 ', recovered_reason: 'the agent stopped' }),
    ]);
    expect(headers(a.r)[1]).toBe('continued after turn 1 was interrupted (the agent stopped)');
    a.r.unmount();
    const b = await openTurn2([...oneTurn('s1', 'first'), ...nextTurn('s1', { recovered_from: 'T1-s1' })]);
    expect(headers(b.r)[1]).toBe('continued after turn 1 was interrupted');
    b.r.unmount();
  });

  it.each([['{}', {}], ['[]', []], ['{foo}', { foo: 'bar' }], ['blank', '   '], ['number', 42]])(
    'ignores a recovered_from of %s and shows the replay label',
    async (_n, value) => {
      const { r } = await openTurn2([
        ...oneTurn('s1', 'first'),
        ...nextTurn('s1', { continuity: 'replay', replay_from: 'T1-s1', recovered_from: value }),
      ]);
      expect(headers(r)).toEqual([null, 'continued from turn 1']);
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
    // Turn 1 picked: turn 2's continuity note goes, its error stays.
    await click(r.container.querySelectorAll('.tb')[0]);
    await settle();
    expect(headers(r)).toEqual([null, null]);
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

  it('shows the service reason for a plain-text error and keeps the typed message', async () => {
    const svc = fakeService({
      sessions: [row('s1', { resumable: true })],
      events: { s1: oneTurn('s1', 'first') },
      messages: () =>
        new Response('session s1 was continued by own replay, and no turn of it has a finished reply to replay', { status: 409 }),
    });
    const r = await mount(svc);
    await setValue(r.container.querySelector('#c-reply textarea'), 'try again');
    await submitForm(r.container.querySelector('#c-reply form'));
    expect(r.container.querySelector('#c-reply .form-error')?.textContent).toBe(
      'session s1 was continued by own replay, and no turn of it has a finished reply to replay'
    );
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).value).toBe('try again');
    r.unmount();
  });
});
