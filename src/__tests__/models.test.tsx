// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combo } from '../components/Controls';
import { AgentsDialog } from '../components/AgentsDialog';
import { LiveDataSource } from '../data/LiveDataSource';
import { OPENROUTER_LOAD_ERROR, OPENROUTER_REFRESH_ERROR, parseOpenRouterBody } from '../data/openRouterModels';
import { Harness, ModelList } from '../types';
import { click, flush, render } from './helpers';

const menu = () => document.querySelector('[role="listbox"]');

async function focus(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.focus();
  });
}

describe('Combo with labels', () => {
  it('shows a label with the name beside it, finds it by either, and fills the name', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return (
        <Combo name="m" label="Model" value={v} onChange={setV} suggestions={['gpt-6.1-sol', 'gemini-4-argon-medium']} labels={{ 'gemini-4-argon-medium': 'Gemini 4 Argon' }} />
      );
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await focus(input);
    const opt = menu()!.querySelector('[data-value="gemini-4-argon-medium"]')!;
    expect(opt.textContent).toContain('Gemini 4 Argon');
    expect(opt.textContent).toContain('gemini-4-argon-medium');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'argon');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...menu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['gemini-4-argon-medium']);
    await click(menu()!.querySelector('[data-value="gemini-4-argon-medium"]'));
    expect(input.value).toBe('gemini-4-argon-medium');
  });
});

describe('The agent form and the list of models', () => {
  const harnesses: Harness[] = [
    { name: 'claude', label: 'Claude Code', found: true, runners: [], access: [{ kind: 'subscription', label: 'Claude subscription', models: ['sonnet', 'opus', 'haiku'], any_model: true }] } as Harness,
    { name: 'codex', label: 'Codex', found: true, runners: [], access: [{ kind: 'subscription', label: 'ChatGPT sign-in', models: [], any_model: true }] } as Harness,
  ];

  it('offers the list read for the harness and access, reads it again on Refresh and on a new harness, and saves a typed name or none', async () => {
    const lists: Record<string, ModelList> = {
      claude: { harness: 'claude', access: 'subscription', models: [{ id: 'sonnet' }, { id: 'opus' }, { id: 'haiku' }], source: 'fixed' },
      codex: { harness: 'codex', access: 'subscription', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }], source: 'runner', fetched_at: '2026-11-13T10:00:00Z' },
    };
    const loadModels = vi.fn(async (h: string) => lists[h]);
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => harnesses} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadModels={loadModels} />,
    );
    await flush();
    expect(loadModels).toHaveBeenCalledWith('claude', 'subscription', false);
    expect(container.querySelector('.ad-models')?.textContent).toContain("3 models");
    expect(container.querySelector('.ad-models-refresh')).toBeNull();
    await click(container.querySelector('[data-harness="codex"]'));
    await flush();
    expect(loadModels).toHaveBeenLastCalledWith('codex', 'subscription', false);
    expect(container.querySelector('.ad-models')?.textContent).toContain("2 models");
    const input = container.querySelector('input[name="model"]') as HTMLInputElement;
    expect(input.value).toBe('');
    await focus(input);
    expect([...menu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    await click(container.querySelector('.ad-models-refresh'));
    await flush();
    expect(loadModels).toHaveBeenLastCalledWith('codex', 'subscription', true);
    // No model: the tool's default.
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith({ name: 'Codex', harness: 'codex', access: 'subscription' });
  });

  it("asks for a typed model id when the list has none, and takes it", async () => {
    const loadModels = vi.fn(async (): Promise<ModelList> => ({ harness: 'codex', access: 'subscription', models: [], source: 'runner', error: "no runner has reported Codex's models yet" }));
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [harnesses[1]]} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadModels={loadModels} />,
    );
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain("No list of Codex's models yet. Type a model id above.");
    const input = container.querySelector('input[name="model"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'gpt-typed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex', model: 'gpt-typed' }));
  });
});

describe('LiveDataSource.getModels', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('asks for one harness and access, refresh only when asked, and keeps only ids and labels', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        urls.push(input);
        return new Response(
          JSON.stringify({ harness: 'claude', access: 'openrouter', models: [{ id: 'a/b', label: 'A: B' }, { id: 'c/d', label: 7 }, { label: 'no id' }], source: 'api', fetched_at: '2026-11-13T10:00:00Z' }),
          { status: 200 },
        );
      }),
    );
    const src = new LiveDataSource({ baseUrl: 'http://cockpit.test' });
    const l = await src.getModels('claude', 'openrouter');
    await src.getModels('claude', 'openrouter', true);
    expect(urls).toEqual(['http://cockpit.test/api/v0/harnesses/claude/models?access=openrouter', 'http://cockpit.test/api/v0/harnesses/claude/models?access=openrouter&refresh=true']);
    expect(l).toEqual({ harness: 'claude', access: 'openrouter', models: [{ id: 'a/b', label: 'A: B' }, { id: 'c/d' }], source: 'api', fetched_at: '2026-11-13T10:00:00Z' });
  });
});

