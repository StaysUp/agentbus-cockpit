// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentsColumn } from '../components/AgentsColumn';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { SettingsDialog } from '../components/SettingsDialog';
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
    info: { version: 3, defaults_version: 1, latest_defaults_version: 1, ...info } as SettingsInfo,
    policy: policy(),
    instructions: 'Be brief.',
  };
  const etag = () => `"${state.info.version}"`;
  const stale = (e: string) => {
    if (e !== etag()) throw Object.assign(new Error('changed'), { status: 412 });
    state.info.version++;
  };
  const api = {
    getSettings: vi.fn(async () => ({ value: { ...state.info }, etag: etag() })),
    putDefaults: vi.fn(async (v: number, e: string) => {
      stale(e);
      state.info.defaults_version = v;
      return { value: { ...state.info }, etag: etag() };
    }),
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
  it('shows the defaults version and moves to the newest', async () => {
    const { api, state } = fakeApi({ defaults_version: 1, latest_defaults_version: 2 });
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
    await flush();
    expect(container.textContent).toContain('Version 1; version 2 is the newest.');
    await click(button(container, 'Move to version 2'));
    await flush();
    expect(api.putDefaults).toHaveBeenCalledWith(2, '"3"');
    expect(state.info.defaults_version).toBe(2);
    expect(container.textContent).toContain('Version 2, the newest.');
    expect(button(container, 'Move to version 2')).toBeUndefined();
  });

  it('saves the grants into the policy with the version it read', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
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
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
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
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
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
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
    await flush();
    await setValue(container.querySelector('textarea[name="instructions"]'), 'Draft, not saved.');
    await click(container.querySelector('input[name="commands"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(state.policy.commands).toBe(false);
    expect((container.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement).value).toBe('Draft, not saved.');
    expect(api.getInstructions).toHaveBeenCalledTimes(1);
    // The settings version moved, and the page shows it.
    expect(container.textContent).toContain('Settings version 4.');
  });

  it('saves the instructions', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsDialog api={api} onClose={() => {}} />);
    await flush();
    expect((container.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement).value).toBe('Be brief.');
    await setValue(container.querySelector('textarea[name="instructions"]'), 'Be kind.');
    await click(button(container, 'Save instructions'));
    await flush();
    expect(api.putInstructions).toHaveBeenCalledWith('Be kind.', '"3"');
    expect(state.instructions).toBe('Be kind.');
  });
});

describe('the Settings button', () => {
  it('shows only when the source keeps settings', async () => {
    const onSettings = vi.fn();
    const a = await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} onSettings={onSettings} />);
    await click(button(a.container, 'Settings'));
    expect(onSettings).toHaveBeenCalledTimes(1);
    const b = await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} />);
    expect(button(b.container, 'Settings')).toBeUndefined();
  });
});

describe('the Settings page in the app', () => {
  it('Escape closes Settings and leaves the turn panel open', async () => {
    const replay = new ReplayDataSource(jsonl([
      ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'st', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'hi', agent: 'claude', folder: '/w' }),
      ev({ seq: 3, session: 'st', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
    ]));
    const source = Object.assign(replay, fakeApi().api);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    expect(panelOpen(r.container)).toBe(true);
    await click(button(r.container, 'Settings'));
    await flush();
    expect(r.container.querySelector('[aria-label="Settings"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(r.container.querySelector('[aria-label="Settings"]')).toBeNull();
    expect(panelOpen(r.container)).toBe(true);
  });
});
