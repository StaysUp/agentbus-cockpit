// @vitest-environment jsdom
// The line under the agent picker: harness · model · access. A part with no
// value is left out, never shown as "undefined".
import { afterEach, describe, expect, it } from 'vitest';
import { agentLine } from '../components/AgentsDialog';
import { NewSessionDialog } from '../components/NewSessionDialog';
import { SavedAgent } from '../types';
import { flush, render, unmountAll } from './helpers';

afterEach(() => unmountAll());

describe('the agent line', () => {
  it('names harness, model and access as the API gives them', () => {
    const a = { id: 'a1', name: 'x', harness: 'claude', access: 'subscription' } as SavedAgent;
    expect(agentLine(a)).toBe('Claude Code · default model · subscription');
    expect(agentLine({ ...a, harness: 'opencode', access: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } as SavedAgent)).toBe(
      'OpenCode · deepseek/deepseek-v4.1-flash · OpenRouter'
    );
    expect(agentLine({ ...a, access: 'xai' } as SavedAgent)).toBe('Claude Code · default model · xai');
  });

  it('leaves the access out when an agent has none, and never says undefined', () => {
    const a = { id: 'a1', name: 'x', harness: 'claude' } as SavedAgent;
    expect(agentLine(a)).toBe('Claude Code · default model');
    expect(agentLine({ ...a, access: '' } as SavedAgent)).toBe('Claude Code · default model');
  });

  it('the New session dialog shows the line without undefined for such an agent', async () => {
    const r = await render(
      <NewSessionDialog loadAgents={async () => [{ id: 'claude', name: 'Claude Code', harness: 'claude' } as SavedAgent]} onStart={async () => {}} onClose={() => {}} />
    );
    await flush();
    const text = r.container.textContent ?? '';
    expect(text).toContain('Claude Code · default model');
    expect(text).not.toContain('undefined');
  });
});
