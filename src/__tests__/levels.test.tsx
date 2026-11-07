// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { callGroups } from '../data/turns';
import { DataSource, SessionSummary } from '../types';
import { click, ev, flush, jsonl, render, openSession } from './helpers';

// One session, two turns. Turn 1 makes two model calls; the first asks for two
// tools. Turn 2 makes one call and answers.
function events() {
  return [
    ev({ seq: 1, session: 'lv', kind: 'session.registered', agent: 'claude', folder: '/work/levels' }),
    ev({ seq: 2, session: 'lv', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'read the two files' }),
    ev({ seq: 3, session: 'lv', kind: 'model.requested', turn: 'T1', exchange: 'x1', model: 'claude-sonnet-5', tools_offered: ['Read', 'Bash', 'Edit'] }),
    ev({ seq: 4, session: 'lv', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, stop_reason: 'tool_use', text: 'Reading both.',
      usage: { input_tokens: 1200, output_tokens: 40, cache_read_tokens: 900, cache_write_tokens: 300 }, latency_ms: 2100, cost_usd: 0.25, cost_complete: true }),
    ev({ seq: 5, session: 'lv', kind: 'tool.requested', turn: 'T1', exchange: 'x1', tool_id: 'tA', tool_name: 'Read', tool_input: { file_path: '/work/levels/a.go' } }),
    ev({ seq: 6, session: 'lv', kind: 'tool.requested', turn: 'T1', exchange: 'x1', tool_id: 'tB', tool_name: 'Bash', tool_input: { command: 'cat b.go' } }),
    ev({ seq: 7, session: 'lv', kind: 'tool.completed', turn: 'T1', exchange: 'x2', tool_id: 'tA', tool_output: 'package a' }),
    ev({ seq: 8, session: 'lv', kind: 'tool.completed', turn: 'T1', exchange: 'x2', tool_id: 'tB', tool_output: 'package b' }),
    ev({ seq: 9, session: 'lv', kind: 'model.requested', turn: 'T1', exchange: 'x2', model: 'claude-sonnet-5', tools_offered: ['Read', 'Bash', 'Edit'] }),
    ev({ seq: 10, session: 'lv', kind: 'model.responded', turn: 'T1', exchange: 'x2', status: 200, stop_reason: 'end_turn', text: 'Both files are package declarations.',
      usage: { input_tokens: 1500, output_tokens: 20 }, latency_ms: 900, cost_usd: 0.1, cost_complete: false }),
    ev({ seq: 11, session: 'lv', kind: 'turn.completed', turn: 'T1', exchange: 'x2', outcome: 'finished' }),
    ev({ seq: 12, session: 'lv', kind: 'turn.started', turn: 'T2', exchange: 'x3', text: 'thanks' }),
    ev({ seq: 13, session: 'lv', kind: 'model.requested', turn: 'T2', exchange: 'x3', model: 'claude-sonnet-5' }),
    ev({ seq: 14, session: 'lv', kind: 'model.responded', turn: 'T2', exchange: 'x3', status: 200, stop_reason: 'end_turn', text: 'You are welcome.',
      usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.5, cost_complete: true }),
    ev({ seq: 15, session: 'lv', kind: 'turn.completed', turn: 'T2', exchange: 'x3', outcome: 'finished' }),
  ];
}

async function app() {
  const r = await render(<App dataSource={new ReplayDataSource(jsonl(events()))} />);
  await flush();
  await flush();
  const q = (sel: string) => r.container.querySelector(sel);
  const qa = (sel: string) => Array.from(r.container.querySelectorAll(sel));
  return {
    r,
    q,
    qa,
    marks: () => qa('#convo .lvl-sel'),
    head: () => q('#p-head .colhead-title')?.textContent ?? '',
    tabs: () => qa('#d-tabs .tab').map((t) => t.textContent!.replace(/ \(\d+\)$/, '')),
    callRows: () => qa('#convo .wl.model'),
    turnBlock: (n: number) => qa('#convo .tb')[n - 1],
  };
}

