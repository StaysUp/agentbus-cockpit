// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { buildAgents } from '../data/turns';
import { CockpitEvent, DataSource, SessionSummary } from '../types';
import { click, ev, flush, jsonl, liveReplay, render, rowSession, showDetails, shownSession } from './helpers';

describe('App', () => {
  it('#9 subscribes, applies new events to the shown session, and unsubscribes on unmount', async () => {
    const base = [
      ev({ seq: 1, session: 'live1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'live1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'first prompt' }),
      ev({ seq: 3, session: 'live1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
      ev({ seq: 4, session: 'live1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'reply' }),
      ev({ seq: 5, session: 'live1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
    ];
    const { source, push, unsubscribed } = liveReplay(base);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    expect(r.container.querySelectorAll('.tb')).toHaveLength(1);

    // A new turn on the stream reads the turn list again; it shows without a reload.
    await act(async () => {
      push(ev({ seq: 6, session: 'live1', kind: 'turn.started', turn: 'T2', exchange: 'x2', text: 'second prompt' }));
      push(ev({ seq: 7, session: 'live1', kind: 'model.requested', turn: 'T2', exchange: 'x2' }));
    });
    await flush();
    const bubbles = Array.from(r.container.querySelectorAll('.tb .bubble')).map((b) => b.textContent);
    expect(bubbles).toEqual(['first prompt', 'second prompt']);

    // An event of the open turn joins its events: its answer shows.
    await act(async () => {
      push(ev({ seq: 8, session: 'live1', kind: 'tool.requested', turn: 'T1', exchange: 'x1', tool_id: 'late', tool_name: 'Late' }));
    });
    await flush();
    await showDetails(r.container);
    expect(Array.from(r.container.querySelectorAll('#convo .wl.tool .wk')).map((w) => w.textContent)).toEqual(['Late']);

    r.unmount();
    expect(unsubscribed()).toBe(1);
  });

  it('a streamed model.requested reads the turn list again: an unopened turn\'s call count and model follow', async () => {
    const base = [
      ev({ seq: 1, session: 'mc', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'mc', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'first' }),
      ev({ seq: 3, session: 'mc', kind: 'model.requested', turn: 'T1', exchange: 'x1', model: 'm1' }),
      ev({ seq: 4, session: 'mc', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'one' }),
      ev({ seq: 5, session: 'mc', kind: 'turn.started', turn: 'T2', exchange: 'y1', text: 'second' }),
      ev({ seq: 6, session: 'mc', kind: 'model.requested', turn: 'T2', exchange: 'y1', model: 'm1' }),
      ev({ seq: 7, session: 'mc', kind: 'model.responded', turn: 'T2', exchange: 'y1', status: 200, text: 'two' }),
    ];
    const { source, push } = liveReplay(base);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const head = (i: number) => r.container.querySelectorAll('#convo .tb-h')[i].textContent;
    const answer = (i: number) => r.container.querySelectorAll('#convo .tb')[i].querySelector('.m-agent');
    // The first load opens turn 1; turn 2 is read from the list.
    expect(head(1)).toBe('Turn 2 m1 · 1 model call');
    expect(answer(1)!.className).toContain('preview');
    expect(answer(1)!.textContent).toBe('two');
    await act(async () => {
      push(ev({ seq: 8, session: 'mc', kind: 'model.requested', turn: 'T2', exchange: 'y2', model: 'm2' }));
    });
    await flush();
    expect(head(1)).toBe('Turn 2 m2 · 2 model calls');
    // Its last call has no reply yet, so the earlier reply is not shown as the answer.
    expect(answer(1)).toBeNull();
    r.unmount();
  });

  it('renders the recorded test data with no console errors', async () => {
    const errors = vi.spyOn(console, 'error');
    const r = await render(<App />);
    await flush();
    await flush();
    expect(r.container.querySelectorAll('.tb').length).toBeGreaterThan(0);
    expect(errors).not.toHaveBeenCalled();
    r.unmount();
    errors.mockRestore();
  });

  it('R2#3 live events refresh the tokens of the shown session and its turns', async () => {
    const base = [
      ev({ seq: 1, session: 'up', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'up', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'first prompt' }),
      ev({ seq: 3, session: 'up', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
      ev({ seq: 4, session: 'up', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'r',
        usage: { input_tokens: 100, output_tokens: 0 } }),
      ev({ seq: 5, session: 'up', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
    ];
    const { source, push } = liveReplay(base);
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const row = () => r.container.querySelector('#sessions .sess .s-m')!.textContent;
    expect(row()).toContain('100 tokens');
    expect(r.container.querySelectorAll('#convo .tb')).toHaveLength(1);

    await act(async () => {
      push(ev({ seq: 6, session: 'up', kind: 'turn.started', turn: 'T2', exchange: 'x2', text: 'second' }));
      push(ev({ seq: 7, session: 'up', kind: 'model.requested', turn: 'T2', exchange: 'x2' }));
      push(ev({ seq: 8, session: 'up', kind: 'model.responded', turn: 'T2', exchange: 'x2', status: 200, text: 's',
        usage: { input_tokens: 2000, output_tokens: 0 } }));
    });
    // The shown session's row follows the session list, read again within 500 ms.
    await vi.waitFor(async () => {
      await flush();
      expect(row()).toContain('2.1k tokens');
    }, { timeout: 3000 });
    expect(r.container.querySelectorAll('#convo .tb')).toHaveLength(2);
    r.unmount();
  });

  it('R2#5 after a store reset, a selection that no longer exists moves to the first available', async () => {
    const before = new ReplayDataSource(jsonl([
      ev({ seq: 1, session: 'old', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'old', kind: 'turn.started', turn: 'A', exchange: 'x1', text: 'old prompt' }),
    ]));
    const after = new ReplayDataSource(jsonl([
      ev({ seq: 1, session: 'new', kind: 'session.registered', agent: 'codex', folder: '/w' }),
      ev({ seq: 2, session: 'new', kind: 'turn.started', turn: 'B', exchange: 'x1', text: 'new prompt' }),
    ]));
    let current = before;
    let reset: ((sessions: SessionSummary[]) => void) | undefined;
    const source: DataSource = {
      getAgents: () => current.getAgents(),
      getSessions: (a) => current.getSessions(a),
      getTurns: (id) => current.getTurns(id),
      getTurn: (s, t) => current.getTurn(s, t),
      subscribe: (_cb, onSnapshot) => {
        reset = onSnapshot;
        current.getSessions().then((list) => onSnapshot?.(list));
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    expect(r.container.querySelector('.tb .bubble')!.textContent).toBe('old prompt');

    current = after;
    await act(async () => reset!(await after.getSessions()));
    await flush();
    await flush();
    await flush();
    expect(r.container.querySelector('#sessions .sess code')?.textContent).toBe('new');
    expect(r.container.querySelector('.tb .bubble')?.textContent).toBe('new prompt');
    r.unmount();
  });

  it('R3#1 an unselected session that receives events gets fresh token counts and last active time', async () => {
    const row = (id: string, last: string, turns: number, tokens: number): SessionSummary => ({
      id, agent: 'claude', client: 'c', title: id, started: '2026-11-05T09:00:00Z', last, open: true, turns,
      usage: { input_tokens: tokens, output_tokens: 0 },
    });
    let rows = [row('sel', '2026-11-05T09:30:00Z', 1, 10), row('other', '2026-11-05T09:20:00Z', 1, 10)];
    let push: ((e: CockpitEvent) => void) | null = null;
    const source: DataSource = {
      getAgents: async () => buildAgents(rows),
      getSessions: async () => rows,
      getTurns: async () => ({ turns: [] }),
      getTurn: async () => null,
      subscribe: (cb, onSnapshot) => {
        push = cb;
        setTimeout(() => onSnapshot?.(rows), 0);
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const meta = (id: string) =>
      Array.from(r.container.querySelectorAll('#sessions .sess'))
        .find((b) => rowSession(b) === id)!
        .querySelector('.s-m')!.textContent;
    expect(meta('other')).toContain('10 tokens');

    // The service stored a new turn for "other"; its snapshot row now says so.
    rows = [rows[0], row('other', '2026-11-05T09:21:00Z', 2, 5000)];
    await act(async () => {
      push!(ev({ seq: 50, session: 'other', kind: 'turn.started', turn: 'T2', text: 'more' }));
    });
    await vi.waitFor(async () => {
      await flush();
      expect(meta('other')).toContain('5.0k tokens');
    }, { timeout: 3000 });
    r.unmount();
  });

  it('R4#1 sessions with the empty agent "" get a visible agent row and show in Sessions', async () => {
    const rows: SessionSummary[] = [{
      id: 'plain', agent: '', client: 'claude-cli/2.1.318', title: 'plain', started: '2026-11-05T09:00:00Z',
      last: '2026-11-05T09:10:00Z', open: false, turns: 1, usage: { input_tokens: 1, output_tokens: 0 },
    }];
    const source: DataSource = {
      getAgents: async () => buildAgents(rows),
      getSessions: async (a) => (a === undefined ? rows : rows.filter((r) => r.agent === a)),
      getTurns: async () => ({ turns: [] }),
      getTurn: async () => null,
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const agent = r.container.querySelector('#agents .agent');
    expect(agent?.querySelector('b')?.textContent).toBe('claude-cli');
    expect(agent?.className).toContain('on');
    expect(r.container.querySelector('#sessions .sess code')?.textContent).toBe('plain');
    expect(shownSession(r.container)).toBe('plain');
    r.unmount();
  });

  it('R4#2 the list shown comes from the same snapshot the stream starts from', async () => {
    const row = (id: string, last: string, turns: number): SessionSummary => ({
      id, agent: 'claude', client: 'c', title: id, started: '2026-11-05T09:00:00Z',
      last, open: true, turns, usage: { input_tokens: turns * 1000, output_tokens: 0 },
    });
    // An older snapshot (seq 10): "other" has one turn.
    const older = [row('abc', '2026-11-05T09:30:00Z', 1), row('other', '2026-11-05T09:10:00Z', 1)];
    // The stream's snapshot (seq 20): "other" has three.
    const streamed = [row('abc', '2026-11-05T09:30:00Z', 1), row('other', '2026-11-05T09:10:00Z', 3)];
    const source: DataSource = {
      getAgents: async () => buildAgents(older),
      getSessions: async () => older,
      getTurns: async () => ({ turns: [] }),
      getTurn: async () => null,
      subscribe: (_cb, onSnapshot) => {
        setTimeout(() => onSnapshot?.(streamed), 0);
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await flush();
    const other = Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => rowSession(b) === 'other');
    expect(other?.querySelector('.s-m')?.textContent).toContain('3.0k tokens');
    r.unmount();
  });

  // A tool row opens in the turn's Events tab; a model call row selects the
  // call level instead (levels.test.tsx).
  it('R4#3 clicking the same conversation tool row again reopens it in Events', async () => {
    const r = await render(<App />);
    await flush();
    await flush();
    const tab = (label: string) =>
      Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((b) => b.textContent!.startsWith(label))!;
    await showDetails(r.container);
    const row = () => r.container.querySelector('#convo .wl.tool')!;
    await click(row());
    expect(tab('Events').className).toContain('on');
    await click(tab('Prompt'));
    expect(tab('Prompt').className).toContain('on');
    await click(row());
    expect(tab('Events').className).toContain('on');
    expect(r.container.querySelectorAll('#d-body tr.ev-open')).toHaveLength(1);
    r.unmount();
  });
});
