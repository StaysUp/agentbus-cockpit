import { describe, expect, it } from 'vitest';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { ev, jsonl, openSession } from './helpers';

describe('replay pairing and grouping (CLIENT_API "Turns")', () => {
  it('#3 pairs model.requested with model.responded by exchange, not by order', async () => {
    const events = [
      ev({ kind: 'turn.started', session: 's3', exchange: 'x1', text: 'hi' }),
      ev({ kind: 'model.requested', session: 's3', exchange: 'x1', model: 'm' }),
      ev({ kind: 'model.requested', session: 's3', exchange: 'x2', model: 'm' }),
      ev({ kind: 'model.responded', session: 's3', exchange: 'x2', status: 200, stop_reason: 'end_turn' }),
      ev({ kind: 'model.responded', session: 's3', exchange: 'x1', status: 200, stop_reason: 'end_turn' }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const turn = (await openSession(src, 's3'))!.turnsList[0];
    expect(turn.detail!.modelCalls).toHaveLength(2);
    for (const pair of turn.detail!.modelCalls) {
      expect(pair.responded?.exchange).toBe(pair.requested.exchange);
    }
  });

  it('#4 a call with a tool_id and no matching result is pending, never given another result', async () => {
    const events = [
      ev({ kind: 'turn.started', session: 's4', exchange: 'x1', text: 'go' }),
      ev({ kind: 'tool.requested', session: 's4', exchange: 'x1', tool_id: 'toolu_9', tool_name: 'Bash' }),
      ev({ kind: 'tool.completed', session: 's4', exchange: 'x2', tool_id: 'toolu_8', tool_output: 'other' }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const turn = (await openSession(src, 's4'))!.turnsList[0];
    expect(turn.detail!.toolCalls).toHaveLength(1);
    expect(turn.detail!.toolCalls[0].completed).toBeUndefined();
  });

  it('#5 groups by event.turn: a late reply for turn A stays in A', async () => {
    const events = [
      ev({ kind: 'session.registered', session: 's5', agent: 'claude', folder: '/w' }),
      ev({ kind: 'session.opened', session: 's5', hold: 'h1' }),
      ev({ kind: 'turn.started', session: 's5', turn: 'A', exchange: 'xa', text: 'first' }),
      ev({ kind: 'model.requested', session: 's5', turn: 'A', exchange: 'xa' }),
      ev({ kind: 'turn.started', session: 's5', turn: 'B', exchange: 'xb', text: 'second' }),
      ev({ kind: 'model.requested', session: 's5', turn: 'B', exchange: 'xb' }),
      ev({ kind: 'model.responded', session: 's5', turn: 'A', exchange: 'xa', status: 200, text: 'reply A' }),
      ev({ kind: 'turn.completed', session: 's5', turn: 'A', exchange: 'xa', outcome: 'finished' }),
      ev({ kind: 'events.dropped', session: 's5', sessions: ['s5'], dropped: 1 }),
      ev({ kind: 'session.closed', session: 's5', hold: 'h1' }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const detail = (await openSession(src, 's5'))!;
    expect(detail.turnsList.map((t) => t.id)).toEqual(['A', 'B']);
    const [a, b] = detail.turnsList;
    expect(a.prompt).toBe('first');
    expect(a.detail!.agentResponse).toBe('reply A');
    expect(a.outcome).toBe('finished');
    expect(a.detail!.modelCalls[0].responded?.text).toBe('reply A');
    expect(b.prompt).toBe('second');
    expect(b.detail!.events.every((e) => e.turn === 'B')).toBe(true);
    expect(detail.turns).toBe(2);
  });

  it('#5 session.* and events.dropped never create turns in a file without turn', async () => {
    const events = [
      ev({ kind: 'session.registered', session: 's6', agent: 'claude', folder: '/w' }),
      ev({ kind: 'session.opened', session: 's6', hold: 'h1' }),
      ev({ kind: 'turn.started', session: 's6', exchange: 'x1', text: 'only' }),
      ev({ kind: 'model.requested', session: 's6', exchange: 'x1' }),
      ev({ kind: 'model.responded', session: 's6', exchange: 'x1', status: 200, text: 'ok' }),
      ev({ kind: 'turn.completed', session: 's6', exchange: 'x1', outcome: 'finished' }),
      ev({ kind: 'events.dropped', session: 's6', all_sessions: true, dropped: 3 }),
      ev({ kind: 'session.closed', session: 's6', hold: 'h1' }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const detail = (await openSession(src, 's6'))!;
    expect(detail.turnsList).toHaveLength(1);
    expect(detail.turnsList[0].prompt).toBe('only');
    expect(detail.turnsList[0].detail!.events.some((e) => e.kind.startsWith('session.'))).toBe(false);
  });

  it('#6 reads agent and folder from session.registered before the client fallback', async () => {
    const events = [
      ev({ kind: 'session.registered', session: 's7', agent: 'codex', folder: '/Users/ana/Sites/x' }),
      ev({ kind: 'turn.started', session: 's7', turn: 'T', exchange: 'x1', client: 'claude-cli/2.1.318', text: 'hello' }),
      ev({ kind: 'tool.requested', session: 's7', turn: 'T', exchange: 'x1', tool_id: 't1', tool_input: { command: 'cd /elsewhere && ls' } }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const s = (await src.getSessions()).find((x) => x.id === 's7')!;
    expect(s.agent).toBe('codex');
    expect(s.folder).toBe('/Users/ana/Sites/x');
    const agents = await src.getAgents();
    expect(agents.map((a) => a.id)).toEqual(['codex']);
  });

  it('reads agent and folder from the latest run turn or session.opened, as GET /sessions does', async () => {
    const events = [
      // A run's child: session.opened names the agent and folder before any turn.
      ev({ kind: 'session.opened', session: 's8', hold: 'h1', agent: 'codex', folder: '/a' }),
      ev({ kind: 'turn.started', session: 's8', turn: 'T1', exchange: 'x1', text: 'one', agent: 'codex', folder: '/a' }),
      ev({ kind: 'session.closed', session: 's8', hold: 'h1' }),
      // A later turn of the session in another folder: the latest wins.
      ev({ kind: 'session.opened', session: 's8', hold: 'h2', agent: 'claude', folder: '/b' }),
      ev({ kind: 'turn.started', session: 's8', turn: 'T2', exchange: 'x2', text: 'two', agent: 'claude', folder: '/b' }),
      // A turn.started without them (pointed at the gateway by hand) changes nothing.
      ev({ kind: 'turn.started', session: 's8', turn: 'T3', exchange: 'x3', text: 'three' }),
    ];
    const src = new ReplayDataSource(jsonl(events));
    const s = (await src.getSessions()).find((x) => x.id === 's8')!;
    expect(s.agent).toBe('claude');
    expect(s.folder).toBe('/b');
    expect(s.open).toBe(true);
    const turns = (await openSession(src, 's8'))!.turnsList;
    expect(turns.map((t) => [t.agent, t.folder])).toEqual([
      ['codex', '/a'],
      ['claude', '/b'],
      [undefined, undefined],
    ]);
  });

  // The state and outcome are the service's (GET /api/v0/turns), and the
  // replay applies the same rule: a turn not started by a run is finished once
  // it has a turn.completed, and its outcome is the latest one's.
  it('R2#1 a turn with a turn.completed is finished by the API rule, even with a retry still asked', async () => {
    const events = [
      ev({ kind: 'turn.started', session: 'r1', turn: 'T', exchange: 'x1', text: 'go' }),
      ev({ kind: 'model.requested', session: 'r1', turn: 'T', exchange: 'x1' }),
      ev({ kind: 'model.responded', session: 'r1', turn: 'T', exchange: 'x1', status: 200, stop_reason: 'end_turn', text: 'old' }),
      ev({ kind: 'turn.completed', session: 'r1', turn: 'T', exchange: 'x1', outcome: 'finished' }),
      ev({ kind: 'model.requested', session: 'r1', turn: 'T', exchange: 'x2' }),
    ];
    const turn = (await openSession(new ReplayDataSource(jsonl(events)), 'r1'))!.turnsList[0];
    expect(turn.state).toBe('finished');
    expect(turn.outcome).toBe('finished');
    // The retry still shows as a call waiting for its reply.
    expect(turn.detail!.modelCalls.map((p) => !!p.responded)).toEqual([true, false]);
  });

  it('R2#2 the answer is the last exchange reply, and the outcome the latest turn.completed', async () => {
    const events = [
      ev({ kind: 'turn.started', session: 'r2', turn: 'T', exchange: 'x1', text: 'go' }),
      ev({ kind: 'model.requested', session: 'r2', turn: 'T', exchange: 'x1' }),
      ev({ kind: 'model.requested', session: 'r2', turn: 'T', exchange: 'x2' }),
      ev({ kind: 'model.responded', session: 'r2', turn: 'T', exchange: 'x2', status: 200, stop_reason: 'end_turn', text: 'retry answer' }),
      ev({ kind: 'turn.completed', session: 'r2', turn: 'T', exchange: 'x2', outcome: 'finished' }),
      ev({ kind: 'model.responded', session: 'r2', turn: 'T', exchange: 'x1', status: 200, stop_reason: 'end_turn', text: 'original answer' }),
      ev({ kind: 'turn.completed', session: 'r2', turn: 'T', exchange: 'x1', outcome: 'partial' }),
    ];
    const turn = (await openSession(new ReplayDataSource(jsonl(events)), 'r2'))!.turnsList[0];
    expect(turn.detail!.agentResponse).toBe('retry answer');
    expect(turn.outcome).toBe('partial');
  });
});
