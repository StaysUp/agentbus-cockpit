// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { SessionsColumn, sessionsTotal } from '../components/SessionsColumn';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { applyList, countedIn, isNewerList } from '../data/sessionList';
import { addStreamedCost, buildTurns, summarizeSession } from '../data/turns';
import { CockpitEvent, DataSource, SessionList, SessionSummary } from '../types';
import { COST_INCOMPLETE_TITLE, formatCost } from '../utils/format';
import { click, ev, flush, jsonl, render, openSession, shownSession } from './helpers';

function row(fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    agent: 'claude',
    client: 'claude-cli/2',
    title: 't',
    started: '2026-11-05T09:00:00Z',
    last: '2026-11-05T09:10:00Z',
    open: false,
    turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...fields,
  };
}

function oneTurn(replies: Partial<CockpitEvent>[]): CockpitEvent[] {
  const events: CockpitEvent[] = [ev({ kind: 'turn.started', turn: 'T1', text: 'go' })];
  replies.forEach((r, i) => {
    events.push(ev({ kind: 'model.requested', turn: 'T1', exchange: `x${i}` }));
    events.push(ev({ kind: 'model.responded', turn: 'T1', exchange: `x${i}`, status: 200, ...r }));
  });
  return events;
}

describe('formatCost', () => {
  it('shows small, normal and large amounts', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.31)).toBe('$0.31');
    expect(formatCost(123.4)).toBe('$123');
  });

  it('shows exactly zero as $0, not <$0.01', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0, false)).toBe('≥$0');
  });

  it('shows nothing when no cost is known, never $0.00', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(undefined)).toBe('');
  });

  it('shows an incomplete cost as a lower bound, rounded down', () => {
    expect(formatCost(0.316, false)).toBe('≥$0.31');
    expect(formatCost(123.4, false)).toBe('≥$123');
    expect(formatCost(0.004, false)).toBe('≥$0.00');
    expect(formatCost(1.15, false)).toBe('≥$1.15');
    expect(formatCost(0.29, false)).toBe('≥$0.29');
    expect(formatCost(null, false)).toBe('');
  });
});

describe('turn cost', () => {
  it('sums cost_usd over the turn and is complete when every call is', () => {
    const [t] = buildTurns('s1', oneTurn([
      { cost_usd: 0.1, cost_complete: true },
      { cost_usd: 0.25, cost_complete: true },
    ]));
    expect(t.costUsd).toBeCloseTo(0.35);
    expect(t.costComplete).toBe(true);
  });

  it('is incomplete when one call has cost_complete false', () => {
    const [t] = buildTurns('s1', oneTurn([
      { cost_usd: 0.1, cost_complete: true },
      { cost_usd: 0.2, cost_complete: false },
    ]));
    expect(t.costUsd).toBeCloseTo(0.3);
    expect(t.costComplete).toBe(false);
  });

  it('is incomplete when one call lacks cost_usd, and sums the rest', () => {
    const [t] = buildTurns('s1', oneTurn([{ cost_usd: 0.1, cost_complete: true }, {}]));
    expect(t.costUsd).toBeCloseTo(0.1);
    expect(t.costComplete).toBe(false);
  });

  it('is null when no call carries a cost (files recorded before cost)', () => {
    const [t] = buildTurns('s1', oneTurn([{}, {}]));
    expect(t.costUsd).toBeNull();
    expect(t.costComplete).toBe(false);
  });
});

describe('replay session cost', () => {
  it('sums the calls, and an events.dropped naming the session makes it incomplete', () => {
    const events = oneTurn([{ cost_usd: 0.2, cost_complete: true }, { cost_usd: 0.3, cost_complete: true }]);
    const s = summarizeSession('s1', events, buildTurns('s1', events));
    expect(s.cost_usd).toBeCloseTo(0.5);
    expect(s.cost_complete).toBe(true);

    const dropped = [...events, ev({ kind: 'events.dropped', sessions: ['s1'] })];
    const d = summarizeSession('s1', dropped, buildTurns('s1', dropped));
    expect(d.cost_usd).toBeCloseTo(0.5);
    expect(d.cost_complete).toBe(false);

    const all = [...events, ev({ kind: 'events.dropped', sessions: [], all_sessions: true })];
    expect(summarizeSession('s1', all, buildTurns('s1', all)).cost_complete).toBe(false);
  });
});

