// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combo } from '../components/Controls';
import { AgentsDialog } from '../components/AgentsDialog';
import { LiveDataSource } from '../data/LiveDataSource';
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
    expect(container.querySelector('.ad-models')?.textContent).toContain("3 models from Claude Code's aliases");
    expect(container.querySelector('.ad-models-refresh')).toBeNull();
    await click(container.querySelector('[data-harness="codex"]'));
    await flush();
    expect(loadModels).toHaveBeenLastCalledWith('codex', 'subscription', false);
    expect(container.querySelector('.ad-models')?.textContent).toContain("2 models from Codex's own list, after its last turn");
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

  it("shows the list's own words when it has none, and still takes a typed name", async () => {
    const loadModels = vi.fn(async (): Promise<ModelList> => ({ harness: 'codex', access: 'subscription', models: [], source: 'runner', error: "no runner has reported Codex's models yet" }));
    const createAgent = vi.fn(async () => ({}) as never);
    const { container } = await render(
      <AgentsDialog loadHarnesses={async () => [harnesses[1]]} createAgent={createAgent} updateAgent={vi.fn()} onClose={() => undefined} loadModels={loadModels} />,
    );
    await flush();
    expect(container.querySelector('.ad-models')?.textContent).toContain("no runner has reported Codex's models yet");
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
