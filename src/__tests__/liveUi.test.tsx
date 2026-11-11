// @vitest-environment jsdom
// The live status on screen, driven by the real claude turn A recording of
// 2026-11-07 (testdata/live-turns-2026-11-07.jsonl), streamed event by event:
// the session card, the one line in the chat, the panel strip and the Tools tab.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import raw from '../../testdata/live-turns-2026-11-07.jsonl?raw';
import { App, TURN_END_POLL_MS } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { CockpitEvent, DataSource } from '../types';
import { click, flush, jsonl, liveReplay, render } from './helpers';

const TURN = 't_b230d16a85658ec2';
const events: CockpitEvent[] = raw
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((e: CockpitEvent) => e.turn === TURN);
// Up to and with the Edit and Bash asked for by call 2 (11.25 s in).
const cut = events.findIndex((e) => e.kind === 'tool.requested' && e.tool_name === 'Bash') + 1;

const q = (r: { container: HTMLElement }, sel: string) => r.container.querySelector(sel);
const text = (r: { container: HTMLElement }, sel: string) => q(r, sel)?.textContent ?? null;

// The cockpit's clock, set to the recording's: only Date is faked, timers stay real.
const at = (e: CockpitEvent, plusMs = 0) => vi.setSystemTime(Date.parse(e.time) + plusMs);
afterEach(() => {
  vi.useRealTimers();
});

describe('live status on screen', () => {
  it('follows a claude turn from its tools to its reply, in one line that never grows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(events[cut - 1], 1500);
    const { source, push } = liveReplay(events.slice(0, cut));
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await flush();

    // The session card: the live line in place of cost and time, the cost on the title line.
    expect(text(r, '#sessions .sess .s-live')).toBe('2 tools running · 1s');
    expect(text(r, '#sessions .sess .s-cost')).toBe('$0.27');
    // The chat: the prompt, then one line where the reply will be. The words
    // the agent put beside its tools are not shown.
    expect(r.container.querySelectorAll('#convo .tb .m-live')).toHaveLength(1);
    expect(text(r, '#convo .tb .m-live')).toBe('2 tools running · 1s');
    expect(q(r, '#convo .tb .m-agent')).toBeNull();
    expect(q(r, '#convo .tb .tb-state')).toBeNull();

    // The panel: the cost with the last call's delta, and a card per tool.
    await click(q(r, '#convo .tb'));
    expect(text(r, '#d-head .cost-live')).toBe('$0.27+$0.04');
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'Tools'));
    const cards = () =>
      Array.from(r.container.querySelectorAll('#d-body .tcard')).map((c) => [
        c.querySelector('.k')!.textContent,
        c.querySelector('.t')!.textContent,
        c.querySelector('.d')!.textContent,
      ]);
    expect(cards()).toEqual([
      ['Read', 'hello.py', 'ok · 0s'],
      ['Edit', 'hello.py', ''],
      ['Run', 'python3 hello.py && sleep 3 && ls', ''],
    ]);
    expect(r.container.querySelectorAll('#d-body .tcard.running')).toHaveLength(2);
    expect(Array.from(r.container.querySelectorAll('#d-body .tcard .tdiff div')).map((d) => d.textContent)).toEqual([
      '- "hello " + name',
      '+ "hi " + name',
    ]);
    expect(text(r, '#d-body .tgroup-t')).toBe('2 tools from call 2 · 1s · they finish together');

    // Both results come back with call 3: the line moves on, the cards end together.
    const rest = events.slice(cut);
    const pushUntil = async (pred: (e: CockpitEvent) => boolean) => {
      while (rest.length && !pred(rest[0])) {
        at(rest[0]);
        await act(async () => push(rest.shift()!));
      }
      at(rest[0], 2000);
      await act(async () => push(rest.shift()!));
      await flush();
    };
    await pushUntil((e) => e.kind === 'model.requested');
    expect(text(r, '#convo .tb .m-live')).toBe('Waiting on the model · call 3 · 2s');
    expect(cards().map((c) => c[2])).toEqual(['ok · 0s', 'ok', 'ok']);
    expect(text(r, '#d-body .tgroup-t')).toBe('2 tools from call 2 · 3s');

    // The last reply: it replaces the line.
    await pushUntil((e) => e.kind === 'turn.completed');
    expect(q(r, '#convo .tb .m-live')).toBeNull();
    expect(text(r, '#convo .tb .m-agent')).toContain('hi world');
    expect(text(r, '#d-head .cost-live')).toBe('$0.28+$0.01');

    // The agent exits: the card is back to cost and time, nothing ticks.
    await pushUntil((e) => e.kind === 'session.closed');
    await flush();
    expect(q(r, '#sessions .sess .s-live')).toBeNull();
    expect(text(r, '#sessions .sess .s-m')).toMatch(/^\$0\.28 · /);
    expect(q(r, '#d-head .cost-live .plus')).toBeNull();
    r.unmount();
  });

  // The service holds a turn at running until its job has ended, a moment
  // after session.closed, and no event says so. The cockpit reads the turn
  // until the service says it ended, then shows it finished.
  it('a turn whose reply is in reads finished once its job has ended, with no event after session.closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let jobEnded = false;
    const reads: string[] = [];
    const extra: Partial<DataSource> = {
      getTurns: async (id) => {
        const list = await live.replay().getTurns(id);
        return jobEnded ? list : { ...list, turns: list.turns.map((t) => ({ ...t, state: 'running', endedAt: undefined })) };
      },
      queuedTurn: async (_session, turn) => {
        reads.push(turn);
        return { ended: jobEnded, failed: false };
      },
    };
    const live = liveReplay(events.slice(0, cut), extra);
    const r = await render(<App dataSource={live.source} />);
    await flush();
    for (const e of events.slice(cut)) await act(async () => live.push(e));
    await flush();
    await flush();
    expect(text(r, '#convo .tb .tb-state')).toBe('finishing');

    // While the job runs, the turn is read alone and stays finishing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TURN_END_POLL_MS + 100);
    });
    expect(reads).toContain(TURN);
    expect(text(r, '#convo .tb .tb-state')).toBe('finishing');

    // The job ends: the next read sees it, and the list read after it shows finished.
    jobEnded = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TURN_END_POLL_MS + 100);
    });
    await flush();
    expect(q(r, '#convo .tb .tb-state')).toBeNull();
    expect(text(r, '#convo .tb .m-agent')).toContain('hi world');

    // Nothing runs now: the reads stop.
    const n = reads.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * TURN_END_POLL_MS);
    });
    expect(reads).toHaveLength(n);
    r.unmount();
  });

  it('recorded data has no live status: a turn without its end shows as it is', async () => {
    const r = await render(<App dataSource={new ReplayDataSource(jsonl(events.slice(0, cut)))} />);
    await flush();
    await flush();
    expect(q(r, '#convo .m-live')).toBeNull();
    expect(q(r, '#sessions .s-live')).toBeNull();
    expect(text(r, '#convo .tb .tb-state')).toBe('running');
    r.unmount();
  });
});
