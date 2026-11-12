// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentsColumn } from '../components/AgentsColumn';
import { RunnersList, useRunners } from '../components/RunnersList';
import { RunnersPage } from '../components/RunnersPage';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { pageOf } from '../page';
import { RunnerInfo } from '../types';
import { ev, flush, jsonl, render } from './helpers';

const runners: RunnerInfo[] = [
  {
    id: 'run_a',
    name: 'mac',
    role: 'runner',
    online: true,
    last_seen: new Date().toISOString(),
    labels: [],
    harnesses: [
      { name: 'claude', found: true, version: '2.1.319' },
      { name: 'codex', found: false },
    ],
  },
  { id: 'run_b', name: 'mac', role: 'connector', online: true, last_seen: new Date().toISOString(), labels: [], harnesses: [] },
  { id: 'run_c', name: 'box', role: 'runner', online: false, last_seen: new Date(Date.now() - 3 * 60_000).toISOString(), labels: [], harnesses: [] },
];

const link = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('a')].find((a) => a.textContent?.trim().startsWith(text)) as HTMLAnchorElement | undefined;

// A click as a browser sends it: cancelable, so a link the cockpit follows
// itself is not also followed by the page.
async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('the pages', () => {
  it('names a page by its path, and any other path is the cockpit', () => {
    expect(pageOf('/runners')).toBe('runners');
    expect(pageOf('/settings/')).toBe('settings');
    expect(pageOf('/')).toBe('cockpit');
    expect(pageOf('/sessions/x')).toBe('cockpit');
  });
});

describe('Runners list', () => {
  it('shows each runner with a dot, when it was last seen, and the harnesses it found', async () => {
    const r = await render(<RunnersList runners={runners} error={null} />);
    const rows = Array.from(r.container.querySelectorAll('.runner'));
    expect(rows.map((x) => x.getAttribute('data-runner'))).toEqual(['run_a', 'run_b', 'run_c']);
    expect(rows[0].querySelector('.live')).not.toBeNull();
    expect(rows[0].textContent).toContain('online');
    expect(rows[0].querySelector('.rn-h')!.textContent).toBe('claude 2.1.319');
    expect(rows[1].textContent).toContain('connector');
    expect(rows[1].querySelector('.rn-h')).toBeNull();
    expect(rows[2].querySelector('.gone')).not.toBeNull();
    expect(rows[2].textContent).toContain('last seen 3 min ago');
    expect(rows[2].querySelector('.rn-h')!.textContent).toBe('no harness found');
    r.unmount();
  });

  it('reads the list, and holds the API’s words on an error', async () => {
    let got: ReturnType<typeof useRunners> | undefined;
    const Probe = ({ load }: { load?: () => Promise<RunnerInfo[] | null> }) => {
      got = useRunners(load);
      return <RunnersList {...got} />;
    };
    const ok = await render(<Probe load={async () => runners} />);
    await flush();
    expect(got!.runners).toHaveLength(3);
    ok.unmount();
    const none = await render(<Probe />);
    await flush();
    expect(got!.runners).toBeNull();
    expect(none.container.querySelector('.runners')).toBeNull();
    none.unmount();
    const bad = await render(
      <Probe
        load={async () => {
          throw new Error('the token is not valid');
        }}
      />
    );
    await flush();
    expect(bad.container.querySelector('.runners-err')!.textContent).toBe('the token is not valid');
    bad.unmount();
  });

  it('is a page of its own with a way back', async () => {
    const onBack = vi.fn();
    const r = await render(<RunnersPage runners={runners} error={null} onBack={onBack} />);
    expect(r.container.querySelector('#page[aria-label="Runners"] h1')!.textContent).toBe('Runners');
    expect(r.container.querySelectorAll('.runner')).toHaveLength(3);
    const back = link(r.container, '← Cockpit')!;
    expect(back.getAttribute('href')).toBe('/');
    await click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('the links at the foot of the Agents column', () => {
  it('shows Runners with the online count and Settings, each only when the source has it', async () => {
    const onRunners = vi.fn();
    const onSettings = vi.fn();
    const a = await render(
      <AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} onRunners={onRunners} runnersOnline={2} onSettings={onSettings} />
    );
    const runnersLink = link(a.container, 'Runners')!;
    expect(runnersLink.getAttribute('href')).toBe('/runners');
    expect(runnersLink.querySelector('.sl-n')!.textContent).toBe('2');
    await click(runnersLink);
    expect(onRunners).toHaveBeenCalledTimes(1);
    const settingsLink = link(a.container, 'Settings')!;
    expect(settingsLink.getAttribute('href')).toBe('/settings');
    await click(settingsLink);
    expect(onSettings).toHaveBeenCalledTimes(1);
    // The runners list is no longer in the column.
    expect(a.container.querySelector('.runners')).toBeNull();
    a.unmount();
    const b = await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} />);
    expect(link(b.container, 'Runners')).toBeUndefined();
    expect(link(b.container, 'Settings')).toBeUndefined();
    expect(b.container.querySelector('.side-links')).toBeNull();
  });

  it('leaves a click with a modifier key to the browser', async () => {
    const onRunners = vi.fn();
    const a = await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} onRunners={onRunners} />);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    // The browser would open a new tab; jsdom cannot, so the test stops it here.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop);
    link(a.container, 'Runners')!.dispatchEvent(ev);
    document.removeEventListener('click', stop);
    expect(onRunners).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('the Runners page in the app', () => {
  const source = () =>
    Object.assign(new ReplayDataSource(jsonl([ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' })])), {
      listRunners: vi.fn(async () => runners),
    });

  it('counts the online runners, opens /runners, and goes back', async () => {
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const go = link(r.container, 'Runners')!;
    expect(go.querySelector('.sl-n')!.textContent).toBe('2');
    await click(go);
    await flush();
    expect(window.location.pathname).toBe('/runners');
    expect(r.container.querySelectorAll('#page .runner')).toHaveLength(3);
    await click(link(r.container, '← Cockpit'));
    await flush();
    expect(window.location.pathname).toBe('/');
    expect(r.container.querySelector('#page')).toBeNull();
    expect(link(r.container, 'Runners')).toBeDefined();
  });

  it('opens straight on the page at /runners', async () => {
    window.history.replaceState(null, '', '/runners');
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    expect(r.container.querySelectorAll('#page[aria-label="Runners"] .runner')).toHaveLength(3);
  });
});
