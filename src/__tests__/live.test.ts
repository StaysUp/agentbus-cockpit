import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClosed, LiveDataSource, turnError } from '../data/LiveDataSource';
import { CockpitEvent, SessionSummary } from '../types';
import { ev } from './helpers';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// An SSE body that sends the given events, then stays open until aborted.
function sse(events: CockpitEvent[], signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`id: st/${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`));
      }
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const summary = {
  id: 'abc',
  agent: 'claude',
  client: 'claude-cli/2.1.318',
  folder: '/w',
  started: '2026-11-05T09:00:00Z',
  last: '2026-11-05T09:10:00Z',
  open: true,
  turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};

afterEach(() => vi.unstubAllGlobals());

describe('LiveDataSource', () => {
  const sessionEvents = [
    ev({ seq: 3, session: 'abc', kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ev({ seq: 4, session: 'abc', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'hello' }),
    ev({ seq: 5, session: 'abc', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
    ev({ seq: 9, session: 'abc', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'hi' }),
    ev({ seq: 10, session: 'abc', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
  ];

  // One row of GET /api/v0/turns, in the framework's shape (store.Turn).
  const apiTurn = (id: string, started_seq: number, fields: Record<string, unknown> = {}) => ({
    id,
    session: 'abc',
    agent: 'claude',
    folder: '/w',
    prompt: `prompt ${id}`,
    started_seq,
    started: '2026-11-05T09:00:00Z',
    state: 'finished',
    usage: { input_tokens: 10, output_tokens: 5 },
    cost_usd: 0.1,
    cost_complete: true,
    ...fields,
  });

  it('getTurns pages by next_before until it is null, leaves out queued turns, and numbers the turns from the oldest', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url.pathname + url.search);
        const before = url.searchParams.get('before');
        // Newest first; the first page stops at two turns.
        if (!before) {
          return json({
            store: 'st_1',
            seq: 40,
            turns: [
              // The first page starts with the queued turns: the chat shows
              // a queued message as its own pending copy instead.
              apiTurn('Q4', 0, { state: 'queued', started: undefined, started_seq: undefined, number: 4, asked: '2026-11-05T09:01:00Z' }),
              apiTurn('T3', 30, { state: 'running', usage: null, cost_usd: 0, prompt: 'x'.repeat(500), prompt_truncated: true }),
              apiTurn('T2', 20, { ended: '2026-11-05T09:00:07Z', outcome: 'finished', cost_complete: false }),
            ],
            next_before: 20,
          });
        }
        if (before === '20') return json({ store: 'st_1', seq: 41, turns: [apiTurn('T1', 10, { state: 'failed', agent: '', folder: '' })], next_before: null });
        return json({ error: 'unexpected' }, 500);
      })
    );
    const list = await new LiveDataSource({ baseUrl: BASE }).getTurns('abc');
    expect(urls).toEqual(['/api/v0/turns?session=abc', '/api/v0/turns?session=abc&before=20']);
    // The cursor is the first page's.
    expect(list.store).toBe('st_1');
    expect(list.seq).toBe(40);
    expect(list.turns.map((t) => [t.id, t.turnNumber])).toEqual([['T1', 1], ['T2', 2], ['T3', 3]]);
    const [t1, t2, t3] = list.turns;
    expect(t1.state).toBe('failed');
    expect(t1.agent).toBeUndefined();
    expect(t2.durationMs).toBe(7000);
    expect(t2.costComplete).toBe(false);
    expect(t2.outcome).toBe('finished');
    expect(t3.state).toBe('running');
    expect(t3.durationMs).toBeUndefined();
    expect(t3.usage).toBeNull();
    expect(t3.promptTruncated).toBe(true);
    expect(t3.detail).toBeUndefined();
  });

  it('getTurns reads the list again when a page comes from another store, and fails on a second change', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        reads++;
        // Read 1 (page 1) is from st_old; read 2 (page 2) from st_new: start over.
        const store = reads === 1 ? 'st_old' : 'st_new';
        if (!url.searchParams.get('before')) return json({ store, seq: 5, turns: [apiTurn('T2', 2)], next_before: 2 });
        return json({ store, seq: 5, turns: [apiTurn('T1', 1)], next_before: null });
      })
    );
    const list = await new LiveDataSource({ baseUrl: BASE }).getTurns('abc');
    expect(reads).toBe(4);
    expect(list.store).toBe('st_new');
    expect(list.turns.map((t) => t.id)).toEqual(['T1', 'T2']);

    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        n++;
        if (!url.searchParams.get('before')) return json({ store: `st_${n}`, seq: 5, turns: [apiTurn('T2', 2)], next_before: 2 });
        return json({ store: `st_${n}`, seq: 5, turns: [apiTurn('T1', 1)], next_before: null });
      })
    );
    await expect(new LiveDataSource({ baseUrl: BASE }).getTurns('abc')).rejects.toThrow(/store/i);
  });

  it('getTurn pages one turn by next_after with the store, asks for its session, and pairs it', async () => {
    const urls: string[] = [];
    const turnEvents = [
      ...sessionEvents.slice(1, 3),
      // The same turn id in another session: the service leaves it out when
      // asked for session abc.
      ev({ seq: 6, session: 'zzz', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'not mine' }),
      ...sessionEvents.slice(3),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url.pathname + url.search);
        const session = url.pathname.split('/')[4];
        const mine = turnEvents.filter((e) => !session || e.session === session);
        const after = url.searchParams.get('after');
        if (!after) return json({ store: 'st_1', events: mine.slice(0, 2), next_after: 5 });
        if (after === '5') return json({ store: 'st_1', events: mine.slice(2), next_after: null });
        return json({ store: 'st_1', events: [], next_after: null });
      })
    );
    const d = (await new LiveDataSource({ baseUrl: BASE }).getTurn('abc', 'T1'))!;
    expect(urls[0]).toBe('/api/v0/sessions/abc/events?turn=T1&limit=1000');
    expect(urls[1]).toContain('/api/v0/sessions/abc/events?turn=T1');
    expect(urls[1]).toContain('store=st_1');
    expect(urls[1]).toContain('after=5');
    expect(d.events.map((e) => e.session)).toEqual(['abc', 'abc', 'abc', 'abc']);
    expect(d.prompt).toBe('hello');
    expect(d.agentResponse).toBe('hi');
    expect(d.modelCalls).toHaveLength(1);
    expect(d.modelCalls[0].responded?.text).toBe('hi');
  });

  it('getTurn keeps what the service sends: the session filter is the service\'s, not the client\'s', async () => {
    const other = ev({ seq: 6, session: 'zzz', kind: 'model.requested', turn: 'T1', exchange: 'x2' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ store: 'st_1', events: [...sessionEvents.slice(1), other], next_after: null }))
    );
    const d = (await new LiveDataSource({ baseUrl: BASE }).getTurn('abc', 'T1'))!;
    expect(d.events).toHaveLength(5);
  });

  it('getTurns reads each turn\'s reply, model and model calls from the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          store: 'st_1',
          seq: 9,
          turns: [
            apiTurn('T3', 30, { reply: 'é'.repeat(500), reply_truncated: true, model: 'claude-opus-5-5', model_calls: 7 }),
            apiTurn('T2', 20, { reply: '', model: '', model_calls: 0 }),
            // A service older than these fields sends none of them.
            apiTurn('T1', 10),
          ],
          next_before: null,
        })
      )
    );
    const [t1, t2, t3] = (await new LiveDataSource({ baseUrl: BASE }).getTurns('abc')).turns;
    expect([t3.reply?.length, t3.replyTruncated, t3.model, t3.modelCalls]).toEqual([500, true, 'claude-opus-5-5', 7]);
    expect([t2.reply, t2.replyTruncated, t2.model, t2.modelCalls]).toEqual([undefined, false, undefined, 0]);
    expect([t1.reply, t1.replyTruncated, t1.model, t1.modelCalls]).toEqual([undefined, false, undefined, undefined]);
  });

  it('getTurn starts over once on 409, and is null for a turn with no events', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        reads++;
        if (url.searchParams.get('turn') === 'none') return json({ store: 'st_2', events: [], next_after: null });
        if (reads === 1) return json({ store: 'st_1', events: sessionEvents.slice(1, 2), next_after: 4 });
        if (reads === 2) return json({ store: 'st_2' }, 409);
        return json({ store: 'st_2', events: sessionEvents.slice(1), next_after: null });
      })
    );
    const src = new LiveDataSource({ baseUrl: BASE });
    const d = (await src.getTurn('abc', 'T1'))!;
    expect(reads).toBe(3);
    expect(d.events).toHaveLength(4);
    expect(await src.getTurn('abc', 'none')).toBeNull();
  });

  it('#9 subscribe takes a snapshot, streams from its store and seq, and starts over on 409', async () => {
    const calls: string[] = [];
    let snapshots = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        calls.push(url.pathname + url.search);
        if (url.pathname === '/api/v0/sessions') {
          snapshots++;
          return snapshots === 1
            ? json({ store: 'st_old', seq: 41, sessions: [summary] })
            : json({ store: 'st_new', seq: 7, sessions: [summary] });
        }
        if (url.pathname === '/api/v0/events') {
          if (url.searchParams.get('store') === 'st_old') return json({ store: 'st_new' }, 409);
          return sse([ev({ seq: 8, session: 'abc', kind: 'turn.started', turn: 'T2', text: 'more' })], init?.signal);
        }
        return json({}, 404);
      })
    );

    const src = new LiveDataSource({ baseUrl: BASE });
    const got: CockpitEvent[] = [];
    const handed: SessionSummary[][] = [];
    const stop = src.subscribe!((e) => got.push(e), (sessions) => handed.push(sessions));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    stop();

    const streams = calls.filter((c) => c.startsWith('/api/v0/events'));
    expect(calls[0]).toBe('/api/v0/sessions');
    expect(streams[0]).toContain('store=st_old');
    expect(streams[0]).toContain('after=41');
    expect(streams[1]).toContain('store=st_new');
    expect(streams[1]).toContain('after=7');
    expect(handed).toHaveLength(2); // the first snapshot, and the one after the 409
    expect(got[0].seq).toBe(8);
  });

  it('R2#6 a failed fetch or a broken stream reconnects from the last store and seq, and stops on unsubscribe', async () => {
    const streams: string[] = [];
    let attempt = 0;
    const enc = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/v0/sessions') return json({ store: 'st_1', seq: 20, sessions: [summary] });
        streams.push(url.search);
        attempt++;
        if (attempt === 1) throw new TypeError('Failed to fetch'); // network down
        if (attempt === 2) {
          // One event, then the connection breaks mid-stream.
          const e = ev({ seq: 21, session: 'abc', kind: 'turn.started', turn: 'T9', text: 'x' });
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              setTimeout(() => c.error(new TypeError('network error')), 5);
            },
          });
          return new Response(body, { status: 200 });
        }
        return sse([ev({ seq: 22, session: 'abc', kind: 'model.requested', turn: 'T9' })], init?.signal);
      })
    );
    const src = new LiveDataSource({ baseUrl: BASE, retryBaseMs: 5, retryMaxMs: 20 });
    const got: CockpitEvent[] = [];
    const stop = src.subscribe((e) => got.push(e));
    await vi.waitFor(() => expect(got.map((e) => e.seq)).toEqual([21, 22]), { timeout: 2000 });
    expect(streams[0]).toContain('after=20');
    expect(streams[1]).toContain('after=20');
    expect(streams[2]).toContain('store=st_1');
    expect(streams[2]).toContain('after=21');
    stop();
    const count = streams.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(streams.length).toBe(count);
  });

  it('R4#2 subscribe hands over the sessions of the snapshot it streams from', async () => {
    let seq = 10;
    const streams: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/v0/sessions') {
          seq += 10; // every snapshot is newer than the last
          return json({ store: 'st_1', seq, sessions: [{ ...summary, turns: seq }] });
        }
        streams.push(url.search);
        return sse([], init?.signal);
      })
    );
    const src = new LiveDataSource({ baseUrl: BASE });
    await src.getSessions(); // the App's own earlier read, at seq 20
    const handed: SessionSummary[][] = [];
    const stop = src.subscribe(() => {}, (sessions) => handed.push(sessions));
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    stop();
    expect(handed).toHaveLength(1);
    const after = new URLSearchParams(streams[0]).get('after');
    expect(String(handed[0][0].turns)).toBe(after);
  });

  it('R4#1 getSessions("") returns only sessions with the empty agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ store: 'st_1', seq: 1, sessions: [summary, { ...summary, id: 'plain', agent: '' }] })
      )
    );
    const src = new LiveDataSource({ baseUrl: BASE });
    expect((await src.getSessions('')).map((s) => s.id)).toEqual(['plain']);
    expect((await src.getSessions()).map((s) => s.id)).toEqual(['abc', 'plain']);
  });

  it('reads a call context by its turn and exchange, with full as asked, and says the API\'s words on 404', async () => {
    const urls: string[] = [];
    const auth: (string | null)[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      urls.push(url);
      auth.push(new Headers(init?.headers).get('Authorization'));
      if (url.includes('/calls/gone?')) return json({ error: 'no request body is stored for this call' }, 404);
      return json({ exchange: 'x-1/7', size: 10, pieces: [{ kind: 'message', label: 'user', hash: 'h', size: 10 }] });
    });
    const src = new LiveDataSource({ baseUrl: BASE, token: 'tok' });
    const c = await src.getCallContext('T1', 'x-1/7', false);
    expect(c.pieces).toHaveLength(1);
    expect(urls[0]).toBe(`${BASE}/api/v0/turns/T1/calls/x-1%2F7?full=false`);
    expect(auth[0]).toBe('Bearer tok');
    await expect(src.getCallContext('T1', 'gone', true)).rejects.toThrow('404: no request body is stored for this call');
    expect(urls[1]).toBe(`${BASE}/api/v0/turns/T1/calls/gone?full=true`);
  });
  it('follows a queued message by its turn id: only a turn that ended without starting failed it', async () => {
    const urls: string[] = [];
    const rows: Record<string, Record<string, unknown>> = {
      q: { state: 'queued', ahead: 1 },
      gone: { state: 'stopped', stopped: true },
      refused: { state: 'failed', error: 'the session is closed' },
      ran: { state: 'stopped', stopped: true, started_seq: 12 },
      done: { state: 'finished', started_seq: 13 },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const id = new URL(url).pathname.split('/').pop()!;
      return json({ store: 'st', seq: 1, turn: { id, session: 's1', agent: '', folder: '', prompt: 'p', state: 'queued', ...rows[id] } });
    });
    const src = new LiveDataSource({ baseUrl: BASE });
    expect(await src.queuedTurn('s1', 'q')).toEqual({ ended: false, failed: false, why: undefined });
    expect(urls[0]).toBe(`${BASE}/api/v0/turns/q?session=s1`);
    expect(await src.queuedTurn('s1', 'gone')).toEqual({ ended: true, failed: true, why: 'stopped before it started' });
    expect(await src.queuedTurn('s1', 'refused')).toEqual({ ended: true, failed: true, why: 'the session is closed' });
    expect(await src.queuedTurn('s1', 'ran')).toEqual({ ended: true, failed: false, why: undefined });
    expect(await src.queuedTurn('s1', 'done')).toEqual({ ended: true, failed: false, why: undefined });
  });
});

describe('closed and error fields, read before and after the service gives them', () => {
  it('turnError takes a string or an object with a message, and nothing else', () => {
    expect(turnError('the relay refused')).toBe('the relay refused');
    expect(turnError({ message: 'quota reached', code: 429 })).toBe('quota reached');
    expect(turnError(undefined)).toBeUndefined();
    expect(turnError('   ')).toBeUndefined();
    expect(turnError(42)).toBeUndefined();
    expect(turnError(null)).toBeUndefined();
  });

  it('isClosed takes true or a time', () => {
    expect(isClosed(true)).toBe(true);
    expect(isClosed('2026-11-11T09:00:00Z')).toBe(true);
    expect(isClosed(false)).toBe(false);
    expect(isClosed('')).toBe(false);
    expect(isClosed(undefined)).toBe(false);
  });
});
