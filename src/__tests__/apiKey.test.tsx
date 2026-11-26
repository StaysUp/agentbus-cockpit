// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionApi } from '../components/ConnectStep';
import { APIKey } from '../components/OpenRouterKey';
import { AgentsDialog } from '../components/AgentsDialog';
import { signInOf } from '../components/SignInDot';
import { LiveDataSource } from '../data/LiveDataSource';
import { Harness, SubscriptionList } from '../types';
import { click, flush, render } from './helpers';

// Fake keys: no one's credential.
const FAKE_ANTH = 'sk-ant-api03-fake0000111122223333';

// A fake control that keeps each vendor's key and never sends one back.
function fakeApi() {
  const kept: Record<string, string> = {};
  const list = async (): Promise<SubscriptionList> => ({
    subscriptions: [],
    api_keys: Object.fromEntries(['anthropic', 'gemini', 'openai', 'openrouter', 'xai'].map((n) => [n, kept[n] ? { set: true, set_at: '2026-11-13T10:00:00Z' } : { set: false }])),
  });
  const api: SubscriptionApi = {
    list: vi.fn(list),
    connect: vi.fn(),
    get: vi.fn(),
    input: vi.fn(),
    setKey: vi.fn(),
    removeKey: vi.fn(),
    setAPIKey: vi.fn(async (n: string, k: string) => {
      kept[n] = k;
    }),
    removeAPIKey: vi.fn(async (n: string) => {
      delete kept[n];
    }),
  };
  return { api, kept };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('APIKey', () => {
  it('sends the Anthropic key once by its name, then shows only that it is set, and removes it', async () => {
    const f = fakeApi();
    const { container } = await render(<APIKey api={f.api} name="anthropic" />);
    await flush();
    expect(container.textContent).toContain('Anthropic API key');
    expect(container.textContent).toContain('Used by Claude Code agents on an API key.');
    expect(container.querySelector('input[name="anthropic_key"]')).toBeNull();
    await click(container.querySelector('.key-set'));
    const input = container.querySelector('input[name="anthropic_key"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    await type(input, ` ${FAKE_ANTH}\n`);
    await click(container.querySelector('.key-save'));
    await flush();
    expect(f.api.setAPIKey).toHaveBeenCalledWith('anthropic', FAKE_ANTH);
    expect(f.api.setKey).not.toHaveBeenCalled();
    expect(container.querySelector('.cs-status')?.textContent).toBe('set');
    expect(container.querySelector('input[name="anthropic_key"]')).toBeNull();
    expect(container.innerHTML).not.toContain(FAKE_ANTH);
    await click(container.querySelector('.key-remove'));
    // Remove asks first.
    await click(container.querySelector('.confirm-go'));
    await flush();
    expect(f.api.removeAPIKey).toHaveBeenCalledWith('anthropic');
    expect(container.querySelector('.cs-status')?.textContent).toBe('not set');
    expect(container.querySelector('.key-set')?.textContent).toBe('Set key');
    expect(container.querySelector('input[name="anthropic_key"]')).toBeNull();
  });

  it('shows no row for a control too old to list the vendor keys', async () => {
    const f = fakeApi();
    f.api.list = vi.fn(async () => ({ subscriptions: [] }));
    const { container } = await render(<APIKey api={f.api} name="anthropic" />);
    await flush();
    expect(container.querySelector('.key-row')).toBeNull();
  });
});

describe('The API key agent form', () => {
  const harnesses: Harness[] = [
    {
      name: 'claude',
      label: 'Claude Code',
      found: true,
      runners: [],
      access: [
        { kind: 'subscription', label: 'Claude subscription', models: [], any_model: true },
        { kind: 'api', label: 'Anthropic API key', models: [], any_model: true, key_name: 'anthropic' },
      ],
    } as Harness,
  ];

  it('shows the Anthropic key row, starts with no model, and saves access api', async () => {
    const f = fakeApi();
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => harnesses} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} subscriptions={f.api} />,
    );
    await flush();
    await click(container.querySelector('[data-access="api"]'));
    await flush();
    expect(container.querySelector('.key-row[data-harness="anthropic"]')).not.toBeNull();
    // The access choice reads only "API key"; the row and note say whose.
    expect(container.querySelector('[data-access="api"]')?.textContent).toBe('API key');
    expect(container.textContent).toContain('AgentBus adds your Anthropic API key');
    expect((container.querySelector('input[name="model"]') as HTMLInputElement).value).toBe('');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith({ name: 'Claude Code', harness: 'claude', access: 'api' });
  });
});

