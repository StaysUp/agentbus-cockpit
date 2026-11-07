// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ContextTab, LONG_CHARS } from '../components/ContextTab';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { layoutContext, splitReplayed, turnInfo, TurnInfo } from '../data/context';
import { CallContext, ContextPiece, DataSource } from '../types';
import { click, ev, flush, jsonl, render, openCall } from './helpers';

// A piece as the API sends it. size is the json's length here; the API's
// is the stored bytes, which the tab shows as given.
function piece(kind: string, label: string, json: unknown, size?: number): ContextPiece {
  const raw = JSON.stringify(json);
  return { kind, label, hash: `h-${raw.length}-${label}`, size: size ?? raw.length, approx_tokens: Math.round((size ?? raw.length) / 2.66), json };
}

const user = (content: unknown) => piece('message', 'user', { role: 'user', content });
const assistant = (text: string) => piece('message', 'assistant', { role: 'assistant', content: [{ type: 'text', text }] });
const sysMsg = (text: string) =>
  piece('message', 'system', { role: 'system', content: [{ type: 'text', text }, { type: 'tool_addition', tool: { name: 'X' } }] });

// Claude Code's order: messages, then the system blocks, then the tools.
function ctx(pieces: ContextPiece[], extra: Partial<CallContext> = {}): CallContext {
  return {
    exchange: 'x',
    session: 'rp',
    vendor: 'anthropic',
    size: pieces.reduce((n, p) => n + p.size, 0),
    stop_reason: 'end_turn',
    request: { model: 'claude-opus-5-5', max_tokens: 128000, stream: true },
    reply: piece('message', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'All three are TypeScript.' }] }),
    pieces: [
      ...pieces,
      piece('system', 'text', { type: 'text', text: 'You are a Claude agent.' }),
      piece('tool', 'Bash', { name: 'Bash', description: 'Runs a command', input_schema: {} }),
      piece('tool', 'Read', { name: 'Read', description: 'Reads a file', input_schema: {} }),
    ],
    ...extra,
  };
}

// Turn 2 of a session replays turn 1's history (two messages) in front of
// its own message and Claude Code's system message.
const replayedCall = ctx([
  user([
    { type: 'text', text: '<system-reminder>\nCodebase instructions\n</system-reminder>' },
    { type: 'text', text: 'what projects are here?' },
  ]),
  assistant('There are two directories.'),
  user('what language is the frontend?'),
  sysMsg('SessionStart hook additional context: hooks'),
]);

const firstCall = ctx([
  user([
    { type: 'text', text: '<system-reminder>\nCodebase instructions\n</system-reminder>' },
    { type: 'text', text: 'hi' },
  ]),
  sysMsg('SessionStart hook additional context: hooks\n\n# Environment\nPlatform: darwin'),
]);

// Answers like the service: full=false leaves out every json.
function loader(answers: Record<string, CallContext | Error>) {
  const calls: string[] = [];
  const load = async (x: string, full: boolean): Promise<CallContext> => {
    calls.push(`${x}:${full}`);
    const a = answers[x];
    if (!a) throw new Error('404: no request body is stored for this call');
    if (a instanceof Error) throw a;
    if (full) return a;
    const strip = ({ json: _json, ...rest }: ContextPiece) => rest;
    return { ...a, pieces: a.pieces.map(strip), reply: a.reply && strip(a.reply) };
  };
  return { load, calls };
}

function events() {
  return [
    ev({ seq: 1, session: 'rp', kind: 'session.registered', agent: 'claude', folder: '/work/rp' }),
    ev({ seq: 2, session: 'rp', kind: 'turn.started', turn: 'T1', text: 'what projects are here?' }),
    ev({ seq: 3, session: 'rp', kind: 'model.requested', turn: 'T1', exchange: 'x1', model: 'claude-opus-5-5' }),
    ev({ seq: 4, session: 'rp', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, stop_reason: 'end_turn', text: 'There are two directories.' }),
    ev({ seq: 5, session: 'rp', kind: 'turn.completed', turn: 'T1', outcome: 'finished' }),
    ev({ seq: 6, session: 'rp', kind: 'turn.started', turn: 'T2', text: 'what language is the frontend?', continuity: 'replay', replay_from: 'T1' }),
    ev({ seq: 7, session: 'rp', kind: 'model.requested', turn: 'T2', exchange: 'x2', model: 'claude-opus-5-5', replayed: 2 }),
    ev({ seq: 8, session: 'rp', kind: 'model.responded', turn: 'T2', exchange: 'x2', status: 200, stop_reason: 'end_turn', text: 'All three are TypeScript.' }),
    ev({ seq: 9, session: 'rp', kind: 'turn.completed', turn: 'T2', outcome: 'finished' }),
  ];
}

