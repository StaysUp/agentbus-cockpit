// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsColumn } from '../components/AgentsColumn';
import { Cockpit } from '../Cockpit';
import { click, ev, flush, render } from './helpers';

const ADDR = 'http://127.0.0.1:8787';
const TOKEN = 'tok-test-1234';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// An event stream that stays open until the request is aborted.
function openStream(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const summary = {
  id: 'live-abc',
  agent: 'claude',
  folder: '/w',
  started: '2026-11-05T09:00:00Z',
  last: '2026-11-05T09:10:00Z',
  open: true,
  turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const events = [
  ev({ seq: 1, session: 'live-abc', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'live-abc', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'live prompt' }),
  ev({ seq: 3, session: 'live-abc', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 4, session: 'live-abc', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'ok' }),
  ev({ seq: 5, session: 'live-abc', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

// A service that accepts only TOKEN.
function fakeService() {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push({ url: input, auth });
    if (auth !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/v0/sessions') return json({ store: 'st_1', seq: 5, sessions: [summary] });
    if (url.pathname === '/api/v0/events') return openStream(init?.signal);
    if (url.pathname === '/api/v0/turns' && url.searchParams.get('session') === 'live-abc') {
      return json({
        store: 'st_1',
        seq: 5,
        turns: [{ id: 'T1', session: 'live-abc', agent: 'claude', folder: '/w', prompt: 'live prompt', started_seq: 2,
          started: events[1].time, ended: events[4].time, state: 'finished', outcome: 'finished', usage: null,
          cost_usd: 0, cost_complete: false }],
        next_before: null,
      });
    }
    if (url.pathname === '/api/v0/sessions/live-abc/events' && url.searchParams.get('turn') === 'T1') return json({ store: 'st_1', events: events.slice(1), next_after: null });
    return json({}, 404);
  });
  return { fn, calls };
}

// Set an input's value the way a person typing does, so React sees it.
async function type(el: Element | null, value: string) {
  if (!el) throw new Error('no input');
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector('form.connect');
  if (!form) throw new Error('no connect form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
  await flush();
  await flush();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('Connect screen', () => {
  it('shows the address (default) and a password field for the token', async () => {
    const r = await render(<Cockpit />);
    const addr = r.container.querySelector('input[name="address"]') as HTMLInputElement;
    const token = r.container.querySelector('input[name="token"]') as HTMLInputElement;
    expect(addr.value).toBe(ADDR);
    expect(token.type).toBe('password');
    r.unmount();
  });

  it('stores address and token in sessionStorage only, never localStorage or the URL', async () => {
    const svc = fakeService();
    vi.stubGlobal('fetch', svc.fn);
    const hrefBefore = window.location.href;
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);

    expect(sessionStorage.getItem('agentbus.token')).toBe(TOKEN);
    expect(sessionStorage.getItem('agentbus.address')).toBe(ADDR);
    expect(localStorage.length).toBe(0);
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.href).not.toContain(TOKEN);
    expect(svc.calls.length).toBeGreaterThan(0);
    for (const c of svc.calls) expect(c.url).not.toContain(TOKEN);
    r.unmount();
  });

  it('a 401 shows that the token was refused and stores nothing', async () => {
    const svc = fakeService();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), 'wrong');
    await submit(r.container);

    expect(r.container.querySelector('.connect-error')?.textContent).toBe('the token was refused');
    expect(r.container.querySelector('form.connect')).not.toBeNull();
    expect(sessionStorage.getItem('agentbus.token')).toBeNull();
    r.unmount();
  });

  it('a network or CORS failure names the address and the command to start it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);

    expect(r.container.querySelector('.connect-error')?.textContent).toBe(
      `cannot reach agentbus at ${ADDR}; start it with \`agentbus up\` (if it runs with -origin, that must be ${window.location.origin})`
    );
    r.unmount();
  });

  it('a successful check renders the app with the live source', async () => {
    const svc = fakeService();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);

    expect(r.container.querySelector('form.connect')).toBeNull();
    const bubbles = Array.from(r.container.querySelectorAll('.tb .bubble')).map((b) => b.textContent);
    expect(bubbles).toEqual(['live prompt']);
    // The app's reads went to the live service, with the token in the header.
    const paths = svc.calls.map((c) => new URL(c.url).pathname);
    expect(paths).toContain('/api/v0/events');
    expect(paths).toContain('/api/v0/turns');
    // One turn's events, or only the session's "!" commands from before 0.5, never the
    // whole session's.
    const eventReads = svc.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === '/api/v0/sessions/live-abc/events');
    expect(eventReads.length).toBeGreaterThan(0);
    expect(eventReads.every((u) => u.searchParams.get('turn') === 'T1' || (u.searchParams.get('kind') ?? '').startsWith('command.'))).toBe(true);
    expect(svc.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    r.unmount();
  });

  it('disconnect clears storage and goes back to the connect screen', async () => {
    const svc = fakeService();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);
    expect(sessionStorage.getItem('agentbus.token')).toBe(TOKEN);

    await click(r.container.querySelector('button.disconnect'));
    expect(sessionStorage.getItem('agentbus.token')).toBeNull();
    expect(sessionStorage.getItem('agentbus.address')).toBeNull();
    expect(r.container.querySelector('form.connect')).not.toBeNull();
    r.unmount();
  });

  it('offers no way into recorded data in a production render', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    try {
      const r = await render(<Cockpit />);
      expect(r.container.querySelector('form.connect')).not.toBeNull();
      expect(r.container.querySelector('button.use-recorded')).toBeNull();
      expect(r.container.textContent).not.toMatch(/recorded/i);
      expect([...r.container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Connect']);
      r.unmount();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('?recorded in the address opens the recorded data with no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/?recorded');
    const r = await render(<Cockpit />);
    await flush();
    await flush();
    expect(r.container.querySelector('form.connect')).toBeNull();
    expect(r.container.querySelectorAll('.tb').length).toBeGreaterThan(0);
    expect(r.container.querySelector('button.disconnect')?.textContent).toBe('Connect');
    expect(sessionStorage.getItem('agentbus.mode')).toBe('replay');
    expect(fetchSpy).not.toHaveBeenCalled();
    r.unmount();
  });

  it('?recorded wins over a saved connection: no check runs and the token is dropped', async () => {
    sessionStorage.setItem('agentbus.address', ADDR);
    sessionStorage.setItem('agentbus.token', TOKEN);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState(null, '', '/?recorded');
    const r = await render(<Cockpit />);
    await flush();
    await flush();
    expect(r.container.querySelector('form.connect')).toBeNull();
    expect(r.container.querySelector('.connect-error')).toBeNull();
    expect(sessionStorage.getItem('agentbus.token')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe('Connect checks that are overtaken', () => {
  it('a 200 that is not a snapshot is refused and nothing is stored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);

    expect(r.container.querySelector('.connect-error')?.textContent).toBe(
      `agentbus at ${ADDR} did not answer like agentbus`
    );
    expect(sessionStorage.getItem('agentbus.token')).toBeNull();
    r.unmount();
  });

  it('a JSON 200 without store, seq and sessions is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ store: 'st_1', seq: '5', sessions: [] })));
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);
    expect(r.container.querySelector('.connect-error')?.textContent).toBe(
      `agentbus at ${ADDR} did not answer like agentbus`
    );
    r.unmount();
  });
});

describe('AgentsColumn', () => {
  it('shows name and access, no sessions, and no quota text', async () => {
    const agents = [{ id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription', model: 'haiku' }];
    const r = await render(<AgentsColumn agents={agents} selectedAgentId="claude" onSelectAgent={() => {}} />);
    const row = r.container.querySelector('.agent')!;
    expect(row.textContent).toContain('Claude Code');
    expect(row.textContent).toContain('subscription · haiku');
    expect(row.textContent).not.toMatch(/session|running/);
    expect(row.textContent).not.toMatch(/left|limit|%/);
    expect(row.querySelector('.quota')).toBeNull();
    r.unmount();
  });
});

describe('The turn queue on the one API', () => {
  // The service as above, with a turn queue on the same address and token:
  // GET /api/v0/turns of every session answers.
  function withQueue() {
    const svc = fakeService();
    const queueCalls: string[] = [];
    const fn = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname !== '/api/v0/turns' || url.searchParams.has('session')) return svc.fn(input, init);
      queueCalls.push(input);
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
      return json({ store: 'st_1', seq: 5, turns: [], next_before: null });
    });
    return { fn, queueCalls };
  }

  it('one address and one token: the connect form asks for nothing else', async () => {
    const s = withQueue();
    vi.stubGlobal('fetch', s.fn);
    const r = await render(<Cockpit />);
    expect(r.container.querySelectorAll('form.connect input').length).toBe(2);
    expect(r.container.textContent).not.toMatch(/control plane/i);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);
    expect(r.container.querySelector('form.connect')).toBeNull();
    // The turn list is read from the same address, with the same token.
    expect(s.queueCalls.length).toBeGreaterThan(0);
    expect(s.queueCalls.every((u) => u.startsWith(ADDR))).toBe(true);
    expect(Object.keys(sessionStorage).sort()).toEqual(['agentbus.address', 'agentbus.token']);
    expect(localStorage.length).toBe(0);
    expect(r.container.querySelector('.brand-foot')?.textContent).not.toContain('jobs at');
    r.unmount();
  });

  it('a connect drops a control-plane token kept from before there was one API', async () => {
    sessionStorage.setItem('agentbus.jobs.address', 'http://127.0.0.1:8790');
    sessionStorage.setItem('agentbus.jobs.token', 'old');
    const s = withQueue();
    vi.stubGlobal('fetch', s.fn);
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);
    expect(sessionStorage.getItem('agentbus.jobs.token')).toBeNull();
    expect(sessionStorage.getItem('agentbus.jobs.address')).toBeNull();
    r.unmount();
  });

  it('a service with no turn queue still connects, without the queue', async () => {
    const svc = fakeService();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await type(r.container.querySelector('input[name="token"]'), TOKEN);
    await submit(r.container);
    expect(r.container.querySelector('form.connect')).toBeNull();
    // One probe of GET /api/v0/turns, answered 404, and no more reads of it.
    expect(svc.calls.filter((c) => c.url.endsWith('/api/v0/turns?limit=1')).length).toBe(1);
    expect(svc.calls.filter((c) => c.url.includes('/api/v0/turns?limit=200')).length).toBe(0);
    r.unmount();
  });
});
