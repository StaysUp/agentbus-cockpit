// @vitest-environment jsdom
// Applying a conversation: the bar above the message box while it has work
// not yet in the person's folder, the preview in the right panel with one
// "Apply to my folder", and each turn's own read-only Changes tab.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App, TURN_END_POLL_MS } from '../App';
import { UPDATE_WAITING, ApplyPanel, groupByFolder, MERGE_REQUEST, TOO_BIG, TurnChangesTab, turnTooBig } from '../components/Changes';
import { LiveDataSource } from '../data/LiveDataSource';
import { ApplyPreview, ApplyState, DiscardState, TurnChangesPage, TurnDiff, UpdateState } from '../types';
// getWorkspaceChanges/applyWorkspace/discardWorkspace act on the session's
// workspace; these tests build sessions without a workspace field, so the
// cockpit falls back to the session id ('c1') as the workspace.
import { click, ev, flush, liveReplay, panelOpen, render, shownSession } from './helpers';
import type { WorkspaceOutcome } from '../data/outcome';

// The API's 202 reply (queued, with the event it names) and the outcome route
// behind it: each action's result is what readOutcome gives for its event.
function actions() {
  const results = new Map<string, WorkspaceOutcome>();
  let n = 0;
  const queue = (o: WorkspaceOutcome) => {
    const event = `ev_${++n}`;
    results.set(event, o);
    return { state: 'queued', event };
  };
  const readOutcome = vi.fn(async (event: string): Promise<WorkspaceOutcome> => results.get(event) ?? { state: 'queued' });
  return { queue, readOutcome, results };
}

const finished = [
  ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'edit a.txt' }),
  ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'done' }),
  ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

const A_DIFF = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';

const preview: ApplyPreview = {
  session: 'c1',
  isolated: true,
  unapplied: true,
  turn: 'T1',
  turns: ['T1'],
  count: 2,
  files: [
    { path: 'a.txt', change: 'modified', added: 1, removed: 1, diff: A_DIFF },
    { path: 'logo.png', change: 'added', added: 0, removed: 0, diff_left_out: true },
  ],
  conflicts: [],
};
const nothing: ApplyPreview = { session: 'c1', isolated: true, unapplied: false, count: 0, files: [], conflicts: [] };

const diff: TurnDiff = {
  turn: 'T1',
  session: 'c1',
  state: 'finished',
  files: { isolated: true, count: 1 },
  model_calls: { count: 1 },
  tools: { count: 1 },
  apply: { state: 'none' },
};

const changesPage: TurnChangesPage = {
  count: 1,
  changes: [{ path: 'a.txt', change: 'modified', size: 4, diff: A_DIFF }],
  next_before: null,
};