const titles = (root: Element, sel = ':scope > .ctx-fold') =>
  Array.from(root.querySelectorAll(sel)).map((f) => f.querySelector('.ctx-title')!.textContent);

describe('Context tab', () => {
  it('lays out system, tools, then messages, with the replayed ones first', () => {
    const l = layoutContext(replayedCall, { replayed: 2, continuity: 'replay' });
    expect(l.system).toHaveLength(1);
    expect(l.tools.map((t) => t.piece.label)).toEqual(['Bash', 'Read']);
    expect(l.messages.map((m) => [m.role, m.part, m.claudeCode])).toEqual([
      ['user', 'replayed', false],
      ['assistant', 'replayed', false],
      ['user', 'new', false],
      ['system', 'turn', true],
    ]);
    // More replayed than there are messages: clamped, never past the end.
    expect(layoutContext(replayedCall, { replayed: 99 }).replayed).toBe(4);
    // The vendor's resume marks no message as the new one.
    expect(layoutContext(replayedCall, { continuity: 'resume' }).messages.some((m) => m.part === 'new')).toBe(false);
  });

  it('a replayed call: the history is marked "Turn 1" and folded, the new message open', async () => {
    const { load, calls } = loader({ x2: replayedCall, x1: firstCall });
    const base = new ReplayDataSource(jsonl(events()));
    const source: DataSource = {
      getAgents: () => base.getAgents(),
      getSessions: (a) => base.getSessions(a),
      getTurns: (id) => base.getTurns(id),
      getTurn: (s, t) => base.getTurn(s, t),
      getCallContext: load,
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const q = (s: string) => r.container.querySelector(s);
    const qa = (s: string) => Array.from(r.container.querySelectorAll(s));

    await openCall(r.container, 1, 0);
    await click(qa('#d-tabs .tab').find((t) => t.textContent === 'Context'));
    await flush();
    await flush();

    // The outline first, then the whole call (it is small).
    expect(calls).toEqual(['x2:false', 'x2:true']);
    const body = q('#d-body .ctx')!;
    expect(titles(body)).toEqual([
      'System',
      'Tools',
      'Turn 1',
      '#2 usernew message',
      '#3 systemClaude Code',
      'Other fields',
      'assistantend_turn',
    ]);

    const replayed = body.querySelector(':scope > .ctx-fold.replayed')!;
    expect(replayed.classList.contains('open')).toBe(false);
    expect(replayed.querySelector('.ctx-meta')!.textContent).toContain('2 messages');
    // Folded: the history's words are not on the page.
    expect(body.textContent).not.toContain('There are two directories.');

    // The new message is open with its words; Claude Code's message is folded.
    const fresh = body.querySelector(':scope > .ctx-fold.msg-new')!;
    expect(fresh.classList.contains('open')).toBe(true);
    expect(fresh.textContent).toContain('what language is the frontend?');
    expect(body.querySelector(':scope > .ctx-fold.cc')!.classList.contains('open')).toBe(false);
    expect(body.textContent).not.toContain('SessionStart hook');

    // The reply is at the end, open.
    expect(body.querySelector(':scope > .ctx-fold.reply-piece')!.textContent).toContain('All three are TypeScript.');

    // Sizes in bytes, and the service's token estimate marked as one.
    expect(fresh.querySelector('.ctx-meta')!.textContent).toMatch(/\d+ B≈\d+ tok/);

    // Open the history: its messages, the person's reminder folded inside.
    await click(replayed.querySelector('.ctx-row'));
    expect(replayed.textContent).toContain('turn 1');
    expect(titles(replayed.querySelector('.ctx-inner')!)).toEqual(['#0 user', '#1 assistant']);
    await click(replayed.querySelectorAll('.ctx-inner > .ctx-fold > .ctx-row')[0]);
    const first = replayed.querySelectorAll('.ctx-inner > .ctx-fold')[0];
    expect(first.textContent).toContain('what projects are here?');
    expect(titles(first.querySelector('.ctx-blocks')!)).toEqual(['Claude Code text', 'text']);
    expect(first.textContent).not.toContain('Codebase instructions');
    r.unmount();
  });

  it('a first-turn call has no replayed part, and its first message is the new one', async () => {
    const { load } = loader({ x: firstCall });
    const r = await render(<ContextTab exchange="x" load={load} />);
    await flush();
    await flush();
    const body = r.container.querySelector('.ctx')!;
    expect(body.querySelector('.ctx-fold.replayed')).toBeNull();
    expect(body.textContent).not.toContain('replayed');
    expect(titles(body)).toEqual(['System', 'Tools', '#0 usernew message', '#1 systemClaude Code', 'Other fields', 'assistantend_turn']);
    const fresh = body.querySelector('.ctx-fold.msg-new')!;
    // The person's words open; the reminder Claude Code put in front folded.
    expect(fresh.textContent).toContain('hi');
    expect(fresh.textContent).not.toContain('Codebase instructions');
    r.unmount();
  });

  it('a large block opens cut, and shows the rest in pages', async () => {
    const big = 'line of output\n'.repeat(20_000); // 300,000 chars
    const call = ctx([user([{ type: 'tool_result', tool_use_id: 't', content: big }])]);
    const { load } = loader({ x: call });
    const r = await render(<ContextTab exchange="x" load={load} />);
    await flush();
    await flush();
    const fresh = r.container.querySelector('.ctx-fold.msg-new')!;
    // The message's one block opens, cut to its start: 600 of 300,000 chars.
    expect(fresh.querySelector('.ctx-blocks .ctx-meta')!.textContent).toContain('300,000 chars');
    const pre = () => fresh.querySelector('.ctx-text')!.textContent!;
    expect(pre().length).toBeLessThan(LONG_CHARS);
    const more = () => fresh.querySelector('.ctx-more') as HTMLElement | null;
    expect(more()!.textContent).toContain('299,400 left');
    await click(more());
    expect(pre().length).toBe(100_600 + 1);
    await click(more());
    await click(more());
    expect(pre()).toBe(big);
    expect(more()).toBeNull();
    r.unmount();
  });

  it('a large request waits for a click before reading its text', async () => {
    const call = ctx([user('a short question')]);
    call.size = 5_000_000;
    const { load, calls } = loader({ x: call });
    const r = await render(<ContextTab exchange="x" load={load} />);
    await flush();
    await flush();
    // The outline only: the open message offers the read instead of starting it.
    expect(calls).toEqual(['x:false']);
    const fresh = () => r.container.querySelector('.ctx-fold.msg-new')!;
    expect(fresh().textContent).toContain('Read the text (5,000,000 B for the whole call)');
    await click(fresh().querySelector('.ctx-more'));
    await flush();
    expect(calls).toEqual(['x:false', 'x:true']);
    expect(fresh().textContent).toContain('a short question');
    r.unmount();
  });

  it('shows the endpoint error plainly', async () => {
    const { load } = loader({});
    const r = await render(<ContextTab exchange="gone" load={load} />);
    await flush();
    const err = r.container.querySelector('.bad')!;
    expect(err.textContent).toBe('The request could not be read: 404: no request body is stored for this call');
    r.unmount();
  });

  it('says so when the source keeps no request bodies', async () => {
    const r = await render(<ContextTab exchange="x" />);
    expect(r.container.textContent).toContain('keeps no request bodies');
    r.unmount();
  });
});


describe('Replayed history split by turn', () => {
  const T = (o: Partial<TurnInfo>): TurnInfo => ({ resumed: false, recovered: false, ...o });
  const lookup = (m: Record<string, TurnInfo>) => async (id: string) => m[id];

  it('reads a turn from its events', () => {
    expect(turnInfo([{ kind: 'turn.started' }])).toEqual({ replayFrom: undefined, resumed: false, recovered: false, replayed: 0 });
    expect(
      turnInfo([
        { kind: 'turn.started', continuity: 'replay', replay_from: ' T1 ' },
        { kind: 'model.requested', replayed: 3 },
      ])
    ).toEqual({ replayFrom: 'T1', resumed: false, recovered: false, replayed: 3 });
    expect(turnInfo([{ kind: 'turn.started', continuity: 'resume' }]).replayed).toBeUndefined();
  });

  it('a 3-turn chain: turn 3 had 8 from turn 2, turn 2 had 3 from turn 1', async () => {
    const g = await splitReplayed(8, 'T2', lookup({ T2: T({ replayFrom: 'T1', replayed: 3 }), T1: T({ replayed: 0 }) }));
    expect(g).toEqual([
      { kind: 'turn', turnId: 'T1', from: 0, to: 3 },
      { kind: 'turn', turnId: 'T2', from: 3, to: 8 },
    ]);
  });

  it('a first turn: one group, no walk further', async () => {
    expect(await splitReplayed(2, 'T1', lookup({ T1: T({ replayed: 0 }) }))).toEqual([{ kind: 'turn', turnId: 'T1', from: 0, to: 2 }]);
    expect(await splitReplayed(0, 'T1', lookup({}))).toEqual([]);
  });

  it('a resumed turn ends the chain; what is before it stays earlier history', async () => {
    const g = await splitReplayed(8, 'T3', lookup({ T3: T({ replayFrom: 'T2', replayed: 5 }), T2: T({ resumed: true }) }));
    expect(g.map((x) => [x.kind, x.turnId, x.from, x.to])).toEqual([
      ['earlier', undefined, 0, 5],
      ['turn', 'T3', 5, 8],
    ]);
    expect(g[0].why).toContain('resume');
  });

  it('a recovered turn ends the chain after its own messages', async () => {
    const g = await splitReplayed(
      8,
      'T3',
      lookup({ T3: T({ replayFrom: 'T2', replayed: 4, recovered: true }), T2: T({ replayed: 0 }) })
    );
    expect(g.map((x) => [x.kind, x.turnId, x.from, x.to])).toEqual([
      ['earlier', undefined, 0, 4],
      ['turn', 'T3', 4, 8],
    ]);
  });

  it('missing events, a missing count or an impossible one are never guessed', async () => {
    expect((await splitReplayed(5, 'T9', lookup({}))).map((x) => x.kind)).toEqual(['earlier']);
    expect((await splitReplayed(5, 'T2', lookup({ T2: T({ replayFrom: 'T1' }) }))).map((x) => x.kind)).toEqual(['earlier']);
    expect((await splitReplayed(5, 'T2', lookup({ T2: T({ replayFrom: 'T1', replayed: 9 }) }))).map((x) => x.kind)).toEqual(['earlier']);
    expect(await splitReplayed(5, undefined, lookup({}))).toEqual([{ kind: 'earlier', from: 0, to: 5, why: expect.any(String) }]);
  });
});

describe('Context tab, a three-turn chain', () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`m${i}`) : assistant(`m${i}`)));
  // Eight replayed: 3 from turn 1, 5 from turn 2.
  const call3 = ctx([...msgs(8), user('third question'), sysMsg('hook')]);
  const evs = [
    ev({ seq: 1, session: 'ch', kind: 'session.registered', agent: 'claude', folder: '/work/ch' }),
    ev({ seq: 2, session: 'ch', kind: 'turn.started', turn: 'T1', text: 'one' }),
    ev({ seq: 3, session: 'ch', kind: 'model.requested', turn: 'T1', exchange: 'y1', model: 'm' }),
    ev({ seq: 4, session: 'ch', kind: 'model.responded', turn: 'T1', exchange: 'y1', status: 200, stop_reason: 'end_turn', text: 'a' }),
    ev({ seq: 5, session: 'ch', kind: 'turn.completed', turn: 'T1', outcome: 'finished' }),
    ev({ seq: 6, session: 'ch', kind: 'turn.started', turn: 'T2', text: 'two', continuity: 'replay', replay_from: 'T1' }),
    ev({ seq: 7, session: 'ch', kind: 'model.requested', turn: 'T2', exchange: 'y2', model: 'm', replayed: 3 }),
    ev({ seq: 8, session: 'ch', kind: 'model.responded', turn: 'T2', exchange: 'y2', status: 200, stop_reason: 'end_turn', text: 'b' }),
    ev({ seq: 9, session: 'ch', kind: 'turn.completed', turn: 'T2', outcome: 'finished' }),
    ev({ seq: 10, session: 'ch', kind: 'turn.started', turn: 'T3', text: 'three', continuity: 'replay', replay_from: 'T2' }),
    ev({ seq: 11, session: 'ch', kind: 'model.requested', turn: 'T3', exchange: 'y3', model: 'm', replayed: 8 }),
    ev({ seq: 12, session: 'ch', kind: 'model.responded', turn: 'T3', exchange: 'y3', status: 200, stop_reason: 'end_turn', text: 'c' }),
    ev({ seq: 13, session: 'ch', kind: 'turn.completed', turn: 'T3', outcome: 'finished' }),
  ];

  it('folds one group per earlier turn, oldest first, with counts', async () => {
    const { load } = loader({ y3: call3 });
    const base = new ReplayDataSource(jsonl(evs));
    const source: DataSource = {
      getAgents: () => base.getAgents(),
      getSessions: (a) => base.getSessions(a),
      getTurns: (id) => base.getTurns(id),
      getTurn: (s, t) => base.getTurn(s, t),
      getCallContext: load,
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const qa = (s: string) => Array.from(r.container.querySelectorAll(s));
    await openCall(r.container, 2, 0);
    await click(qa('#d-tabs .tab').find((t) => t.textContent === 'Context'));
    for (let i = 0; i < 5; i++) await flush();
    const body = r.container.querySelector('#d-body .ctx')!;
    const folds = Array.from(body.querySelectorAll(':scope > .ctx-fold.replayed'));
    expect(folds.map((f) => f.querySelector('.ctx-title')!.textContent)).toEqual(['Turn 1', 'Turn 2']);
    expect(folds.map((f) => f.querySelector('.ctx-meta')!.textContent)).toEqual([
      expect.stringContaining('3 messages'),
      expect.stringContaining('5 messages'),
    ]);
    expect(body.textContent).not.toContain('holds the turns before');
    r.unmount();
  });
});
