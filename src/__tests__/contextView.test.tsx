// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ContextView, partLabel } from '../components/ContextView';
import { SessionContext, TurnContext } from '../types';
import { render, flush, unmountAll } from './helpers';

const turnCtx: TurnContext = {
  store: 'st',
  seq: 10,
  turn: 'T2',
  session: 's1',
  model: 'claude-opus-5-5',
  window: {
    model: 'claude-opus-5-5',
    harness: 'claude',
    window_tokens: 200000,
    window_known: true,
    used_tokens: 50000,
    percent_full: 25,
    compaction_point: 0.8,
    compaction_pct: 80,
    compaction_source: 'default',
    compaction_is_default: true,
  },
  calls: 2,
  context_tokens: 250,
  cache_read_tokens: 200,
  fresh_tokens: 50,
  output_tokens: 15,
  made_of: {
    exchange: 'x2',
    vendor: 'anthropic',
    bytes: 1000,
    approx_tokens: 376,
    parts: [
      { kind: 'message', label: 'user', approx_tokens: 200, bytes: 532, count: 1 },
      { kind: 'tool', approx_tokens: 100, bytes: 266, count: 2 },
      { kind: 'system', approx_tokens: 76, bytes: 202, count: 1 },
    ],
    note: 'A user message holds your text and the tool results.',
  },
};

const sessionCtx: SessionContext = {
  store: 'st',
  seq: 10,
  session: 's1',
  turns: 2,
  peak_context_tokens: 250,
  cache_read_tokens: 300,
  fresh_tokens: 200,
  output_tokens: 23,
  growth: [
    { turn: 'T2', started: '2026-11-18T09:01:00Z', calls: 2, context_tokens: 250, cache_read_tokens: 200, fresh_tokens: 50, output_tokens: 15 },
    { turn: 'T1', started: '2026-11-18T09:00:00Z', calls: 2, context_tokens: 150, cache_read_tokens: 100, fresh_tokens: 150, output_tokens: 8 },
  ],
  next_before: null,
};

describe('partLabel', () => {
  it('names each piece kind in plain words', () => {
    expect(partLabel({ kind: 'system', approx_tokens: 1, bytes: 1, count: 1 })).toBe('System prompt');
    expect(partLabel({ kind: 'instructions', approx_tokens: 1, bytes: 1, count: 1 })).toBe('System prompt');
    expect(partLabel({ kind: 'tool', approx_tokens: 1, bytes: 1, count: 3 })).toBe('Tool definitions (3)');
    expect(partLabel({ kind: 'message', label: 'user', approx_tokens: 1, bytes: 1, count: 1 })).toBe('Your messages & tool results');
    expect(partLabel({ kind: 'message', label: 'assistant', approx_tokens: 1, bytes: 1, count: 1 })).toBe('Model replies');
    expect(partLabel({ kind: 'input_item', label: 'reasoning', approx_tokens: 1, bytes: 1, count: 1 })).toBe('Conversation · reasoning');
  });
});