describe('replay drop reports filed under another session', () => {
  function file(drop: Partial<CockpitEvent>): string {
    return jsonl([
      ev({ seq: 1, session: 'a', kind: 'turn.started', turn: 'A1', exchange: 'x1', text: 'go' }),
      ev({ seq: 2, session: 'a', kind: 'model.requested', turn: 'A1', exchange: 'x1' }),
      ev({ seq: 3, session: 'a', kind: 'model.responded', turn: 'A1', exchange: 'x1', status: 200, cost_usd: 0.2, cost_complete: true }),
      ev({ seq: 4, session: 'b', kind: 'turn.started', turn: 'B1', exchange: 'y1', text: 'go' }),
      ev({ seq: 5, session: 'b', kind: 'model.requested', turn: 'B1', exchange: 'y1' }),
      ev({ seq: 6, session: 'b', kind: 'model.responded', turn: 'B1', exchange: 'y1', status: 200, cost_usd: 0.1, cost_complete: true }),
      ev({ seq: 7, session: 'default', kind: 'events.dropped', ...drop }),
    ]);
  }
  const costOf = async (src: ReplayDataSource, id: string) => (await src.getSessions()).find((s) => s.id === id)!;

  it('a report under default that names session a makes only a incomplete', async () => {
    const src = new ReplayDataSource(file({ sessions: ['a'] }));
    expect((await costOf(src, 'a')).cost_complete).toBe(false);
    expect((await costOf(src, 'a')).cost_usd).toBeCloseTo(0.2);
    expect((await costOf(src, 'b')).cost_complete).toBe(true);
    expect((await openSession(src, 'a'))!.cost_complete).toBe(false);
  });

  it('a report under default that says all_sessions makes every session incomplete', async () => {
    const src = new ReplayDataSource(file({ sessions: [], all_sessions: true }));
    expect((await costOf(src, 'a')).cost_complete).toBe(false);
    expect((await costOf(src, 'b')).cost_complete).toBe(false);
  });
});

describe('live increment', () => {
  it('adds a streamed call to its session and keeps completeness honest', () => {
    const base = row({ cost_usd: 0.3, cost_complete: true });
    const priced = ev({ kind: 'model.responded', session: 's1', cost_usd: 0.05, cost_complete: true });
    const after = addStreamedCost(base, priced);
    expect(after.cost_usd).toBeCloseTo(0.35);
    expect(after.cost_complete).toBe(true);

    const partial = addStreamedCost(after, ev({ kind: 'model.responded', session: 's1', cost_usd: 0.01, cost_complete: false }));
    expect(partial.cost_usd).toBeCloseTo(0.36);
    expect(partial.cost_complete).toBe(false);

    const unpriced = addStreamedCost(base, ev({ kind: 'model.responded', session: 's1' }));
    expect(unpriced.cost_usd).toBe(0.3);
    expect(unpriced.cost_complete).toBe(false);
  });

  it('a priced call after an unpriced one, on a null total, stays a lower bound', () => {
    // A row the list gave with no total, because its only call was unpriced.
    const listed = row({ cost_usd: null, cost_complete: false });
    const priced = ev({ kind: 'model.responded', session: 's1', cost_usd: 0.05, cost_complete: true });
    const after = addStreamedCost(listed, priced);
    expect(after.cost_usd).toBeCloseTo(0.05);
    expect(after.cost_complete).toBe(false);

    // The same, with both calls streamed onto a row that said nothing yet.
    const fresh = row({ cost_usd: null, cost_complete: undefined });
    const unpriced = addStreamedCost(fresh, ev({ kind: 'model.responded', session: 's1' }));
    expect(unpriced.cost_usd).toBeNull();
    expect(unpriced.cost_complete).toBe(false);
    const then = addStreamedCost(unpriced, priced);
    expect(then.cost_usd).toBeCloseTo(0.05);
    expect(then.cost_complete).toBe(false);
    expect(formatCost(then.cost_usd, then.cost_complete)).toBe('≥$0.05');

    // A row that says nothing yet, then only priced calls, is exact.
    expect(addStreamedCost(fresh, priced).cost_complete).toBe(true);
  });

  it('a replay session whose unpriced call comes first stays incomplete', () => {
    const events = oneTurn([{}, { cost_usd: 0.05, cost_complete: true }]);
    const s = summarizeSession('s1', events, buildTurns('s1', events));
    expect(s.cost_usd).toBeCloseTo(0.05);
    expect(s.cost_complete).toBe(false);
  });

  it('leaves other sessions and other kinds alone', () => {
    const base = row({ cost_usd: 0.3, cost_complete: true });
    expect(addStreamedCost(base, ev({ kind: 'model.responded', session: 'other', cost_usd: 1, cost_complete: true }))).toBe(base);
    expect(addStreamedCost(base, ev({ kind: 'tool.completed', session: 's1', cost_usd: 1 }))).toBe(base);
  });
});

