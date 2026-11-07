// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ConvoColumn } from '../components/ConvoColumn';
import { RightPanel } from '../components/RightPanel';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { replyPreview, turnDetail } from '../data/turns';
import { SessionDetail, Turn } from '../types';
import { click, ev, jsonl, render, useSelection, openSession } from './helpers';

async function sessionFrom(events: ReturnType<typeof ev>[], id: string) {
  const src = new ReplayDataSource(jsonl(events));
  return (await openSession(src, id))!;
}

function toolSession() {
  return [
    ev({ kind: 'turn.started', session: 'c1', exchange: 'x1', text: 'run two tools' }),
    ev({ kind: 'model.requested', session: 'c1', exchange: 'x1', model: 'm' }),
    ev({ kind: 'model.responded', session: 'c1', exchange: 'x1', status: 200, stop_reason: 'tool_use' }),
    ev({ kind: 'tool.requested', session: 'c1', exchange: 'x1', tool_id: 'tA', tool_name: 'Alpha', tool_input: { command: 'a' } }),
    ev({ kind: 'tool.requested', session: 'c1', exchange: 'x1', tool_id: 'tB', tool_name: 'Beta', tool_input: { command: 'b' } }),
    ev({ kind: 'tool.requested', session: 'c1', exchange: 'x1', tool_id: 'tC', tool_name: 'Gamma', tool_input: { command: 'c' } }),
    // B finishes first and is fine; A fails afterwards; C never returns.
    ev({ kind: 'tool.completed', session: 'c1', exchange: 'x2', tool_id: 'tB', tool_output: 'ok' }),
    ev({ kind: 'tool.completed', session: 'c1', exchange: 'x2', tool_id: 'tA', tool_error: true, tool_output: 'no' }),
  ];
}

describe('RightPanel', () => {
  it('#1 opening a row in Model calls or Tool calls keeps the current tab', async () => {
    const session = await sessionFrom(toolSession(), 'c1');
    const turn = session.turnsList[0];

    // The parent keeps selectedEventId, as App does.
    const Harness = () => {
      const [sel, setSel] = useSelection(null);
      return <RightPanel turn={turn} totalTurns={1} selection={sel} onSelectEvent={setSel} />;
    };
    const r = await render(<Harness />);
    const tab = (label: string) =>
      Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((b) => b.textContent!.startsWith(label))!;

    await click(tab('Model calls'));
    await click(r.container.querySelector('#d-body tr.ev'));
    expect(tab('Model calls').className).toContain('on');

    await click(tab('Tool calls'));
    await click(r.container.querySelector('#d-body tr.ev'));
    expect(tab('Tool calls').className).toContain('on');
    r.unmount();
  });
});

describe('RightPanel collapse', () => {
  it('R2#4 a collapsed default row stays collapsed until something new is selected', async () => {
    const session = await sessionFrom(toolSession(), 'c1');
    const turn = session.turnsList[0];
    let rerender: (() => void) | null = null;
    const Harness = () => {
      const [sel, setSel] = useSelection(null);
      const [t, setT] = useState(turn);
      rerender = () => setT({ ...turn }); // the same turn, rebuilt (as a live event does)
      return <RightPanel turn={t} totalTurns={1} selection={sel} onSelectEvent={setSel} />;
    };
    const r = await render(<Harness />);
    const open = () => r.container.querySelectorAll('#d-body tr.ev-open').length;
    expect(open()).toBe(1);
    await click(r.container.querySelector('#d-body tr.ev.sel'));
    expect(open()).toBe(0);
    await act(async () => rerender!());
    expect(open()).toBe(0);
    r.unmount();
  });
});

describe('RightPanel ledger rows', () => {
  async function openedThrough(tabLabel: string, pick: (t: Awaited<ReturnType<typeof sessionFrom>>['turnsList'][0]) => string) {
    const session = await sessionFrom(toolSession(), 'c1');
    const turn = session.turnsList[0];
    const Harness = () => {
      const [sel, setSel] = useSelection(pick(turn));
      return <RightPanel turn={turn} totalTurns={1} selection={sel} onSelectEvent={setSel} />;
    };
    const r = await render(<Harness />);
    const tab = Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((b) => b.textContent!.startsWith(tabLabel));
    await click(tab);
    return r;
  }

  it('R3#3 a model row opened through its reply collapses on one click', async () => {
    const r = await openedThrough('Model calls', (t) => t.detail!.modelCalls[0].responded!.id);
    expect(r.container.querySelectorAll('#d-body tr.ev-open')).toHaveLength(1);
    await click(r.container.querySelector('#d-body tr.ev.sel'));
    expect(r.container.querySelectorAll('#d-body tr.ev-open')).toHaveLength(0);
    r.unmount();
  });

  it('R3#3 a tool row opened through its result collapses on one click', async () => {
    const r = await openedThrough('Tool calls', (t) => t.detail!.toolCalls[0].completed!.id);
    expect(r.container.querySelectorAll('#d-body tr.ev-open')).toHaveLength(1);
    await click(r.container.querySelector('#d-body tr.ev.sel'));
    expect(r.container.querySelectorAll('#d-body tr.ev-open')).toHaveLength(0);
    r.unmount();
  });
});

