// @vitest-environment jsdom
// What a waiting turn says, and for how long. A message queued behind nothing
// names the runner only after a few seconds, timed on a steady clock that the
// events' clock offset never moves. A turn whose reply is in but that waits on
// a long tool call says what it waits on, in full, with its time. A stream
// that drops says so in words, and the view is read again when it is back.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ColumnFoot } from '../components/ColumnFoot';
import { ConvoColumn, RUNNER_WAIT_MS } from '../components/ConvoColumn';
import { noteEventTime, resetClock } from '../data/liveStatus';
import { createEmptyUsage } from '../data/turns';
import { CockpitEvent, DataSource, SessionDetail, Turn } from '../types';
import { ev, flush, liveReplay, render } from './helpers';

function turn(fields: Partial<Turn> = {}): Turn {
  return {
    id: 'T1',
    turnNumber: 1,
    sessionId: 'p',
    startedAt: '2026-11-25T01:00:00Z',
    prompt: 'run the long test',
    agent: 'claude',
    agentId: 'claude',
    state: 'finished',
    usage: null,
    costUsd: null,
    costComplete: true,
    ...fields,
  } as Turn;
}

function session(turns: Turn[]): SessionDetail {
  return { id: 'p', title: 'p', agent: 'claude', turns: turns.length, turnsList: turns, usage: createEmptyUsage() } as unknown as SessionDetail;
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetClock();
});

describe('a message queued behind nothing', () => {
  it('waits on a steady clock: the events clock learning an offset does not move it', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn(async () => ({ session: 'p', turn: 't_q', state: 'queued' as const }));
    const r = await render(
      <ConvoColumn session={session([turn()])} resumable selectedTurn={null} onSelectTurn={() => {}} onSend={onSend} />
    );
    await type(r.container.querySelector('#input') as HTMLTextAreaElement, 'go');
    await act(async () => {
      r.container.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const state = () => r.container.querySelector('.tb.pending .tb-state')?.textContent;
    expect(state()).toBe('waiting for the agent');
    // The stream sets the service's clock offset: an hour off this machine's.
    noteEventTime(new Date(Date.now() + 3600_000).toISOString());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(state()).toBe('waiting for the agent');
    noteEventTime(new Date(Date.now() - 7200_000).toISOString());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(state()).toBe('waiting for the agent');
    // Still queued RUNNER_WAIT_MS on, by the local clock: it names the runner.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNER_WAIT_MS - 1500);
    });
    expect(state()).toBe('queued · waiting for a runner');
    r.unmount();
  });
});

describe('a turn whose reply is in, waiting on one long tool call', () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 10, 25, 1, 0, sec)).toISOString();
  const e = (kind: string, sec: number, f: Partial<CockpitEvent> = {}) =>
    ({ id: `${kind}-${sec}`, kind, time: at(sec), session: 'p', turn: 'T1', ...f }) as CockpitEvent;
  const events = [
    e('run.started', 0, { agent: 'claude' }),
    e('turn.started', 0, { agent: 'claude', folder: '/w', text: 'run the long test' }),
    e('model.requested', 1, { exchange: 'x1' }),
    e('model.responded', 2, { exchange: 'x1', status: 200 }),
    e('tool.requested', 3, {
      exchange: 'x1',
      tool_id: 'b',
      tool_name: 'Bash',
      tool_input: { command: 'cd /w && npx vitest run --no-file-parallelism', run_in_background: true },
    }),
    e('tool.completed', 3, { tool_id: 'b', tool_output: 'Command running in background with ID: b1' }),
    e('model.requested', 4, { exchange: 'x2' }),
    e('model.responded', 5, { exchange: 'x2', status: 200, text: 'Started the tests.' }),
    e('turn.completed', 6, { exchange: 'x2' }),
  ];

  it('says what it waits on, in full, and for how long, not a bare "finishing"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(6)) + 12 * 60_000);
    const running = turn({ state: 'running', reply: 'Started the tests.' } as Partial<Turn>);
    const r = await render(
      <ConvoColumn session={session([running])} selectedTurn={null} onSelectTurn={() => {}} live={{ turn: 'T1', events }} />
    );
    const foot = r.container.querySelector('.tb .tb-foot')!;
    const line = foot.querySelector('.tb-live .live-text');
    expect(line?.textContent).toBe('waiting on a background command · npx vitest run --no-file-parallelism · 12m 0s');
    expect(foot.querySelector('.tb-live')!.getAttribute('data-state')).toBe('finishing');
    expect(foot.textContent).not.toMatch(/^finishing/);
    // The reply stays where it is.
    expect(r.container.querySelector('.m-agent')?.textContent).toContain('Started the tests.');
    r.unmount();
  });
});

describe('a stream that drops', () => {
  it('the AgentBus card says so in words while it reconnects', async () => {
    const up = await render(<ColumnFoot current="cockpit" streamUp sourceLabel="http://127.0.0.1:8787" />);
    expect(up.container.querySelector('.bc-addr')!.textContent).toBe('http://127.0.0.1:8787');
    expect(up.container.querySelector('.bc-down')).toBeNull();
    up.unmount();
    const down = await render(<ColumnFoot current="cockpit" streamUp={false} sourceLabel="http://127.0.0.1:8787" />);
    const note = down.container.querySelector('.bc-down[role="status"]')!;
    expect(note.textContent).toBe('Disconnected · reconnecting…');
    expect(note.getAttribute('title')).toBe('http://127.0.0.1:8787');
    down.unmount();
  });

  it('back after a drop, the list and the shown session are read again', async () => {
    const lr = liveReplay([
      ev({ session: 's1', kind: 'turn.started', turn: 'T1', text: 'hi', agent: 'claude' }),
      ev({ session: 's1', kind: 'turn.completed', turn: 'T1' }),
    ]);
    let setUp: ((up: boolean) => void) | undefined;
    let lists = 0;
    let turnReads = 0;
    const source: DataSource = {
      ...lr.source,
      getSessions: () => {
        lists++;
        return lr.source.getSessions();
      },
      getTurns: (id) => {
        turnReads++;
        return lr.source.getTurns(id);
      },
      subscribe: (cb, onSnapshot, onState) => {
        setUp = onState;
        const stop = lr.source.subscribe!(cb, onSnapshot);
        onState?.(true);
        return stop;
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const listsBefore = lists;
    const turnsBefore = turnReads;
    await act(async () => setUp!(false));
    await flush();
    expect(r.container.querySelector('.bc-down')?.textContent).toBe('Disconnected · reconnecting…');
    expect(lists).toBe(listsBefore);
    await act(async () => setUp!(true));
    await flush();
    await flush();
    expect(r.container.querySelector('.bc-down')).toBeNull();
    expect(lists).toBeGreaterThan(listsBefore);
    expect(turnReads).toBeGreaterThan(turnsBefore);
    r.unmount();
  });
});