const bar = (c: HTMLElement) => c.querySelector('#c-reply .apply-bar') as HTMLElement | null;
const button = (c: ParentNode, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;

// GET /sessions folds each session's workspace and mode in. The replay source
// does not, so wrap it: session c1 runs in workspace ws_c1, in sandbox mode.
// Apply, Discard and the preview act on that workspace (no session-id fallback).
const withWorkspace = <T extends { id: string }>(list: T[]) => list.map((s) => ({ ...s, workspace: `ws_${s.id}`, sandbox: true }));

async function open(extra: Parameters<typeof liveReplay>[1]) {
  const lr = liveReplay(finished, extra);
  const source: typeof lr.source = {
    ...lr.source,
    getSessions: async () => withWorkspace(await lr.source.getSessions!()),
    subscribe: (cb, snap, st) => lr.source.subscribe!(cb, (sessions, c) => snap?.(withWorkspace(sessions), c), st),
  };
  const r = await render(<App dataSource={source} />);
  await flush();
  await flush();
  return { ...lr, source, r };
}

describe('The apply bar', () => {
  it('shows "● 2 files changed, not applied  Changes ▸" above the message box while there is unapplied work', async () => {
    const getWorkspaceChanges = vi.fn(async () => preview);
    const { r } = await open({ getWorkspaceChanges, applyWorkspace: vi.fn() });
    expect(getWorkspaceChanges).toHaveBeenCalledWith('ws_c1', undefined);
    const b = bar(r.container)!;
    expect(b).not.toBeNull();
    expect(b.querySelector('.ab-dot')!.textContent).toBe('●');
    expect(b.querySelector('.ab-text')!.textContent).toBe('2 files changed, not applied');
    expect(b.querySelector('.ab-review')!.textContent).toBe('Changes ▸');
    // Directly above the message box.
    expect(b.nextElementSibling!.tagName).toBe('FORM');
    r.unmount();
  });

  it('is not shown when nothing is unapplied, or when the source has no preview', async () => {
    const a = await open({ getWorkspaceChanges: vi.fn(async () => nothing) });
    expect(bar(a.r.container)).toBeNull();
    a.r.unmount();
    const b = await open({});
    expect(bar(b.r.container)).toBeNull();
    b.r.unmount();
  });

  it('the old per-turn "N files changed · Review" header control is gone', async () => {
    const getTurnDiff = vi.fn(async () => diff);
    const { r } = await open({ getWorkspaceChanges: vi.fn(async () => preview), getTurnDiff, applyWorkspace: vi.fn() });
    expect(r.container.querySelector('#convo .tb-changes')).toBeNull();
    expect(r.container.querySelector('#convo .tb-applied')).toBeNull();
    // No turn's diff is read for the chat itself.
    expect(getTurnDiff).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is read again when a turn ends, records its changes, or is applied', async () => {
    let p = nothing;
    const getWorkspaceChanges = vi.fn(async () => p);
    const { r, push } = await open({ getWorkspaceChanges });
    expect(bar(r.container)).toBeNull();
    const reads = getWorkspaceChanges.mock.calls.length;
    p = preview;
    await act(async () => push(ev({ seq: 6, session: 'c1', kind: 'turn.changed', turn: 'T1' })));
    await flush();
    expect(getWorkspaceChanges.mock.calls.length).toBe(reads + 1);
    expect(bar(r.container)).not.toBeNull();
    p = nothing;
    await act(async () => push(ev({ seq: 7, session: 'c1', kind: 'turn.applied', turn: 'T1' })));
    await flush();
    expect(bar(r.container)).toBeNull();
    // Another session's events do not read it.
    const before = getWorkspaceChanges.mock.calls.length;
    await act(async () => push(ev({ seq: 8, session: 'c2', kind: 'turn.changed', turn: 'X' })));
    await flush();
    expect(getWorkspaceChanges.mock.calls.length).toBe(before);
    r.unmount();
  });

  it('is read again when an update (or a Merge) of its workspace ends, matched by the workspace', async () => {
    const getWorkspaceChanges = vi.fn(async () => preview);
    const { r, push } = await open({ getWorkspaceChanges });
    const reads = getWorkspaceChanges.mock.calls.length;
    // An update job has no session: the event names only the workspace.
    await act(async () => push(ev({ seq: 6, session: '', kind: 'workspace.updated', workspace: 'ws_c1' })));
    await flush();
    expect(getWorkspaceChanges.mock.calls.length).toBe(reads + 1);
    // Another workspace's update does not read it.
    await act(async () => push(ev({ seq: 7, session: '', kind: 'workspace.updated', workspace: 'ws_c2' })));
    await flush();
    expect(getWorkspaceChanges.mock.calls.length).toBe(reads + 1);
    r.unmount();
  });

  it('is read again when a discard, close or failed action of its workspace ends, matched by the workspace', async () => {
    const getWorkspaceChanges = vi.fn(async () => preview);
    const { r, push } = await open({ getWorkspaceChanges });
    let reads = getWorkspaceChanges.mock.calls.length;
    let seq = 20;
    for (const kind of ['workspace.discarded', 'workspace.closed', 'workspace.failed']) {
      // None of these carries a session: only the workspace.
      await act(async () => push(ev({ seq: seq++, session: '', kind, workspace: 'ws_c1' })));
      await flush();
      expect([kind, getWorkspaceChanges.mock.calls.length]).toEqual([kind, ++reads]);
      await act(async () => push(ev({ seq: seq++, session: '', kind, workspace: 'ws_other' })));
      await flush();
      expect([kind, getWorkspaceChanges.mock.calls.length]).toEqual([kind, reads]);
    }
    r.unmount();
  });

  it('runs one read at a time: events during a read make one more read after it', async () => {
    let release: (() => void) | null = null;
    let reads = 0;
    const getWorkspaceChanges = vi.fn(() => {
      reads++;
      if (reads === 1) return Promise.resolve(nothing);
      return new Promise<ApplyPreview>((done) => {
        release = () => done(preview);
      });
    });
    const { r, push } = await open({ getWorkspaceChanges });
    expect(reads).toBe(1);
    await act(async () => push(ev({ seq: 6, session: 'c1', kind: 'turn.completed', turn: 'T1' })));
    await act(async () => push(ev({ seq: 7, session: 'c1', kind: 'turn.changed', turn: 'T1' })));
    await act(async () => push(ev({ seq: 8, session: 'c1', kind: 'turn.changed', turn: 'T1' })));
    expect(reads).toBe(2);
    await act(async () => release!());
    await flush();
    expect(reads).toBe(3);
    r.unmount();
  });
});

describe('The apply preview', () => {
  it('Changes ▸ opens it in the right panel: each file with counts and a coloured diff', async () => {
    const { r } = await open({ getWorkspaceChanges: vi.fn(async () => preview), applyWorkspace: vi.fn() });
    expect(panelOpen(r.container)).toBe(false);
    await click(bar(r.container)!.querySelector('.ab-review'));
    await flush();
    expect(panelOpen(r.container)).toBe(true);
    const panel = r.container.querySelector('#right.apply-panel')!;
    expect(panel).not.toBeNull();
    expect(Array.from(panel.querySelectorAll('.ch-path code')).map((c) => c.textContent)).toEqual(['a.txt', 'logo.png']);
    const lines = (k: string) => Array.from(panel.querySelectorAll(`.ch-diff .dl.${k}`)).map((l) => l.textContent);
    expect(lines('add')).toEqual(['+two']);
    expect(lines('del')).toEqual(['-one']);
    expect(lines('hunk')).toEqual(['@@ -1 +1 @@']);
    expect(panel.querySelector('.ch-count')!.textContent).toBe('+1 −1');
    expect(panel.textContent).toContain('No diff here');
    const apply = button(panel, 'Apply')!;
    expect(apply.className).toContain('btn-primary');
    expect(apply.disabled).toBe(false);
    r.unmount();
  });

  it('Apply applies the turn the preview names; then "Applied. Your folder matches this session." and the bar goes', async () => {
    let p = preview;
    const getWorkspaceChanges = vi.fn(async () => p);
    const applyWorkspace = vi.fn(async () => ({ state: 'queued', event: 'ev_apply' }) as ApplyState);
    const getWorkspaceOutcome = vi.fn(async (ws: string, event: string) => {
      expect([ws, event]).toEqual(['ws_c1', 'ev_apply']);
      p = nothing;
      return { state: 'applied', files: ['a.txt', 'logo.png'] };
    });
    const { r } = await open({ getWorkspaceChanges, applyWorkspace, getWorkspaceOutcome });
    await click(bar(r.container)!.querySelector('.ab-review'));
    await flush();
    await click(button(r.container.querySelector('#right')!, 'Apply'));
    await flush();
    expect(applyWorkspace).toHaveBeenCalledWith('ws_c1', 'T1');
    expect(getWorkspaceOutcome).toHaveBeenCalledWith('ws_c1', 'ev_apply');
    expect(r.container.querySelector('#right .nd-note.ok[role="status"]')!.textContent).toBe('Applied. Your folder matches this session.');
    expect(button(r.container.querySelector('#right')!, 'Apply')).toBeUndefined();
    expect(bar(r.container)).toBeNull();
    r.unmount();
  });

  it('the bar is the panel foot: the file list scrolls in its own area above it, never under it', async () => {
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} discard={vi.fn()} />);
    const panel = r.container.querySelector('#right.apply-panel')!;
    const bar = panel.querySelector('.ap-actions')!;
    expect(bar).not.toBeNull();
    // Out of the scrolling body, after it, as the panel's last child.
    expect(bar.closest('#d-body')).toBeNull();
    expect(bar.parentElement).toBe(panel);
    expect(panel.lastElementChild).toBe(bar);
    expect(panel.querySelector('#d-body .ch-files')).not.toBeNull();
    // Its CSS (no sticky bar inside the scroll) is checked in look.test.ts.
    r.unmount();
  });

  it('a file changed in the folder since is marked plainly, and Apply is off', async () => {
    const conflicted: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }] };
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} />);
    expect(r.container.querySelector('.ch-file.conflict .ch-conflict')!.textContent).toBe(
      'you changed this file since; it would be refused'
    );
    const box = r.container.querySelector('.form-warn.ap-conflicts')!;
    expect(box.textContent).toContain('1 file would be refused.');
    expect(box.querySelector('li')!.textContent).toBe('a.txt: changed in your folder since the checkpoint');
    expect(button(r.container, 'Apply')!.disabled).toBe(true);
    r.unmount();
  });

  it('a refused apply (a 202, refused on its outcome) shows the API words and each conflict', async () => {
    const refused: ApplyState = {
      state: 'refused',
      error: 'apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt',
      conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }],
    };
    const { queue, readOutcome } = actions();
    const apply = vi.fn(async () => queue(refused) as ApplyState);
    const onApplyEnded = vi.fn();
    const r = await render(<ApplyPanel preview={preview} apply={apply} readOutcome={readOutcome} onApplyEnded={onApplyEnded} />);
    await click(button(r.container, 'Apply'));
    await flush();
    expect(apply).toHaveBeenCalledWith('T1');
    expect(onApplyEnded).toHaveBeenCalled();
    const err = r.container.querySelector('.form-error')!;
    expect(err.textContent).toContain('apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt');
    expect(err.querySelector('li')!.textContent).toBe('a.txt: changed in your folder since the checkpoint');
    r.unmount();
  });

  it('an apply still queued follows its own event on the outcome route until it ends', async () => {
    let ended = false;
    const readOutcome = vi.fn(async (_event: string): Promise<WorkspaceOutcome> => (ended ? { state: 'applied' } : { state: 'queued' }));
    const apply = vi.fn(async () => ({ state: 'queued', event: 'ev_9' }) as ApplyState);
    const r = await render(<ApplyPanel preview={preview} apply={apply} readOutcome={readOutcome} pollMs={5} />);
    await click(button(r.container, 'Apply'));
    await flush();
    expect(r.container.textContent).toContain('Applying…');
    ended = true;
    for (let i = 0; i < 50 && !r.container.textContent!.includes('Applied.'); i++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(readOutcome).toHaveBeenCalledWith('ev_9');
    expect(readOutcome.mock.calls.every((c) => c[0] === 'ev_9')).toBe(true);
    expect(r.container.textContent).toContain('Applied. Your folder matches this session.');
    r.unmount();
  });

  it('says how many files are not listed and when the preview was taken, with Refresh', async () => {
    const big: ApplyPreview = {
      session: 'c1',
      isolated: true,
      unapplied: true,
      turn: 'T1',
      count: 5000,
      truncated: true,
      previewed_at: '2026-11-17T20:00:00Z',
      files: [{ path: 'a.txt', change: 'modified', added: 1, removed: 0 }],
      conflicts: [],
    };
    const onRefresh = vi.fn();
    const r = await render(<ApplyPanel preview={big} apply={vi.fn()} onRefresh={onRefresh} />);
    expect(r.container.querySelector('.ap-more')!.textContent).toBe('4999 more files not listed: too many to send');
    expect(r.container.querySelector('.ap-asof')!.textContent).toContain('As of');
    await click(button(r.container, 'Refresh'));
    expect(onRefresh).toHaveBeenCalled();
    r.unmount();
  });

  it('a stale preview shows an out-of-date warning with its why', async () => {
    const stale: ApplyPreview = {
      session: 'c1',
      isolated: true,
      unapplied: true,
      turn: 'T1',
      count: 1,
      previewed_at: '2026-11-17T20:00:00Z',
      stale: true,
      why: 'the session changed after this preview was taken',
      files: [{ path: 'a.txt', change: 'modified', added: 1, removed: 0 }],
      conflicts: [],
    };
    const r = await render(<ApplyPanel preview={stale} apply={vi.fn()} />);
    const note = r.container.querySelector('.ap-stale')!;
    expect(note.textContent).toContain('Out of date');
    expect(note.textContent).toContain('the session changed after this preview was taken');
    r.unmount();
  });

  it('a preview that fails shows the words, e.g. a machine offline', async () => {
    const r = await render(<ApplyPanel preview={null} error="The machine with this folder is offline." />);
    expect(r.container.querySelector('.form-error')!.textContent).toBe('The machine with this folder is offline.');
    r.unmount();
  });

  it('a conversation not in an isolated copy says why, with no Apply', async () => {
    const r = await render(
      <ApplyPanel preview={{ ...nothing, isolated: false, why: 'this conversation works in your folder itself' }} apply={vi.fn()} />
    );
    expect(r.container.textContent).toContain('this conversation works in your folder itself');
    expect(button(r.container, 'Apply')).toBeUndefined();
    r.unmount();
  });

  it('the preview counts lines as the API gives them', async () => {
    const r = await render(<ApplyPanel preview={{ ...preview, files: [{ ...preview.files[0], added: 7, removed: 3 }] }} />);
    expect(r.container.querySelector('.ch-count')!.textContent).toBe('+7 −3');
    r.unmount();
  });

  it('more than three files start folded to their names', async () => {
    const many: ApplyPreview = {
      ...preview,
      count: 4,
      files: ['a', 'b', 'c', 'd'].map((p) => ({ path: `${p}.txt`, change: 'modified' as const, added: 1, removed: 1, diff: '@@ -1 +1 @@\n-x\n+y\n' })),
    };
    const r = await render(<ApplyPanel preview={many} />);
    const files = Array.from(r.container.querySelectorAll('details.ch-file')) as HTMLDetailsElement[];
    expect(files).toHaveLength(4);
    expect(files.every((f) => !f.open)).toBe(true);
    r.unmount();
  });

  it('clicking a turn shows the turn panel again', async () => {
    const { r } = await open({ getWorkspaceChanges: vi.fn(async () => preview), applyWorkspace: vi.fn() });
    await click(bar(r.container)!.querySelector('.ab-review'));
    await flush();
    expect(r.container.querySelector('#right.apply-panel')).not.toBeNull();
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    expect(r.container.querySelector('#right.apply-panel')).toBeNull();
    expect(r.container.querySelector('#right #d-tabs')).not.toBeNull();
    r.unmount();
  });
});