describe('The models of an API key agent', () => {
  it("reads the vendor's list on access api, says where it came from, and reads it again once the key is saved", async () => {
    const f = fakeApi();
    const harnesses: Harness[] = [
      {
        name: 'claude',
        label: 'Claude Code',
        found: true,
        runners: [],
        access: [{ kind: 'api', label: 'Anthropic API key', models: [], any_model: true, key_name: 'anthropic' }],
      } as Harness,
    ];
    const loadModels = vi.fn(async (harness: string, access: string) => ({
      harness,
      access,
      source: 'api',
      models: f.kept.anthropic ? [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] : [],
      ...(f.kept.anthropic ? { fetched_at: '2026-11-13T10:00:00Z' } : { error: 'set your Anthropic API key in Settings' }),
    }));
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => harnesses} loadModels={loadModels} createAgent={vi.fn()} updateAgent={vi.fn()} onClose={() => undefined} subscriptions={f.api} />,
    );
    await flush();
    await click(container.querySelector('[data-access="api"]'));
    await flush();
    expect(loadModels).toHaveBeenCalledWith('claude', 'api', false);
    await click(container.querySelector('.key-set'));
    await type(container.querySelector('input[name="anthropic_key"]') as HTMLInputElement, FAKE_ANTH);
    await click(container.querySelector('.key-save'));
    await flush();
    await flush();
    expect(loadModels).toHaveBeenLastCalledWith('claude', 'api', true);
    expect(container.querySelector('.ad-models')?.textContent).toContain("1 model");
    expect(container.innerHTML).not.toContain(FAKE_ANTH);
  });
});

describe('signInOf and API key agents', () => {
  it('says whether the vendor key is set, from the subscriptions', () => {
    const a = { id: 'a', name: 'x', harness: 'claude', access: 'api', created: '', updated: '' };
    expect(signInOf(a as never, { subscriptions: [], api_keys: { anthropic: { set: true } } })?.ok).toBe(true);
    expect(signInOf(a as never, { subscriptions: [], api_keys: { anthropic: { set: false } } })?.ok).toBe(false);
    expect(signInOf(a as never, { subscriptions: [] })?.ok).toBe(false);
    expect(signInOf(a as never, null)).toBeUndefined();
  });
});

describe('LiveDataSource and the vendor keys', () => {
  afterEach(() => vi.unstubAllGlobals());
  const BASE = 'http://cockpit.test';

  it('sends a vendor key in the body of a PUT to its own path only, and reads back only whether each is set', async () => {
    const seen: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        seen.push({ method: init?.method ?? 'GET', url: input, body: init?.body as string | undefined });
        if (input.endsWith('/api/v0/subscriptions')) {
          return new Response(JSON.stringify({ subscriptions: [], api_keys: { anthropic: { set: true, set_at: '2026-11-13T10:00:00Z' }, openai: { set: false }, bad: 'x' } }), {
            status: 200,
          });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const src = new LiveDataSource({ baseUrl: BASE });
    await src.setAPIKey('anthropic', FAKE_ANTH);
    await src.removeAPIKey('anthropic');
    const list = await src.listSubscriptions();
    expect(seen[0]).toEqual({ method: 'PUT', url: `${BASE}/api/v0/subscriptions/anthropic/key`, body: JSON.stringify({ key: FAKE_ANTH }) });
    expect(seen[1]).toMatchObject({ method: 'DELETE', url: `${BASE}/api/v0/subscriptions/anthropic/key` });
    expect(seen.every((s) => !s.url.includes(FAKE_ANTH))).toBe(true);
    expect(list?.api_keys).toEqual({ anthropic: { set: true, set_at: '2026-11-13T10:00:00Z' }, openai: { set: false } });
  });
});

describe('The provider agent form', () => {
  const harnesses: Harness[] = [
    {
      name: 'opencode',
      label: 'OpenCode',
      found: true,
      runners: [],
      access: [
        { kind: 'openrouter', label: 'OpenRouter key', models: ['deepseek/deepseek-v4.1-flash'], any_model: true, key_env: 'OPENROUTER_API_KEY' },
        { kind: 'xai', label: 'xAI key', models: ['grok-4.7', 'grok-4.6'], any_model: true, key_name: 'xai' },
      ],
    } as Harness,
  ];

  it('shows the xAI key row, starts with its first model, and saves access xai', async () => {
    const f = fakeApi();
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => harnesses} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} subscriptions={f.api} />,
    );
    await flush();
    await click(container.querySelector('[data-access="xai"]'));
    await flush();
    expect(container.querySelector('.key-row[data-harness="xai"]')).not.toBeNull();
    expect(container.textContent).toContain('xAI API key');
    expect(container.textContent).toContain('AgentBus adds your xAI API key');
    expect((container.querySelector('input[name="model"]') as HTMLInputElement).value).toBe('grok-4.7');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode', access: 'xai', model: 'grok-4.7' }));
  });
});
