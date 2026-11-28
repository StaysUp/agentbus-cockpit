// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combo } from '../components/Controls';
import { AgentsDialog } from '../components/AgentsDialog';
import { LiveDataSource } from '../data/LiveDataSource';
import { Harness, ModelList } from '../types';
import { choose, click, flush, optionsOf, render, selectIn } from './helpers';

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

  it('offers the current model list, refreshes it, and lets the user return to Default before saving', async () => {
    const lists: Record<string, ModelList> = {
      claude: { harness: 'claude', access: 'subscription', models: [{ id: 'sonnet' }, { id: 'opus' }, { id: 'haiku' }], source: 'fixed' },
      codex: { harness: 'codex', access: 'subscription', models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' }, { id: 'gpt-6-luna' }], source: 'runner', fetched_at: '2026-11-13T10:00:00Z' },
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
    await click(container.querySelector('.ad-options'));
    const modelGroup = container.querySelector('#ad-model')!;
    const model = selectIn(modelGroup, 'model')!;
    expect(model.textContent).toBe('Default');
    expect((await optionsOf(container, 'model')).map(([, label]) => label))
      .toEqual(['Default', 'GPT 6.1 Sol', 'gpt-6-luna', 'Custom model ID…']);
    await choose(container, 'model', 'gpt-6.1-sol');
    expect(model.value).toBe('gpt-6.1-sol');
    expect(model.textContent).toBe('GPT 6.1 Sol');
    await click(modelGroup.querySelector('.ad-models-refresh'));
    await flush();
    expect(loadModels).toHaveBeenLastCalledWith('codex', 'subscription', true);
    await choose(container, 'model', '');
    expect(model.textContent).toBe('Default');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(createAgent).toHaveBeenCalledWith({ name: 'Codex', harness: 'codex', access: 'subscription' });
  });

  it('accepts a custom model ID even when no model list is available', async () => {
    const loadModels = vi.fn(async (): Promise<ModelList> => ({ harness: 'codex', access: 'subscription', models: [], source: 'runner', error: "no runner has reported Codex's models yet" }));
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [harnesses[1]]} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadModels={loadModels} />,
    );
    await flush();
    await click(container.querySelector('.ad-options'));
    expect(container.querySelector('.ad-models')?.textContent).toContain("No list of Codex's models yet.");
    await click(selectIn(container, 'model'));
    const custom = [...menu()!.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Custom model ID…');
    await click(custom);
    const input = container.querySelector('input[name="custom_model"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
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

  it('shows a saved model outside the list and resets it when editing to Default', async () => {
    const edit = { id: 'agent-1', name: 'Codex reviewer', harness: 'codex', access: 'subscription', model: 'saved-model' };
    const updateAgent = vi.fn(async () => edit);
    const { container } = await render(
      <AgentsDialog edit={edit} loadHarnesses={async () => [harnesses[1]]} createAgent={vi.fn()} updateAgent={updateAgent} onClose={() => undefined} />,
    );
    expect(selectIn(container, 'model')?.textContent).toBe('saved-model');
    await choose(container, 'model', '');
    await act(async () => {
      (container.querySelector('form.agent-form') as HTMLFormElement).requestSubmit();
    });
    expect(updateAgent).toHaveBeenCalledWith('agent-1', {
      name: 'Codex reviewer', harness: 'codex', access: 'subscription',
    });
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