async function esc(target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

describe('selection levels', () => {
  it('opens on turn 1, with that turn the one marked thing', async () => {
    const a = await app();
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0]).toBe(a.turnBlock(1));
    expect(a.head()).toContain('turn 1 of 2');
    a.r.unmount();
  });

  it('picking the session, a turn and a call each marks exactly one thing', async () => {
    const a = await app();
    await click(a.q('#sessions .sess'));
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0].id).toBe('c-meta');

    await click(a.turnBlock(2));
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0]).toBe(a.turnBlock(2));

    await click(a.callRows()[1]);
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0]).toBe(a.callRows()[1]);
    // The turn holding the call is not marked as well.
    expect(a.turnBlock(1).classList.contains('lvl-sel')).toBe(false);

    await click(a.q('#c-meta'));
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0].id).toBe('c-meta');
    a.r.unmount();
  });

  it('picking an agent selects the session', async () => {
    const a = await app();
    await click(a.q('#agents .agent'));
    expect(a.marks()[0]?.id).toBe('c-meta');
    expect(a.head()).toMatch(/^Session/);
    a.r.unmount();
  });

  it('Esc steps up from call to turn to session, and stays at the session', async () => {
    const a = await app();
    await click(a.callRows()[1]);
    expect(a.head()).toContain('Call 2 of 2');
    await esc();
    expect(a.marks()[0]).toBe(a.turnBlock(1));
    expect(a.head()).toContain('turn 1 of 2');
    await esc();
    expect(a.marks()[0].id).toBe('c-meta');
    expect(a.head()).toMatch(/^Session/);
    await esc();
    expect(a.marks()[0].id).toBe('c-meta');
    a.r.unmount();
  });

  it('Esc in a text box first leaves the box, and only the next Esc steps up', async () => {
    const a = await app();
    await click(a.callRows()[0]);
    const box = a.q('#input') as HTMLTextAreaElement;
    box.disabled = false;
    box.focus();
    expect(document.activeElement).toBe(box);
    await esc(box);
    expect(document.activeElement).not.toBe(box);
    expect(a.head()).toContain('Call 1 of 2');
    await esc();
    expect(a.head()).toContain('turn 1 of 2');
    a.r.unmount();
  });
});

describe('the right panel header', () => {
  it('shows the path back up, and each part goes to its level', async () => {
    const a = await app();
    await click(a.callRows()[1]);
    const crumbs = () => a.qa('#p-head .crumb').map((c) => c.textContent);
    expect(crumbs()).toEqual(['Session', 'Turn 1']);
    expect(a.head()).toContain('Session›Turn 1›Call 2 of 2');

    await click(a.qa('#p-head .crumb').find((c) => c.textContent === 'Turn 1'));
    expect(a.marks()[0]).toBe(a.turnBlock(1));
    expect(crumbs()).toEqual(['Session']);

    await click(a.q('#p-head .crumb'));
    expect(a.marks()[0].id).toBe('c-meta');
    expect(crumbs()).toEqual([]);
    a.r.unmount();
  });
});

describe('the session panel', () => {
  it('shows cost (a lower bound here), turns, tokens, id, agent and folder, and a table of turns', async () => {
    const a = await app();
    await click(a.q('#sessions .sess'));
    const strip = a.q('#d-head .strip')!.textContent!;
    // 0.25 + 0.1 (incomplete) + 0.5: a lower bound.
    expect(strip).toContain('≥$0.85');
    expect(strip).toContain('Turns2');
    expect(strip).toContain('4.0k');
    expect(strip).toContain('lv');
    expect(a.q('#d-head')!.textContent).toContain('Claude Code');
    expect(a.q('#d-head')!.textContent).toContain('/work/levels');
    expect(a.q('#d-tabs')).toBeNull();

    const rows = a.qa('#d-body table.turns tbody tr');
    expect(rows).toHaveLength(2);
    const cells = (i: number) => Array.from(rows[i].querySelectorAll('td')).map((td) => td.textContent);
    expect(cells(0)[0]).toBe('1');
    expect(cells(0)[1]).toBe('read the two files');
    expect(cells(0)[3]).toBe('≥$0.35');
    expect(cells(0)[4]).toBe('finished');
    expect(cells(1)[3]).toBe('$0.50');

    // A row goes to that turn.
    await click(rows[1]);
    expect(a.marks()[0]).toBe(a.turnBlock(2));
    expect(a.head()).toContain('turn 2 of 2');
    a.r.unmount();
  });
});