const CATALOGUE = {
  data: [
    { id: 'openai/gpt-oss-120b', name: 'OpenAI: gpt-oss-120b', context_length: 131072, pricing: { prompt: '0.00000005', completion: '0.00000025' } },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', context_length: 1048576, pricing: { prompt: '0.00000014', completion: '0.00000042' } },
    { id: 'x-ai/grok-4.7', name: 'SpaceXSI: Grok 4.7', context_length: 256000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: '~openai/gpt-astra-latest', name: 'OpenAI: GPT Astra', context_length: 1, pricing: { prompt: '0', completion: '0' } },
  ],
};

const OR_HARNESS = {
  name: 'claude',
  label: 'Claude Code',
  found: true,
  runners: [],
  access: [
    { kind: 'subscription', label: 'Claude subscription', models: ['sonnet', 'opus'], any_model: true },
    { kind: 'openrouter', label: 'OpenRouter key', models: ['deepseek/deepseek-v4.1-flash', 'missing/one'], any_model: true },
    { kind: 'api', label: 'API key', models: ['claude-sonnet'], any_model: false, key_name: 'anthropic' },
  ],
} as Harness;

// An earlier test can leave its menu on document.body. The one just opened is last.
const latestMenu = () => document.querySelectorAll('[role="listbox"]').item(document.querySelectorAll('[role="listbox"]').length - 1);

