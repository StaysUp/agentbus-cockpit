// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { SettingsPage } from '../components/SettingsPage';
import { LiveDataSource } from '../data/LiveDataSource';
import { grantsOf, lines, networkOf, Policy, SettingsApi, SettingsInfo, withGrants } from '../data/settings';
import { click, ev, flush, jsonl, panelOpen, render } from './helpers';

// The policy as GET /api/v0/settings/permissions sends it on the defaults.
function policy(): Policy {
  return {
    read_folders: [],
    allow: [],
    forbid: ['git push'],
    edit: 'session',
    subagents: true,
    commands: true,
    limits: { max_depth: 2 },
    agent_api: { scope: 'tree', apply: true, read: true },
    network: { contain: 'off', allow: [] },
    sandbox: { mode: 'off', read: [] },
  };
}

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(c: HTMLElement, text: string): HTMLElement | undefined {
  return [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLElement | undefined;
}

// A settings API in memory, with versions as ETags, that refuses a stale one
// with 412 as the service does.
function fakeApi(info: Partial<SettingsInfo> = {}) {
  const state = {
    info: { version: 3, ...info } as SettingsInfo,
    policy: policy(),
    instructions: 'Be brief.',
  };
  const etag = () => `"${state.info.version}"`;
  const stale = (e: string) => {
    if (e !== etag()) throw Object.assign(new Error('changed'), { status: 412 });
    state.info.version++;
    state.info.changed = '2026-11-12T10:00:00Z';
  };
  const api = {
    getSettings: vi.fn(async () => ({ value: { ...state.info }, etag: etag() })),
    getPolicy: vi.fn(async () => ({ value: structuredClone(state.policy), etag: etag() })),
    putPolicy: vi.fn(async (p: Policy, e: string) => {
      stale(e);
      state.policy = structuredClone(p);
      return { value: p, etag: etag() };
    }),
    getInstructions: vi.fn(async () => ({ value: state.instructions, etag: etag() })),
    putInstructions: vi.fn(async (t: string, e: string) => {
      stale(e);
      state.instructions = t;
      return { value: t, etag: etag() };
    }),
  } satisfies SettingsApi;
  return { api, state };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the grants as policy keys', () => {
  it('reads the network in three words', () => {
    expect(networkOf({ network: { contain: 'off', allow: ['github.com'] } })).toBe('on');
    expect(networkOf({ network: { contain: 'on', allow: [] } })).toBe('off');
    expect(networkOf({ network: { contain: 'on', allow: ['github.com'] } })).toBe('list');
    expect(networkOf({})).toBe('on');
  });

  it('writes the grants into their keys and keeps every other key', () => {
    const p = policy();
    const g = { ...grantsOf(p), network: 'list' as const, hosts: ['github.com'], sandbox: 'on' as const,
      read: ['~/.aws/config'], agentsApply: false, commands: false };
    const out = withGrants(p, g);
    expect(out.network).toEqual({ contain: 'on', allow: ['github.com'] });
    expect(out.sandbox).toEqual({ mode: 'on', read: ['~/.aws/config'] });
    expect(out.agent_api).toEqual({ scope: 'tree', apply: false, read: true });
    expect(out.commands).toBe(false);
    expect(out.forbid).toEqual(['git push']);
    expect(grantsOf(out)).toEqual(g);
    // Off empties the list; on keeps it.
    expect(withGrants(out, { ...g, network: 'off' }).network).toEqual({ contain: 'on', allow: [] });
    expect(withGrants(out, { ...g, network: 'on' }).network).toEqual({ contain: 'off', allow: ['github.com'] });
  });

  it('reads one entry per line', () => {
    expect(lines(' ~/.aws/config \n\n~/.config/gcloud\n')).toEqual(['~/.aws/config', '~/.config/gcloud']);
  });
});

describe('the settings routes', () => {
  it('reads the ETag and sends it back in If-Match', async () => {
    const seen: { method: string; ifMatch: string | null; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get('Authorization')).toBe('Bearer tok');
      seen.push({ method: init?.method ?? 'GET', ifMatch: h.get('If-Match'), body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (input.endsWith('/api/v0/settings/permissions') && init?.method === 'PUT' && h.get('If-Match') !== '"v1"') {
        return new Response(JSON.stringify({ error: 'the setting changed' }), { status: 412 });
      }
      return new Response(JSON.stringify(input.endsWith('instructions') ? { text: 'hi' } : policy()), {
        status: 200, headers: { ETag: '"v1"' },
      });
    }));
    const src = new LiveDataSource({ baseUrl: 'http://127.0.0.1:8787', token: 'tok' });
    const got = await src.getPolicy();
    expect(got.etag).toBe('"v1"');
    await src.putPolicy(got.value, got.etag);
    expect(seen[1]).toMatchObject({ method: 'PUT', ifMatch: '"v1"', body: { commands: true } });
    await expect(src.putPolicy(got.value, '"v0"')).rejects.toMatchObject({ status: 412 });
    expect((await src.getInstructions()).value).toBe('hi');
    // No ETag is an error, never a write that overwrites whatever is there.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(policy()), { status: 200 })));
    await expect(src.getPolicy()).rejects.toThrow('no ETag');
    vi.unstubAllGlobals();
  });
});