describe('the turn panel', () => {
  it('keeps its tabs, with Result first holding the final answer', async () => {
    const a = await app();
    expect(a.tabs()).toEqual(['Result', 'Events', 'Model calls', 'Tool calls', 'Prompt', 'Skills', 'MCP']);
    await click(a.qa('#d-tabs .tab')[0]);
    expect(a.q('#d-body')!.textContent).toContain('Both files are package declarations.');
    a.r.unmount();
  });
});

describe('the model call panel', () => {
  it('opens from a row in the turn Model calls tab', async () => {
    const a = await app();
    await click(a.qa('#d-tabs .tab').find((t) => t.textContent!.startsWith('Model calls')));
    await click(a.qa('#d-body tr.ev')[1]);
    await click(a.q('#d-body .open-call'));
    expect(a.head()).toContain('Call 2 of 2');
    expect(a.marks()).toEqual([a.callRows()[1]]);
    a.r.unmount();
  });

  it('shows the call strip and the Reply, Sent and Context tabs', async () => {
    const a = await app();
    await click(a.callRows()[0]);
    const strip = a.q('#d-head .strip')!.textContent!;
    expect(strip).toContain('$0.25');
    expect(strip).toContain('1,200 in / 40 out');
    expect(strip).toContain('Cache read900');
    expect(strip).toContain('Cache write300');
    expect(strip).toContain('2.1s');
    expect(strip).toContain('tool_use');
    expect(a.tabs()).toEqual(['Reply', 'Sent', 'Context']);

    // Reply: the text and the tool calls it asked for.
    const body = () => a.q('#d-body')!.textContent!;
    expect(body()).toContain('Reading both.');
    const asked = a.qa('#d-body .asked tbody tr').map((tr) => tr.querySelector('code')!.textContent);
    expect(asked).toEqual(['Read', 'Bash']);

    await click(a.qa('#d-tabs .tab').find((t) => t.textContent === 'Sent'));
    expect(body()).toContain('claude-sonnet-5');
    expect(body()).toContain('3 tools offered');
    expect(body()).toContain('Read, Bash, Edit');
    a.r.unmount();
  });

  it('an incomplete call cost shows as a lower bound', async () => {
    const a = await app();
    await click(a.callRows()[1]);
    expect(a.q('#d-head .strip')!.textContent).toContain('≥$0.10');
    a.r.unmount();
  });
});

describe('the conversation column', () => {
  it('opens each turn with a header and separates turns with a rule', async () => {
    const a = await app();
    const heads = () => a.qa('#convo .tb-h').map((h) => h.textContent);
    // An unopened turn's calls and model come from the turn list; an opened
    // turn's from its events. They agree.
    const both = ['Turn 1 · 2 model calls · claude-sonnet-5', 'Turn 2 · 1 model call · claude-sonnet-5'];
    expect(heads()).toEqual(both);
    expect(a.qa('#convo .tsep')).toHaveLength(1);
    await click(a.qa('#convo .tb')[1]);
    await flush();
    expect(heads()).toEqual(both);
    a.r.unmount();
  });

  it('Show details lists numbered calls with the tools each asked for under it', async () => {
    const a = await app();
    const lines = a.qa('#convo .tb')[0].querySelectorAll('.wlines .wl');
    const text = Array.from(lines).map((l) => `${l.className.includes('model') ? 'M' : 'T'} ${l.querySelector('.wk')!.textContent}`);
    expect(text).toEqual(['M call 1 of 2', 'T Read', 'T Bash', 'M call 2 of 2']);
    a.r.unmount();
  });

  it('a tool row opens that tool in the turn panel Events tab', async () => {
    const a = await app();
    await click(a.qa('#convo .wl.tool')[0]);
    expect(a.marks()[0]).toBe(a.turnBlock(1));
    expect(a.q('#d-tabs .tab.on')!.textContent).toBe('Events');
    expect(a.q('#d-body tr.ev-open')!.textContent).toContain('tA');
    a.r.unmount();
  });
});