describe('ConvoColumn', () => {
  it('R3#2 the first Hide details click hides the details', async () => {
    const session = await sessionFrom(toolSession(), 'c1');
    const r = await render(<ConvoColumn session={session} selectedTurn={null} onSelectTurn={() => {}} />);
    expect(r.container.querySelectorAll('.wlines')).toHaveLength(1);
    await click(r.container.querySelector('.work-h'));
    expect(r.container.querySelectorAll('.wlines')).toHaveLength(0);
    expect(r.container.querySelector('.work-h')!.textContent).toContain('Show details');
    await click(r.container.querySelector('.work-h'));
    expect(r.container.querySelectorAll('.wlines')).toHaveLength(1);
    r.unmount();
  });

  it('#2 matches tool results by tool_id and shows error, ok or pending', async () => {
    const session = await sessionFrom(toolSession(), 'c1');
    const r = await render(
      <ConvoColumn session={session} selectedTurn={session.turnsList[0]} onSelectTurn={() => {}} />
    );
    const status = (name: string) => {
      const row = Array.from(r.container.querySelectorAll('.wl.tool')).find(
        (b) => b.querySelector('.wk')!.textContent === name
      );
      return row!.querySelector('.wd')!.textContent;
    };
    expect(status('Alpha')).toBe('error');
    expect(status('Beta')).toBe('ok');
    expect(status('Gamma')).toBe('pending');
    r.unmount();
  });

  it('shows the turn list states: running, finished by its outcome, failed', async () => {
    const events = [
      // A turn with no turn.completed and no run: running, whatever its reply.
      ev({ kind: 'turn.started', session: 'st', turn: 'R', exchange: 'xr', text: 'one' }),
      ev({ kind: 'model.requested', session: 'st', turn: 'R', exchange: 'xr' }),
      ev({ kind: 'model.responded', session: 'st', turn: 'R', exchange: 'xr', status: 200, stop_reason: 'tool_use' }),
      // A run whose agent exited 1: failed.
      ev({ kind: 'session.opened', session: 'st', turn: 'F', hold: 'h1' }),
      ev({ kind: 'turn.started', session: 'st', turn: 'F', exchange: 'xf', text: 'two' }),
      ev({ kind: 'session.closed', session: 'st', turn: 'F', hold: 'h1', exit_code: 1 }),
      // A run whose agent exited 0: finished, shown by its outcome.
      ev({ kind: 'session.opened', session: 'st', turn: 'D', hold: 'h2' }),
      ev({ kind: 'turn.started', session: 'st', turn: 'D', exchange: 'xd', text: 'three' }),
      ev({ kind: 'turn.completed', session: 'st', turn: 'D', exchange: 'xd', outcome: 'max_tokens' }),
      ev({ kind: 'session.closed', session: 'st', turn: 'D', hold: 'h2', exit_code: 0 }),
    ];
    const s = await sessionFrom(events, 'st');
    expect(s.turnsList.map((t) => t.state)).toEqual(['running', 'failed', 'finished']);

    const r = await render(<ConvoColumn session={s} selectedTurn={null} onSelectTurn={() => {}} />);
    // A finished turn shows no state in the conversation; the others do.
    const shown = Array.from(r.container.querySelectorAll('.tb-state')).map((x) => x.textContent);
    expect(shown).toEqual(['running', 'failed']);
    expect(r.container.querySelector('.tb-state.bad')!.textContent).toBe('failed');
    r.unmount();
  });
});

