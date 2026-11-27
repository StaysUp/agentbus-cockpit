// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { GuidePage } from '../components/GuidePage';
import { guideFacts, type GuideFacts } from '../data/guide';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { pageOf } from '../page';
import { click, ev, flush, jsonl, render, unmountAll } from './helpers';

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  connected: true,
  agents: 0,
  signIn: false,
  sessions: 0,
  workedTogether: 0,
  ...over,
});

const page = async (over: Partial<GuideFacts> = {}, actions = {}) =>
  render(
    <GuidePage
      facts={facts(over)}
      actions={actions}
      onBack={() => {}}
      sourceLabel="http://127.0.0.1:8787"
      version="0.6.6"
    />
  );

const row = (c: HTMLElement, id: string) => c.querySelector(`.gd-row[data-step="${id}"]`) as HTMLButtonElement;
const main = (c: HTMLElement) => c.querySelector('.pg-main') as HTMLElement;
const action = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('.gd-actions button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('the setup guide', () => {
  it('is a page of its own, named by its path', () => {
    expect(pageOf('/guide')).toBe('guide');
    expect(pageOf('/guide/')).toBe('guide');
  });

  it('opens on the first required step left, and shows the whole quickstart', async () => {
    const r = await page();
    expect(r.container.querySelector('#page[aria-label="Setup"]')).not.toBeNull();
    const rows = [...r.container.querySelectorAll('.gd-row')].map((x) => x.getAttribute('data-step'));
    expect(rows).toEqual(['running', 'agents', 'sign-in', 'config', 'session', 'second-agent']);
    // AgentBus is already running: step 1 is done, and the count leaves the
    // optional steps out.
    expect(row(r.container, 'running').getAttribute('data-done')).toBe('yes');
    expect(r.container.querySelector('.gd-sumline')!.textContent).toBe('1 of 6 steps done');
    // The middle opens on the first step still to do.
    expect(row(r.container, 'agents').getAttribute('aria-current')).toBe('step');
    expect(main(r.container).querySelector('.colhead')!.textContent).toBe('Add your agentsstep 2 of 6');
    expect(r.container.querySelector('.gd-row[data-step="config"]')!.textContent).toContain('Optional');
  });

  it('shows a step’s copy and calls the cockpit action it names', async () => {
    const actions = {
      addAgent: vi.fn(),
      connect: vi.fn(),
      settings: vi.fn(),
      startSession: vi.fn(),
      cockpit: vi.fn(),
    };
    const r = await page({}, actions);
    expect(action(r.container, 'Add agent')).not.toBeUndefined();
    await click(action(r.container, 'Add agent'));
    expect(actions.addAgent).toHaveBeenCalledTimes(1);

    await click(row(r.container, 'sign-in'));
    expect(main(r.container).textContent).toContain('not the CLI');
    await click(action(r.container, 'Open Settings'));
    expect(actions.connect).toHaveBeenCalledTimes(1);

    await click(row(r.container, 'config'));
    expect(main(r.container).textContent).toContain('Use my config');
    await click(action(r.container, 'Open Settings'));
    expect(actions.settings).toHaveBeenCalledTimes(1);

    await click(row(r.container, 'session'));
    await click(action(r.container, 'Start a session'));
    expect(actions.startSession).toHaveBeenCalledTimes(1);

    await click(row(r.container, 'second-agent'));
    await click(action(r.container, 'Open the cockpit'));
    expect(actions.cockpit).toHaveBeenCalledTimes(1);

    // The first step has no action of its own beyond the way back to work.
    await click(row(r.container, 'running'));
    expect(main(r.container).textContent).toContain('agentbus up -open');
    expect(main(r.container).textContent).toContain('http://127.0.0.1:8787');
  });

  it('explains an action the cockpit cannot take, rather than drawing a dead button', async () => {
    const r = await page();
    expect(action(r.container, 'Add agent')).toBeUndefined();
    expect(main(r.container).textContent).toContain('This service keeps no saved agents');
    await click(row(r.container, 'sign-in'));
    expect(main(r.container).textContent).toContain('This service keeps no subscriptions');
    await click(row(r.container, 'session'));
    expect(main(r.container).textContent).toContain('Add an agent first.');
  });

  it('reports the facts it read, and marks the steps done', async () => {
    const r = await page({ agents: 2, signIn: true, sessions: 1, workedTogether: 1 });
    expect(r.container.querySelector('.gd-sumline')!.textContent).toBe('5 of 6 steps done');
    const side = r.container.querySelector('.pg-side') as HTMLElement;
    const text = side.textContent!;
    expect(text).toContain('Agents2');
    expect(text).toContain('Sign-inready');
    expect(text).toContain('Sessions1');
    expect(text).toContain('Two agentsyes');
    expect(text).toContain('0.6.6');
    expect(text).toContain('http://127.0.0.1:8787');
    // All required work is done; the next thing is the first optional step.
    expect(text).toContain('Bring your setup (optional)');
    for (const id of ['running', 'agents', 'sign-in', 'session']) {
      expect(row(r.container, id).getAttribute('data-done')).toBe('yes');
    }
    expect(row(r.container, 'config').getAttribute('data-done')).toBe('no');
  });

  it('derives the same facts the cockpit reads', () => {
    const f = guideFacts({ connected: true, agents: [], subscriptions: null, sessions: [] });
    expect(f).toEqual({ connected: true, agents: 0, signIn: false, sessions: 0, workedTogether: 0 });
  });

  it('opens from the foot nav and goes back to the cockpit', async () => {
    const src = new ReplayDataSource(
      jsonl([ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' })])
    );
    const r = await render(<App dataSource={src} />);
    await flush();
    await flush();
    const guide = [...r.container.querySelectorAll('.side-links a')].find(
      (a) => a.textContent?.trim() === 'Guide'
    ) as HTMLAnchorElement;
    expect(guide.getAttribute('href')).toBe('/guide');
    await click(guide);
    await flush();
    expect(window.location.pathname).toBe('/guide');
    expect(r.container.querySelector('#page[aria-label="Setup"]')).not.toBeNull();
    expect(r.container.querySelector('.side-link[aria-current="page"]')!.textContent).toContain('Guide');
    const cockpit = [...r.container.querySelectorAll('.side-links a')].find(
      (a) => a.textContent?.trim() === 'Cockpit'
    ) as HTMLAnchorElement;
    await click(cockpit);
    await flush();
    expect(window.location.pathname).toBe('/');
  });
});