describe('selection edge cases', () => {
  it('a tool call whose exchange matches no model call is never put under another call', async () => {
    const evs = [
      ev({ seq: 1, session: 'ux', kind: 'turn.started', turn: 'U', exchange: 'x1', text: 'go' }),
      ev({ seq: 2, session: 'ux', kind: 'model.requested', turn: 'U', exchange: 'x1' }),
      ev({ seq: 3, session: 'ux', kind: 'model.responded', turn: 'U', exchange: 'x1', status: 200, stop_reason: 'tool_use' }),
      ev({ seq: 4, session: 'ux', kind: 'tool.requested', turn: 'U', exchange: 'x1', tool_id: 'own', tool_name: 'Own' }),
      // The request of exchange x9 was dropped: only its tool call arrived.
      ev({ seq: 5, session: 'ux', kind: 'tool.requested', turn: 'U', exchange: 'x9', tool_id: 'lost', tool_name: 'Lost' }),
      // No exchange at all: the only case that may fall back to the call before it.
      ev({ seq: 6, session: 'ux', kind: 'tool.requested', turn: 'U', tool_id: 'bare', tool_name: 'Bare' }),
    ];
    const turn = (await openSession(new ReplayDataSource(jsonl(evs)), 'ux'))!.turnsList[0];
    const { groups, unmatched } = callGroups(turn.detail!);
    expect(groups[0].tools.map((t) => t.requested.tool_name)).toEqual(['Own', 'Bare']);
    expect(unmatched.map((t) => t.requested.tool_name)).toEqual(['Lost']);

    // In the conversation, Lost is listed apart, after a label, not under call 1.
    const r = await render(<App dataSource={new ReplayDataSource(jsonl(evs))} />);
    await flush();
    await flush();
    const lines = Array.from(r.container.querySelectorAll('#convo .wlines > *')).map((l) =>
      l.classList.contains('wl-unmatched') ? 'LABEL' : l.querySelector('.wk')!.textContent
    );
    expect(lines).toEqual(['call 1 of 1', 'Own', 'Bare', 'LABEL', 'Lost']);
    r.unmount();
  });

  // The new session's history can be empty when it loads, or already hold its
  // first turn. Either way the session panel shows.
  it.each([0, 1])('starting a new session while a call is selected shows the new session panel (%i turns loaded)', async (turns) => {
    const replay = new ReplayDataSource(jsonl(events()));
    const freshEvents = [
      ev({ seq: 50, session: 'fresh', kind: 'turn.started', turn: 'F1', exchange: 'f1', text: 'hello' }),
      ev({ seq: 51, session: 'fresh', kind: 'model.requested', turn: 'F1', exchange: 'f1' }),
    ];
    const freshReplay = new ReplayDataSource(jsonl(freshEvents));
    const fresh: SessionSummary = {
      id: 'fresh', agent: 'claude', client: 'c', title: 'fresh', started: '2026-11-05T10:00:00Z',
      last: '2026-11-05T10:00:00Z', open: true, turns, usage: { input_tokens: 0, output_tokens: 0 },
    };
    let snapshot: ((s: SessionSummary[]) => void) | null = null;
    const source: DataSource = {
      getAgents: () => replay.getAgents(),
      getSessions: () => replay.getSessions(),
      getTurns: async (id) => (id === 'fresh' ? (turns === 0 ? { turns: [] } : freshReplay.getTurns(id)) : replay.getTurns(id)),
      getTurn: (s, t) => (s === 'fresh' ? freshReplay.getTurn(s, t) : replay.getTurn(s, t)),
      getInstalledAgents: async () => [{ name: 'claude', found: true }],
      startRun: async () => ({ id: 'fresh' }),
      subscribe: (_cb, onSnapshot) => {
        snapshot = onSnapshot ?? null;
        replay.getSessions().then((l) => onSnapshot?.(l));
        return () => {};
      },
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .wl.model'));
    expect(r.container.querySelector('#p-head .colhead-title')!.textContent).toContain('Call 1 of 2');

    await click(r.container.querySelector('#sessions .new-session'));
    await flush();
    const set = (sel: string, value: string) => {
      const el = r.container.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      set('.new-dialog input[name="folder"]', '/work/fresh');
      set('.new-dialog textarea[name="prompt"]', 'hello');
    });
    await act(async () => {
      r.container.querySelector('.new-dialog')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const list = await replay.getSessions();
    await act(async () => snapshot!([fresh, ...list]));
    await flush();
    await flush();

    expect(r.container.querySelector('#c-meta .c-id code')?.textContent).toBe('fresh');
    expect(r.container.querySelector('#p-head .colhead-title')!.textContent).toBe(turns === 0 ? 'Session0 turns' : 'Session1 turn');
    expect(r.container.querySelector('#d-head .strip')!.textContent).toContain('Sessionfresh');
    expect(r.container.querySelectorAll('#convo .lvl-sel')[0]?.id).toBe('c-meta');
    r.unmount();
  });

  it('clicking another session in the list while a call is selected shows that session panel', async () => {
    const both = [...events(), ...events().map((e) => ({ ...e, id: `o-${e.id}`, seq: (e.seq ?? 0) + 100, session: 'other' }))];
    const r = await render(<App dataSource={new ReplayDataSource(jsonl(both))} />);
    await flush();
    await flush();
    await click(r.container.querySelector('#convo .wl.model'));
    expect(r.container.querySelector('#p-head .colhead-title')!.textContent).toContain('Call 1 of 2');
    const shown = r.container.querySelector('#c-meta .c-id code')!.textContent;
    const otherRow = Array.from(r.container.querySelectorAll('#sessions .sess')).find(
      (b) => b.querySelector('.s-from code, code')!.textContent !== shown
    );
    await click(otherRow);
    await flush();
    await flush();
    expect(r.container.querySelector('#c-meta .c-id code')!.textContent).not.toBe(shown);
    expect(r.container.querySelector('#p-head .colhead-title')!.textContent).toBe('Session2 turns');
    expect(r.container.querySelectorAll('#convo .lvl-sel')[0]?.id).toBe('c-meta');
    r.unmount();
  });
});

describe('the turn panel keeps its open row across levels', () => {
  it('opening call 2 from Model calls and coming back through the Turn link keeps call 2 open', async () => {
    const a = await app();
    await click(a.qa('#d-tabs .tab').find((t) => t.textContent!.startsWith('Model calls')));
    await click(a.qa('#d-body tr.ev')[1]);
    await click(a.q('#d-body .open-call'));
    expect(a.head()).toContain('Call 2 of 2');
    await click(a.qa('#p-head .crumb').find((c) => c.textContent === 'Turn 1'));
    expect(a.q('#d-tabs .tab.on')!.textContent).toMatch(/^Model calls/);
    const open = a.qa('#d-body tr.ev.sel');
    expect(open).toHaveLength(1);
    expect(open[0].querySelectorAll('td')[1].textContent).toBe('2');
    a.r.unmount();
  });

  it('a collapsed row stays collapsed after a visit to the session panel', async () => {
    const a = await app();
    expect(a.qa('#d-body tr.ev-open')).toHaveLength(1);
    await click(a.q('#d-body tr.ev.sel'));
    expect(a.qa('#d-body tr.ev-open')).toHaveLength(0);
    await click(a.q('#c-meta'));
    expect(a.head()).toMatch(/^Session/);
    await click(a.turnBlock(1));
    expect(a.head()).toContain('turn 1 of 2');
    expect(a.qa('#d-body tr.ev-open')).toHaveLength(0);
    a.r.unmount();
  });

  it('another turn still starts with its own default row open', async () => {
    const a = await app();
    await click(a.q('#d-body tr.ev.sel'));
    await click(a.turnBlock(2));
    expect(a.qa('#d-body tr.ev-open')).toHaveLength(1);
    a.r.unmount();
  });
});

describe('failed calls and hidden details', () => {
  // A stream cut off mid-reply: status 200, a stop reason, and an error.
  function cutEvents() {
    return [
      ev({ seq: 1, session: 'cut', kind: 'turn.started', turn: 'C', exchange: 'c1', text: 'go' }),
      ev({ seq: 2, session: 'cut', kind: 'model.requested', turn: 'C', exchange: 'c1', model: 'm' }),
      ev({ seq: 3, session: 'cut', kind: 'model.responded', turn: 'C', exchange: 'c1', status: 200, stop_reason: 'end_turn',
        error: 'stream interrupted', text: 'partial', usage: { input_tokens: 5, output_tokens: 2 } }),
    ];
  }

  it('a call with an error shows it and reads as failed, whatever its status', async () => {
    const r = await render(<App dataSource={new ReplayDataSource(jsonl(cutEvents()))} />);
    await flush();
    await flush();
    const q = (s: string) => r.container.querySelector(s);
    const qa = (s: string) => Array.from(r.container.querySelectorAll(s));
    // The conversation's call row.
    expect(q('#convo .wl.model .wt')!.textContent).toContain('failed');
    // The turn level: the Events row for the reply, and the Model calls row.
    const replyRow = qa('#d-body tr.ev').find((tr) => tr.textContent!.includes('model.responded'))!;
    // It is the turn's default open row; open it only if it is not.
    if (!replyRow.classList.contains('sel')) await click(replyRow);
    expect(q('#d-body tr.ev-open')!.textContent).toContain('stream interrupted');
    await click(qa('#d-tabs .tab').find((t) => t.textContent!.startsWith('Model calls')));
    expect(q('#d-body tr.ev')!.textContent).toContain('failed');
    // The call level: the strip and the Reply tab.
    await click(q('#convo .wl.model'));
    expect(q('#d-head .strip')!.textContent).toContain('failed');
    expect(q('#d-body')!.textContent).toContain('stream interrupted');
    r.unmount();
  });

  it('hiding the details of a turn whose call is selected moves the selection to the turn', async () => {
    const a = await app();
    await click(a.callRows()[1]);
    await click(a.turnBlock(1).querySelector('.work-h'));
    expect(a.turnBlock(1).querySelector('.wlines')).toBeNull();
    expect(a.marks()).toEqual([a.turnBlock(1)]);
    expect(a.head()).toContain('turn 1 of 2');
    a.r.unmount();
  });

  it('opening a call from the panel shows its row even when that turn hid its details', async () => {
    const a = await app();
    await click(a.turnBlock(1).querySelector('.work-h'));
    expect(a.turnBlock(1).querySelector('.wlines')).toBeNull();
    await click(a.qa('#d-tabs .tab').find((t) => t.textContent!.startsWith('Model calls')));
    await click(a.qa('#d-body tr.ev')[1]);
    await click(a.q('#d-body .open-call'));
    expect(a.marks()).toHaveLength(1);
    expect(a.marks()[0].classList.contains('wl')).toBe(true);
    a.r.unmount();
  });

  it('a call clicked in A while B loads acts on A; B still opens on its session panel', async () => {
    const both = [...events(), ...events().map((e) => ({ ...e, id: `b-${e.id}`, seq: (e.seq ?? 0) + 100, session: 'bee' }))];
    const replay = new ReplayDataSource(jsonl(both));
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const source: DataSource = {
      getAgents: () => replay.getAgents(),
      getSessions: async () => (await replay.getSessions()).slice().sort((x) => (x.id === 'lv' ? -1 : 1)),
      getTurns: async (id) => {
        if (id === 'bee') await gate;
        return replay.getTurns(id);
      },
      getTurn: (s, t) => replay.getTurn(s, t),
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const q = (s: string) => r.container.querySelector(s);
    expect(q('#c-meta .c-id code')!.textContent).toBe('lv');
    const rowB = Array.from(r.container.querySelectorAll('#sessions .sess')).find((b) => b.querySelector('code')!.textContent === 'bee');
    await click(rowB);
    // A is still on screen; a call clicked there acts on A.
    await click(q('#convo .wl.model'));
    expect(q('#c-meta .c-id code')!.textContent).toBe('lv');
    expect(q('#p-head .colhead-title')!.textContent).toContain('Call 1 of 2');
    await act(async () => release());
    await flush();
    await flush();
    expect(q('#c-meta .c-id code')!.textContent).toBe('bee');
    expect(q('#p-head .colhead-title')!.textContent).toBe('Session2 turns');
    expect(r.container.querySelectorAll('#convo .lvl-sel')[0]?.id).toBe('c-meta');
    r.unmount();
  });
});
