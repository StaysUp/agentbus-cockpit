// @vitest-environment jsdom
// Applying a conversation: the bar above the message box while it has work
// not yet in the person's folder, the preview in the right panel with one
// "Apply to my folder", and each turn's own read-only Changes tab.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ApplyPanel, TOO_BIG, TurnChangesTab, turnTooBig } from '../components/Changes';
import { LiveDataSource } from '../data/LiveDataSource';
import { ApplyPreview, ApplyState, TurnDiff } from '../types';
import { click, ev, flush, liveReplay, panelOpen, render } from './helpers';

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
  files: { isolated: true, count: 1, changes: [{ path: 'a.txt', change: 'modified', size: 4, diff: A_DIFF }] },
  model_calls: { count: 1 },
  tools: { count: 1 },
  commands: ['go test ./...'],
  apply: { state: 'none' },
};

const bar = (c: HTMLElement) => c.querySelector('#c-reply .apply-bar') as HTMLElement | null;
const button = (c: ParentNode, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;

async function open(extra: Parameters<typeof liveReplay>[1]) {
  const lr = liveReplay(finished, extra);
  const r = await render(<App dataSource={lr.source} />);
  await flush();
  await flush();
  return { ...lr, r };
}

describe('The apply bar', () => {
  it('shows "● 2 files changed, not applied  Review ▸" above the message box while there is unapplied work', async () => {
    const getApplyPreview = vi.fn(async () => preview);
    const { r } = await open({ getApplyPreview, applyTurn: vi.fn() });
    expect(getApplyPreview).toHaveBeenCalledWith('c1');
    const b = bar(r.container)!;
    expect(b).not.toBeNull();
    expect(b.querySelector('.ab-dot')!.textContent).toBe('●');
    expect(b.querySelector('.ab-text')!.textContent).toBe('2 files changed, not applied');
    expect(b.querySelector('.ab-review')!.textContent).toBe('Review ▸');
    // Directly above the message box.
    expect(b.nextElementSibling!.tagName).toBe('FORM');
    r.unmount();
  });

  it('is not shown when nothing is unapplied, or when the source has no preview', async () => {
    const a = await open({ getApplyPreview: vi.fn(async () => nothing) });
    expect(bar(a.r.container)).toBeNull();
    a.r.unmount();
    const b = await open({});
    expect(bar(b.r.container)).toBeNull();
    b.r.unmount();
  });

  it('the old per-turn "N files changed · Review" header control is gone', async () => {
    const getTurnDiff = vi.fn(async () => diff);
    const { r } = await open({ getApplyPreview: vi.fn(async () => preview), getTurnDiff, applyTurn: vi.fn() });
    expect(r.container.querySelector('#convo .tb-changes')).toBeNull();
    expect(r.container.querySelector('#convo .tb-applied')).toBeNull();
    // No turn's diff is read for the chat itself.
    expect(getTurnDiff).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is read again when a turn ends, records its changes, or is applied', async () => {
    let p = nothing;
    const getApplyPreview = vi.fn(async () => p);
    const { r, push } = await open({ getApplyPreview });
    expect(bar(r.container)).toBeNull();
    const reads = getApplyPreview.mock.calls.length;
    p = preview;
    await act(async () => push(ev({ seq: 6, session: 'c1', kind: 'turn.changed', turn: 'T1' })));
    await flush();
    expect(getApplyPreview.mock.calls.length).toBe(reads + 1);
    expect(bar(r.container)).not.toBeNull();
    p = nothing;
    await act(async () => push(ev({ seq: 7, session: 'c1', kind: 'turn.applied', turn: 'T1' })));
    await flush();
    expect(bar(r.container)).toBeNull();
    // Another session's events do not read it.
    const before = getApplyPreview.mock.calls.length;
    await act(async () => push(ev({ seq: 8, session: 'c2', kind: 'turn.changed', turn: 'X' })));
    await flush();
    expect(getApplyPreview.mock.calls.length).toBe(before);
    r.unmount();
  });

  it('runs one read at a time: events during a read make one more read after it', async () => {
    let release: (() => void) | null = null;
    let reads = 0;
    const getApplyPreview = vi.fn(() => {
      reads++;
      if (reads === 1) return Promise.resolve(nothing);
      return new Promise<ApplyPreview>((done) => {
        release = () => done(preview);
      });
    });
    const { r, push } = await open({ getApplyPreview });
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
  it('Review ▸ opens it in the right panel: each file with counts and a coloured diff', async () => {
    const { r } = await open({ getApplyPreview: vi.fn(async () => preview), applyTurn: vi.fn() });
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
    const apply = button(panel, 'Apply to my folder')!;
    expect(apply.className).toContain('btn-primary');
    expect(apply.disabled).toBe(false);
    r.unmount();
  });

  it('Apply applies the turn the preview names; then "Applied. Your folder matches this conversation." and the bar goes', async () => {
    let p = preview;
    const getApplyPreview = vi.fn(async () => p);
    const applyTurn = vi.fn(async () => {
      p = nothing;
      return { state: 'applied', files: ['a.txt', 'logo.png'] } as ApplyState;
    });
    const { r } = await open({ getApplyPreview, applyTurn });
    await click(bar(r.container)!.querySelector('.ab-review'));
    await flush();
    await click(button(r.container.querySelector('#right')!, 'Apply to my folder'));
    await flush();
    expect(applyTurn).toHaveBeenCalledWith('T1');
    expect(r.container.querySelector('#right .nd-note.ok[role="status"]')!.textContent).toBe('Applied. Your folder matches this conversation.');
    expect(button(r.container.querySelector('#right')!, 'Apply to my folder')).toBeUndefined();
    expect(bar(r.container)).toBeNull();
    r.unmount();
  });

  it('a file changed in the folder since is marked plainly, and Apply is off', async () => {
    const conflicted: ApplyPreview = { ...preview, conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }] };
    const r = await render(<ApplyPanel preview={conflicted} apply={vi.fn()} />);
    expect(r.container.querySelector('.ch-file.conflict .ch-conflict')!.textContent).toBe(
      'you changed this file since; it would be refused'
    );
    const box = r.container.querySelector('.form-error.ap-conflicts')!;
    expect(box.textContent).toContain('1 file would be refused.');
    expect(box.querySelector('li')!.textContent).toBe('a.txt: changed in your folder since the checkpoint');
    expect(button(r.container, 'Apply to my folder')!.disabled).toBe(true);
    r.unmount();
  });

  it('a refused apply shows the API words and each conflict', async () => {
    const refused: ApplyState = {
      state: 'refused',
      error: 'apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt',
      conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }],
    };
    const apply = vi.fn(async () => refused);
    const onApplyEnded = vi.fn();
    const r = await render(<ApplyPanel preview={preview} apply={apply} onApplyEnded={onApplyEnded} />);
    await click(button(r.container, 'Apply to my folder'));
    await flush();
    expect(apply).toHaveBeenCalledWith('T1');
    expect(onApplyEnded).toHaveBeenCalled();
    const err = r.container.querySelector('.form-error')!;
    expect(err.textContent).toContain('apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt');
    expect(err.querySelector('li')!.textContent).toBe('a.txt: changed in your folder since the checkpoint');
    r.unmount();
  });

  it('an apply still queued is read again until it ends', async () => {
    let ended = false;
    const readApply = vi.fn(async () => (ended ? { state: 'applied' } : { state: 'queued' }) as ApplyState);
    const apply = vi.fn(async () => ({ state: 'queued' }) as ApplyState);
    const r = await render(<ApplyPanel preview={preview} apply={apply} readApply={readApply} pollMs={5} />);
    await click(button(r.container, 'Apply to my folder'));
    await flush();
    expect(r.container.textContent).toContain('Applying…');
    ended = true;
    for (let i = 0; i < 50 && !r.container.textContent!.includes('Applied.'); i++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(readApply).toHaveBeenCalledWith('T1');
    expect(r.container.textContent).toContain('Applied. Your folder matches this conversation.');
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
    expect(button(r.container, 'Apply to my folder')).toBeUndefined();
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
    const { r } = await open({ getApplyPreview: vi.fn(async () => preview), applyTurn: vi.fn() });
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

describe("A turn's Changes tab", () => {
  it('sits beside Result and shows the turn\'s own diff, read-only', async () => {
    const getTurnDiff = vi.fn(async () => diff);
    const { r } = await open({ getTurnDiff, applyTurn: vi.fn() });
    await click(r.container.querySelector('#convo .tb'));
    await flush();
    const tabs = Array.from(r.container.querySelectorAll('#d-tabs .tab')).map((t) => t.textContent);
    expect(tabs.slice(0, 2)).toEqual(['Result', 'Changes']);
    expect(getTurnDiff).not.toHaveBeenCalled();
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Changes'));
    await flush();
    expect(getTurnDiff).toHaveBeenCalledWith('c1', 'T1');
    const body = r.container.querySelector('#d-body')!;
    expect(body.querySelector('.tab-sum')!.textContent).toContain('1 file');
    expect(body.querySelector('.ch-diff .dl.add')!.textContent).toBe('+two');
    expect(body.textContent).toContain('Commands');
    expect(button(body, 'Apply to my folder')).toBeUndefined();
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

describe('The live source', () => {
  it('reads the diff and GET /sessions/<id>/changes, says a machine offline plainly, and takes a 409 apply as an answer', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/apply')) {
        return new Response(JSON.stringify({ state: 'refused', conflicts: [{ path: 'a.txt', why: 'x' }] }), { status: 409 });
      }
      if (url.includes('/diff')) return new Response(JSON.stringify(diff), { status: 200 });
      if (url.endsWith('/sessions/c1/changes')) return new Response(JSON.stringify(preview), { status: 200 });
      if (url.endsWith('/sessions/off/changes')) return new Response('{"error":"offline"}', { status: 503 });
      if (url.endsWith('/sessions/slow/changes')) return new Response('{"error":"timeout"}', { status: 504 });
      if (url.endsWith('/sessions/busy/changes')) return new Response('{"error":"an apply is running"}', { status: 409 });
      return new Response(JSON.stringify({ error: 'no' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
      expect((await src.getTurnDiff('c1', 'T1')).files!.count).toBe(1);
      expect((await src.getApplyPreview('c1')).count).toBe(2);
      expect((await src.applyTurn('T1')).state).toBe('refused');
      expect(calls).toEqual([
        'GET http://cockpit.test/api/v0/turns/T1/diff?session=c1',
        'GET http://cockpit.test/api/v0/sessions/c1/changes',
        'POST http://cockpit.test/api/v0/turns/T1/apply',
      ]);
      await expect(src.getApplyPreview('off')).rejects.toThrow('The machine with this folder is offline.');
      await expect(src.getApplyPreview('slow')).rejects.toThrow('The machine with this folder did not answer in 30 seconds.');
      await expect(src.getApplyPreview('busy')).rejects.toThrow('an apply is running');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const TRUNCATED_ERR = 'the copy had more files than a checkpoint holds, so its changes cannot be applied; nothing was written';

describe('A folder too big to track (over 200,000 files)', () => {
  it('the bar says so in place of a count, with no Review', async () => {
    const { r } = await open({ getApplyPreview: vi.fn(async () => Promise.reject(new Error(TRUNCATED_ERR))), applyTurn: vi.fn() });
    const b = bar(r.container)!;
    expect(b.className).toContain('too-big');
    expect(b.querySelector('.ab-text')!.textContent).toBe(TOO_BIG);
    expect(TOO_BIG).toBe('This folder is too big to track changes (over 200,000 files). Pick a smaller folder.');
    expect(b.querySelector('.ab-review')).toBeNull();
    r.unmount();
  });

  it('the preview panel says so, with no count and no Apply, also when an apply is refused for it', async () => {
    const a = await render(<ApplyPanel preview={preview} error={TRUNCATED_ERR} apply={vi.fn()} />);
    expect(a.container.querySelector('#d-body')!.textContent).toBe(TOO_BIG);
    expect(button(a.container, 'Apply to my folder')).toBeUndefined();
    a.unmount();
    const apply = vi.fn(async (): Promise<ApplyState> => ({ state: 'refused', error: TRUNCATED_ERR }));
    const b = await render(<ApplyPanel preview={preview} apply={apply} />);
    await click(button(b.container, 'Apply to my folder'));
    await flush();
    expect(b.container.querySelector('#d-body')!.textContent).toBe(TOO_BIG);
    expect(button(b.container, 'Apply to my folder')).toBeUndefined();
    b.unmount();
  });

  it("a turn's Changes tab says so in place of its count when the cut is the copy's", async () => {
    const cut: TurnDiff = { ...diff, files: { isolated: true, count: 1, truncated: true, changes: diff.files!.changes } };
    const r = await render(<TurnChangesTab turnId="T1" loadDiff={async () => cut} />);
    await flush();
    expect(r.container.textContent).toBe(TOO_BIG);
    expect(r.container.querySelector('.tab-sum')).toBeNull();
    r.unmount();
  });

  it('a list cut past 1,000 files is not the copy: it counts, unless the preview said the copy is too big', async () => {
    const many = { count: 32692, truncated: true, changes: new Array(1000).fill({}) };
    expect(turnTooBig(many)).toBe(false);
    expect(turnTooBig(many, true)).toBe(true);
    expect(turnTooBig({ ...many, truncated: false }, true)).toBe(false);
    expect(turnTooBig({ count: 3, truncated: true, changes: [{}, {}, {}] })).toBe(true);
    const cut: TurnDiff = { ...diff, files: { isolated: true, ...many, changes: diff.files!.changes } };
    const a = await render(<TurnChangesTab turnId="T1" loadDiff={async () => cut} />);
    await flush();
    expect(a.container.querySelector('.tab-sum')!.textContent).toContain('32692 files');
    a.unmount();
    const b = await render(<TurnChangesTab turnId="T1" loadDiff={async () => cut} tooBig />);
    await flush();
    expect(b.container.textContent).toBe(TOO_BIG);
    b.unmount();
  });
});

describe('The turn panel after the preview', () => {
  it('keeps the chosen tab when the preview was open in its place', async () => {
    const { r } = await open({ getApplyPreview: vi.fn(async () => preview), getTurnDiff: vi.fn(async () => diff), applyTurn: vi.fn() });
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
