// @vitest-environment jsdom
// Agents ask agents: a delivered result shows as such, names the agent that
// did the work and links to its session; a turn another agent asked for
// links to the session that asked. The live source reads origin from the
// turn list.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ConvoColumn } from '../components/ConvoColumn';
import { LiveDataSource } from '../data/LiveDataSource';
import { createEmptyUsage } from '../data/turns';
import { SavedAgent, SessionDetail, Turn } from '../types';
import { click, ev, flush, liveReplay, render, shownSession } from './helpers';

const SAVED: SavedAgent[] = [
  { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' },
  { id: 'deepseek', name: 'DeepSeek flash', harness: 'claude', access: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
];

function turn(id: string, n: number, fields: Partial<Turn> = {}): Turn {
  return {
    id,
    turnNumber: n,
    sessionId: 'p',
    startedAt: '2026-11-09T01:00:00Z',
    prompt: `prompt ${id}`,
    agent: 'claude',
    agentId: 'claude',
    state: 'finished',
    usage: null,
    costUsd: null,
    costComplete: true,
    ...fields,
  };
}

function session(turns: Turn[]): SessionDetail {
  return {
    id: 'p',
    title: 'p',
    agent: 'claude',
    turns: turns.length,
    turnsList: turns,
    usage: createEmptyUsage(),
  } as unknown as SessionDetail;
}

describe('asked work in the conversation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a delivered result says who did the work and links to its session', async () => {
    const opened: string[] = [];
    const s = session([
      turn('T1', 1, { prompt: 'run all two on this' }),
      turn('T2', 2, {
        prompt: '[AgentBus] This message is from AgentBus, not from the person',
        origin: { kind: 'result', session: 'child1', turn: 'tc', job: 'job_1', jobKind: 'turn', agent: 'deepseek' },
      }),
      turn('T3', 3, { origin: { kind: 'result', session: 'rs', job: 'job_2', jobKind: 'review', agent: 'codex' } }),
    ]);
    const r = await render(
      <ConvoColumn session={s} selectedTurn={null} onSelectTurn={() => {}} agents={SAVED} onOpenSession={(id) => opened.push(id)} />
    );
    const lines = Array.from(r.container.querySelectorAll('.m-origin')).map((x) => x.textContent);
    expect(lines).toEqual([
      'Result from DeepSeek flash, delivered by AgentBus, not typed by you · open its session',
      'Review result from Codex, delivered by AgentBus, not typed by you · open its session',
    ]);
    const bubbles = r.container.querySelectorAll('.tb .bubble');
    expect(bubbles[0].classList.contains('delivered')).toBe(false);
    expect(bubbles[1].classList.contains('delivered')).toBe(true);
    await click(r.container.querySelector('.origin-link'));
    expect(opened).toEqual(['child1']);
    r.unmount();
  });

  it('an asked turn links to the session that asked; without onOpenSession there is no link', async () => {
    const s = session([turn('C1', 1, { origin: { kind: 'asked', session: 'p0', turn: 'T1' } })]);
    const r = await render(<ConvoColumn session={s} selectedTurn={null} onSelectTurn={() => {}} agents={SAVED} />);
    expect(r.container.querySelector('.m-origin')!.textContent).toBe('Asked by another agent');
    expect(r.container.querySelector('.origin-link')).toBeNull();
    r.unmount();
  });

  it('the live source reads origin from GET /api/v0/turns, and leaves out a kind it does not know', async () => {
    const row = (id: string, seq: number, origin?: unknown) => ({
      id,
      session: 'p',
      agent: 'claude',
      folder: '/w',
      prompt: id,
      started_seq: seq,
      started: '2026-11-09T01:00:00Z',
      state: 'finished',
      usage: null,
      cost_usd: 0,
      cost_complete: true,
      origin,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            store: 'st',
            seq: 9,
            turns: [
              row('T3', 3, { kind: 'later' }),
              row('T2', 2, { kind: 'result', session: 'c', turn: 'tc', job: 'job_1', job_kind: 'review', agent: 'codex' }),
              row('T1', 1),
            ],
            next_before: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const list = await new LiveDataSource({ baseUrl: 'http://cockpit.test' }).getTurns('p');
    expect(list.turns.map((t) => t.origin)).toEqual([
      undefined,
      { kind: 'result', session: 'c', turn: 'tc', job: 'job_1', jobKind: 'review', agent: 'codex' },
      undefined,
    ]);
  });
});

describe('asked work across sessions', () => {
  const started = (session: string, turn: string, text: string, agent: string, origin?: unknown) => [
    ev({ session, kind: 'turn.started', turn, text, agent, agent_id: agent, folder: '/w', ...(origin ? { origin } : {}) }),
    ev({ session, kind: 'model.requested', turn, exchange: `x-${turn}`, model: 'm' }),
    ev({ session, kind: 'model.responded', turn, exchange: `x-${turn}`, status: 200, text: 'ok', stop_reason: 'end_turn' }),
    ev({ session, kind: 'turn.completed', turn, exchange: `x-${turn}`, outcome: 'finished' }),
  ];
  const parent = [
    ...started('p', 'T1', 'run codex on this', 'claude'),
    ...started('p', 'T2', '[AgentBus] result', 'claude', { kind: 'result', session: 'c', turn: 'C1', job: 'job_1', job_kind: 'turn', agent: 'codex' }),
    ...started('p', 'T3', '[AgentBus] result', 'claude', { kind: 'result', session: 'n', turn: 'N1', job: 'job_2', job_kind: 'turn', agent: 'codex' }),
  ];
  const child = (id: string, turn: string) => started(id, turn, 'do it', 'codex', { kind: 'asked', session: 'p', turn: 'T1' });

  it('the replay source reads origin from turn.started', async () => {
    const lr = liveReplay([...parent, ...child('c', 'C1')]);
    const turns = (await lr.source.getTurns('p')).turns;
    expect(turns.map((t) => t.origin?.kind)).toEqual([undefined, 'result', 'result']);
    expect((await lr.source.getTurns('c')).turns[0].origin).toEqual({ kind: 'asked', session: 'p', turn: 'T1', job: undefined, jobKind: undefined, agent: undefined });
  });

  it('a result link opens the child session under its own agent, and one not listed yet opens once it is', async () => {
    const lr = liveReplay([...parent, ...child('c', 'C1')], { listAgents: async () => SAVED });
    const r = await render(<App dataSource={lr.source} />);
    // The child is listed first; its asked line links to the parent, which
    // is under another agent.
    await waitFor(() => shownSession(r.container) === 'c' && r.container.querySelector('.origin-link') !== null, 'the child');
    expect(r.container.querySelector('.m-origin')!.textContent).toBe('Asked by another agent · open the session that asked');
    await click(r.container.querySelector('.origin-link'));
    await waitFor(() => shownSession(r.container) === 'p' && r.container.querySelectorAll('.origin-link').length === 2, 'the parent');
    // A later list refresh keeps it.
    lr.push(ev({ session: 'p', kind: 'model.requested', turn: 'T3', exchange: 'x-more', model: 'm' }));
    await flush();
    expect(shownSession(r.container)).toBe('p');
    await click(r.container.querySelectorAll('.origin-link')[0]);
    await waitFor(() => shownSession(r.container) === 'c', 'the child again');
    await click(r.container.querySelector('.origin-link'));
    await waitFor(() => shownSession(r.container) === 'p', 'back to the parent');
    // Session n is not listed yet: the link waits for it.
    await click(r.container.querySelectorAll('.origin-link')[1]);
    await flush();
    expect(shownSession(r.container)).toBe('p');
    for (const e of child('n', 'N1')) lr.push(e);
    await waitFor(() => shownSession(r.container) === 'n', 'the new child');
    r.unmount();
  });
});

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('timed out waiting for ' + what);
}