describe('list against stream ordering (by store and seq)', () => {
  it('isNewerList: a lower seq or another store is not newer; no cursor always is', () => {
    expect(isNewerList(null, { store: 'st', seq: 1 })).toBe(true);
    expect(isNewerList({ store: 'st', seq: 10 }, { store: 'st', seq: 8 })).toBe(false);
    expect(isNewerList({ store: 'st', seq: 10 }, { store: 'st', seq: 12 })).toBe(true);
    expect(isNewerList({ store: 'st', seq: 10 }, { store: 'other', seq: 99 })).toBe(false);
    expect(isNewerList({ store: 'st', seq: 10 }, {})).toBe(true);
  });

  it('countedIn: an event at or below the list seq is already counted', () => {
    const c = { store: 'st', seq: 10 };
    expect(countedIn(c, ev({ kind: 'model.responded', seq: 10 }))).toBe(true);
    expect(countedIn(c, ev({ kind: 'model.responded', seq: 11 }))).toBe(false);
    expect(countedIn(null, ev({ kind: 'model.responded', seq: 1 }))).toBe(false);
  });

  it('applyList adds only streamed calls after the list seq, and keeps only those', () => {
    const buffer = [
      { id: 'e1', session: 's1', seq: 9, usd: 0.1, complete: true },
      { id: 'e2', session: 's1', seq: 11, usd: 0.05, complete: true },
      { id: 'e3', session: 'other', seq: 12, usd: 1, complete: true },
    ];
    const out = applyList({ store: 'st', seq: 10, sessions: [row({ cost_usd: 0.3, cost_complete: true })] }, buffer);
    expect(out.sessions[0].cost_usd).toBeCloseTo(0.35);
    expect(out.buffer.map((c) => c.id)).toEqual(['e2', 'e3']);
  });
});

