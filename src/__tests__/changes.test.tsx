// @vitest-environment jsdom
// A turn's changes: GET /api/v0/turns/<id>/diff in a dialog, and "Apply to
// my folder" through POST /api/v0/turns/<id>/apply, with a refusal shown in
// the API's words.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ChangesDialog } from '../components/ChangesDialog';
import { LiveDataSource } from '../data/LiveDataSource';
import { ApplyState, TurnDiff } from '../types';
import { click, ev, flush, liveReplay, render } from './helpers';

const finished = [
  ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'edit a.txt' }),
  ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'done' }),
  ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

const diff: TurnDiff = {
  turn: 'T1',
  session: 'c1',
  state: 'finished',
  files: {
    isolated: true,
    count: 2,
    changes: [
      { path: 'a.txt', change: 'modified', size: 4, diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n' },
      { path: 'logo.png', change: 'added', size: 900, diff_left_out: true },
    ],
  },
  model_calls: { count: 1 },
  tools: { count: 1 },
  commands: ['go test ./...'],
  apply: { state: 'none' },
};

// The Changes button is off by default (src/features.ts); these tests turn
// it on, except the one that checks the default.
beforeEach(() => {
  vi.stubEnv('VITE_REVIEW_UI', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Changes by default', () => {
  it('is hidden: applies are asked for in the chat', async () => {
    vi.stubEnv('VITE_REVIEW_UI', '');
    const { source } = liveReplay(finished, { getTurnDiff: vi.fn(), applyTurn: vi.fn() });
    const r = await render(<App dataSource={source} />);
    await flush();
    expect(r.container.querySelector('#convo .tb')).not.toBeNull();
    expect(r.container.querySelector('.tb-changes')).toBeNull();
    r.unmount();
  });
});

describe('Changes', () => {
  it('shows a turn diff, and a refused apply names each file in the API words', async () => {
    const refused: ApplyState = {
      state: 'refused',
      error: 'apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt',
      conflicts: [{ path: 'a.txt', why: 'changed in your folder since the checkpoint' }],
    };
    const getTurnDiff = vi.fn(async () => diff);
    const applyTurn = vi.fn(async () => refused);
    const { source } = liveReplay(finished, { getTurnDiff, applyTurn });
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .tb-changes'));
    await flush();
    expect(getTurnDiff).toHaveBeenCalledWith('c1', 'T1');
    const dialog = r.container.querySelector('.changes-dialog')!;
    expect(dialog.querySelector('.ch-diff')!.textContent).toContain('+two');
    expect(dialog.textContent).toContain('No diff here');
    expect(dialog.textContent).toContain('1 command');
    const button = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Apply to my folder')!;
    await click(button);
    await flush();
    expect(applyTurn).toHaveBeenCalledWith('T1');
    const err = dialog.querySelector('.form-error')!;
    expect(err.textContent).toContain('apply refused: 1 file(s) in your folder changed since the checkpoint: a.txt');
    expect(err.querySelector('li')!.textContent).toBe('a.txt: changed in your folder since the checkpoint');
    r.unmount();
  });

  it('an applied turn says so, and the button is off', async () => {
    const getTurnDiff = vi.fn(async () => ({ ...diff, apply: { state: 'applied', files: ['a.txt', 'logo.png'] } }));
    const { source } = liveReplay(finished, { getTurnDiff, applyTurn: vi.fn() });
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .tb-changes'));
    await flush();
    const dialog = r.container.querySelector('.changes-dialog')!;
    expect(dialog.textContent).toContain('Applied to your folder. 2 files written.');
    const button = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Apply to my folder')!;
    expect((button as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('another turn\'s Changes starts empty: Apply never applies a turn whose diff is not shown', async () => {
    const two = [
      ...finished,
      ev({ seq: 6, session: 'c1', kind: 'turn.started', turn: 'T2', exchange: 'y1', text: 'edit b.txt' }),
      ev({ seq: 7, session: 'c1', kind: 'model.requested', turn: 'T2', exchange: 'y1' }),
      ev({ seq: 8, session: 'c1', kind: 'model.responded', turn: 'T2', exchange: 'y1', status: 200, text: 'done' }),
      ev({ seq: 9, session: 'c1', kind: 'turn.completed', turn: 'T2', exchange: 'y1', outcome: 'finished' }),
    ];
    const getTurnDiff = vi.fn((_s: string, turn: string) => (turn === 'T1' ? Promise.resolve(diff) : new Promise<TurnDiff>(() => {})));
    const applyTurn = vi.fn();
    const { source } = liveReplay(two, { getTurnDiff, applyTurn });
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const buttons = r.container.querySelectorAll('#convo .tb-changes');
    expect(buttons).toHaveLength(2);
    await click(buttons[0]);
    await flush();
    expect(r.container.querySelector('.changes-dialog .ch-diff')).not.toBeNull();
    await click(buttons[1]);
    await flush();
    const dialog = r.container.querySelector('.changes-dialog')!;
    expect(dialog.querySelector('.ch-diff')).toBeNull();
    expect(dialog.textContent).toContain('Reading');
    const apply = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Apply to my folder')!;
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('an apply still queued is read again until it ends', async () => {
    let calls = 0;
    const loadDiff = vi.fn(async () => {
      calls++;
      return calls < 3 ? diff : { ...diff, apply: { state: 'applied', files: ['a.txt'] } };
    });
    const apply = vi.fn(async () => ({ state: 'queued' }) as ApplyState);
    const r = await render(<ChangesDialog turnNumber={1} loadDiff={loadDiff} apply={apply} onClose={() => {}} pollMs={5} />);
    await flush();
    const button = Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent === 'Apply to my folder')!;
    await click(button);
    await flush();
    expect(r.container.textContent).toContain('Applying');
    for (let i = 0; i < 50 && !r.container.textContent!.includes('Applied to your folder'); i++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(r.container.textContent).toContain('Applied to your folder. 1 file written.');
    r.unmount();
  });

  it('a source with no diff shows no Changes button', async () => {
    const { source } = liveReplay(finished);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    expect(r.container.querySelector('#convo .tb')).not.toBeNull();
    expect(r.container.querySelector('#convo .tb-changes')).toBeNull();
    r.unmount();
  });

  it('the live source reads the diff and takes a 409 as an answer', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/apply')) {
        return new Response(JSON.stringify({ state: 'refused', conflicts: [{ path: 'a.txt', why: 'x' }] }), { status: 409 });
      }
      if (url.includes('/diff')) return new Response(JSON.stringify(diff), { status: 200 });
      return new Response(JSON.stringify({ error: 'no' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
      expect((await src.getTurnDiff('c1', 'T1')).files!.count).toBe(2);
      expect((await src.applyTurn('T1')).state).toBe('refused');
      expect(calls).toEqual(['GET http://cockpit.test/api/v0/turns/T1/diff?session=c1', 'POST http://cockpit.test/api/v0/turns/T1/apply']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
