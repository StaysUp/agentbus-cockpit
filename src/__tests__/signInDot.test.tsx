// @vitest-environment jsdom
// A sign-in dot on each saved agent, and beside the picker near Send: green
// when its tool is connected, yellow when it is not; a click opens Settings
// on Subscriptions.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { signInOf } from '../components/SignInDot';
import { CockpitEvent, DataSource, SavedAgent, SubscriptionList } from '../types';
import { choose, click, ev, flush, liveReplay, render, unmountAll } from './helpers';

const SAVED: SavedAgent[] = [
  { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' },
  { id: 'codex', name: 'Codex', harness: 'codex', access: 'subscription' },
  { id: 'or', name: 'Router', harness: 'claude', access: 'openrouter', key_env: 'OPENROUTER_API_KEY', key_set: false },
];

const SUBS: SubscriptionList = {
  subscriptions: [
    { harness: 'claude', connected: true, expired: false },
    { harness: 'codex', connected: false, expired: false },
  ],
};

// One finished turn on codex, so the picker starts on Codex.
function events(): CockpitEvent[] {
  return [
    ev({ session: 's1', kind: 'turn.started', turn: 'T1', text: 'hi', agent: 'codex', agent_id: 'codex', folder: '/w' }),
    ev({ session: 's1', kind: 'model.requested', turn: 'T1', exchange: 'x1', model: 'gpt-x' }),
    ev({ session: 's1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'ok', stop_reason: 'end_turn' }),
    ev({ session: 's1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
  ];
}

function source(subs: SubscriptionList = SUBS, agents: () => SavedAgent[] = () => SAVED) {
  const base = liveReplay(events());
  const resumable = <T extends { resumable?: boolean }>(list: T[]) => list.map((s) => ({ ...s, resumable: true }));
  const listSubscriptions = vi.fn(async () => subs);
  const src: DataSource = {
    ...base.source,
    getSessions: async () => resumable(await base.source.getSessions()),
    subscribe: (cb, snap) => base.source.subscribe!(cb, (list, c) => snap?.(resumable(list), c)),
    listAgents: async () => agents(),
    sendMessage: vi.fn(async (id: string) => ({ session: id, turn: 'Tnext', state: 'running' as const })),
    listSubscriptions,
    connectSubscription: vi.fn(),
    getConnect: vi.fn(),
    connectInput: vi.fn(),
    getSettings: async () => ({ value: { version: 1 } as never, etag: '"1"' }),
    getPolicy: async () => ({ value: {}, etag: '"1"' }),
    putPolicy: async (p) => ({ value: p, etag: '"1"' }),
    getInstructions: async () => ({ value: '', etag: '"1"' }),
    putInstructions: async (t) => ({ value: t, etag: '"1"' }),
  };
  return { src, listSubscriptions };
}

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('timed out waiting for ' + what);
}

const rowDot = (c: HTMLElement, id: string) => c.querySelector(`#agents [data-agent="${id}"] .signin-dot`) as HTMLElement | null;
const sendDot = (c: HTMLElement) => c.querySelector('#c-reply .next-agent-at .signin-dot') as HTMLElement | null;

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('signInOf', () => {
  const claude = SAVED[0];
  const router = SAVED[2];
  it('is green when the tool is connected, and says so', () => {
    expect(signInOf(claude, SUBS)).toEqual({ ok: true, title: 'claude is connected' });
  });
  it('is yellow when the tool is not connected, or its sign-in expired', () => {
    expect(signInOf(SAVED[1], SUBS)).toEqual({ ok: false, title: 'codex is not connected — open Settings to connect' });
    expect(signInOf(claude, { subscriptions: [] })?.ok).toBe(false);
    const expired = signInOf(claude, { subscriptions: [{ harness: 'claude', connected: true, expired: true }] });
    expect(expired).toEqual({ ok: false, title: "claude's sign-in expired — open Settings to connect again" });
  });
  it('shows nothing for a subscription agent until the subscriptions are read, or when the service keeps none', () => {
    expect(signInOf(claude, undefined)).toBeUndefined();
    expect(signInOf(claude, null)).toBeUndefined();
  });
  it('is green for an OpenRouter agent with a key set in Settings or in its environment variable', () => {
    expect(signInOf(router, SUBS)).toEqual({ ok: false, title: 'OpenRouter key is not set — open Settings to add it' });
    expect(signInOf(router, { ...SUBS, openrouter_key: { set: true } })).toEqual({ ok: true, title: 'OpenRouter key is set' });
    expect(signInOf({ ...router, key_set: true }, undefined)?.ok).toBe(true);
    expect(signInOf({ ...router, key_set: undefined }, undefined)).toBeUndefined();
  });
  it('shows nothing for an agent of another access', () => {
    expect(signInOf({ ...claude, access: 'api' }, SUBS)).toBeUndefined();
  });
});

describe('the sign-in dot in the cockpit', () => {
  it('marks each saved agent green or yellow, with a title that says which', async () => {
    const { src } = source();
    const r = await render(<App dataSource={src} />);
    await waitFor(() => rowDot(r.container, 'codex') !== null, 'the dots');
    const ok = rowDot(r.container, 'claude')!;
    expect(ok.getAttribute('data-signin')).toBe('ok');
    expect(ok.classList.contains('pending')).toBe(false);
    expect(ok.getAttribute('title')).toBe('claude is connected');
    const no = rowDot(r.container, 'codex')!;
    expect(no.getAttribute('data-signin')).toBe('no');
    expect(no.classList.contains('pending')).toBe(true);
    expect(no.getAttribute('title')).toBe('codex is not connected — open Settings to connect');
    expect(rowDot(r.container, 'or')!.getAttribute('data-signin')).toBe('no');
    // No Connect button on agents.
    expect([...r.container.querySelectorAll('#agents button')].some((b) => /connect/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('turns an OpenRouter agent green when a key is set in Settings', async () => {
    const { src } = source({ ...SUBS, openrouter_key: { set: true } });
    const r = await render(<App dataSource={src} />);
    await waitFor(() => rowDot(r.container, 'or') !== null, 'the dot');
    expect(rowDot(r.container, 'or')!.getAttribute('data-signin')).toBe('ok');
    expect(rowDot(r.container, 'or')!.getAttribute('title')).toBe('OpenRouter key is set');
  });

  it('opens Settings on Subscriptions when clicked, without picking the agent', async () => {
    const { src, listSubscriptions } = source();
    const r = await render(<App dataSource={src} />);
    await waitFor(() => rowDot(r.container, 'codex') !== null, 'the dots');
    // Codex is picked, as the newest session ran on it; the dot is clicked
    // on another agent's row.
    expect(r.container.querySelector('#agents [data-agent="codex"]')!.classList.contains('on')).toBe(true);
    const reads = listSubscriptions.mock.calls.length;
    await click(rowDot(r.container, 'or'));
    await flush();
    expect(window.location.pathname).toBe('/settings');
    await waitFor(() => r.container.querySelector('[data-part="subscriptions"]') !== null, 'the Subscriptions part');
    expect(r.container.querySelector('[data-part="subscriptions"]')!.getAttribute('aria-current')).toBe('true');
    expect(r.container.querySelector('.pg-main .colhead')!.textContent).toContain('Subscriptions');
    // Back on the cockpit, the subscriptions are read again.
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => rowDot(r.container, 'codex') !== null, 'the cockpit again');
    expect(listSubscriptions.mock.calls.length).toBeGreaterThan(reads);
    expect(r.container.querySelector('#agents [data-agent="or"]')!.classList.contains('on')).toBe(false);
    expect(r.container.querySelector('#agents [data-agent="codex"]')!.classList.contains('on')).toBe(true);
  });

  it('reads the agents again with the subscriptions on coming back, so a key set in Settings shows', async () => {
    let keySet = false;
    let subs: SubscriptionList = SUBS;
    const { src } = source(SUBS, () => SAVED.map((a) => (a.id === 'or' ? { ...a, key_set: keySet } : a)));
    src.listSubscriptions = async () => subs;
    const r = await render(<App dataSource={src} />);
    await waitFor(() => rowDot(r.container, 'or') !== null, 'the dot');
    expect(rowDot(r.container, 'or')!.getAttribute('data-signin')).toBe('no');
    await click(rowDot(r.container, 'or'));
    await flush();
    expect(window.location.pathname).toBe('/settings');
    // The key is set in Settings: the agent's key_set says so, and the
    // subscriptions read says so too.
    keySet = true;
    subs = { ...SUBS, openrouter_key: { set: true } };
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => rowDot(r.container, 'or')?.getAttribute('data-signin') === 'ok', 'the dot turning green');
    // And removed: both reads say so, and the dot turns yellow again.
    await click(rowDot(r.container, 'or'));
    await flush();
    keySet = false;
    subs = SUBS;
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => rowDot(r.container, 'or')?.getAttribute('data-signin') === 'no', 'the dot turning yellow');
  });

  it('opens Settings on its first part from the Settings link', async () => {
    const { src } = source();
    const r = await render(<App dataSource={src} />);
    await waitFor(() => rowDot(r.container, 'codex') !== null, 'the dots');
    const link = [...r.container.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Settings')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();
    expect(r.container.querySelector('[data-part="grants"]')!.getAttribute('aria-current')).toBe('true');
  });

  it('shows the picked agent’s dot beside the picker near Send, and follows the pick', async () => {
    const { src } = source();
    const r = await render(<App dataSource={src} />);
    await waitFor(() => sendDot(r.container) !== null, 'the send-box dot');
    expect(sendDot(r.container)!.getAttribute('data-signin')).toBe('no');
    expect(sendDot(r.container)!.getAttribute('title')).toBe('codex is not connected — open Settings to connect');
    await choose(r.container, 'next_agent', 'claude');
    expect(sendDot(r.container)!.getAttribute('data-signin')).toBe('ok');
    expect(sendDot(r.container)!.getAttribute('title')).toBe('claude is connected');
    await choose(r.container, 'next_agent', 'codex');
    expect(sendDot(r.container)!.getAttribute('data-signin')).toBe('no');
    await click(sendDot(r.container));
    await flush();
    expect(window.location.pathname).toBe('/settings');
  });
});