describe('A local file link and the Changes tab', () => {
  const reply = 'See [the file](/w/a.txt:6) and [missing](/w/xa.txt:2) and [other](/w/lib/a.txt) and [rel](./a.txt).';
  const linked = [
    ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', folder: '/w', text: 'edit a.txt' }),
    ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
    ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: reply }),
    ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
  ];
  const many: TurnChangesPage = {
    count: 4,
    changes: [
      { path: 'a.txt', change: 'modified', size: 4, diff: A_DIFF },
      { path: 'lib/a.txt', change: 'added', size: 1 },
      { path: 'b.txt', change: 'added', size: 1 },
      { path: 'c.txt', change: 'added', size: 1 },
    ],
    next_before: null,
  };
  const fileDiff: TurnDiff = { ...diff, files: { isolated: true, count: 4 } };

  function link(root: ParentNode, label: string): HTMLElement {
    const el = Array.from(root.querySelectorAll('#convo .md-file')).find((n) => n.textContent?.startsWith(label));
    if (!el) throw new Error(`no file link ${label}`);
    return el as HTMLElement;
  }
  function opened(root: ParentNode): string[] {
    return Array.from(root.querySelectorAll('details.ch-file'))
      .filter((el) => (el as HTMLDetailsElement).open)
      .map((el) => el.querySelector('code')!.textContent!);
  }

  it('opens a changed file, including one named like another, and copies a path that is not changed', async () => {
    let copied = '';
    const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { copied = t; } }, configurable: true });
    try {
      const lr = liveReplay(linked, { getTurnDiff: async () => fileDiff, getTurnChanges: async () => many });
      const source: typeof lr.source = {
        ...lr.source,
        getSessions: async () => withWorkspace(await lr.source.getSessions!()),
        subscribe: (cb, snap, st) => lr.source.subscribe!(cb, (sessions, c) => snap?.(withWorkspace(sessions), c), st),
      };
      const r = await render(<App dataSource={source} />);
      await flush();
      await flush();
      expect(panelOpen(r.container)).toBe(false);

      await click(link(r.container, 'missing'));
      await flush();
      await flush();
      expect(copied).toBe('/w/xa.txt:2');
      expect(panelOpen(r.container)).toBe(false);

      await click(link(r.container, 'the file'));
      await flush();
      await flush();
      await flush();
      expect(panelOpen(r.container)).toBe(true);
      expect(r.container.querySelector('#d-tabs .tab.on')!.textContent).toBe('Changes');
      // Four files start folded. Only a.txt is the file the link named.
      expect(opened(r.container)).toEqual(['a.txt']);
      expect(r.container.querySelector('#convo .md-file')!.textContent).toContain('a.txt:6');

      await click(link(r.container, 'other'));
      await flush();
      await flush();
      await flush();
      expect(opened(r.container)).toContain('lib/a.txt');
      expect(opened(r.container)).not.toEqual(['a.txt']);
      expect(copied).toBe('/w/xa.txt:2');

      await click(link(r.container, 'rel'));
      await flush();
      await flush();
      expect(opened(r.container)).toContain('a.txt');
      r.unmount();
    } finally {
      if (own) Object.defineProperty(navigator, 'clipboard', own);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('a Direct session copies the path: its Changes tab keeps no file list', async () => {
    let copied = '';
    const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { copied = t; } }, configurable: true });
    const getTurnChanges = vi.fn(async () => many);
    try {
      const lr = liveReplay(linked, { getTurnDiff: async () => fileDiff, getTurnChanges });
      const direct = <T extends { id: string }>(list: T[]) => list.map((s) => ({ ...s, workspace: `ws_${s.id}`, sandbox: false as const }));
      const source: typeof lr.source = {
        ...lr.source,
        getSessions: async () => direct(await lr.source.getSessions!()),
        subscribe: (cb, snap, st) => lr.source.subscribe!(cb, (sessions, c) => snap?.(direct(sessions), c), st),
      };
      const r = await render(<App dataSource={source} />);
      await flush();
      await flush();
      await click(link(r.container, 'the file'));
      await flush();
      await flush();
      expect(copied).toBe('/w/a.txt:6');
      expect(panelOpen(r.container)).toBe(false);
      expect(getTurnChanges).not.toHaveBeenCalled();
      r.unmount();
    } finally {
      if (own) Object.defineProperty(navigator, 'clipboard', own);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('opens a file that is on a later changes page', async () => {
    const page1: TurnChangesPage = {
      count: 5,
      changes: [
        { path: 'zzz.txt', change: 'added', size: 1 },
        { path: 'b.txt', change: 'added', size: 1 },
        { path: 'c.txt', change: 'added', size: 1 },
        { path: 'd.txt', change: 'added', size: 1 },
      ],
      next_before: 1,
    };
    const page2: TurnChangesPage = {
      count: 5,
      changes: [{ path: 'a.txt', change: 'modified', size: 4, diff: A_DIFF }],
      next_before: null,
    };
    const loadChanges = vi.fn(async (before?: number) => (before ? page2 : page1));
    const r = await render(
      <TurnChangesTab
        turnId="T1"
        loadDiff={async () => ({ ...diff, files: { isolated: true, count: 5 } })}
        loadChanges={loadChanges}
        reveal={{ path: 'a.txt', n: 1 }}
      />,
    );
    await flush();
    await flush();
    await flush();
    expect(loadChanges).toHaveBeenCalledWith(1);
    expect(opened(r.container)).toEqual(['a.txt']);
    const z = Array.from(r.container.querySelectorAll('details.ch-file')).find((el) => el.querySelector('code')!.textContent === 'zzz.txt');
    expect((z as HTMLDetailsElement).open).toBe(false);
    r.unmount();
  });

  // A read held until the test lets it finish, so the click and a later
  // navigation can overlap.
  function heldChanges() {
    const lands: ((page: TurnChangesPage) => void)[] = [];
    const getTurnChanges = vi.fn(() => new Promise<TurnChangesPage>((res) => lands.push(res)));
    return { lands, getTurnChanges };
  }
  async function mount(events: ReturnType<typeof ev>[], extra: Parameters<typeof liveReplay>[1]) {
    const lr = liveReplay(events, extra);
    const source: typeof lr.source = {
      ...lr.source,
      getSessions: async () => withWorkspace(await lr.source.getSessions!()),
      subscribe: (cb, snap, st) => lr.source.subscribe!(cb, (sessions, c) => snap?.(withWorkspace(sessions), c), st),
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    return r;
  }
  function twoTurns() {
    return [
      ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', folder: '/w', text: 'edit a.txt' }),
      ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
      ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'See [the file](/w/a.txt:6).' }),
      ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
      ev({ seq: 6, session: 'c1', kind: 'turn.started', turn: 'T2', exchange: 'x2', folder: '/w', text: 'second' }),
      ev({ seq: 7, session: 'c1', kind: 'model.requested', turn: 'T2', exchange: 'x2' }),
      ev({ seq: 8, session: 'c1', kind: 'model.responded', turn: 'T2', exchange: 'x2', status: 200, text: 'ok' }),
      ev({ seq: 9, session: 'c1', kind: 'turn.completed', turn: 'T2', exchange: 'x2', outcome: 'finished' }),
    ];
  }
  const turnLabel = (root: ParentNode) => root.querySelector('.ph-n')!.textContent;
  const tabOn = (root: ParentNode) => root.querySelector('#d-tabs .tab.on')!.textContent;

  it('a lookup that finishes after another turn is open leaves that turn in place', async () => {
    const { lands, getTurnChanges } = heldChanges();
    const r = await mount(twoTurns(), { getTurnDiff: async () => fileDiff, getTurnChanges });
    await click(link(r.container, 'the file'));
    expect(getTurnChanges).toHaveBeenCalledTimes(1);
    await click(r.container.querySelectorAll('#convo .tb')[1]);
    await flush();
    expect(turnLabel(r.container)).toContain('Turn 2 of 2');
    await act(async () => lands[0](many));
    await flush();
    await flush();
    expect(turnLabel(r.container)).toContain('Turn 2 of 2');
    expect(tabOn(r.container)).toBe('Result');
    expect(r.container.querySelector('details.ch-file')).toBeNull();
    // The finished read released the in-flight flag, so a new click is read.
    await click(link(r.container, 'the file'));
    expect(getTurnChanges).toHaveBeenCalledTimes(2);
    await act(async () => lands[1](many));
    await flush();
    await flush();
    if (lands[2]) {
      await act(async () => lands[2](many));
      await flush();
      await flush();
    }
    expect(tabOn(r.container)).toBe('Changes');
    expect(opened(r.container)).toEqual(['a.txt']);
    r.unmount();
  });

  it('a lookup that finishes after another session is open leaves that session in place', async () => {
    const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      // c2 is created first, so its times are earlier and c1 is the session
      // opened on load. `linked` is built at import, and its times would lose.
      const older = [
        ev({ seq: 1, session: 'c2', kind: 'session.registered', agent: 'claude', folder: '/other' }),
        ev({ seq: 2, session: 'c2', kind: 'turn.started', turn: 'T9', exchange: 'y1', folder: '/other', text: 'other session' }),
        ev({ seq: 3, session: 'c2', kind: 'turn.completed', turn: 'T9', exchange: 'y1', outcome: 'finished' }),
      ];
      const here = [
        ev({ seq: 4, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
        ev({ seq: 5, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', folder: '/w', text: 'edit a.txt' }),
        ev({ seq: 6, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
        ev({ seq: 7, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'See [the file](/w/a.txt:6).' }),
        ev({ seq: 8, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
      ];
      const { lands, getTurnChanges } = heldChanges();
      const r = await mount([...older, ...here], { getTurnDiff: async () => fileDiff, getTurnChanges });
      expect(shownSession(r.container)).toBe('c1');
      expect(panelOpen(r.container)).toBe(false);
      await click(link(r.container, 'the file'));
      await click(r.container.querySelector('#sessions .sess[data-session="c2"]'));
      await flush();
      await flush();
      expect(shownSession(r.container)).toBe('c2');
      await act(async () => lands[0](many));
      await flush();
      await flush();
      expect(shownSession(r.container)).toBe('c2');
      expect(panelOpen(r.container)).toBe(false);
      expect(getTurnChanges).toHaveBeenCalledTimes(1);
      expect(writeText).not.toHaveBeenCalled();
      r.unmount();
    } finally {
      if (own) Object.defineProperty(navigator, 'clipboard', own);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('an older file lookup cannot overwrite a newer one that already landed', async () => {
    const turns = [
      ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', folder: '/w', text: 'edit a.txt' }),
      ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
      ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'See [alpha](/w/a.txt:6).' }),
      ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
      ev({ seq: 6, session: 'c1', kind: 'turn.started', turn: 'T2', exchange: 'x2', folder: '/w', text: 'second' }),
      ev({ seq: 7, session: 'c1', kind: 'model.requested', turn: 'T2', exchange: 'x2' }),
      ev({ seq: 8, session: 'c1', kind: 'model.responded', turn: 'T2', exchange: 'x2', status: 200, text: 'See [beta](/w/b.txt).' }),
      ev({ seq: 9, session: 'c1', kind: 'turn.completed', turn: 'T2', exchange: 'x2', outcome: 'finished' }),
    ];
    const { lands, getTurnChanges } = heldChanges();
    const r = await mount(turns, { getTurnDiff: async () => fileDiff, getTurnChanges });
    await click(link(r.container, 'alpha'));
    expect(getTurnChanges).toHaveBeenCalledTimes(1);
    await click(r.container.querySelectorAll('#convo .tb')[1]);
    await flush();
    await click(link(r.container, 'beta'));
    expect(getTurnChanges).toHaveBeenCalledTimes(2);
    // Turn B's read lands first and opens b.txt. Turn A's older read then
    // lands and must leave that turn and file where they are.
    await act(async () => lands[1](many));
    await flush();
    await flush();
    if (lands[2]) {
      await act(async () => lands[2](many));
      await flush();
      await flush();
    }
    expect(turnLabel(r.container)).toContain('Turn 2 of 2');
    expect(tabOn(r.container)).toBe('Changes');
    expect(opened(r.container)).toContain('b.txt');
    await act(async () => lands[0](many));
    await flush();
    await flush();
    expect(turnLabel(r.container)).toContain('Turn 2 of 2');
    expect(tabOn(r.container)).toBe('Changes');
    expect(opened(r.container)).toContain('b.txt');
    expect(opened(r.container)).not.toContain('a.txt');
    // The stale read did not leave the in-flight flag set.
    const calls = getTurnChanges.mock.calls.length;
    await click(link(r.container, 'beta'));
    expect(getTurnChanges.mock.calls.length).toBe(calls + 1);
    r.unmount();
  });

  it('an older lookup does not replace a tab chosen while it was reading', async () => {
    const { lands, getTurnChanges } = heldChanges();
    const r = await mount(twoTurns(), { getTurnDiff: async () => fileDiff, getTurnChanges });
    await click(link(r.container, 'the file'));
    await click(r.container.querySelectorAll('#convo .tb')[1]);
    await flush();
    const events = Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Events');
    await click(events);
    expect(tabOn(r.container)).toBe('Events');
    await act(async () => lands[0](many));
    await flush();
    await flush();
    expect(turnLabel(r.container)).toContain('Turn 2 of 2');
    expect(tabOn(r.container)).toBe('Events');
    expect(r.container.querySelector('details.ch-file')).toBeNull();
    expect(getTurnChanges).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it('a failed Changes lookup shows the API error and does not read again', async () => {
    const getTurnChanges = vi.fn(async () => {
      throw new Error('the runner is offline');
    });
    const getTurnDiff = vi.fn(async () => fileDiff);
    const r = await mount(linked, { getTurnDiff, getTurnChanges });
    await click(link(r.container, 'the file'));
    await flush();
    await flush();
    expect(r.container.querySelector('.form-error')!.textContent).toBe('the runner is offline');
    expect(tabOn(r.container)).toBe('Changes');
    expect(r.container.querySelector('details.ch-file')).toBeNull();
    expect(getTurnChanges).toHaveBeenCalledTimes(1);
    expect(getTurnDiff).not.toHaveBeenCalled();
    r.unmount();
  });

  it('the Changes error clears when another turn is selected and when a later lookup succeeds', async () => {
    let fail = true;
    const getTurnChanges = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error('the runner is offline');
      }
      return many;
    });
    const r = await mount(twoTurns(), { getTurnDiff: async () => fileDiff, getTurnChanges });
    await click(link(r.container, 'the file'));
    await flush();
    await flush();
    expect(r.container.querySelector('.form-error')!.textContent).toBe('the runner is offline');
    await click(r.container.querySelectorAll('#convo .tb')[1]);
    await flush();
    await flush();
    expect(r.container.querySelector('.form-error')).toBeNull();
    await click(r.container.querySelectorAll('#convo .tb')[0]);
    await flush();
    await flush();
    // Coming back does not bring the old failure with it.
    expect(r.container.querySelector('.form-error')).toBeNull();
    await click(link(r.container, 'the file'));
    await flush();
    await flush();
    await flush();
    expect(r.container.querySelector('.form-error')).toBeNull();
    expect(tabOn(r.container)).toBe('Changes');
    expect(opened(r.container)).toEqual(['a.txt']);
    r.unmount();
  });
});

describe("A turn's Changes tab", () => {
  it('sits beside Result and shows the turn\'s own diff, read-only', async () => {
    const getTurnDiff = vi.fn(async () => diff);
    const getTurnChanges = vi.fn(async () => changesPage);
    const { r } = await open({ getTurnDiff, getTurnChanges, applyWorkspace: vi.fn() });
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    const tabs = Array.from(r.container.querySelectorAll('#d-tabs .tab')).map((t) => t.textContent);
    expect(tabs.slice(0, 2)).toEqual(['Result', 'Changes']);
    expect(getTurnDiff).not.toHaveBeenCalled();
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Changes'));
    await flush();
    expect(getTurnDiff).toHaveBeenCalledWith('c1', 'T1');
    expect(getTurnChanges).toHaveBeenCalledWith('c1', 'T1', undefined);
    const body = r.container.querySelector('#d-body')!;
    expect(body.querySelector('.tab-sum')!.textContent).toContain('1 file');
    expect(body.querySelector('.ch-diff .dl.add')!.textContent).toBe('+two');
    expect(button(body, 'Apply')).toBeUndefined();
    r.unmount();
  });

  it('pages a long changes list with Load more, and shows it sorted by path', async () => {
    const page1: TurnChangesPage = {
      count: 3,
      changes: [
        { path: 'y.txt', change: 'added', size: 1 },
        { path: 'z.txt', change: 'added', size: 1 },
      ],
      next_before: 2,
    };
    const page2: TurnChangesPage = { count: 3, changes: [{ path: 'a.txt', change: 'added', size: 1 }], next_before: null };
    const loadChanges = vi.fn(async (before?: number) => (before ? page2 : page1));
    const big: TurnDiff = { ...diff, files: { isolated: true, count: 3 } };
    const r = await render(<TurnChangesTab turnId="T1" loadDiff={async () => big} loadChanges={loadChanges} />);
    await flush();
    const paths = () => Array.from(r.container.querySelectorAll('.ch-path code')).map((e) => e.textContent);
    expect(paths()).toEqual(['y.txt', 'z.txt']);
    await click(button(r.container, 'Load more'));
    await flush();
    expect(loadChanges).toHaveBeenCalledWith(2);
    expect(paths()).toEqual(['a.txt', 'y.txt', 'z.txt']);
    expect(button(r.container, 'Load more')).toBeUndefined();
    r.unmount();
  });

  it('holds Load more while a rev re-read is in flight, so it cannot page from the stale cursor', async () => {
    const page1: TurnChangesPage = { count: 3, changes: [{ path: 'z.txt', change: 'added', size: 1 }], next_before: 2 };
    let landSecond: ((p: TurnChangesPage) => void) | null = null;
    let call = 0;
    const loadChanges = vi.fn((_before?: number) => {
      call++;
      if (call === 1) return Promise.resolve(page1); // the first page, cursor 2
      if (call === 2) return new Promise<TurnChangesPage>((res) => (landSecond = res)); // the rev re-read, held
      return new Promise<TurnChangesPage>(() => {}); // a later Load more, never landed
    });
    const big: TurnDiff = { ...diff, files: { isolated: true, count: 3 } };
    const el = (rev: number) => <TurnChangesTab turnId="T1" rev={rev} loadDiff={async () => big} loadChanges={loadChanges} />;
    const r = await render(el(0));
    await flush();
    const more = () => button(r.container, 'Load more');
    expect(more()?.disabled).toBe(false);
    // rev bumps: the first-page re-read is in flight, so Load more is held.
    const { act } = await import('react');
    await act(async () => {
      r.root.render(el(1));
    });
    expect(more()?.disabled).toBe(true);
    const callsBefore = loadChanges.mock.calls.length;
    await click(more()); // a click while held pages nothing: the cursor is stale
    expect(loadChanges.mock.calls.length).toBe(callsBefore);
    // The re-read lands with a fresh page and cursor; Load more frees up and
    // pages from that fresh cursor, not the one the stale page carried.
    await act(async () => {
      landSecond!({ count: 3, changes: [{ path: 'm.txt', change: 'added', size: 1 }], next_before: 5 });
      await Promise.resolve();
    });
    await flush();
    expect(more()?.disabled).toBe(false);
    await click(more());
    await flush();
    expect(loadChanges).toHaveBeenLastCalledWith(5);
    r.unmount();
  });

  it('re-reads on a rev bump, keeping the files shown until the new read lands (no flash of Loading)', async () => {
    let landSecond: (() => void) | null = null;
    let first = true;
    const loadChanges = vi.fn((_before?: number) => {
      if (first) {
        first = false;
        return Promise.resolve(changesPage); // a.txt
      }
      return new Promise<TurnChangesPage>((res) => {
        landSecond = () => res({ count: 1, changes: [{ path: 'b.txt', change: 'added', size: 1, diff: A_DIFF }], next_before: null });
      });
    });
    const el = (rev: number) => <TurnChangesTab turnId="T1" rev={rev} loadDiff={async () => diff} loadChanges={loadChanges} />;
    const r = await render(el(0));
    await flush();
    const paths = () => Array.from(r.container.querySelectorAll('.ch-path code')).map((e) => e.textContent);
    expect(paths()).toEqual(['a.txt']);
    // rev bumps: the second read is in flight; the old file still shows, no Loading.
    const { act } = await import('react');
    await act(async () => {
      r.root.render(el(1));
    });
    expect(paths()).toEqual(['a.txt']);
    expect(r.container.querySelector('.turn-changes')).not.toBeNull();
    // The new read lands: the file list swaps.
    await act(async () => {
      landSecond!();
      await Promise.resolve();
    });
    await flush();
    expect(paths()).toEqual(['b.txt']);
    r.unmount();
  });

  it('shows the API words when Load more fails, and keeps the files already loaded', async () => {
    const page1: TurnChangesPage = { count: 3, changes: [{ path: 'z.txt', change: 'added', size: 1 }], next_before: 2 };
    const loadChanges = vi.fn(async (before?: number) => {
      if (before) throw new Error('the machine is offline');
      return page1;
    });
    const big: TurnDiff = { ...diff, files: { isolated: true, count: 3 } };
    const r = await render(<TurnChangesTab turnId="T1" loadDiff={async () => big} loadChanges={loadChanges} />);
    await flush();
    await click(button(r.container, 'Load more'));
    await flush();
    expect(r.container.textContent).toContain('offline');
    expect(Array.from(r.container.querySelectorAll('.ch-path code')).map((e) => e.textContent)).toEqual(['z.txt']);
    r.unmount();
  });

  it('re-reads when the turn gets an event that changes its data (turn.changed), and shows the new file', async () => {
    let page: TurnChangesPage = changesPage; // a.txt
    const getTurnDiff = vi.fn(async () => diff);
    const getTurnChanges = vi.fn(async () => page);
    const { r, push } = await open({ getTurnDiff, getTurnChanges, applyWorkspace: vi.fn() });
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Changes'));
    await flush();
    const paths = () => Array.from(r.container.querySelectorAll('.ch-path code')).map((e) => e.textContent);
    expect(paths()).toEqual(['a.txt']);
    const reads = getTurnChanges.mock.calls.length;
    // The turn's changes change: a new file, delivered by a turn.changed event.
    page = { count: 1, changes: [{ path: 'b.txt', change: 'added', size: 2, diff: A_DIFF }], next_before: null };
    await act(async () => push(ev({ seq: 6, session: 'c1', kind: 'turn.changed', turn: 'T1' })));
    await flush();
    expect(getTurnChanges.mock.calls.length).toBe(reads + 1);
    expect(paths()).toEqual(['b.txt']);
    // The run ending with no turn.completed (a stop or a failure ends the run
    // that way) also re-reads, so a settled turn is current.
    const afterChange = getTurnChanges.mock.calls.length;
    await act(async () => push(ev({ seq: 7, session: 'c1', kind: 'run.ended', hold: 'h1' })));
    await flush();
    expect(getTurnChanges.mock.calls.length).toBe(afterChange + 1);
    // Another session's event does not re-read this turn.
    const before = getTurnChanges.mock.calls.length;
    await act(async () => push(ev({ seq: 8, session: 'c2', kind: 'turn.changed', turn: 'X' })));
    await flush();
    expect(getTurnChanges.mock.calls.length).toBe(before);
    r.unmount();
  });

  // A running turn whose Changes tab is open. Its changeset commits a moment
  // after its last event, with nothing streamed to say so: the service reads
  // the turn as settled, a state the events alone do not carry. These build a
  // source whose getTurns reports that settling once `settled` flips, as the
  // real service does, over a liveReplay that still serves the turn's events.
  const runningBase = [
    ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ev({ seq: 2, session: 'c1', kind: 'run.started', turn: 'T1', hold: 'h1' }),
    ev({ seq: 3, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'edit a.txt' }),
    ev({ seq: 4, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ];
  const runningSource = (extra: Parameters<typeof liveReplay>[1], settledRef: { v: boolean }) => {
    const lr = liveReplay(runningBase, extra);
    const source: typeof lr.source = {
      ...lr.source,
      getTurns: async (id: string) => {
        const list = await lr.replay().getTurns(id);
        return settledRef.v
          ? { ...list, seq: (list.seq ?? 0) + 1, turns: list.turns.map((t) => (t.id === 'T1' ? { ...t, state: 'finished' as const } : t)) }
          : list;
      },
    };
    return { ...lr, source };
  };
  const openChanges = async (r: { container: HTMLElement }) => {
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Changes'));
    await flush();
  };
  const paths = (c: HTMLElement) => Array.from(c.querySelectorAll('.ch-path code')).map((e) => e.textContent);

  it('re-reads the Changes tab when the end poll sees the turn settle (no event says so)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let page: TurnChangesPage = { count: 0, changes: [], next_before: null };
      const settledRef = { v: false };
      const getTurnChanges = vi.fn(async () => page);
      const queuedTurn = vi.fn(async () => ({ ended: settledRef.v, failed: false }));
      const { source } = runningSource({ getTurnDiff: async () => diff, getTurnChanges, queuedTurn }, settledRef);
      const r = await render(<App dataSource={source} />);
      await flush();
      await flush();
      await openChanges(r);
      expect(paths(r.container)).toEqual([]); // the read made while it ran saw nothing
      const reads = getTurnChanges.mock.calls.length;
      // The job ends: the changeset is committed, the service reads the turn
      // settled, and the poll sees ended.
      page = { count: 1, changes: [{ path: 'a.txt', change: 'added', size: 2, diff: A_DIFF }], next_before: null };
      settledRef.v = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TURN_END_POLL_MS + 100);
      });
      await flush();
      expect(getTurnChanges.mock.calls.length).toBeGreaterThan(reads);
      expect(paths(r.container)).toEqual(['a.txt']);
      r.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads the Changes tab when an events.dropped refresh finds the turn settled', async () => {
    // No queuedTurn: the poll is off, so the only re-read comes from the
    // events.dropped refresh finding the turn settled. The old running-state
    // refresh handled this; the revision must still follow it.
    let page: TurnChangesPage = { count: 0, changes: [], next_before: null };
    const settledRef = { v: false };
    const getTurnChanges = vi.fn(async () => page);
    const { source, push } = runningSource({ getTurnDiff: async () => diff, getTurnChanges }, settledRef);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await openChanges(r);
    expect(paths(r.container)).toEqual([]);
    const reads = getTurnChanges.mock.calls.length;
    // The drop coincides with the turn having settled: the refresh it forces
    // reads the turn finished, so the tab must read its changes again.
    page = { count: 1, changes: [{ path: 'a.txt', change: 'added', size: 2, diff: A_DIFF }], next_before: null };
    settledRef.v = true;
    await act(async () => push(ev({ seq: 5, session: 'c1', kind: 'events.dropped', sessions: ['c1'] })));
    await flush();
    await flush();
    expect(getTurnChanges.mock.calls.length).toBeGreaterThan(reads);
    expect(paths(r.container)).toEqual(['a.txt']);
    r.unmount();
  });

  it('is not there when the source keeps no diffs', async () => {
    const { r } = await open({});
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    const tabs = Array.from(r.container.querySelectorAll('#d-tabs .tab')).map((t) => t.textContent);
    expect(tabs).not.toContain('Changes');
    r.unmount();
  });
});

describe('No workspace', () => {
  it('a session without a workspace reads no preview and offers no apply (no backward-compatible fallback)', async () => {
    // liveReplay does not fold a workspace in, so c1 has none.
    const getWorkspaceChanges = vi.fn(async () => preview);
    const lr = liveReplay(finished, { getWorkspaceChanges, applyWorkspace: vi.fn(), discardWorkspace: vi.fn() });
    const r = await render(<App dataSource={lr.source} />);
    await flush();
    await flush();
    expect(getWorkspaceChanges).not.toHaveBeenCalled();
    expect(bar(r.container)).toBeNull();
    r.unmount();
  });
});

describe('One rule for Apply, Discard and Update: send, wait, show the outcome of that event', () => {
  it('a failed apply (workspace.failed) is said in plain words, and Apply comes back', async () => {
    const { queue, readOutcome } = actions();
    const apply = vi.fn(async () => queue({ state: 'failed', kind: 'workspace.failed', error: 'the runner holding this copy went away' }) as ApplyState);
    const r = await render(<ApplyPanel preview={preview} apply={apply} readOutcome={readOutcome} />);
    await click(button(r.container, 'Apply'));
    await flush();
    expect(r.container.querySelector('.ap-failed')!.textContent).toBe('The apply did not run: the runner holding this copy went away.');
    expect(button(r.container, 'Apply')!.disabled).toBe(false);
    r.unmount();
  });

  it('a failed discard is said in plain words, and marks no turn', async () => {
    const { queue, readOutcome } = actions();
    const discard = vi.fn(async (): Promise<DiscardState> => queue({ state: 'failed', error: 'the copy could not be reset' }));
    const onDiscarded = vi.fn();
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} discard={discard} readOutcome={readOutcome} onDiscarded={onDiscarded} />);
    await click(button(r.container, 'Discard'));
    await click(button(r.container.querySelector('.ap-confirm')!, 'Discard'));
    await flush();
    expect(r.container.textContent).toContain('The discard did not run: the copy could not be reset.');
    expect(onDiscarded).not.toHaveBeenCalled();
    r.unmount();
  });

  it('an update waiting behind a turn says so from its outcome, then "Updated" from the outcome too', async () => {
    let ended = false;
    const update = vi.fn(async (): Promise<UpdateState> => ({ state: 'queued', event: 'ev_u' }));
    const readOutcome = vi.fn(async (_e: string): Promise<WorkspaceOutcome> => (ended ? { state: 'updated', kind: 'workspace.updated' } : { state: 'queued' }));
    const conflicted: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }] };
    const onRefresh = vi.fn();
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={onRefresh} pollMs={5} />);
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    expect(r.container.textContent).toContain(UPDATE_WAITING);
    expect(onRefresh).not.toHaveBeenCalled();
    ended = true;
    for (let i = 0; i < 50 && !r.container.textContent!.includes('Updated from your folder'); i++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(r.container.textContent).toContain('Updated from your folder');
    expect(r.container.textContent).not.toContain(UPDATE_WAITING);
    expect(readOutcome.mock.calls.every((c) => c[0] === 'ev_u')).toBe(true);
    expect(onRefresh).toHaveBeenCalled();
    r.unmount();
  });

  it('an action whose outcome never comes is said, not waited on for ever', async () => {
    const { followOutcome } = await import('../data/outcome');
    const o = await followOutcome({ state: 'queued', event: 'ev_x' }, async () => ({ state: 'queued' }), { pollMs: 1, giveUpMs: 20 });
    expect(o).toEqual({ state: 'stalled', event: 'ev_x' });
  });

  it('reads the outcome whether the route names its result at the top or under the event', async () => {
    const { readOutcome } = await import('../data/outcome');
    expect(readOutcome({ kind: 'workspace.applied', applied: { files: ['a.txt'], count: 1 } })).toMatchObject({ state: 'applied', files: ['a.txt'], count: 1 });
    expect(readOutcome({ state: 'refused', conflicts: [{ path: 'a.txt', why: 'x' }] })).toMatchObject({ state: 'refused', conflicts: [{ path: 'a.txt', why: 'x' }] });
    expect(readOutcome({ kind: 'workspace.failed', failed: { error: 'gone' } })).toMatchObject({ state: 'failed', error: 'gone' });
    expect(readOutcome({ state: 'running' }).state).toBe('running');
  });
});