describe('ConvoColumn turns not yet opened', () => {
  const row = (n: number, fields: Partial<Turn>): Turn => ({
    id: `T${n}`,
    turnNumber: n,
    sessionId: 'lst',
    startedAt: '2026-11-06T09:00:00Z',
    prompt: `prompt ${n}`,
    state: 'finished',
    usage: null,
    costUsd: null,
    costComplete: true,
    ...fields,
  });
  const session = (turnsList: Turn[]): SessionDetail => ({
    id: 'lst',
    agent: 'claude',
    client: '',
    title: 'lst',
    started: '2026-11-06T09:00:00Z',
    last: '2026-11-06T09:10:00Z',
    open: false,
    turns: turnsList.length,
    usage: { input_tokens: 0, output_tokens: 0 },
    turnsList,
  });

  it('shows the list row\'s reply, model and call count; an opened turn shows its own events', async () => {
    const opened = turnDetail([
      ev({ kind: 'turn.started', session: 'lst', turn: 'T3', exchange: 'o1', text: 'prompt 3' }),
      ev({ kind: 'model.requested', session: 'lst', turn: 'T3', exchange: 'o1', model: 'm-detail' }),
      ev({ kind: 'model.responded', session: 'lst', turn: 'T3', exchange: 'o1', status: 200, text: 'The whole answer.' }),
    ]);
    const s = session([
      row(1, { reply: 'First part.\n\nSecond part', replyTruncated: true, model: 'claude-opus-5-5', modelCalls: 7 }),
      row(2, { modelCalls: 0 }),
      // Opened: its detail wins over what the list said.
      row(3, { reply: 'stale preview', model: 'm-list', modelCalls: 9, detail: opened }),
      // A service older than these fields: the prompt only, as before.
      row(4, {}),
    ]);
    const r = await render(<ConvoColumn session={s} selectedTurn={null} onSelectTurn={() => {}} />);
    const blocks = Array.from(r.container.querySelectorAll('#convo .tb'));
    const head = (i: number) => blocks[i].querySelector('.tb-h')!.textContent;
    const answer = (i: number) => blocks[i].querySelector('.m-agent');

    expect(head(0)).toBe('Turn 1 · 7 model calls · claude-opus-5-5');
    expect(answer(0)!.className).toContain('preview');
    expect(Array.from(answer(0)!.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['First part.', 'Second part…']);

    expect(head(1)).toBe('Turn 2 · 0 model calls');
    expect(answer(1)).toBeNull();

    expect(head(2)).toBe('Turn 3 · 1 model call · m-detail');
    expect(answer(2)!.textContent).toBe('The whole answer.');
    expect(answer(2)!.className).not.toContain('preview');

    expect(head(3)).toBe('Turn 4');
    expect(answer(3)).toBeNull();
    r.unmount();
  });
});

describe('replyPreview', () => {
  it('keeps 500 characters, never splits one, and says when it cut', () => {
    expect(replyPreview('short')).toEqual({ text: 'short', truncated: false });
    const exact = '😀'.repeat(500);
    expect(replyPreview(exact)).toEqual({ text: exact, truncated: false });
    const cut = replyPreview('😀'.repeat(501));
    expect(Array.from(cut.text)).toHaveLength(500);
    expect(cut.truncated).toBe(true);
    expect(replyPreview('a\u0000b')).toEqual({ text: 'a\u0000b', truncated: false });
  });
});

describe('RightPanel model calls', () => {
  function replySession() {
    return [
      ev({ kind: 'turn.started', session: 'm1', turn: 'T1', exchange: 'x1', text: 'hello' }),
      ev({ kind: 'model.requested', session: 'm1', turn: 'T1', exchange: 'x1', model: 'claude-sonnet-5' }),
      ev({ kind: 'model.responded', session: 'm1', turn: 'T1', exchange: 'x1', status: 200, stop_reason: 'tool_use', text: 'ONLY-ONCE reply', usage: { input_tokens: 3, output_tokens: 4 }, cost_usd: 0.31, cost_complete: true }),
      ev({ kind: 'model.requested', session: 'm1', turn: 'T1', exchange: 'x2', model: 'claude-haiku-5-5' }),
      ev({ kind: 'model.responded', session: 'm1', turn: 'T1', exchange: 'x2', status: 200, stop_reason: 'end_turn', text: 'second' }),
      ev({ kind: 'model.requested', session: 'm1', turn: 'T1', exchange: 'x3', model: 'claude-sonnet-5' }),
      ev({ kind: 'model.responded', session: 'm1', turn: 'T1', exchange: 'x3', status: 200, stop_reason: 'end_turn', text: 'third' }),
    ];
  }

  async function panel(pick: (t: Awaited<ReturnType<typeof sessionFrom>>['turnsList'][0]) => string) {
    const turn = (await sessionFrom(replySession(), 'm1')).turnsList[0];
    const Harness = () => {
      const [sel, setSel] = useSelection(pick(turn));
      return <RightPanel turn={turn} totalTurns={1} selection={sel} onSelectEvent={setSel} />;
    };
    return render(<Harness />);
  }
  const tab = (r: { container: HTMLElement }, label: string) =>
    Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((b) => b.textContent!.startsWith(label));
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('an opened model call shows its reply text once, and its cost', async () => {
    const r = await panel((t) => t.detail!.modelCalls[0].requested.id);
    await click(tab(r, 'Model calls'));
    const open = r.container.querySelector('#d-body tr.ev-open')!;
    expect(count(open.textContent!, 'ONLY-ONCE reply')).toBe(1);
    expect(count(open.textContent!, 'tool_use')).toBe(1);
    expect(open.textContent).toContain('$0.31');
    r.unmount();
  });

  it('the Events tab still shows a request row with its reply figures', async () => {
    const r = await panel((t) => t.detail!.modelCalls[0].requested.id);
    const open = r.container.querySelector('#d-body tr.ev-open')!;
    expect(open.textContent).toContain('Stop reason');
    expect(open.textContent).toContain('tool_use');
    expect(open.textContent).toContain('ONLY-ONCE reply');
    r.unmount();
  });

  it('the Model calls header names the distinct models the calls used', async () => {
    const r = await panel((t) => t.detail!.modelCalls[0].requested.id);
    await click(tab(r, 'Model calls'));
    const head = r.container.querySelector('#d-body .ledger-head')!.textContent;
    expect(head).toBe('claude-sonnet-5, claude-haiku-5-5 · 3 calls in this turn');
    expect(head).not.toContain('Haiku 5.5');
    r.unmount();
  });
});
