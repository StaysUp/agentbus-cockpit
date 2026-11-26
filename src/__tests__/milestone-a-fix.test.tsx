// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { LiveDataSource } from '../data/LiveDataSource';
import { ApplyPanel } from '../components/Changes';
import { turnDetail } from '../data/turns';
import { click, flush, render, unmountAll } from './helpers';
import type { DataSource, ApplyPreview } from '../types';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const row = (id: string) => ({ id, title: id, agent: 'claude', client: '', started: '2026-11-18T00:00:00Z', last: '2026-11-18T00:01:00Z', open: false, turns: 1, usage: null });

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

// P1 #1: sessions after the first API page reach the sidebar.
it('retains sessions beyond the first API page', async () => {
  const fetcher = vi.fn(async (input: string) => {
    const u = new URL(input);
    return u.searchParams.has('before')
      ? json({ store: 's', seq: 100, sessions: [row('older')], next_before: null })
      : json({ store: 's', seq: 100, sessions: [row('newer')], next_before: 7 });
  });
  vi.stubGlobal('fetch', fetcher);
  const list = await new LiveDataSource({ baseUrl: 'http://service.test' }).getSessions();
  expect(list.map((s) => s.id)).toEqual(['newer', 'older']);
});

// P1 #3: the files after the first preview page reach the panel.
it('provides the files after the first preview page', async () => {
  const page: ApplyPreview = {
    session: 's1', turn: 'T1', isolated: true, unapplied: true, count: 2,
    files: [{ path: 'z.txt', change: 'added', added: 1, removed: 0 }], conflicts: [],
    event: 'preview-1', store: 's', next_before: 1, previewed_at: '2026-11-18T00:01:00Z',
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const u = new URL(input);
    return u.searchParams.has('before')
      ? json({ ...page, files: [{ path: 'a.txt', change: 'added', added: 1, removed: 0 }], next_before: null })
      : json(page);
  }));
  const preview = await new LiveDataSource({ baseUrl: 'http://service.test' }).getWorkspaceChanges('s1');
  const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} />);
  const paths = Array.from(r.container.querySelectorAll('.ch-path code')).map((e) => e.textContent);
  const hasMore = Array.from(r.container.querySelectorAll('button')).some((b) => b.textContent === 'Load more');
  expect(paths.includes('a.txt') || hasMore).toBe(true);
  r.unmount();
});

// P1 #2: a turn's whole reply stays visible when its events carry no reply text.
it('keeps a full turn reply visible when its events carry no reply text', async () => {
  const events = [
    { id: 'e1', seq: 1, time: '2026-11-18T00:00:00Z', session: 's1', turn: 'T1', kind: 'turn.started', exchange: 'x1', text: '' },
    { id: 'e2', seq: 2, time: '2026-11-18T00:00:01Z', session: 's1', turn: 'T1', kind: 'model.requested', exchange: 'x1' },
    { id: 'e3', seq: 3, time: '2026-11-18T00:00:02Z', session: 's1', turn: 'T1', kind: 'model.responded', exchange: 'x1', status: 200 },
    { id: 'e4', seq: 4, time: '2026-11-18T00:00:03Z', session: 's1', turn: 'T1', kind: 'turn.completed' },
  ];
  const source: DataSource = {
    getSessions: async () => [row('s1')],
    getTurns: async () => ({ turns: [{ id: 'T1', sessionId: 's1', turnNumber: 1, startedAt: events[0].time, prompt: '', state: 'finished', usage: null, costUsd: null, costComplete: true }] }),
    getTurn: async () => turnDetail(events),
    getTurnText: async () => ({ prompt: 'The whole prompt', reply: 'The whole reply from the single turn' }),
  } as unknown as DataSource;
  const r = await render(<App dataSource={source} />);
  await flush();
  await flush();
  expect(r.container.querySelector('#convo')?.textContent).toContain('The whole reply from the single turn');
  r.unmount();
});

// P1 #4: the stale warning shows after an earlier apply in the same panel.
it('shows the stale warning after an earlier apply in the same panel', async () => {
  const initial: ApplyPreview = {
    session: 's1', turn: 'T1', isolated: true, unapplied: true, count: 1,
    files: [{ path: 'a.txt', change: 'added', added: 1, removed: 0 }], conflicts: [],
    previewed_at: '2026-11-18T00:01:00Z',
  };
  const apply = async () => ({ state: 'applied' as const });
  const r = await render(<ApplyPanel preview={initial} apply={apply} />);
  await click(Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent === 'Apply'));
  await flush();
  const stale: ApplyPreview = {
    ...initial, unapplied: false, count: 0, files: [], stale: true,
    why: 'the session changed after this preview was taken',
  };
  await act(async () => r.root.render(<ApplyPanel preview={stale} apply={apply} />));
  expect(r.container.textContent).toContain('Out of date.');
  expect(r.container.textContent).not.toContain('Your folder matches this session.');
  r.unmount();
});

// Round 2: stale status from a later preview page is carried out.
it('carries stale status from a later preview page', async () => {
  const page1: ApplyPreview = {
    session: 's1', turn: 'T1', isolated: true, unapplied: true, count: 2,
    files: [{ path: 'z.txt', change: 'added', added: 1, removed: 0 }], conflicts: [],
    event: 'preview-1', store: 's', next_before: 1, previewed_at: '2026-11-18T00:01:00Z',
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const u = new URL(input);
    return u.searchParams.has('before')
      ? json({ ...page1, files: [{ path: 'a.txt', change: 'added', added: 1, removed: 0 }], next_before: null, stale: true, why: 'the session changed after this preview was taken' })
      : json(page1);
  }));
  const preview = await new LiveDataSource({ baseUrl: 'http://service.test' }).getWorkspaceChanges('s1');
  expect(preview.stale).toBe(true);
  expect(preview.why).toContain('changed');
});

// Round 2: a 409 (pinned store changed) restarts the session read, not aborts.
it('restarts the session read when the pinned store changes (409)', async () => {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    call++;
    if (call === 1) return json({ store: 's1', seq: 100, sessions: [row('a')], next_before: 5 });
    if (call === 2) return new Response('store changed', { status: 409 });
    if (call === 3) return json({ store: 's2', seq: 50, sessions: [row('b')], next_before: 9 });
    return json({ store: 's2', seq: 50, sessions: [row('c')], next_before: null });
  }));
  const list = await new LiveDataSource({ baseUrl: 'http://service.test' }).getSessions();
  expect(list.map((s) => s.id)).toEqual(['b', 'c']);
});
