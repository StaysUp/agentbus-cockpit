// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { SettingsPage } from '../components/SettingsPage';
import { LiveDataSource } from '../data/LiveDataSource';
import { grantsOf, homeFilesOf, lines, networkOf, Policy, sandboxOffer, SettingsApi, SettingsInfo, withGrants, withHomeFiles } from '../data/settings';
import { RunnerInfo } from '../types';
import { click, ev, flush, jsonl, panelOpen, render, unmountAll } from './helpers';

// The policy as GET /api/v0/settings/permissions sends it on the defaults.
function policy(): Policy {
  return {
    read_folders: [],
    allow: [],
    forbid: ['git push'],
    edit: 'session',
    subagents: true,
    limits: { max_depth: 2 },
    agent_api: { scope: 'tree', apply: true, read: true },
    network: { contain: 'off', allow: [] },
    sandbox: { mode: 'off' },
    home_files: [],
  };
}

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// pick opens a part of the page (grants, policy, instructions), or a grant's
// editor in the right column.
async function pick(c: HTMLElement, sel: string) {
  await click(c.querySelector(sel));
}

function button(c: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
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
  unmountAll();
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
      agentsApply: false };
    const out = withGrants(p, g);
    expect(out.network).toEqual({ contain: 'on', allow: ['github.com'] });
    expect(out.sandbox).toEqual({ mode: 'on' });
    expect(out.home_files).toEqual([]);
    expect(out.agent_api).toEqual({ scope: 'tree', apply: false, read: true });
    expect(out.forbid).toEqual(['git push']);
    expect(grantsOf(out)).toEqual(g);
    // Off empties the list; on keeps it.
    expect(withGrants(out, { ...g, network: 'off' }).network).toEqual({ contain: 'on', allow: [] });
    expect(withGrants(out, { ...g, network: 'on' }).network).toEqual({ contain: 'off', allow: ['github.com'] });
  });

  it('writes home files into home_files, outside the sandbox, and keeps every other key', () => {
    const out = withHomeFiles(policy(), ['~/.aws/config']);
    expect(out.home_files).toEqual(['~/.aws/config']);
    expect(out.sandbox).toEqual({ mode: 'off' });
    expect(out.forbid).toEqual(['git push']);
    expect(homeFilesOf(out)).toEqual(['~/.aws/config']);
    expect(homeFilesOf({})).toEqual([]);
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
    expect(seen[1]).toMatchObject({ method: 'PUT', ifMatch: '"v1"', body: { subagents: true } });
    await expect(src.putPolicy(got.value, '"v0"')).rejects.toMatchObject({ status: 412 });
    expect((await src.getInstructions()).value).toBe('hi');
    // No ETag is an error, never a write that overwrites whatever is there.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(policy()), { status: 200 })));
    await expect(src.getPolicy()).rejects.toThrow('no ETag');
    vi.unstubAllGlobals();
  });
});

