// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentsColumn } from '../components/AgentsColumn';
import { RunnersList, useRunners } from '../components/RunnersList';
import { RunnersPage } from '../components/RunnersPage';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { pageOf } from '../page';
import { ApiTurn } from '../data/jobs';
import { LiveDataSource } from '../data/LiveDataSource';
import { versionLabel } from '../utils/format';
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
    expect(rows[0].querySelector('.rn-dot.online')).not.toBeNull();
    expect(rows[0].textContent).toContain('online');
    expect(rows[0].querySelector('.rn-h')!.textContent).toBe('claude');
    expect(rows[1].textContent).toContain('connector');
    expect(rows[1].querySelector('.rn-h')).toBeNull();
    expect(rows[2].querySelector('.rn-dot.offline')).not.toBeNull();
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
    const back = link(r.container, 'Cockpit')!;
    expect(back.getAttribute('href')).toBe('/');
    await click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('the Runners page in three columns', () => {
  const full: RunnerInfo = {
    ...runners[0],
    capacity: 4,
    os: 'darwin',
    arch: 'arm64',
    labels: ['gpu'],
    enrolled: '2026-11-11T09:00:03Z',
    harnesses: [
      { name: 'claude', found: true, version: '2.1.319', signed_in: true },
      { name: 'codex', found: true, version: '0.164.0' },
      { name: 'agy', found: false },
    ],
  };
  const turn = (t: Partial<ApiTurn>): ApiTurn => ({ id: 't', session: 's', agent: 'claude', folder: '', prompt: '', state: 'queued', ...t });

  it('shows the first runner, and another on a click, with only what it reported', async () => {
    const r = await render(<RunnersPage runners={[full, runners[1], runners[2]]} error={null} onBack={() => {}} />);
    const main = () => r.container.querySelector('.pg-main')!;
    expect(r.container.querySelector('.pg-list .runner.on')!.getAttribute('data-runner')).toBe('run_a');
    expect(main().querySelector('.colhead')!.textContent).toBe('macrunner');
    const t = main().textContent!;
    expect(t).toContain('Online');
    expect(t).toContain('4 turns at once');
    expect(t).toContain('claude 2.1.319');
    expect(t).toContain('darwin arm64');
    expect(t).toContain('gpu');
    // Signed in lists only the harnesses that said so.
    const signed = [...main().querySelectorAll('.pg-kv tr')].find((x) => x.textContent!.startsWith('Signed in'))!;
    expect(signed.textContent).toBe('Signed inclaude');
    // A harness not found is listed, quiet.
    expect(main().querySelector('.rn-harnesses tr.off')!.textContent).toContain('agy');
    // A connector has no harnesses; an offline runner says when it was last seen.
    await click(r.container.querySelector('[data-runner="run_b"]'));
    expect(main().querySelector('.colhead')!.textContent).toBe('macconnector');
    expect(main().textContent).not.toContain('Harnesses');
    expect(main().textContent).toContain('takes no work now');
    await click(r.container.querySelector('[data-runner="run_c"]'));
    expect(main().textContent).toContain('Offline');
    expect(main().textContent).toContain('last seen 3 min ago');
    expect(main().textContent).toContain('not reported yet');
  });

  it('says one runner per machine, and shows the machine a session names', async () => {
    const r = await render(<RunnersPage runners={[{ ...full, connector: 'con_8a7b6c5d4e3f2a10' }]} error={null} onBack={() => {}} />);
    const machine = [...r.container.querySelectorAll('.pg-main .pg-kv tr')].find((x) => x.textContent!.startsWith('Machine'))!;
    expect(machine.textContent).toBe('Machinecon_8a7b6c5d4e3f2a10');
    expect(r.container.textContent).toContain('One runner per machine.');
    expect(r.container.textContent).not.toContain('A connector owns');
  });

  it('shows the queue: what waits and why, and what runs', async () => {
    const turns = [
      turn({ id: 'q1', prompt: 'fix the test', ahead: 2, asked: new Date(Date.now() - 120_000).toISOString() }),
      turn({ id: 'q2', prompt: 'write docs', ahead: 0 }),
      turn({ id: 'r1', prompt: 'refactor', state: 'running', number: 3 }),
      turn({ id: 'f1', prompt: 'done', state: 'finished' }),
    ];
    const r = await render(<RunnersPage runners={runners} error={null} onBack={() => {}} queue={{ turns, error: null }} />);
    const side = r.container.querySelector('.pg-side')!;
    expect(side.querySelector('.tab-sum')!.textContent).toBe('2 waiting·1 running');
    const waiting = side.querySelector('[aria-label="Waiting"]')!;
    expect([...waiting.querySelectorAll('[data-turn]')].map((x) => x.getAttribute('data-turn'))).toEqual(['q1', 'q2']);
    expect(waiting.querySelector('[data-turn="q1"]')!.textContent).toContain('2 earlier turns of its session');
    expect(waiting.querySelector('[data-turn="q1"]')!.textContent).toContain('2 min ago');
    expect(waiting.querySelector('[data-turn="q2"]')!.textContent).toContain('for a free runner');
    const running = side.querySelector('[aria-label="Running"]')!;
    expect(running.textContent).toContain('refactor');
    expect(running.textContent).toContain('turn 3');
    expect(side.textContent).not.toContain('done');
    r.unmount();
    const none = await render(<RunnersPage runners={runners} error={null} onBack={() => {}} />);
    expect(none.container.querySelector('.pg-side')!.textContent).toContain('This service keeps no queue.');
  });
});