describe('Discard', () => {
  it('a sandbox session shows Discard beside Apply; it asks once in place, then drops the changes', async () => {
    const { queue, readOutcome } = actions();
    const discard = vi.fn(async (): Promise<DiscardState> => queue({ state: 'discarded', dropped_turns: ['T1'] }));
    const onDiscarded = vi.fn();
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} discard={discard} readOutcome={readOutcome} onDiscarded={onDiscarded} />);
    // Both actions on the right; the question is not shown yet.
    expect(button(r.container, 'Discard')).not.toBeUndefined();
    expect(button(r.container, 'Apply')).not.toBeUndefined();
    expect(r.container.querySelector('.ap-confirm')).toBeNull();
    // Discard asks in place: "Discard 2 files?", no pop-up window.
    await click(button(r.container, 'Discard'));
    const confirm = r.container.querySelector('.ap-confirm')!;
    expect(confirm.querySelector('.ap-confirm-q')!.textContent).toBe('Discard 2 files?');
    expect(r.container.querySelector('[role="dialog"]')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    // Confirming drops the changes and reports the dropped turns, read from
    // the outcome of this discard's event (the 202 carries none).
    await click(button(confirm, 'Discard'));
    await flush();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledWith(['T1']);
  });

  it('Cancel leaves the changes and asks nothing of the source', async () => {
    const discard = vi.fn(async (): Promise<DiscardState> => ({}));
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} discard={discard} onDiscarded={vi.fn()} />);
    await click(button(r.container, 'Discard'));
    expect(r.container.querySelector('.ap-confirm')).not.toBeNull();
    await click(button(r.container, 'Cancel'));
    expect(r.container.querySelector('.ap-confirm')).toBeNull();
    expect(button(r.container, 'Apply')).not.toBeUndefined();
    expect(discard).not.toHaveBeenCalled();
    r.unmount();
  });

  it('no Discard for a session the panel was given no discard for (a direct session)', async () => {
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} />);
    expect(button(r.container, 'Discard')).toBeUndefined();
    r.unmount();
  });

  it('a refused discard shows the API words and keeps the changes', async () => {
    const discard = vi.fn(async (): Promise<DiscardState> => {
      throw new Error('a turn is still running; wait for it to end before discarding');
    });
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} discard={discard} onDiscarded={vi.fn()} />);
    await click(button(r.container, 'Discard'));
    await click(button(r.container.querySelector('.ap-confirm')!, 'Discard'));
    await flush();
    expect(r.container.textContent).toContain('a turn is still running');
    r.unmount();
  });

  it('the live source posts to the workspace discard route (202) and reads its outcome by event', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/outcome')) {
        return new Response(JSON.stringify({ state: 'discarded', kind: 'workspace.discarded', discarded: { dropped_turns: ['T1', 'T2'] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ state: 'queued', event: 'ev_d' }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
      expect(await src.discardWorkspace('ws_1')).toEqual({ state: 'queued', event: 'ev_d' });
      expect((await src.getWorkspaceOutcome('ws_1', 'ev_d')).dropped_turns).toEqual(['T1', 'T2']);
      expect(calls).toEqual([
        'POST http://cockpit.test/api/v0/workspaces/ws_1/discard',
        'GET http://cockpit.test/api/v0/workspaces/ws_1/outcome?event=ev_d',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Update from my folder', () => {
  const conflicted: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }] };

  it('offers Update when the folder changed, merges it, and refreshes the preview', async () => {
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (): Promise<UpdateState> => queue({ state: 'updated', updated: true }));
    const onRefresh = vi.fn();
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={onRefresh} />);
    const btn = button(r.container, 'Update from my folder')!;
    expect(btn).not.toBeUndefined();
    expect(btn.disabled).toBe(false);
    await click(btn);
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalled();
    expect(r.container.textContent).toContain('Updated from your folder');
    r.unmount();
  });

  it('a conflicting update turns Review into Merge, hides Update, and says so at the top', async () => {
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (): Promise<UpdateState> => queue({ state: 'conflict', conflicts: ['a.txt', 'b.txt'] }));
    const onRefresh = vi.fn();
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const two: ApplyPreview = {
      ...preview,
      conflicts: [
        { path: 'a.txt', why: 'changed in your folder since the checkpoint' },
        { path: 'b.txt', why: 'changed in your folder since the checkpoint' },
      ],
    };
    const r = await render(<ApplyPanel preview={two} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={onRefresh} review={review} />);
    expect(button(r.container, 'Review')).not.toBeUndefined();
    expect(button(r.container, 'Merge')).toBeUndefined();
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(button(r.container, 'Update from my folder')).toBeUndefined();
    expect(button(r.container, 'Review')).toBeUndefined();
    expect(button(r.container, 'Merge')).not.toBeUndefined();
    const top = r.container.querySelector('.ap-conflicts')!;
    expect(top.textContent).toContain('2 files changed on both sides. Merge asks Codex to combine them, then Apply.');
    expect(r.container.textContent).not.toContain('still conflict');
    expect(r.container.querySelector('p.nd-note[role="status"]')).toBeNull();
    r.unmount();
  });

  it('Merge fills the message at once, then asks AgentBus to merge; the next preview decides what shows', async () => {
    const order: string[] = [];
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (mode?: 'merge'): Promise<UpdateState> => {
      order.push(`update:${mode ?? ''}`);
      return queue(mode === 'merge' ? { state: 'merged', updated: true, unresolved: ['a.txt'] } : { state: 'conflict', conflicts: ['a.txt'] });
    });
    const onRefresh = vi.fn();
    const onMerge = vi.fn(() => {
      order.push('fill');
    });
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge };
    const markers: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'still holds conflict markers', markers: true }] };
    const panel = (p: ApplyPreview) => <ApplyPanel preview={p} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={onRefresh} review={review} />;
    const r = await render(panel(conflicted));
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    await click(button(r.container, 'Merge')!);
    await flush();
    // Filled before the merge call, so a draft typed while it runs is kept.
    expect(order).toEqual(['update:', 'fill', 'update:merge']);
    expect(onMerge).toHaveBeenCalledWith('ag1', ['a.txt']);
    expect(onRefresh).toHaveBeenCalled();
    // The new preview: a.txt still holds markers. Merge only fills again.
    await act(async () => r.root.render(panel(markers)));
    expect(button(r.container, 'Update from my folder')).toBeUndefined();
    await click(button(r.container, 'Merge')!);
    expect(update).toHaveBeenCalledTimes(2);
    expect(onMerge).toHaveBeenCalledTimes(2);
    // The turn combined it: Review is back.
    await act(async () => r.root.render(panel(preview)));
    expect(button(r.container, 'Merge')).toBeUndefined();
    expect(button(r.container, 'Review')).not.toBeUndefined();
    // A later conflict in another file starts over from Update, never from the
    // earlier merge's files (review findings, 2026-11-24).
    const later: ApplyPreview = { ...preview, conflicts: [{ path: 'b.txt', why: 'changed in your folder since the checkpoint' }] };
    await act(async () => r.root.render(panel(later)));
    expect(button(r.container, 'Update from my folder')).not.toBeUndefined();
    expect(button(r.container, 'Merge')).toBeUndefined();
    r.unmount();
  });

  it('Merge goes when a new preview has no conflict left, even before it was clicked', async () => {
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (): Promise<UpdateState> => queue({ state: 'conflict', conflicts: ['a.txt'] }));
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} />);
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    expect(button(r.container, 'Merge')).not.toBeUndefined();
    // The person resolved it in their folder; the next preview has no conflict.
    await act(async () => r.root.render(<ApplyPanel preview={{ ...preview }} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} />));
    expect(button(r.container, 'Merge')).toBeUndefined();
    expect(button(r.container, 'Review')).not.toBeUndefined();
    r.unmount();
  });

  it('a Merge still waiting its turn says so, from its outcome, and is not asked for twice', async () => {
    const { queue, readOutcome, results } = actions();
    const update = vi.fn(async (mode?: 'merge'): Promise<UpdateState> =>
      queue(mode === 'merge' ? { state: 'queued' } : { state: 'conflict', conflicts: ['a.txt'] })
    );
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const panel = (p: ApplyPreview) => <ApplyPanel preview={p} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} pollMs={5} />;
    const r = await render(panel(conflicted));
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    await click(button(r.container, 'Merge')!);
    await flush();
    // The outcome of the merge's event says it waits: said, and held.
    expect(r.container.textContent).toContain('Merging… it is waiting its turn.');
    expect(button(r.container, 'Merging…')!.disabled).toBe(true);
    expect(button(r.container, 'Update from my folder')).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    // It ends: the outcome says merged and the preview is read again; the
    // files now hold the markers, so Merge only fills.
    results.set('ev_2', { state: 'merged', unresolved: ['a.txt'] });
    const markers: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'still holds conflict markers', markers: true }] };
    await act(async () => r.root.render(panel(markers)));
    for (let i = 0; i < 50 && !button(r.container, 'Merge'); i++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(button(r.container, 'Merge')!.disabled).toBe(false);
    expect(r.container.textContent).not.toContain('Merging… it is waiting its turn.');
    r.unmount();
  });

  it('a late Merge reply clears only its own result, never a newer conflict', async () => {
    let finish: ((s: UpdateState) => void) | null = null;
    const { queue, readOutcome } = actions();
    const update = vi.fn((mode?: 'merge'): Promise<UpdateState> =>
      mode === 'merge'
        ? new Promise<UpdateState>((done) => {
            finish = done;
          })
        : Promise.resolve(queue({ state: 'conflict', conflicts: ['a.txt'] }))
    );
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const panel = (u?: { result?: string; conflicts?: string[] }) => (
      <ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} lastUpdate={u ?? null} />
    );
    const r = await render(panel());
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    await click(button(r.container, 'Merge')!); // waits
    // Meanwhile the record streams a newer update result: a conflict again.
    await act(async () => r.root.render(panel({ result: 'conflict', conflicts: ['a.txt'] })));
    await act(async () => finish!(queue({ state: 'merged', updated: true, unresolved: ['a.txt'] })));
    await flush();
    // The newer conflict still offers Merge, and Merge still asks AgentBus.
    await click(button(r.container, 'Merge')!);
    await flush();
    expect(update.mock.calls.filter((c) => c[0] === 'merge').length).toBe(2);
    r.unmount();
  });

  it('a conflict result survives the preview read again after it, and a streamed one offers Merge', async () => {
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (): Promise<UpdateState> => queue({ state: 'conflict', conflicts: ['a.txt'] }));
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} />);
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    // The update's own workspace.updated reads the preview again: a new
    // preview, still refusing a.txt. Merge stays (review finding, 2026-11-24).
    const again: ApplyPreview = { ...conflicted, previewed_at: '2026-11-24T11:00:00Z' };
    await act(async () => r.root.render(<ApplyPanel preview={again} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} />));
    expect(button(r.container, 'Merge')).not.toBeUndefined();
    expect(button(r.container, 'Update from my folder')).toBeUndefined();
    r.unmount();
    // An update that ended after nobody waited for it, as the record streams it.
    const r2 = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} review={review} lastUpdate={{ result: 'conflict', conflicts: ['a.txt'] }} />);
    expect(button(r2.container, 'Merge')).not.toBeUndefined();
    r2.unmount();
  });

  it('a Merge that finds nothing left to combine reads as a plain update', async () => {
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (mode?: 'merge'): Promise<UpdateState> =>
      queue(mode === 'merge' ? { state: 'updated', updated: true } : { state: 'conflict', conflicts: ['a.txt'] })
    );
    const onRefresh = vi.fn();
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={onRefresh} review={review} />);
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    await click(button(r.container, 'Merge')!);
    await flush();
    expect(onRefresh).toHaveBeenCalled();
    expect(r.container.textContent).toContain('Updated from your folder');
    r.unmount();
  });

  it('a merge that changed nothing (files that cannot hold markers) says why', async () => {
    const why = 'some files cannot be merged with conflict markers (not text, a link, or removed on one side): a.bin; nothing changed';
    const { queue, readOutcome } = actions();
    const update = vi.fn(async (mode?: 'merge'): Promise<UpdateState> =>
      queue(mode === 'merge' ? { state: 'conflict', conflicts: ['a.bin'], unmergeable: ['a.bin'], error: why } : { state: 'conflict', conflicts: ['a.bin'] })
    );
    const review = { options: [{ id: 'ag1', name: 'Codex' }], defaultAgent: 'ag1', onReview: vi.fn(), onMerge: vi.fn() };
    const bin: ApplyPreview = { ...preview, conflicts: [{ path: 'a.bin', why: 'changed in your folder since the checkpoint' }] };
    const r = await render(<ApplyPanel preview={bin} apply={vi.fn()} update={update} readOutcome={readOutcome} onRefresh={vi.fn()} review={review} />);
    await click(button(r.container, 'Update from my folder')!);
    await flush();
    await click(button(r.container, 'Merge')!);
    await flush();
    expect(r.container.textContent).toContain(why);
    r.unmount();
  });

  it('the merge request is the goal only: no file list, no steps', () => {
    expect(MERGE_REQUEST).toBe("My folder changed while you worked. Bring it into your work and tell me when it's ready to apply.");
    expect(MERGE_REQUEST).not.toMatch(/\.txt|\.go|files:/);
  });

  it('no conflicts: the Update button is disabled', async () => {
    const r = await render(<ApplyPanel preview={preview} apply={vi.fn()} update={vi.fn()} />);
    expect(button(r.container, 'Update from my folder')!.disabled).toBe(true);
    r.unmount();
  });

  it('no Update for a session the panel was given no update for (a direct session)', async () => {
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} />);
    expect(button(r.container, 'Update from my folder')).toBeUndefined();
    r.unmount();
  });

  it('the live source posts to the workspace update route', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/outcome')) return new Response(JSON.stringify({ kind: 'workspace.updated', updated: { result: 'conflict', conflicts: ['a.txt'] } }), { status: 200 });
      return new Response(JSON.stringify({ state: 'queued', event: 'ev_u' }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
      expect(await src.updateWorkspace('ws_1')).toEqual({ state: 'queued', event: 'ev_u' });
      // The result is on the outcome: its state named from the event's own result.
      expect(await src.getWorkspaceOutcome('ws_1', 'ev_u')).toMatchObject({ state: 'conflict', conflicts: ['a.txt'] });
      calls.length = 0;
      await src.updateWorkspace('ws_1', 'merge');
      expect(calls).toEqual(['POST http://cockpit.test/api/v0/workspaces/ws_1/update']);
      expect(fetchMock.mock.calls[2][1]?.body).toBe('{"mode":"merge"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('The live source', () => {
  it('reads the diff and GET /workspaces/<id>/changes, says a machine offline plainly; an apply is a 202 refused on its outcome', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/workspaces/c1/apply')) return new Response(JSON.stringify({ state: 'queued', event: 'ev_a' }), { status: 202 });
      if (url.endsWith('/workspaces/busy/apply')) return new Response('{"error":"an apply is running"}', { status: 409 });
      if (url.includes('/workspaces/c1/outcome')) {
        return new Response(JSON.stringify({ state: 'refused', conflicts: [{ path: 'a.txt', why: 'x' }] }), { status: 200 });
      }
      if (url.includes('/diff')) return new Response(JSON.stringify(diff), { status: 200 });
      if (url.includes('/workspaces/c1/changes')) return new Response(JSON.stringify(preview), { status: 200 });
      if (url.includes('/workspaces/off/changes')) return new Response('{"error":"offline"}', { status: 503 });
      if (url.includes('/workspaces/slow/changes')) return new Response('{"error":"timeout"}', { status: 504 });
      if (url.includes('/workspaces/busy/changes')) return new Response('{"error":"an apply is running"}', { status: 409 });
      return new Response(JSON.stringify({ error: 'no' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
      expect((await src.getTurnDiff('c1', 'T1')).files!.count).toBe(1);
      expect((await src.getWorkspaceChanges('c1')).count).toBe(2);
      expect(await src.applyWorkspace('c1', 'T1')).toEqual({ state: 'queued', event: 'ev_a' });
      const out = await src.getWorkspaceOutcome('c1', 'ev_a');
      expect(out.state).toBe('refused');
      expect(out.conflicts).toEqual([{ path: 'a.txt', why: 'x' }]);
      expect(calls).toEqual([
        'GET http://cockpit.test/api/v0/turns/T1/diff?session=c1',
        'GET http://cockpit.test/api/v0/workspaces/c1/changes?limit=1000',
        'POST http://cockpit.test/api/v0/workspaces/c1/apply',
        'GET http://cockpit.test/api/v0/workspaces/c1/outcome?event=ev_a',
      ]);
      // A 409 is no longer an answer: it is the API's words.
      await expect(src.applyWorkspace('busy')).rejects.toThrow('an apply is running');
      await expect(src.getWorkspaceChanges('off')).rejects.toThrow('The machine with this folder is offline.');
      await expect(src.getWorkspaceChanges('slow')).rejects.toThrow('The machine with this folder did not answer in 30 seconds.');
      await expect(src.getWorkspaceChanges('busy')).rejects.toThrow('an apply is running');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const TRUNCATED_ERR = 'the copy had more files than a checkpoint holds, so its changes cannot be applied; nothing was written';

describe('A folder too big to track (over 200,000 files)', () => {
  it('the bar says so in place of a count, with no Review', async () => {
    const { r } = await open({ getWorkspaceChanges: vi.fn(async () => Promise.reject(new Error(TRUNCATED_ERR))), applyWorkspace: vi.fn() });
    const b = bar(r.container)!;
    expect(b.className).toContain('too-big');
    expect(b.querySelector('.ab-text')!.textContent).toBe(TOO_BIG);
    expect(TOO_BIG).toBe('This folder is too big to track changes (over 200,000 files)');
    expect(b.querySelector('.ab-review')).toBeNull();
    r.unmount();
  });

  it('the preview panel says so, with no count and no Apply, also when an apply is refused for it', async () => {
    const a = await render(<ApplyPanel preview={preview} error={TRUNCATED_ERR} apply={vi.fn()} />);
    expect(a.container.querySelector('#d-body')!.textContent).toBe(TOO_BIG);
    expect(button(a.container, 'Apply')).toBeUndefined();
    a.unmount();
    const { queue, readOutcome } = actions();
    const apply = vi.fn(async (): Promise<ApplyState> => queue({ state: 'refused', error: TRUNCATED_ERR }) as ApplyState);
    const b = await render(<ApplyPanel preview={preview} apply={apply} readOutcome={readOutcome} />);
    await click(button(b.container, 'Apply'));
    await flush();
    expect(b.container.querySelector('#d-body')!.textContent).toBe(TOO_BIG);
    expect(button(b.container, 'Apply')).toBeUndefined();
    b.unmount();
  });

  it("a turn's Changes tab says so in place of its count when the cut is the copy's", async () => {
    const page: TurnChangesPage = { count: 1, truncated: true, changes: changesPage.changes, next_before: null };
    const r = await render(<TurnChangesTab turnId="T1" loadDiff={async () => diff} loadChanges={async () => page} tooBig />);
    await flush();
    expect(r.container.textContent).toBe(TOO_BIG);
    expect(r.container.querySelector('.tab-sum')).toBeNull();
    r.unmount();
  });

  it('a cut list still counts, unless the preview said the copy is too big', async () => {
    expect(turnTooBig(true)).toBe(false);
    expect(turnTooBig(true, true)).toBe(true);
    expect(turnTooBig(false, true)).toBe(false);
    const big: TurnDiff = { ...diff, files: { isolated: true, count: 32692 } };
    const page: TurnChangesPage = { count: 32692, truncated: true, changes: changesPage.changes, next_before: null };
    const a = await render(<TurnChangesTab turnId="T1" loadDiff={async () => big} loadChanges={async () => page} />);
    await flush();
    expect(a.container.querySelector('.tab-sum')!.textContent).toContain('32692 files');
    a.unmount();
    const b = await render(<TurnChangesTab turnId="T1" loadDiff={async () => big} loadChanges={async () => page} tooBig />);
    await flush();
    expect(b.container.textContent).toBe(TOO_BIG);
    b.unmount();
  });
});

describe('The turn panel after the preview', () => {
  it('keeps the chosen tab when the preview was open in its place', async () => {
    const { r } = await open({ getWorkspaceChanges: vi.fn(async () => preview), getTurnDiff: vi.fn(async () => diff), applyWorkspace: vi.fn() });
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    const tab = (t: string) => Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((x) => x.textContent === t);
    await click(tab('Events'));
    expect(tab('Events')!.className).toContain('on');
    await click(bar(r.container)!.querySelector('.ab-review'));
    await flush();
    expect(r.container.querySelector('#right.apply-panel')).not.toBeNull();
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    expect(r.container.querySelector('#right.apply-panel')).toBeNull();
    expect(tab('Events')!.className).toContain('on');
    expect(tab('Result')!.className).not.toContain('on');
    r.unmount();
  });
});

describe('Review of several folders', () => {
  it('groups files by the folder each path starts with; one folder is one group', () => {
    const files = [{ path: 'cockpit/a.tsx' }, { path: 'framework/b.go' }, { path: 'framework/x/c.go' }];
    expect(groupByFolder(files, ['framework', 'cockpit']).map((g) => [g.name, g.files.map((f) => f.path)])).toEqual([
      ['framework', ['framework/b.go', 'framework/x/c.go']],
      ['cockpit', ['cockpit/a.tsx']],
    ]);
    expect(groupByFolder(files, ['framework'])).toEqual([{ name: '', files }]);
    expect(groupByFolder(files)).toEqual([{ name: '', files }]);
  });

  it('the apply panel lists each folder under its name', async () => {
    const two: ApplyPreview = {
      ...preview,
      files: [
        { path: 'cockpit/a.tsx', change: 'modified', added: 1, removed: 1 },
        { path: 'framework/b.go', change: 'added', added: 1, removed: 0 },
      ],
    };
    const r = await render(<ApplyPanel preview={two} apply={vi.fn()} folders={['framework', 'cockpit']} />);
    expect(Array.from(r.container.querySelectorAll('.ch-folder')).map((e) => e.textContent)).toEqual(['framework', 'cockpit']);
    r.unmount();
    const one = await render(<ApplyPanel preview={two} apply={vi.fn()} />);
    expect(one.container.querySelector('.ch-folder')).toBeNull();
    one.unmount();
  });
});