async function typeIn(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('OpenRouter model picker', () => {
  it('puts suggested models first, fills the model field from a pick, and submits that id', async () => {
    const loadModels = vi.fn(async (h: string, a: string): Promise<ModelList> => ({ harness: h, access: a, models: [{ id: 'sonnet' }, { id: 'opus' }], source: 'fixed' }));
    const loadOpenRouterModels = vi.fn(async () => parseOpenRouterBody(CATALOGUE));
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [OR_HARNESS]} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadModels={loadModels} loadOpenRouterModels={loadOpenRouterModels} />,
    );
    await flush();
    expect(loadOpenRouterModels).not.toHaveBeenCalled();
    expect(loadModels).toHaveBeenCalledWith('claude', 'subscription', false);
    const sub = container.querySelector('input[name="model"]') as HTMLInputElement;
    await focus(sub);
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['sonnet', 'opus']);
    expect(latestMenu()!.querySelector('.menu-g')).toBeNull();

    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    expect(loadModels.mock.calls.every((c) => c[1] !== 'openrouter')).toBe(true);
    expect(loadOpenRouterModels).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(container.querySelector('.ad-models')?.textContent).toContain('3 models');
    await click(container.querySelector('.ad-models-refresh'));
    await flush();
    expect(loadOpenRouterModels).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
    const model = container.querySelector('input[name="model"]') as HTMLInputElement;
    expect(model.value).toBe('deepseek/deepseek-v4.1-flash');
    await focus(model);
    expect([...latestMenu()!.querySelectorAll('.menu-g')].map((g) => g.textContent)).toEqual(['Suggested', 'All models']);
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'missing/one',
      'openai/gpt-oss-120b',
      'x-ai/grok-4.7',
    ]);
    expect(latestMenu()!.querySelector('[data-value="~openai/gpt-astra-latest"]')).toBeNull();
    const flash = latestMenu()!.querySelector('[data-value="deepseek/deepseek-v4.1-flash"]')!;
    expect(flash.textContent).toContain('DeepSeek V4.1 Flash');
    expect(flash.textContent).toContain('deepseek/deepseek-v4.1-flash · DeepSeek · 1,048,576 · $0.14 in · $0.42 out');
    expect(latestMenu()!.querySelector('[data-value="missing/one"]')!.querySelector('.sub')).toBeNull();

    await typeIn(model, 'SpaceXSI');
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['x-ai/grok-4.7']);
    expect([...latestMenu()!.querySelectorAll('.menu-g')].map((g) => g.textContent)).toEqual(['All models']);
    await click(latestMenu()!.querySelector('[data-value="x-ai/grok-4.7"]'));
    expect(model.value).toBe('x-ai/grok-4.7');
    expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Claude Code · x-ai/grok-4.7');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith({
      name: 'Claude Code · x-ai/grok-4.7',
      harness: 'claude',
      access: 'openrouter',
      model: 'x-ai/grok-4.7',
    });
  });

  it('submits a model id typed by hand, including when the catalogue fails', async () => {
    const loadOpenRouterModels = vi.fn(async () => {
      throw new Error('offline');
    });
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [OR_HARNESS]} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadOpenRouterModels={loadOpenRouterModels} />,
    );
    await flush();
    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain(OPENROUTER_LOAD_ERROR);
    expect(container.querySelector('.ad-models')?.textContent).not.toContain('could not be refreshed');
    const model = container.querySelector('input[name="model"]') as HTMLInputElement;
    expect(model.disabled).toBe(false);
    await focus(model);
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'missing/one',
    ]);
    await typeIn(model, 'qwen/qwen3-coder:free');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ access: 'openrouter', model: 'qwen/qwen3-coder:free' }));
  });

  it('says when the catalogue is empty, and leaves an API-key model as a fixed list', async () => {
    const loadOpenRouterModels = vi.fn(async () => []);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [OR_HARNESS]} createAgent={vi.fn()} updateAgent={vi.fn()} onClose={() => undefined} loadOpenRouterModels={loadOpenRouterModels} />,
    );
    await flush();
    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain('No models returned. Type a model id.');
    const model = container.querySelector('input[name="model"]') as HTMLInputElement;
    await typeIn(model, 'custom/typed');
    expect(model.value).toBe('custom/typed');

    await click(container.querySelector('[data-access="api"]'));
    await flush();
    expect(container.querySelector('input[name="model"]')).toBeNull();
    expect(container.querySelector('[role="combobox"][name="model"]')).not.toBeNull();
    expect(loadOpenRouterModels).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded models when a refresh fails, and clears that note when a later one works', async () => {
    let failRefresh = false;
    const loadOpenRouterModels = vi.fn(async (refresh?: boolean) => {
      if (refresh && failRefresh) throw new Error('offline');
      return parseOpenRouterBody(CATALOGUE);
    });
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [OR_HARNESS]} createAgent={vi.fn()} updateAgent={vi.fn()} onClose={() => undefined} loadOpenRouterModels={loadOpenRouterModels} />,
    );
    await flush();
    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain('3 models');
    failRefresh = true;
    await click(container.querySelector('.ad-models-refresh'));
    await flush();
    const note = container.querySelector('.ad-models');
    expect(note?.textContent).toContain(OPENROUTER_REFRESH_ERROR);
    expect(note?.textContent).not.toContain(OPENROUTER_LOAD_ERROR);
    const model = container.querySelector('input[name="model"]') as HTMLInputElement;
    expect(model.disabled).toBe(false);
    await focus(model);
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'missing/one',
      'openai/gpt-oss-120b',
      'x-ai/grok-4.7',
    ]);
    failRefresh = false;
    await click(container.querySelector('.ad-models-refresh'));
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain('3 models');
    expect(container.querySelector('.ad-models')?.textContent).not.toContain('could not be refreshed');
  });

  it('searches ids, providers and prices, and not the words in and out', async () => {
    const loadOpenRouterModels = vi.fn(async () => parseOpenRouterBody(CATALOGUE));
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [OR_HARNESS]} createAgent={vi.fn()} updateAgent={vi.fn()} onClose={() => undefined} loadOpenRouterModels={loadOpenRouterModels} />,
    );
    await flush();
    await click(container.querySelector('[data-access="openrouter"]'));
    await flush();
    const model = container.querySelector('input[name="model"]') as HTMLInputElement;
    await focus(model);
    const grok = latestMenu()!.querySelector('[data-value="x-ai/grok-4.7"]')!;
    expect(grok.textContent).toContain('$2.50 in');
    expect(grok.textContent).toContain('$10 out');
    const openMenus = () => document.querySelectorAll('[role="listbox"]').length;
    const openBefore = openMenus();
    await typeIn(model, 'out');
    expect(model.getAttribute('aria-expanded')).toBe('false');
    expect(openMenus()).toBe(openBefore - 1);
    await typeIn(model, 'in');
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['missing/one']);
    await typeIn(model, '0.14');
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['deepseek/deepseek-v4.1-flash']);
    await typeIn(model, 'x-ai');
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['x-ai/grok-4.7']);
    await typeIn(model, '1,048,576');
    expect([...latestMenu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['deepseek/deepseek-v4.1-flash']);
  });
});
