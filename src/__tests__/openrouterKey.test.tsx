// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionApi } from '../components/ConnectStep';
import { OpenRouterKey } from '../components/OpenRouterKey';
import { AgentsDialog } from '../components/AgentsDialog';
import { LiveDataSource } from '../data/LiveDataSource';
import { Harness, SubscriptionList } from '../types';
import { click, flush, render } from './helpers';

// A fake key: the shape OpenRouter's have, no one's credential.
const FAKE_KEY = 'sk-or-v1-fake0000111122223333444455556666';

// A fake control that keeps the key and, as the API, never sends it back.
function fakeApi(set = false) {
  let kept: string | null = set ? FAKE_KEY : null;
  const list = async (): Promise<SubscriptionList> => ({
    subscriptions: [{ harness: 'claude', connected: false, expired: false }],
    openrouter_key: kept ? { set: true, set_at: '2026-11-13T10:00:00Z' } : { set: false },
  });
  const api: SubscriptionApi = {
    list: vi.fn(list),
    connect: vi.fn(),
    get: vi.fn(),
    input: vi.fn(),
    setKey: vi.fn(async (k: string) => {
      kept = k;
    }),
    removeKey: vi.fn(async () => {
      kept = null;
    }),
  };
  return { api, kept: () => kept };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const row = (root: HTMLElement) => root.querySelector('.or-key');
const field = (root: HTMLElement) => root.querySelector('input[name="openrouter_key"]') as HTMLInputElement | null;

describe('OpenRouterKey', () => {
  it('takes the key in a password field, sends it once, then shows only that it is set', async () => {
    const f = fakeApi();
    const { container } = await render(<OpenRouterKey api={f.api} />);
    await flush();
    expect(row(container)?.getAttribute('data-phase')).toBe('not-connected');
    expect(container.querySelector('.cs-status')?.textContent).toBe('not set');
    const input = field(container)!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    const save = container.querySelector('.or-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await type(input, `  ${FAKE_KEY}\n`);
    await click(container.querySelector('.or-save'));
    await flush();
    expect(f.api.setKey).toHaveBeenCalledTimes(1);
    expect(f.api.setKey).toHaveBeenCalledWith(FAKE_KEY);
    expect(container.querySelector('.cs-status')?.textContent).toBe('set');
    expect(container.textContent).toContain('since 2026-11-13');
    // No field, and nothing of the key, is left on the page.
    expect(field(container)).toBeNull();
    expect(container.innerHTML).not.toContain(FAKE_KEY);
  });

  it('replaces and removes a key that is set; Cancel leaves it as it was', async () => {
    const f = fakeApi(true);
    const { container } = await render(<OpenRouterKey api={f.api} />);
    await flush();
    expect(container.querySelector('.cs-status')?.textContent).toBe('set');
    expect(field(container)).toBeNull();
    expect(container.innerHTML).not.toContain(FAKE_KEY);

    await click(container.querySelector('.or-replace'));
    await type(field(container)!, 'sk-or-v1-other');
    await click(container.querySelector('.or-cancel'));
    expect(field(container)).toBeNull();
    expect(f.api.setKey).not.toHaveBeenCalled();

    await click(container.querySelector('.or-replace'));
    expect(field(container)!.value).toBe('');
    await type(field(container)!, 'sk-or-v1-other');
    await act(async () => {
      field(container)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(f.api.setKey).toHaveBeenCalledWith('sk-or-v1-other');
    expect(f.kept()).toBe('sk-or-v1-other');
    expect(field(container)).toBeNull();

    await click(container.querySelector('.or-remove'));
    await flush();
    expect(f.api.removeKey).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cs-status')?.textContent).toBe('not set');
    expect(field(container)).not.toBeNull();
  });

  it('shows the API words when a save is refused, and keeps the field to try again', async () => {
    const f = fakeApi();
    f.api.setKey = vi.fn(async () => {
      throw new Error('the key must be one line of at most 512 characters with no spaces');
    });
    const { container } = await render(<OpenRouterKey api={f.api} />);
    await flush();
    await type(field(container)!, 'a b');
    await click(container.querySelector('.or-save'));
    await flush();
    expect(container.querySelector('.form-error')?.textContent).toContain('no spaces');
    expect(container.querySelector('.cs-status')?.textContent).toBe('not set');
    expect(field(container)).not.toBeNull();
  });

  // The write worked, then the list read after it failed: the row shows
  // what the write did, and the list's words.
  for (const startSet of [false, true]) {
    it(`shows a ${startSet ? 'remove' : 'save'} that worked even when the list read after it fails`, async () => {
      const f = fakeApi(startSet);
      const { container } = await render(<OpenRouterKey api={f.api} />);
      await flush();
      f.api.list = vi.fn(async () => {
        throw new Error('the list could not be read');
      });
      if (startSet) {
        await click(container.querySelector('.or-remove'));
      } else {
        await type(field(container)!, FAKE_KEY);
        await click(container.querySelector('.or-save'));
      }
      await flush();
      expect(container.querySelector('.cs-status')?.textContent).toBe(startSet ? 'not set' : 'set');
      expect(field(container) === null).toBe(!startSet);
      expect(container.querySelector('.form-error')?.textContent).toContain('could not be read');
      expect(container.innerHTML).not.toContain(FAKE_KEY);
    });
  }

  it('shows no row for a control that keeps no key, or an api without the routes', async () => {
    const old = fakeApi();
    old.api.list = vi.fn(async () => ({ subscriptions: [] }));
    let r = await render(<OpenRouterKey api={old.api} />);
    await flush();
    expect(row(r.container)).toBeNull();
    const none = fakeApi();
    delete none.api.setKey;
    r = await render(<OpenRouterKey api={none.api} />);
    await flush();
    expect(row(r.container)).toBeNull();
  });
});

describe('The OpenRouter agent form', () => {
  const harnesses: Harness[] = [
    {
      name: 'claude',
      label: 'Claude Code',
      found: true,
      runners: [],
      access: [
        { kind: 'subscription', label: 'Subscription', models: [], any_model: true },
        { kind: 'openrouter', label: 'OpenRouter key', models: ['deepseek/deepseek-v4.1-flash'], any_model: true, key_env: 'OPENROUTER_API_KEY', key_set: false },
      ],
    } as Harness,
  ];

  it('shows the key row and keeps the key variable closed under Advanced', async () => {
    const f = fakeApi();
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => harnesses} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} subscriptions={f.api} />,
    );
    await flush();
    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    expect(row(container)).not.toBeNull();
    expect(container.textContent).toContain('set once in Settings');
    const adv = container.querySelector('details.ad-advanced') as HTMLDetailsElement;
    expect(adv.open).toBe(false);
    expect((adv.querySelector('input[name="key_env"]') as HTMLInputElement).placeholder).toBe('OPENROUTER_API_KEY');
    // The key's Save is a plain button: it never submits the agent's form.
    await type(field(container)!, FAKE_KEY);
    await click(container.querySelector('.or-save'));
    await flush();
    expect(f.api.setKey).toHaveBeenCalledWith(FAKE_KEY);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('opens Advanced for an agent that names its own variable', async () => {
    const f = fakeApi();
    const { container } = await render(
      <AgentsDialog
        loadHarnesses={async () => harnesses}
        createAgent={vi.fn()}
        updateAgent={vi.fn()}
        onClose={() => undefined}
        subscriptions={f.api}
        edit={{ id: 'a1', name: 'Old', harness: 'claude', access: 'openrouter', model: 'x/y', key_env: 'MY_OR_KEY', created: '', updated: '' } as never}
      />,
    );
    await flush();
    const adv = container.querySelector('details.ad-advanced') as HTMLDetailsElement;
    expect(adv.open).toBe(true);
    expect((adv.querySelector('input[name="key_env"]') as HTMLInputElement).value).toBe('MY_OR_KEY');
  });
});

describe('LiveDataSource and the OpenRouter key', () => {
  afterEach(() => vi.unstubAllGlobals());
  const BASE = 'http://cockpit.test';

  it('sends the key in the body of a PUT only, and reads back only whether it is set', async () => {
    const seen: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        seen.push({ method: init?.method ?? 'GET', url: input, body: init?.body as string | undefined });
        if (input.endsWith('/api/v0/subscriptions')) {
          return new Response(JSON.stringify({ subscriptions: [], openrouter_key: { set: true, set_at: '2026-11-13T10:00:00Z' } }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const src = new LiveDataSource({ baseUrl: BASE });
    await src.setOpenRouterKey(FAKE_KEY);
    await src.removeOpenRouterKey();
    const list = await src.listSubscriptions();
    expect(seen[0]).toEqual({ method: 'PUT', url: `${BASE}/api/v0/subscriptions/openrouter/key`, body: JSON.stringify({ key: FAKE_KEY }) });
    expect(seen[1]).toMatchObject({ method: 'DELETE', url: `${BASE}/api/v0/subscriptions/openrouter/key` });
    expect(seen.every((s) => !s.url.includes(FAKE_KEY))).toBe(true);
    expect(list?.openrouter_key).toEqual({ set: true, set_at: '2026-11-13T10:00:00Z' });
  });

  it('shows the API words when the key is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'the key must be one line of at most 512 characters with no spaces' }), { status: 400 })),
    );
    await expect(new LiveDataSource({ baseUrl: BASE }).setOpenRouterKey('a b')).rejects.toThrow(/no spaces/);
  });
});