describe('the AgentBus card', () => {
  it('names a release by its version, and a dev build by its short commit too', () => {
    expect(versionLabel({ version: '0.5.0', commit: '5fea80b5aaaabbbb', modified: false })).toBe('0.5.0');
    expect(versionLabel({ version: 'dev', commit: '12874bdeabbcdc22', modified: false })).toBe('dev · 12874bd');
    expect(versionLabel({ version: 'dev', commit: '12874bdeabbcdc22', modified: true })).toBe('dev · 12874bd+');
    expect(versionLabel({ version: 'dev' })).toBe('dev');
  });

  it('reads GET /api/v0/version with the token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ version: 'dev', commit: 'abc', modified: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const src = new LiveDataSource({ baseUrl: 'http://127.0.0.1:8787', token: 'tok' });
    expect(await src.getVersion()).toEqual({ version: 'dev', commit: 'abc', modified: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8787/api/v0/version');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    vi.unstubAllGlobals();
  });

  it('shows the version on the card at the foot, which sits outside the scrolling list', async () => {
    const src = Object.assign(new ReplayDataSource(jsonl([ev({ seq: 1, session: 'st', kind: 'session.registered', agent: 'claude', folder: '/w' })])), {
      listRunners: vi.fn(async () => runners),
      getVersion: vi.fn(async () => ({ version: 'dev', commit: '12874bdeabbcdc22', modified: false })),
    });
    const r = await render(<App dataSource={src} />);
    await flush();
    await flush();
    expect(src.getVersion).toHaveBeenCalledTimes(1);
    const col = r.container.querySelector('#agents')!;
    expect(col.querySelector('.bus-card .bc-v')!.textContent).toBe('dev · 12874bd');
    // The column is its header, the list that scrolls, then the foot: the
    // links and the card are never inside the list.
    expect([...col.children].map((x) => x.className)).toEqual(['colhead', 'colbody', 'brand-foot']);
    expect(col.querySelector('.colbody .brand-foot, .colbody .side-links, .colbody .bus-card')).toBeNull();
    expect(col.querySelector('.brand-foot .side-links')).not.toBeNull();
  });

  it('shows no version when the source has none', async () => {
    const a = await render(<AgentsColumn agents={[]} selectedAgentId={null} onSelectAgent={() => {}} />);
    expect(a.container.querySelector('.bc-v')).toBeNull();
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
    await click(link(r.container, 'Cockpit'));
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