describe('ContextView', () => {
  it('shows the turn size, the cache split, the parts and the session growth', async () => {
    const r = await render(
      <ContextView session="s1" turn="T2" loadTurn={async () => turnCtx} loadSession={async () => sessionCtx} />
    );
    await flush();
    const text = r.container.textContent ?? '';
    // The headline is how full the context is against the window, and where it
    // compacts — the practical number, not the raw tokens.
    expect(text).toContain('25%');
    expect(text).toMatch(/compacts ~80%/);
    // The cache split is shown as one supporting fact: its share, no bar.
    expect(text).toMatch(/Cache/);
    expect(text).toContain('80%');
    // The made_of parts, largest first, in plain names, in the shared grid.
    expect(text).toContain('Your messages & tool results');
    expect(text).toContain('Tool definitions (2)');
    expect(text).toContain('System prompt');
    // The growth chart: one bar per turn, the current one marked.
    const cols = r.container.querySelectorAll('.ctx-bar');
    expect(cols.length).toBe(2);
    expect(r.container.querySelectorAll('.ctx-bar.here').length).toBe(1);
    r.unmount();
  });

  it('says plainly when the turn made no model call', async () => {
    const empty: TurnContext = { ...turnCtx, calls: 0, context_tokens: 0, made_of: null };
    const r = await render(
      <ContextView session="s1" turn="T2" loadTurn={async () => empty} loadSession={async () => sessionCtx} />
    );
    await flush();
    expect(r.container.textContent).toMatch(/no model call/i);
    r.unmount();
  });

  it('falls back to raw tokens when the turn has no window', async () => {
    const noWindow: TurnContext = { ...turnCtx, window: null };
    const r = await render(
      <ContextView session="s1" turn="T2" loadTurn={async () => noWindow} loadSession={async () => sessionCtx} />
    );
    await flush();
    const text = r.container.textContent ?? '';
    // No meter: the raw context size stands in.
    expect(text).toContain('250');
    expect(r.container.querySelector('.ctx-meter')).toBeNull();
    r.unmount();
  });

  it('follows the session pages so the growth chart is whole', async () => {
    const page1: SessionContext = { ...sessionCtx, growth: [sessionCtx.growth[0]], next_before: 5 };
    const page2: SessionContext = { ...sessionCtx, growth: [sessionCtx.growth[1]], next_before: null };
    const calls: (number | undefined)[] = [];
    const loadSession = async (_s: string, before?: number) => {
      calls.push(before);
      return before === 5 ? page2 : page1;
    };
    const r = await render(<ContextView session="s1" turn="T2" loadTurn={async () => turnCtx} loadSession={loadSession} />);
    await flush();
    // Both pages were fetched (undefined, then the cursor), and both turns drawn.
    expect(calls).toEqual([undefined, 5]);
    expect(r.container.querySelectorAll('.ctx-bar').length).toBe(2);
    r.unmount();
  });

  // It reads once on open and does not read again on its own.
  it('reads once on open', async () => {
    let n = 0;
    const loadTurn = async () => {
      n += 1;
      return turnCtx;
    };
    const r = await render(
      <ContextView session="s1" turn="T2" loadTurn={loadTurn} loadSession={async () => sessionCtx} rev={0} />
    );
    await flush();
    expect(n).toBe(1);
    // No Refresh control and no re-read while it simply stays open.
    expect(r.container.textContent).not.toMatch(/Refresh/);
    r.unmount();
  });

  // A rev bump (the turn's data changed: its end, among others) re-reads, so a
  // settled turn is current without a Refresh.
  it('re-reads when the turn data changes (rev bumps)', async () => {
    let n = 0;
    const loadTurn = async () => {
      n += 1;
      return turnCtx;
    };
    const loadSession = async () => sessionCtx;
    const el = (rev: number) => (
      <ContextView session="s1" turn="T2" loadTurn={loadTurn} loadSession={loadSession} rev={rev} />
    );
    const r = await render(el(0));
    await flush();
    expect(n).toBe(1);
    const { act } = await import('react');
    await act(async () => {
      r.root.render(el(1));
    });
    await flush();
    expect(n).toBe(2);
    r.unmount();
  });

  // A slow earlier read must not overwrite a newer one (the StrictMode race):
  // each read guards its writes with its own `live` flag.
  it('a superseded read does not overwrite a newer result', async () => {
    const { act } = await import('react');
    const resolvers: Array<(t: TurnContext) => void> = [];
    const loadTurn = () => new Promise<TurnContext>((res) => resolvers.push(res));
    const loadSession = async () => sessionCtx;
    const el = (rev: number) => (
      <ContextView key="x" session="s1" turn="T2" loadTurn={loadTurn} loadSession={loadSession} rev={rev} />
    );
    const r = await render(el(0)); // read #1 in flight
    // The turn's data changes -> a second read starts; read #1 is superseded.
    await act(async () => {
      r.root.render(el(1));
    });
    // Resolve the NEWER read first (33% full), then the OLDER one (11%).
    await act(async () => {
      resolvers[1]?.({ ...turnCtx, window: { ...turnCtx.window!, percent_full: 33 } });
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]?.({ ...turnCtx, window: { ...turnCtx.window!, percent_full: 11 } });
      await Promise.resolve();
    });
    await flush();
    // The newer result stands; the stale 11% was discarded.
    expect(r.container.textContent).toContain('33%');
    expect(r.container.textContent).not.toContain('11%');
    r.unmount();
  });

  // The 429 cost case is moot: the view shows no cost at all (it owns tokens).
  it('shows no cost (cost lives on the turn, not here)', async () => {
    const r = await render(
      <ContextView session="s1" turn="T2" loadTurn={async () => turnCtx} loadSession={async () => sessionCtx} />
    );
    await flush();
    expect(r.container.textContent).not.toMatch(/\$|cost/i);
    r.unmount();
  });

  // React StrictMode mounts twice (setup, cleanup, setup). The view must
  // re-arm its mounted flag in setup, or it strands on Loading forever.
  it('renders under StrictMode, not stuck on Loading', async () => {
    const { StrictMode } = await import('react');
    const r = await render(
      <StrictMode>
        <ContextView session="s1" turn="T2" loadTurn={async () => turnCtx} loadSession={async () => sessionCtx} />
      </StrictMode>
    );
    await flush();
    expect(r.container.textContent).toContain('25%');
    expect(r.container.textContent).not.toMatch(/^Loading/);
    r.unmount();
  });

  it('shows the API error wording', async () => {
    const r = await render(
      <ContextView
        session="s1"
        turn="T2"
        loadTurn={async () => {
          throw new Error('the roof fell in');
        }}
        loadSession={async () => sessionCtx}
      />
    );
    await flush();
    expect(r.container.textContent).toContain('the roof fell in');
    r.unmount();
  });
});

unmountAll();
