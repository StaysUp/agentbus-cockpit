// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnersPage } from '../components/RunnersPage';
import { CLOSE_WAITING, hasUnapplied, UNAPPLIED, WorkspacesApi } from '../components/Workspaces';
import { LiveDataSource } from '../data/LiveDataSource';
import { CloseState, RunnerInfo, WorkspaceRow } from '../types';
import { click, flush, render, unmountAll } from './helpers';

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const runners: RunnerInfo[] = [
  { id: 'run_a', name: 'mac', role: 'runner', machine: 'con_aaaaaaaaaaaaaaaa', online: true, last_seen: ago(0), labels: [], harnesses: [] },
  { id: 'run_b', name: 'box', role: 'runner', machine: 'con_bbbbbbbbbbbbbbbb', online: false, last_seen: ago(5), labels: [], harnesses: [] },
];

const ws = (w: Partial<WorkspaceRow> & { workspace: string }): WorkspaceRow => ({ sandbox: true, created: ago(10), ...w });

const rows: WorkspaceRow[] = [
  ws({ workspace: 'ws_old', machine: 'con_aaaaaaaaaaaaaaaa', folder: '/Users/p/Sites/old-app', created: ago(3 * 24 * 60) }),
  ws({ workspace: 'ws_new', machine: 'con_aaaaaaaaaaaaaaaa', folder: '/Users/p/Sites/new-app', created: ago(5), head_turn: 't_2', applied_turn: 't_1' }),
  ws({
    workspace: 'ws_two',
    machine: 'con_bbbbbbbbbbbbbbbb',
    folders: [
      { name: 'api', folder: '/srv/api' },
      { name: 'web', folder: '/srv/web' },
    ],
    created: ago(90),
    head_turn: 't_9',
    applied_turn: 't_9',
  }),
  ws({ workspace: 'ws_closed', machine: 'con_aaaaaaaaaaaaaaaa', folder: '/Users/p/gone', closed: ago(1) }),
  ws({ workspace: 'ws_real', machine: 'con_aaaaaaaaaaaaaaaa', folder: '/Users/p/real', sandbox: false }),
  ws({ workspace: 'ws_local', folder: '/home/p/here', created: ago(30) }),
];

const api = (close: WorkspacesApi['close'] = async () => ({ state: 'closed' })): WorkspacesApi & { list: ReturnType<typeof vi.fn> } => ({
  list: vi.fn(async () => rows),
  close,
});

const page = async (a: WorkspacesApi) => {
  const r = await render(<RunnersPage runners={runners} error={null} onBack={() => {}} workspaces={a} />);
  await flush();
  return r;
};