describe('the Settings page', () => {
  // Every turn uses the subscriptions control keeps: Settings has a part
  // with a Connect step for each, and none where the service keeps none.
  it('has a Subscriptions part with a Connect step for each subscription', async () => {
    const { api } = fakeApi();
    const subs = {
      list: vi.fn(async () => ({
        subscriptions: [
          { harness: 'claude', connected: true, expired: false, expires_at: '2027-11-10T00:00:00Z' },
          { harness: 'codex', connected: false, expired: false },
        ],
      })),
      connect: vi.fn(),
      get: vi.fn(),
      input: vi.fn(),
    };
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} subscriptions={subs} />);
    await flush();
    await click(container.querySelector('[data-part="subscriptions"]'));
    await flush();
    await flush();
    const steps = [...container.querySelectorAll('.connect-step')];
    expect(steps.map((s) => s.getAttribute('data-harness'))).toEqual(['claude', 'codex']);
    expect(steps.map((s) => s.getAttribute('data-phase'))).toEqual(['connected', 'not-connected']);
    expect(container.textContent).toContain('Every turn uses the subscription connected here');

    const { container: none } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    expect(none.querySelector('[data-part="subscriptions"]')).toBeNull();
  });

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
    // The first grant's editor is open; each other grant opens on a click.
    // Home files are not a grant: they are a part of their own.
    expect(container.querySelector('[data-grant="read"]')).toBeNull();
    expect(container.querySelector('textarea[name="home_files"]')).toBeNull();
    await click(container.querySelector('button[name="sandbox"]'));
    await pick(container, '[data-grant="network"]');
    await click(container.querySelector('[aria-label="Network"] [role="radio"]:nth-child(2)'));
    await setValue(container.querySelector('textarea[name="hosts"]'), 'github.com\nregistry.npmjs.org');
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    // There is no "!" commands grant: a "!" message goes to the agent.
    expect(container.querySelector('[data-grant="commands"]')).toBeNull();
    // The table shows the drafts before they are saved.
    const row = (k: string) => container.querySelector(`[data-grant="${k}"]`)!.textContent;
    expect(row('sandbox')).toContain('On');
    expect(row('network')).toContain('A list · 2 hosts');
    expect(row('apply')).toContain('Off');
    await click(button(container, 'Save grants'));
    await flush();
    expect(api.putPolicy).toHaveBeenCalledTimes(1);
    expect(api.putPolicy.mock.calls[0][1]).toBe('"3"');
    expect(state.policy).toMatchObject({
      forbid: ['git push'],
      agent_api: { apply: false, scope: 'tree' },
      network: { contain: 'on', allow: ['github.com', 'registry.npmjs.org'] },
      sandbox: { mode: 'on' },
      home_files: [],
    });
    expect(container.textContent).toContain('Saved.');
    // The page read the policy again: the JSON shows what is stored now.
    await pick(container, '[data-part="policy"]');
    const json = (container.querySelector('textarea[name="policy"]') as HTMLTextAreaElement).value;
    expect(JSON.parse(json).agent_api.apply).toBe(false);
  });

  it('shows Home files as a part of its own, with its one line, and saves them into home_files', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    await pick(container, '[data-part="home"]');
    expect(container.textContent).toContain("Files from your home copied into each conversation's own home, such as ~/.aws/config.");
    await setValue(container.querySelector('textarea[name="home_files"]'), '~/.aws/config\n\n~/.gitconfig');
    expect(container.querySelector('[data-part="home"]')!.textContent).toContain('Unsaved');
    await click(button(container, 'Save home files'));
    await flush();
    expect(api.putPolicy).toHaveBeenCalledTimes(1);
    expect(api.putPolicy.mock.calls[0][1]).toBe('"3"');
    expect(state.policy).toMatchObject({ forbid: ['git push'], sandbox: { mode: 'off' }, home_files: ['~/.aws/config', '~/.gitconfig'] });
    expect(state.policy.sandbox).not.toHaveProperty('read');
    expect(container.textContent).toContain('Saved.');
    expect(container.querySelector('[data-part="home"]')!.textContent).not.toContain('Unsaved');
  });

  it('refuses a stale write and says so', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    state.info.version = 9; // changed elsewhere
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(container.textContent).toContain('Changed elsewhere since this page read it.');
    expect(state.policy.agent_api?.apply).toBe(true);
    await click(button(container, 'Read again'));
    await flush();
    expect(container.querySelector('button[name="agents_apply"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('saves the policy as JSON, and refuses JSON that does not parse', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    await pick(container, '[data-part="policy"]');
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
    await pick(container, '[data-part="instructions"]');
    await setValue(container.querySelector('textarea[name="instructions"]'), 'Draft, not saved.');
    await pick(container, '[data-part="grants"]');
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    await click(button(container, 'Save grants'));
    await flush();
    expect(state.policy.agent_api?.apply).toBe(false);
    await pick(container, '[data-part="instructions"]');
    expect((container.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement).value).toBe('Draft, not saved.');
    expect(api.getInstructions).toHaveBeenCalledTimes(1);
    // The page read the state again: it shows when the settings changed.
    expect(container.textContent).toContain('Last changed');
  });

  it('shows which parts hold unsaved changes, and opens Save only then', async () => {
    const { api } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    const dirty = () => [...container.querySelectorAll('.pg-list [data-part]')].filter((x) => x.querySelector('.pr-dirty')).map((x) => x.getAttribute('data-part'));
    expect(dirty()).toEqual([]);
    expect(button(container, 'Save grants')!.disabled).toBe(true);
    expect(container.querySelector('.pg-dirty')).toBeNull();
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    expect(dirty()).toEqual(['grants']);
    expect(container.querySelector('.pg-main .pg-dirty')!.textContent).toBe('Unsaved changes');
    expect(button(container, 'Save grants')!.disabled).toBe(false);
    // Put back as it was: nothing to save again.
    await click(container.querySelector('button[name="agents_apply"]'));
    expect(dirty()).toEqual([]);
    expect(button(container, 'Save grants')!.disabled).toBe(true);
    await pick(container, '[data-part="instructions"]');
    expect(button(container, 'Save instructions')!.disabled).toBe(true);
    await setValue(container.querySelector('textarea[name="instructions"]'), 'New words.');
    expect(dirty()).toEqual(['instructions']);
    await click(button(container, 'Save instructions'));
    await flush();
    expect(dirty()).toEqual([]);
    expect(button(container, 'Save instructions')!.disabled).toBe(true);
  });

  it('asks before leaving with unsaved changes, and stays or leaves on the answer', async () => {
    const { api } = fakeApi();
    const { usePage } = await import('../page');
    window.history.replaceState(null, '', '/settings');
    const Pages: React.FC = () => {
      const [page, go] = usePage();
      return page === 'settings' ? <SettingsPage api={api} onBack={() => go('cockpit')} /> : <div id="cockpit-shown" />;
    };
    const { container } = await render(<Pages />);
    await flush();
    const ask = () => document.querySelector('[role="alertdialog"]');
    // A link's click, as a browser sends it: cancelable, so the page keeps it.
    const back = () =>
      act(async () => {
        container.querySelector('.page-back')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      });
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    // A reload or a closed tab asks through the browser.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await back();
    expect(ask()!.textContent).toContain('Your changes to Grants are not saved.');
    await click([...ask()!.querySelectorAll('button')].find((x) => x.textContent === 'Stay')!);
    expect(ask()).toBeNull();
    // Escape is Stay too.
    await back();
    await act(async () => {
      ask()!.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(ask()).toBeNull();
    expect(window.location.pathname).toBe('/settings');
    expect(container.querySelector('#cockpit-shown')).toBeNull();
    // The browser's Back asks too, and the address stays on the page meanwhile.
    window.history.pushState(null, '', '/');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(window.location.pathname).toBe('/settings');
    expect(ask()).not.toBeNull();
    await click([...ask()!.querySelectorAll('button')].find((x) => x.textContent === 'Leave without saving')!);
    expect(container.querySelector('#cockpit-shown')).not.toBeNull();
    expect(window.location.pathname).toBe('/');
    // Gone from the page, the guard is gone too.
    const later = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('asked to leave while a save lands, it leaves once nothing is unsaved', async () => {
    const { api, state } = fakeApi();
    const { usePage } = await import('../page');
    window.history.replaceState(null, '', '/settings');
    const Pages: React.FC = () => {
      const [page, go] = usePage();
      return page === 'settings' ? <SettingsPage api={api} onBack={() => go('cockpit')} /> : <div id="cockpit-shown" />;
    };
    const { container } = await render(<Pages />);
    await flush();
    await pick(container, '[data-grant="apply"]');
    await click(container.querySelector('button[name="agents_apply"]'));
    // The read after the write waits until released.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    api.getPolicy.mockImplementationOnce(async () => {
      await held;
      return { value: structuredClone(state.policy), etag: `"${state.info.version}"` };
    });
    await click(button(container, 'Save grants'));
    await act(async () => {
      container.querySelector('.page-back')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => release());
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('#cockpit-shown')).not.toBeNull();
  });

  it('leaves at once when nothing is unsaved', async () => {
    const { api } = fakeApi();
    const { usePage } = await import('../page');
    window.history.replaceState(null, '', '/settings');
    const Pages: React.FC = () => {
      const [page, go] = usePage();
      return page === 'settings' ? <SettingsPage api={api} onBack={() => go('cockpit')} /> : <div id="cockpit-shown" />;
    };
    const { container } = await render(<Pages />);
    await flush();
    await act(async () => {
      container.querySelector('.page-back')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('#cockpit-shown')).not.toBeNull();
  });

  it('lays out as the mockup: the parts, the picked one, its detail', async () => {
    const { api } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    const parts = [...container.querySelectorAll('.pg-list [data-part]')].map((x) => x.getAttribute('data-part'));
    expect(parts).toEqual(['grants', 'home', 'policy', 'instructions']);
    expect(container.querySelector('.pg-list .on')!.getAttribute('data-part')).toBe('grants');
    expect(container.querySelector('.pg-main .colhead')!.textContent).toContain('Grants');
    expect(container.querySelectorAll('.pg-main tr[data-grant]')).toHaveLength(3);
    expect(container.querySelector('.pg-side .colhead')!.textContent).toBe('Sandbox');
    await pick(container, '[data-grant="network"]');
    expect(container.querySelector('.pg-side .colhead')!.textContent).toBe('Network');
    expect(container.querySelector('tr[data-grant="network"]')!.getAttribute('aria-selected')).toBe('true');
    // The policy as saved, nested keys by their dotted path.
    await pick(container, '[data-part="policy"]');
    const saved = container.querySelector('[aria-label="Saved policy"]')!.textContent!;
    expect(saved).toContain('limits.max_depth2');
    expect(saved).toContain('forbidgit push');
    expect(saved).toContain('read_foldersnone');
    expect(saved).toContain('home_filesnone');
  });

  it('saves the instructions', async () => {
    const { api, state } = fakeApi();
    const { container } = await render(<SettingsPage api={api} onBack={() => {}} />);
    await flush();
    await pick(container, '[data-part="instructions"]');
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

  it('opens at /settings from the Settings link, and Cockpit and Back return', async () => {
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const go = link(r.container, 'Settings');
    expect(go?.getAttribute('href')).toBe('/settings');
    await follow(go);
    await flush();
    expect(window.location.pathname).toBe('/settings');
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    expect(r.container.querySelector('#agents, #sessions')).toBeNull();
    // Esc on a page of its own does nothing.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    await follow(link(r.container, 'Cockpit'));
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

// One machine as GET /api/v0/runners lists it.
function machine(name: string, fields: Partial<RunnerInfo> = {}): RunnerInfo {
  return { id: `r_${name}`, name, role: 'runner', online: true, last_seen: '2026-11-12T10:00:00Z', labels: [], harnesses: [], ...fields };
}

describe('the sandbox switch offers only what the machines can build', () => {
  it('reads the offer from the online machines\' own reports', () => {
    expect(sandboxOffer([machine('mac', { sandbox: { can: true } })])).toEqual({ can: true, machines: ['mac'] });
    // One online machine that can is enough; an offline one that can is not.
    expect(sandboxOffer([machine('vm', { sandbox: { can: false, why: 'AppArmor refuses user namespaces' } }), machine('mac', { sandbox: { can: true } })]).can).toBe(true);
    expect(sandboxOffer([machine('mac', { online: false, sandbox: { can: true } })])).toEqual({ can: false, why: 'No machine is online to build it.' });
    // A connector from before 0.5 runs no session.
    expect(sandboxOffer([machine('old', { role: 'connector', sandbox: { can: true } })]).can).toBe(false);
    expect(sandboxOffer([])).toEqual({ can: false, why: 'No machine is online to build it.' });
    // Each online machine's reason, or that it has not reported one.
    expect(sandboxOffer([machine('up', { sandbox: { can: false, why: 'the session has no home of its own on this runner' } }), machine('new')])).toEqual({
      can: false,
      why: 'No online machine can build it. up: the session has no home of its own on this runner; new: it has not reported whether it can.',
    });
    // Before the first read, and when the read failed.
    expect(sandboxOffer(undefined)).toEqual({ can: false, why: 'Reading which machines can build it…' });
    expect(sandboxOffer(undefined, 'agentbus answered 500')).toEqual({ can: false, why: 'The machines could not be read: agentbus answered 500' });
    expect(sandboxOffer(null).can).toBe(false);
    // A read that fails after one that worked keeps the machines it read.
    expect(sandboxOffer([machine('mac', { sandbox: { can: true } })], 'agentbus answered 500').can).toBe(true);
  });

  const openSandbox = async (sandbox: ReturnType<typeof sandboxOffer>, mode = 'off') => {
    const f = fakeApi();
    f.state.policy.sandbox = { mode, read: [] };
    const r = await render(<SettingsPage api={f.api} onBack={() => {}} sandbox={sandbox} />);
    await flush();
    await flush();
    await pick(r.container, 'tr[data-grant="sandbox"]');
    return { r, f, sw: () => r.container.querySelector('button[name="sandbox"]') as HTMLButtonElement };
  };

  it('is disabled, with the reason, when no online machine can build it', async () => {
    const { r, sw } = await openSandbox({ can: false, why: 'No online machine can build it. up: the session has no home of its own on this runner.' });
    expect(sw().disabled).toBe(true);
    expect(r.container.querySelector('[data-sandbox-why]')?.textContent).toBe(
      'Not offered. No online machine can build it. up: the session has no home of its own on this runner.'
    );
    await click(sw());
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('is enabled when at least one online machine can, and names them', async () => {
    const { r, sw } = await openSandbox({ can: true, machines: ['mac', 'vm'] });
    expect(sw().disabled).toBe(false);
    expect(r.container.querySelector('[data-sandbox-why]')).toBeNull();
    expect(r.container.textContent).toContain('Online and able to build it: mac, vm.');
    await click(sw());
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('still turns off a sandbox that is on when no machine can build it, and says its turns are refused', async () => {
    const { r, sw } = await openSandbox({ can: false, why: 'No machine is online to build it.' }, 'on');
    expect(sw().disabled).toBe(false);
    expect(r.container.querySelector('[data-sandbox-why]')?.textContent).toBe(
      'On, but no machine can build it now, so its turns are refused. No machine is online to build it.'
    );
    await click(sw());
    expect(sw().getAttribute('aria-checked')).toBe('false');
    // Once off, it is not offered again.
    expect(sw().disabled).toBe(true);
  });

  it('in the app, reads the offer from GET /api/v0/runners', async () => {
    window.history.replaceState(null, '', '/settings');
    try {
      const replay = new ReplayDataSource(jsonl([ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' })]));
      const src = Object.assign(replay, fakeApi().api, {
        listRunners: vi.fn(async () => [machine('up', { sandbox: { can: false, why: 'the session has no home of its own on this runner' } })]),
      });
      const r = await render(<App dataSource={src} />);
      await flush();
      await flush();
      await pick(r.container, 'tr[data-grant="sandbox"]');
      expect((r.container.querySelector('button[name="sandbox"]') as HTMLButtonElement).disabled).toBe(true);
      expect(r.container.querySelector('[data-sandbox-why]')?.textContent).toContain('up: the session has no home of its own on this runner');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
