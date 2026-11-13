// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cockpit, resetSignInCode } from '../Cockpit';
import { SIGN_IN_EXPIRED } from '../data/connection';
import { ev, flush, render } from './helpers';

// The cockpit served by agentbus up: index.html carries the marker, the API
// is the page's own origin, and the sign-in link is /?t=<code>.

const TOKEN = 'tok-signin-5678';
const CODE = 'code-0123456789abcdef';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function openStream(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const summary = {
  id: 'live-abc', agent: 'claude', folder: '/w', started: '2026-11-05T09:00:00Z', last: '2026-11-05T09:10:00Z',
  open: true, turns: 1, usage: { input_tokens: 1, output_tokens: 1 },
};
const events = [
  ev({ seq: 1, session: 'live-abc', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'live-abc', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'live prompt' }),
  ev({ seq: 3, session: 'live-abc', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

// agentbus: the code trades once for TOKEN; every other call needs TOKEN.
function fakeAgentbus(codeWorks = true) {
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
  let used = false;
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push({ url: input, method: init?.method ?? 'GET', auth, body: init?.body as string | undefined });
    if (url.pathname === '/api/v0/signin') {
      const { code } = JSON.parse(String(init?.body));
      if (!codeWorks || used || code !== CODE) return json({ error: 'the sign-in code is wrong, used or expired' }, 401);
      used = true;
      return json({ token: TOKEN });
    }
    if (auth !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/v0/sessions') return json({ store: 'st_1', seq: 3, sessions: [summary] });
    if (url.pathname === '/api/v0/events') return openStream(init?.signal);
    if (url.pathname === '/api/v0/turns' && url.searchParams.get('session') === 'live-abc') {
      return json({
        store: 'st_1', seq: 3,
        turns: [{ id: 'T1', session: 'live-abc', agent: 'claude', folder: '/w', prompt: 'live prompt', started_seq: 2,
          started: events[1].time, ended: events[2].time, state: 'finished', outcome: 'finished', usage: null,
          cost_usd: 0, cost_complete: false }],
        next_before: null,
      });
    }
    if (url.pathname === '/api/v0/sessions/live-abc/events') return json({ store: 'st_1', events: events.slice(1), next_after: null });
    return json({}, 404);
  });
  return { fn, calls };
}

function served(on: boolean) {
  document.head.querySelectorAll('meta[name="agentbus"]').forEach((m) => m.remove());
  if (on) {
    const m = document.createElement('meta');
    m.name = 'agentbus';
    m.content = 'served';
    document.head.appendChild(m);
  }
}

async function settle() {
  for (let i = 0; i < 6; i++) await flush();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetSignInCode();
});
afterEach(() => {
  vi.unstubAllGlobals();
  served(false);
  window.history.replaceState(null, '', '/');
});

describe('Served by agentbus', () => {
  it('the sign-in link signs in once, with no connect screen, and leaves no code in the address', async () => {
    served(true);
    window.history.replaceState(null, '', `/?t=${CODE}`);
    const svc = fakeAgentbus();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    // The code left the address bar at once.
    expect(window.location.search).toBe('');
    await settle();

    expect(r.container.querySelector('form.connect')).toBeNull();
    const bubbles = Array.from(r.container.querySelectorAll('.tb .bubble')).map((b) => b.textContent);
    expect(bubbles).toEqual(['live prompt']);
    const trades = svc.calls.filter((c) => new URL(c.url).pathname === '/api/v0/signin');
    expect(trades).toHaveLength(1);
    expect(trades[0].method).toBe('POST');
    expect(new URL(trades[0].url).origin).toBe(window.location.origin);
    expect(JSON.parse(trades[0].body!)).toEqual({ code: CODE });
    // Every other call goes to the page's own origin with the token.
    for (const c of svc.calls.filter((c) => c !== trades[0])) {
      expect(new URL(c.url).origin).toBe(window.location.origin);
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(CODE);
    }
    expect(sessionStorage.getItem('agentbus.token')).toBe(TOKEN);
    expect(sessionStorage.getItem('agentbus.address')).toBe(window.location.origin);
    expect(localStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TOKEN);
    r.unmount();
  });

  it('a used or expired code shows the connect screen on this address, with how to get a new link', async () => {
    served(true);
    window.history.replaceState(null, '', `/settings?t=${CODE}`);
    const svc = fakeAgentbus(false);
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await settle();

    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('');
    expect(r.container.querySelector('form.connect')).not.toBeNull();
    expect(r.container.querySelector('.connect-error')?.textContent).toBe(SIGN_IN_EXPIRED);
    expect((r.container.querySelector('input[name="address"]') as HTMLInputElement).value).toBe(window.location.origin);
    expect(r.container.querySelector('.connect-hint')?.textContent).toContain('agentbus open');
    expect(sessionStorage.getItem('agentbus.token')).toBeNull();
    r.unmount();
  });

  it('with no code it offers this address and how to get a link', async () => {
    served(true);
    const svc = fakeAgentbus();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await settle();
    expect(svc.calls).toHaveLength(0);
    expect((r.container.querySelector('input[name="address"]') as HTMLInputElement).value).toBe(window.location.origin);
    expect(r.container.querySelector('.connect-hint')).not.toBeNull();
    r.unmount();
  });
});

describe('From the dev server', () => {
  it('ignores a t parameter and works as before', async () => {
    served(false);
    window.history.replaceState(null, '', `/?t=${CODE}`);
    const svc = fakeAgentbus();
    vi.stubGlobal('fetch', svc.fn);
    const r = await render(<Cockpit />);
    await settle();
    expect(svc.calls).toHaveLength(0);
    expect(window.location.search).toBe(`?t=${CODE}`);
    expect((r.container.querySelector('input[name="address"]') as HTMLInputElement).value).toBe('http://127.0.0.1:8787');
    expect(r.container.querySelector('.connect-hint')).toBeNull();
    r.unmount();
  });
});