// The shown runner's Workspaces table, and the ids of its rows in order.
const table = (c: HTMLElement) => c.querySelector('table.rn-workspaces');
const ids = (c: HTMLElement) => [...(table(c)?.querySelectorAll('tr[data-workspace]') ?? [])].map((x) => x.getAttribute('data-workspace'));
const row = (c: HTMLElement, id: string) => c.querySelector(`tr[data-workspace="${id}"]`)!;
const pick = (c: HTMLElement, runner: string) => click(c.querySelector(`[data-runner="${runner}"]`));

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe('workspaces on a runner’s page', () => {
  it('shows the picked runner’s open sandbox workspaces on its page, newest first', async () => {
    const r = await page(api());
    // The list on the left is runners only.
    expect(r.container.querySelector('.runners [data-workspace]')).toBeNull();
    // Closed ones, and those in the real folder (nothing to close), are left
    // out. The one with no machine id is the service's own machine's: the
    // first runner listed.
    expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
    // Below Harnesses' place, under its own heading.
    expect(table(r.container)!.previousElementSibling!.textContent).toBe('Workspaces');
    // The folder name in full, its path on hover, and when it was made.
    expect(row(r.container, 'ws_old').querySelector('.ws-n')!.textContent).toBe('old-app');
    expect(row(r.container, 'ws_old').querySelector('.ws-n')!.getAttribute('title')).toBe('/Users/p/Sites/old-app');
    expect(row(r.container, 'ws_old').querySelector('.ws-age')!.textContent).toBe('3 days ago');
    // Another runner's page shows its own.
    await pick(r.container, 'run_b');
    expect(ids(r.container)).toEqual(['ws_two']);
    expect(row(r.container, 'ws_two').querySelector('.ws-n')!.textContent).toBe('api, web');
    expect(row(r.container, 'ws_two').querySelector('.ws-n')!.getAttribute('title')).toBe('/srv/api\n/srv/web');
    expect(row(r.container, 'ws_two').querySelector('.ws-age')!.textContent).toBe('1 hour ago');
  });

  it('gives a runner with no open workspaces no table', async () => {
    const a: WorkspacesApi = { list: async () => rows.filter((w) => w.machine === 'con_bbbbbbbbbbbbbbbb'), close: async () => ({}) };
    const r = await page(a);
    expect(table(r.container)).toBeNull();
  });

  it('marks a workspace with changes not applied, with a tooltip that says so', async () => {
    const r = await page(api());
    const mark = (id: string) => row(r.container, id).querySelector('.ws-unapplied');
    expect(mark('ws_new')!.getAttribute('title')).toBe(UNAPPLIED);
    expect(mark('ws_new')!.querySelector('svg')).not.toBeNull();
    expect(mark('ws_old')).toBeNull();
    // Everything applied up to its latest turn: no mark.
    await pick(r.container, 'run_b');
    expect(mark('ws_two')).toBeNull();
    expect(hasUnapplied(ws({ workspace: 'x' }))).toBe(false);
  });

  // A list that answers the rows given, then the next list once set.
  const listing = (close: WorkspacesApi['close']) => {
    let now = rows;
    const a = { list: vi.fn(async () => now), close };
    return { a, set: (next: WorkspaceRow[]) => (now = next) };
  };
  const closedNow = (id: string) => rows.map((w) => (w.workspace === id ? { ...w, closed: ago(0) } : w));
  const label = (c: HTMLElement, id: string) => row(c, id).querySelector('.ws-close')!.textContent;

  it('closes a workspace with no confirm, and the row goes once the service lists it closed', async () => {
    const close = vi.fn(async (): Promise<CloseState> => ({ state: 'closed' }));
    const { a, set } = listing(close);
    const r = await page(a);
    // The service lists it closed once the close has run.
    set(closedNow('ws_old'));
    const btn = row(r.container, 'ws_old').querySelector('.ws-close')!;
    // Quiet: a text action, not a bordered button.
    expect(btn.className).toContain('link-btn');
    await click(btn);
    await flush();
    expect(close).toHaveBeenCalledWith('ws_old');
    expect(r.container.querySelector('[role="dialog"]')).toBeNull();
    // The close reply reads the list again at once.
    expect(a.list).toHaveBeenCalledTimes(2);
    expect(ids(r.container)).toEqual(['ws_new', 'ws_local']);
  });

  it('keeps a row whose close still waits, marked Closing…, until the service lists it closed', async () => {
    const close = vi.fn(async (): Promise<CloseState> => ({ state: 'queued' }));
    const { a, set } = listing(close);
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const r = await page(a);
      await click(row(r.container, 'ws_new').querySelector('.ws-close'));
      await flush();
      // The service still lists it open: the close waits behind a turn.
      expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
      expect(label(r.container, 'ws_new')).toBe('Closing…');
      expect(row(r.container, 'ws_new').querySelector('.ws-close')!.getAttribute('title')).toBe(CLOSE_WAITING);
      expect(label(r.container, 'ws_old')).toBe('Close');
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
      expect(label(r.container, 'ws_new')).toBe('Closing…');
      // The close ran: the next read lists it closed and the row goes.
      set(closedNow('ws_new'));
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(ids(r.container)).toEqual(['ws_local', 'ws_old']);
      // A later turn copies it again: the service lists it open, and so does the page.
      set(rows);
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
      expect(label(r.container, 'ws_new')).toBe('Close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a failed close’s reason on its row, and keeps the row', async () => {
    const r = await page(api(async () => ({ state: 'failed', error: 'the copy could not be removed: permission denied' })));
    await click(row(r.container, 'ws_old').querySelector('.ws-close'));
    await flush();
    expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
    expect(label(r.container, 'ws_old')).toBe('Close');
    const err = r.container.querySelector('.ws-err-row')!;
    expect(err.previousElementSibling!.getAttribute('data-workspace')).toBe('ws_old');
    expect(err.textContent).toBe('the copy could not be removed: permission denied');
  });

  it('asked again while its close still waits, shows the service’s words and stays Closing…', async () => {
    const close = vi
      .fn<(id: string) => Promise<CloseState>>()
      .mockResolvedValueOnce({ state: 'running' })
      .mockRejectedValueOnce(new Error('an apply, discard, update or close of this workspace is still running or waiting'));
    const r = await page(api(close));
    await click(row(r.container, 'ws_old').querySelector('.ws-close'));
    await flush();
    expect(label(r.container, 'ws_old')).toBe('Closing…');
    await click(row(r.container, 'ws_old').querySelector('.ws-close'));
    await flush();
    expect(close).toHaveBeenCalledTimes(2);
    expect(label(r.container, 'ws_old')).toBe('Closing…');
    expect(r.container.querySelector('.ws-err')!.textContent).toBe(
      'an apply, discard, update or close of this workspace is still running or waiting'
    );
  });

  it('keeps the row and shows the API’s words when Close is refused', async () => {
    const r = await page(api(async () => Promise.reject(new Error('an apply of this workspace is still running'))));
    await click(row(r.container, 'ws_old').querySelector('.ws-close'));
    await flush();
    expect(ids(r.container)).toEqual(['ws_new', 'ws_local', 'ws_old']);
    expect(r.container.querySelector('.ws-err')!.textContent).toBe('an apply of this workspace is still running');
  });

  it('shows no workspaces for a source without them', async () => {
    const r = await render(<RunnersPage runners={runners} error={null} onBack={() => {}} />);
    expect(table(r.container)).toBeNull();
  });
});

describe('the live source’s workspaces', () => {
  const src = () => new LiveDataSource({ baseUrl: 'http://svc', token: 'tok' });

  it('lists them from GET /api/v0/workspaces, and null without the route', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: rows }), { status: 200 }));
    expect(await src().listWorkspaces()).toHaveLength(rows.length);
    expect(String(f.mock.calls[0][0])).toBe('http://svc/api/v0/workspaces');
    f.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await src().listWorkspaces()).toBeNull();
  });

  it('closes with POST /api/v0/workspaces/{id}/close and rejects a refusal in the API’s words', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ state: 'closed' }), { status: 200 }));
    expect(await src().closeWorkspace('ws_1')).toEqual({ state: 'closed' });
    expect(String(f.mock.calls[0][0])).toBe('http://svc/api/v0/workspaces/ws_1/close');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('POST');
    f.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'failed', error: 'still running or waiting' }), { status: 409 }));
    await expect(src().closeWorkspace('ws_1')).rejects.toThrow('still running or waiting');
  });
});