describe('the Settings page', () => {
  it('shows no versions, only when the settings last changed', async () => {
    const { api } = fakeApi({ version: 3, changed: '2026-11-12T09:00:00Z' });
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain(`Last changed ${new Date('2026-11-12T09:00:00Z').toLocaleString()}.`);
    expect(text).not.toMatch(/[Vv]ersion/);
    expect(text).not.toContain('Defaults');
    expect(container.querySelector('[aria-label="Defaults"]')).toBeNull();
  });

  it('says nothing of changes when the settings never changed', async () => {
    const { api } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    expect(container.textContent).not.toContain('Last changed');
    expect(container.textContent).toContain('Grants');
  });

  it('saves the grants into the policy with the version it read', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    await setValue(container.querySelector('textarea[name="read"]'), '~/.aws/config\n');
    await click(container.querySelector('[aria-label="Sandbox"] [role="radio"]:nth-child(2)'));
    await click(container.querySelector('[aria-label="Network"] [role="radio"]:nth-child(2)'));
    await setValue(container.querySelector('textarea[name="hosts"]'), 'github.com\nregistry.npmjs.org');
    await click(container.querySelector('input[name="agents_apply"]'));
    await click(container.querySelector('input[name="commands"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(api.putPolicy).toHaveBeenCalledTimes(1);
    expect(api.putPolicy.mock.calls[0][1]).toBe('"3"');
    expect(state.policy).toMatchObject({
      forbid: ['git push'],
      commands: false,
      agent_api: { apply: false, scope: 'tree' },
      network: { contain: 'on', allow: ['github.com', 'registry.npmjs.org'] },
      sandbox: { mode: 'on', read: ['~/.aws/config'] },
    });
    expect(container.textContent).toContain('Saved.');
    // The page read the policy again: the JSON shows what is stored now.
    const json = (container.querySelector('textarea[name="policy"]') as HTMLTextAreaElement).value;
    expect(JSON.parse(json).commands).toBe(false);
  });

  it('refuses a stale write and says so', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    state.info.version = 9; // changed elsewhere
    await click(container.querySelector('input[name="commands"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(container.textContent).toContain('Changed elsewhere since this page read it.');
    expect(state.policy.commands).toBe(true);
    await click(button(container, 'Read again'));
    await flush();
    expect((container.querySelector('input[name="commands"]') as HTMLInputElement).checked).toBe(true);
  });

  it('saves the policy as JSON, and refuses JSON that does not parse', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    const area = container.querySelector('textarea[name="policy"]');
    await setValue(area, '{ not json');
    await click(button(container, 'Save policy'));
    await flush();
    expect(container.textContent).toContain('The policy is not valid JSON.');
    expect(api.putPolicy).not.toHaveBeenCalled();
    await setValue(area, JSON.stringify({ ...policy(), forbid: ['rm'] }));
    await click(button(container, 'Save policy'));
    await flush();
    expect(state.policy.forbid).toEqual(['rm']);
  });

  it('keeps an unsaved draft of another part when one part saves', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    await setValue(container.querySelector('textarea[name="instructions"]'), 'Draft, not saved.');
    await click(container.querySelector('input[name="commands"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(state.policy.commands).toBe(false);
    expect((container.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement).value).toBe('Draft, not saved.');
    expect(api.getInstructions).toHaveBeenCalledTimes(1);
    // The page read the state again: it shows when the settings changed.
    expect(container.textContent).toContain('Last changed');
  });

  it('saves the instructions', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    expect((container.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement).value).toBe('Be brief.');
    await setValue(container.querySelector('textarea[name="instructions"]'), 'Be kind.');
    await click(button(container, 'Save instructions'));
    await flush();
    expect(api.putInstructions).toHaveBeenCalledWith('Be kind.', '"3"');
    expect(state.instructions).toBe('Be kind.');
  });
});

describe('the Settings page in the app', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  const source = () => {
    const replay = new ReplayDataSource(jsonl([
      ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'st', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'hi', agent: 'claude', folder: '/w' }),
      ev({ seq: 3, session: 'st', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
    ]));
    return Object.assign(replay, fakeApi().api);
  };
  // A click as a browser sends it, cancelable, for a link.
  const follow = async (el: Element | undefined) => {
    await act(async () => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
  };
  const link = (c: HTMLElement, text: string) =>
    [...c.querySelectorAll('a')].find((a) => a.textContent?.trim() === text) as HTMLAnchorElement | undefined;

  it('opens at /settings from the Settings link, and ← Cockpit and Back return', async () => {
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const go = link(r.container, 'Settings');
    expect(go?.getAttribute('href')).toBe('/settings');
    await follow(go);
    await flush();
    expect(window.location.pathname).toBe('/settings');
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    expect(r.container.querySelector('#agents, aside')).toBeNull();
    // Esc on a page of its own does nothing.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    await follow(link(r.container, '← Cockpit'));
    await flush();
    expect(window.location.pathname).toBe('/');
    expect(r.container.querySelector('#page')).toBeNull();
    // Forward to Settings again, then the browser's Back.
    await follow(link(r.container, 'Settings'));
    await flush();
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await flush();
    expect(r.container.querySelector('#page')).toBeNull();
    expect(link(r.container, 'Settings')).toBeDefined();
  });

  it('opens straight on the page at /settings, as a reload or a bookmark does', async () => {
    window.history.replaceState(null, '', '/settings');
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    expect(r.container.textContent).toContain('Grants');
  });

  it('shows the cockpit at /settings when the source keeps no settings', async () => {
    window.history.replaceState(null, '', '/settings');
    const replay = new ReplayDataSource(jsonl([ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' })]));
    const r = await render(<App dataSource={replay} />);
    await flush();
    expect(r.container.querySelector('#page')).toBeNull();
    expect(link(r.container, 'Settings')).toBeUndefined();
  });

  it('keeps Esc working in the cockpit shown at /settings when the source keeps no settings', async () => {
    window.history.replaceState(null, '', '/settings');
    const replay = new ReplayDataSource(jsonl([
      ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'st', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'hi', agent: 'claude', folder: '/w' }),
      ev({ seq: 3, session: 'st', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
    ]));
    const r = await render(<App dataSource={replay} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    expect(panelOpen(r.container)).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panelOpen(r.container)).toBe(false);
  });
});