describe('live rows in the app', () => {
  // Session a is shown; b is not. The stream starts from a snapshot at seq 10.
  // Each list refresh takes the next list from `lists`.
  async function setup() {
    const events = [
      ev({ seq: 1, session: 'a', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'a', kind: 'turn.started', turn: 'A1', exchange: 'ax1', text: 'first' }),
      ev({ seq: 3, session: 'a', kind: 'model.requested', turn: 'A1', exchange: 'ax1' }),
      ev({ seq: 4, session: 'a', kind: 'model.responded', turn: 'A1', exchange: 'ax1', status: 200, cost_usd: 0.2, cost_complete: true }),
      ev({ seq: 5, session: 'a', kind: 'turn.completed', turn: 'A1', exchange: 'ax1', outcome: 'finished' }),
      ev({ seq: 6, session: 'b', kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ];
    const replay = new ReplayDataSource(jsonl(events));
    const base = (await replay.getSessions()).sort((x) => (x.id === 'a' ? -1 : 1));
    const rowsAt = (bCost: number, aTurns = 1) =>
      base.map((s) => (s.id === 'b' ? { ...s, cost_usd: bCost, cost_complete: true } : { ...s, turns: aTurns }));
    const lists: SessionList[] = [];
    let push: ((e: CockpitEvent) => void) | null = null;
    const source: DataSource = {
      getAgents: () => replay.getAgents(),
      getSessions: async () => rowsAt(0.3),
      getSessionList: async () => lists.shift() ?? { store: 'st', seq: 10, sessions: rowsAt(0.3) },
      getTurns: (id) => replay.getTurns(id),
      getTurn: (s, t) => replay.getTurn(s, t),
      subscribe: (cb, onSnapshot) => {
        push = cb;
        Promise.resolve().then(() => onSnapshot?.(rowsAt(0.3), { store: 'st', seq: 10 }));
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    // The row's quiet line, and its tooltip, which holds the turn count.
    const rowText = (id: string) => {
      const m = Array.from(r.container.querySelectorAll('#sessions .sess'))
        .find((b) => (b as HTMLElement).dataset.session === id)
        ?.querySelector('.s-m');
      return m ? `${m.textContent} | ${m.getAttribute('title')}` : '';
    };
    const send = async (e: Partial<CockpitEvent> & { kind: string }) => {
      await act(async () => push!(ev(e)));
    };
    // b is not shown, so its events schedule one list refresh after 500 ms.
    const refresh = async () => {
      await act(async () => {
        await new Promise((res) => setTimeout(res, 600));
      });
      await flush();
    };
    return { r, rowText, send, refresh, lists, rowsAt };
  }

  it('a late, older list does not wipe a streamed cost', async () => {
    const { r, rowText, send, refresh, lists, rowsAt } = await setup();
    expect((r.container.querySelector('#sessions .sess.on') as HTMLElement | null)?.dataset.session).toBe('a');
    expect(rowText('b')).toContain('$0.30');
    await send({ seq: 11, session: 'b', kind: 'model.responded', cost_usd: 0.05, cost_complete: true });
    expect(rowText('b')).toContain('$0.35');
    // The list the stream started from lands again (seq 10): the call at 11 is kept on top.
    lists.push({ store: 'st', seq: 10, sessions: rowsAt(0.3) });
    await refresh();
    expect(rowText('b')).toContain('$0.35');
    // An older list (seq 8) is ignored.
    await send({ seq: 12, session: 'b', kind: 'tool.requested', tool_id: 't' });
    lists.push({ store: 'st', seq: 8, sessions: rowsAt(0.1) });
    await refresh();
    expect(rowText('b')).toContain('$0.35');
    r.unmount();
  });

  it('a list that already counts a call, then that call streamed, counts it once', async () => {
    const { r, rowText, send, refresh, lists, rowsAt } = await setup();
    lists.push({ store: 'st', seq: 12, sessions: rowsAt(0.35) });
    await send({ seq: 11, session: 'b', kind: 'tool.requested', tool_id: 't' });
    await refresh();
    expect(rowText('b')).toContain('$0.35');
    await send({ seq: 12, session: 'b', kind: 'model.responded', cost_usd: 0.05, cost_complete: true });
    expect(rowText('b')).toContain('$0.35');
    expect(rowText('b')).not.toContain('$0.40');
    r.unmount();
  });

  it('a newer list replaces the row', async () => {
    const { r, rowText, send, refresh, lists, rowsAt } = await setup();
    await send({ seq: 11, session: 'b', kind: 'model.responded', cost_usd: 0.05, cost_complete: true });
    expect(rowText('b')).toContain('$0.35');
    lists.push({ store: 'st', seq: 15, sessions: rowsAt(1) });
    await refresh();
    expect(rowText('b')).toContain('$1.00');
    r.unmount();
  });

  it('the shown session row follows the session list, and an older list does not replace it (TODO line 1)', async () => {
    const { r, rowText, send, refresh, lists, rowsAt } = await setup();
    expect(rowText('a')).toContain('1 turn');
    // The service counts the new turn in the list at seq 11.
    lists.push({ store: 'st', seq: 11, sessions: rowsAt(0.3, 2) });
    await send({ seq: 11, session: 'a', kind: 'turn.started', turn: 'A2', exchange: 'ax2', text: 'second' });
    await refresh();
    expect(rowText('a')).toContain('2 turns');
    // A list computed before it (seq 9, 1 turn) lands afterwards and is ignored.
    lists.push({ store: 'st', seq: 9, sessions: rowsAt(0.3, 1) });
    await send({ seq: 12, session: 'b', kind: 'tool.requested', tool_id: 't' });
    await refresh();
    expect(rowText('a')).toContain('2 turns');
    r.unmount();
  });
});

describe('switching sessions', () => {
  it('a list landing mid-switch keeps the old session fresh counts, not its old detail', async () => {
    const events = [
      ev({ seq: 1, session: 'a', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 2, session: 'a', kind: 'turn.started', turn: 'A1', exchange: 'ax1', text: 'first' }),
      ev({ seq: 3, session: 'b', kind: 'session.registered', agent: 'claude', folder: '/w' }),
      ev({ seq: 4, session: 'b', kind: 'turn.started', turn: 'B1', exchange: 'bx1', text: 'other' }),
    ];
    const replay = new ReplayDataSource(jsonl(events));
    const base = (await replay.getSessions()).sort((x) => (x.id === 'a' ? -1 : 1));
    const rowsAt = (aTurns: number) => base.map((s) => (s.id === 'a' ? { ...s, turns: aTurns } : s));
    const lists: SessionList[] = [];
    let push: ((e: CockpitEvent) => void) | null = null;
    // b's detail stays in flight until the test lets it go.
    let releaseB: () => void = () => {};
    const bGate = new Promise<void>((res) => (releaseB = res));
    const source: DataSource = {
      getAgents: () => replay.getAgents(),
      getSessions: async () => rowsAt(1),
      getSessionList: async () => lists.shift() ?? { store: 'st', seq: 10, sessions: rowsAt(1) },
      getTurns: async (id) => {
        if (id === 'b') await bGate;
        return replay.getTurns(id);
      },
      getTurn: (s, t) => replay.getTurn(s, t),
      subscribe: (cb, onSnapshot) => {
        push = cb;
        Promise.resolve().then(() => onSnapshot?.(rowsAt(1), { store: 'st', seq: 10 }));
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const rowOf = (id: string) =>
      Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => (b as HTMLElement).dataset.session === id);
    const turnsOf = (id: string) => rowOf(id)?.querySelector('.s-m')?.getAttribute('title') ?? '';
    expect(rowOf('a')?.classList.contains('on')).toBe(true);
    expect(turnsOf('a')).toContain('1 turn');

    // Switch to b; its detail is still loading, so a's detail is still held.
    await click(rowOf('b'));
    // a gets a second turn; a is no longer selected, so a list refresh follows.
    lists.push({ store: 'st', seq: 11, sessions: rowsAt(2) });
    await act(async () => push!(ev({ seq: 11, session: 'a', kind: 'turn.started', turn: 'A2', exchange: 'ax2', text: 'second' })));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 600));
    });
    await flush();
    expect(turnsOf('a')).toContain('2 turns');

    // b finishes loading; a keeps its fresh count.
    await act(async () => releaseB());
    await flush();
    expect(rowOf('b')?.classList.contains('on')).toBe(true);
    expect(turnsOf('a')).toContain('2 turns');
    r.unmount();
  });
});

describe('the switch window', () => {
  it('while B loads, the conversation and the panel still show A in every value; then B', async () => {
    const reply = (session: string, turn: string, x: string, usd: number, tokens: number) =>
      ev({ session, kind: 'model.responded', turn, exchange: x, status: 200, text: `${session} answer`, cost_usd: usd, cost_complete: true, usage: { input_tokens: tokens, output_tokens: 0 } });
    const events = [
      ev({ seq: 1, session: 'a', kind: 'session.registered', agent: 'claude', folder: '/wa' }),
      ev({ seq: 2, session: 'a', kind: 'turn.started', turn: 'A1', exchange: 'ax1', text: 'alpha prompt' }),
      ev({ seq: 3, session: 'a', kind: 'model.requested', turn: 'A1', exchange: 'ax1', model: 'm' }),
      { ...reply('a', 'A1', 'ax1', 0.2, 100), seq: 4 },
      ev({ seq: 5, session: 'a', kind: 'turn.completed', turn: 'A1', exchange: 'ax1', outcome: 'finished' }),
      ev({ seq: 6, session: 'b', kind: 'session.registered', agent: 'claude', folder: '/wb' }),
      ev({ seq: 7, session: 'b', kind: 'turn.started', turn: 'B1', exchange: 'bx1', text: 'beta prompt' }),
      ev({ seq: 8, session: 'b', kind: 'model.requested', turn: 'B1', exchange: 'bx1', model: 'm' }),
      { ...reply('b', 'B1', 'bx1', 2, 5000), seq: 9 },
      ev({ seq: 10, session: 'b', kind: 'turn.completed', turn: 'B1', exchange: 'bx1', outcome: 'finished' }),
      ev({ seq: 11, session: 'b', kind: 'turn.started', turn: 'B2', exchange: 'bx2', text: 'beta again' }),
      ev({ seq: 12, session: 'b', kind: 'model.requested', turn: 'B2', exchange: 'bx2', model: 'm' }),
      { ...reply('b', 'B2', 'bx2', 2, 5000), seq: 13 },
      ev({ seq: 14, session: 'b', kind: 'turn.completed', turn: 'B2', exchange: 'bx2', outcome: 'finished' }),
    ];
    const replay = new ReplayDataSource(jsonl(events));
    // A can take a next message; B is held open by a run and cannot.
    const rows = (await replay.getSessions())
      .sort((x) => (x.id === 'a' ? -1 : 1))
      .map((s) => (s.id === 'a' ? { ...s, resumable: true, open: false } : { ...s, resumable: false, open: true }));
    let releaseB: () => void = () => {};
    const bGate = new Promise<void>((res) => (releaseB = res));
    const sent: string[] = [];
    const source: DataSource = {
      getAgents: () => replay.getAgents(),
      getSessions: async () => rows,
      getTurns: async (id) => {
        if (id === 'b') await bGate;
        return replay.getTurns(id);
      },
      getTurn: (s, t) => replay.getTurn(s, t),
      sendMessage: async (id) => {
        sent.push(id);
        return { id };
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const q = (sel: string) => r.container.querySelector(sel);
    const rowOf = (id: string) =>
      Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => (b as HTMLElement).dataset.session === id);

    // The panel follows the selected level. Picking a session selects the
    // session level, so after the click the panel shows a session strip.
    const expectShowing = (who: 'a' | 'b', level: 'turn' | 'session' = 'turn') => {
      const a = who === 'a';
      expect(q('#convo .colhead-title')?.textContent).toBe(a ? 'alpha prompt' : 'beta prompt');
      expect(shownSession(r.container)).toBe(who);
      const foot = q('#convo .tb-stat')?.textContent ?? '';
      expect(foot).toContain(a ? '$0.20' : '$2.00');
      expect(foot).toContain(a ? '100 tokens' : '5.0k tokens');
      expect(r.container.querySelectorAll('#convo .tb')).toHaveLength(a ? 1 : 2);
      expect(q('#convo .m-agent')?.textContent).toContain(`${who} answer`);
      // A takes a next message; B is held open, so its box is closed.
      expect((q('#input') as HTMLTextAreaElement).disabled).toBe(!a);
      if (level === 'turn') {
        expect(q('#right .colhead-title')?.textContent).toContain(a ? 'alpha prompt' : 'beta prompt');
        expect(q('#right .colhead-title')?.textContent).toContain(a ? 'turn 1 of 1' : 'turn 1 of 2');
        expect(q('#d-head .strip')?.textContent).toContain(a ? '$0.20' : '$2.00');
      } else {
        expect(q('#right .colhead-title')?.textContent).toBe(a ? 'Session1 turn' : 'Session2 turns');
        const strip = q('#d-head .strip')?.textContent ?? '';
        expect(strip).toContain(a ? '$0.20' : '$4.00');
        expect(strip).not.toContain(a ? '$4.00' : '$0.20');
        expect(strip).toContain(`Session${who}`);
      }
    };

    expect(rowOf('a')?.classList.contains('on')).toBe(true);
    // Open the panel on A's turn.
    await click(r.container.querySelector('#convo .tb'));
    expectShowing('a');

    await click(rowOf('b'));
    expect(rowOf('b')?.classList.contains('on')).toBe(true);
    expectShowing('a', 'session');

    // A message sent from A's conversation goes to A.
    const ta = q('#input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, 'hello a');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      q('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(sent).toEqual(['a']);

    await act(async () => releaseB());
    await flush();
    await flush();
    expectShowing('b', 'session');
    // B's first turn, picked in the conversation, shows at the turn level.
    await click(r.container.querySelector('#convo .tb'));
    expectShowing('b');
    r.unmount();
  });
});

describe('cost rendering', () => {
  it('shows an incomplete cost with ≥ and the tooltip, and nothing for null', async () => {
    const r = await render(
      <SessionsColumn
        sessions={[row({ id: 'a', cost_usd: 0.42, cost_complete: false }), row({ id: 'b', cost_usd: null })]}
        selectedSessionId={null}
        onSelectSession={() => {}}
      />
    );
    const rows = r.container.querySelectorAll('.sess .s-m');
    expect(rows[0].textContent).toContain('≥$0.42');
    expect(rows[0].querySelector('span[title]')?.getAttribute('title')).toBe(COST_INCOMPLETE_TITLE);
    expect(rows[1].textContent).not.toContain('$');
    // The header total is a lower bound too: one session has no cost.
    expect(r.container.querySelector('.colhead .ch-sub')?.textContent).toBe('≥$0.42');
    r.unmount();
  });

  it('totals the listed sessions', () => {
    expect(sessionsTotal([row({ cost_usd: 0.1, cost_complete: true }), row({ cost_usd: 0.2, cost_complete: true })])).toEqual({
      usd: expect.closeTo(0.3),
      complete: true,
    });
    expect(sessionsTotal([row({ cost_usd: null })])).toBeNull();
  });
});
