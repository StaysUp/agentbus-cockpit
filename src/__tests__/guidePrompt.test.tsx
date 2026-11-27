// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { GuidePrompt } from '../components/GuidePrompt';
import { GuideReturn } from '../components/GuideReturn';
import { GUIDE_PROMPT_KEY } from '../data/guidePrompt';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { click, ev, flush, jsonl, render, unmountAll } from './helpers';

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

// A fresh service: no agents and no sessions, but it can save agents.
const fresh = () =>
  Object.assign(new ReplayDataSource(jsonl([])), {
    listAgents: async () => [],
    getHarnesses: async () => [{ name: 'claude', found: true }],
    createAgent: async () => ({ id: 'a_1', name: 'Claude Code', harness: 'claude', access: 'subscription' }),
  });

// One session, so the guide prompt stays out of the way of the return test.
const oneSession = () =>
  Object.assign(
    new ReplayDataSource(
      jsonl([
        ev({ seq: 1, session: 's1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
        ev({ seq: 2, session: 's1', kind: 'turn.started', turn: 'T1', agent: 'claude', folder: '/w', text: 'hi' }),
      ])
    ),
    { listAgents: async () => [] }
  );

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

describe('the first-visit guide prompt', () => {
  it('asks once, starts the guide, and remembers the answer', async () => {
    const r = await render(<App dataSource={fresh()} />);
    await flush();
    await flush();
    const prompt = r.container.querySelector('.guide-prompt') as HTMLElement;
    expect(prompt).not.toBeNull();
    expect(prompt.querySelector('.nd-title')!.textContent).toBe('Set up AgentBus?');
    expect(prompt.textContent).toContain('adding an agent');
    await click(button(prompt, 'Start the guide'));
    await flush();
    expect(window.location.pathname).toBe('/guide');
    expect(localStorage.getItem(GUIDE_PROMPT_KEY)).toBe('1');
    expect(r.container.querySelector('#page[aria-label="Setup"]')).not.toBeNull();
  });

  it('can be declined, and does not ask again', async () => {
    const first = await render(<App dataSource={fresh()} />);
    await flush();
    await flush();
    await click(button(first.container.querySelector('.guide-prompt')!, 'Not now'));
    await flush();
    expect(first.container.querySelector('.guide-prompt')).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(localStorage.getItem(GUIDE_PROMPT_KEY)).toBe('1');
    first.unmount();

    // A new mount on the same browser reads the answer, not the question.
    const again = await render(<App dataSource={fresh()} />);
    await flush();
    await flush();
    expect(again.container.querySelector('.guide-prompt')).toBeNull();
  });

  it('draws the question as the cockpit’s one dialog', async () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    const r = await render(<GuidePrompt onStart={onStart} onClose={onClose} />);
    const dialog = r.container.querySelector('.new-dialog.guide-prompt')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Set up AgentBus?');
    await click(button(dialog, 'Start the guide'));
    expect(onStart).toHaveBeenCalledTimes(1);
    await click(button(dialog, 'Not now'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the way back to the guide', () => {
  it('shows the steps done, returns to the guide, and can be put away', async () => {
    const open = vi.fn();
    const dismiss = vi.fn();
    const r = await render(<GuideReturn done={2} total={6} onOpen={open} onDismiss={dismiss} />);
    expect(r.container.querySelector('.guide-return')!.textContent).toContain('Setup guide');
    expect(r.container.querySelector('.gr-p')!.textContent).toBe('2 of 6');
    await click(r.container.querySelector('.gr-open'));
    expect(open).toHaveBeenCalledTimes(1);
    await click(r.container.querySelector('.gr-x'));
    expect(dismiss).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it('stays after a step opens another page, with the progress so far', async () => {
    const r = await render(<App dataSource={oneSession()} />);
    await flush();
    await flush();
    const goGuide = [...r.container.querySelectorAll('.side-links a')].find((a) => a.textContent?.trim() === 'Guide')!;
    await click(goGuide);
    await flush();
    expect(window.location.pathname).toBe('/guide');

    // The running step's way back to work is a guide action.
    await click(r.container.querySelector('.gd-row[data-step="running"]'));
    await click(button(r.container.querySelector('.gd-actions')!, 'Open the cockpit'));
    await flush();
    expect(window.location.pathname).toBe('/');
    const back = r.container.querySelector('.guide-return') as HTMLElement;
    expect(back).not.toBeNull();
    expect(back.querySelector('.gr-p')!.textContent).toBe('2 of 6');

    // The pill returns to the guide and leaves the page.
    await click(back.querySelector('.gr-open'));
    await flush();
    expect(window.location.pathname).toBe('/guide');
    expect(r.container.querySelector('.guide-return')).toBeNull();

    // Coming back again, the pill can be dismissed instead.
    await click(r.container.querySelector('.gd-row[data-step="running"]'));
    await click(button(r.container.querySelector('.gd-actions')!, 'Open the cockpit'));
    await flush();
    expect(r.container.querySelector('.guide-return')).not.toBeNull();
    await click(r.container.querySelector('.guide-return .gr-x'));
    expect(r.container.querySelector('.guide-return')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });
});
