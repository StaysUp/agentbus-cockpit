// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ContextTab, holdsAdded } from '../components/ContextTab';
import { RunnersList } from '../components/RunnersList';
import { addedContext } from '../data/turns';
import { CallContext, ContextPiece, RunnerInfo, TurnDetail } from '../types';
import { click, ev, flush, render } from './helpers';

function piece(kind: string, label: string, json: unknown): ContextPiece {
  const raw = JSON.stringify(json);
  return { kind, label, hash: `h-${raw.length}-${label}`, size: raw.length, approx_tokens: 1, json };
}

const instr = 'You work through AgentBus, in session s1.\n"Quoted" line.';
const asked = 'Another agent asked for this work.';
const added = [
  { kind: 'instructions', bytes: instr.length, text: instr },
  { kind: 'asked_by', bytes: asked.length, text: asked },
];

// Claude Code's system prompt: its own block, then one that ends with what
// AgentBus appended.
const call: CallContext = {
  exchange: 'x',
  session: 's1',
  vendor: 'anthropic',
  size: 100,
  stop_reason: 'end_turn',
  request: { model: 'claude-haiku-4-5' },
  pieces: [
    piece('message', 'user', { role: 'user', content: 'hi' }),
    piece('system', 'text', { type: 'text', text: 'You are Claude Code.' }),
    piece('system', 'text', { type: 'text', text: `Claude Code's own part.\n\n${instr}\n\n${asked}` }),
  ],
};

const load = async () => call;

describe('Added by AgentBus', () => {
  it('reads context.added from the turn, and nothing from a turn without it', () => {
    const detail = (events: ReturnType<typeof ev>[]): TurnDetail => ({ events, modelCalls: [], toolCalls: [] }) as unknown as TurnDetail;
    expect(addedContext(detail([ev({ session: 's1', kind: 'context.added', turn: 'T1', added })]))).toEqual(added);
    expect(addedContext(detail([ev({ session: 's1', kind: 'turn.started', turn: 'T1' })]))).toEqual([]);
    expect(addedContext(undefined)).toEqual([]);
  });

  it('finds a text in a piece as JSON escapes it', () => {
    expect(holdsAdded({ type: 'text', text: `x ${instr} y` }, added)).toBe(true);
    expect(holdsAdded({ type: 'text', text: 'You are Claude Code.' }, added)).toBe(false);
    expect(holdsAdded(undefined, added)).toBe(false);
  });

  it('lists each piece above the request, and marks the system block that holds them', async () => {
    const r = await render(<ContextTab turn="T1" exchange="x" load={load} added={added} />);
    await flush();
    await flush();
    const body = r.container.querySelector('.ctx')!;
    const heads = Array.from(body.querySelectorAll('.sub-h')).map((h) => h.textContent);
    expect(heads.slice(0, 2)).toEqual(['Added by AgentBus', 'Request']);
    const rows = Array.from(body.querySelectorAll('.ctx-fold.ctx-added'));
    expect(rows.map((f) => f.querySelector('.ctx-title')!.textContent)).toEqual(['Instructions (instructions.md)', 'Who asked for this work']);
    expect(rows[0].querySelector('.ctx-meta')!.textContent).toBe(`${instr.length} B`);
    await click(rows[0].querySelector('.ctx-row'));
    expect(rows[0].textContent).toContain('"Quoted" line.');

    const system = Array.from(body.querySelectorAll(':scope > .ctx-fold')).find((f) => f.querySelector('.ctx-title')!.textContent!.startsWith('System'))!;
    expect(system.querySelector('.ctx-title .ctx-tag.ab')).not.toBeNull();
    await click(system.querySelector('.ctx-row'));
    const blocks = Array.from(system.querySelectorAll('.ctx-inner .ctx-fold')).map((f) => !!f.querySelector('.ctx-title .ctx-tag.ab'));
    expect(blocks).toEqual([false, true]);
    r.unmount();
  });

  it('shows no section for a turn AgentBus added nothing to', async () => {
    const r = await render(<ContextTab turn="T1" exchange="x" load={load} />);
    await flush();
    await flush();
    expect(r.container.textContent).not.toContain('Added by AgentBus');
    expect(r.container.querySelector('.ctx-tag.ab')).toBeNull();
    r.unmount();
  });
});

describe('Runners list', () => {
  const runners: RunnerInfo[] = [
    {
      id: 'run_a',
      name: 'mac',
      role: 'runner',
      online: true,
      last_seen: new Date().toISOString(),
      labels: [],
      harnesses: [
        { name: 'claude', found: true, version: '2.1.319' },
        { name: 'codex', found: false },
      ],
    },
    { id: 'run_b', name: 'mac', role: 'connector', online: true, last_seen: new Date().toISOString(), labels: [], harnesses: [] },
    { id: 'run_c', name: 'box', role: 'runner', online: false, last_seen: new Date(Date.now() - 3 * 60_000).toISOString(), labels: [], harnesses: [] },
  ];

  it('shows each runner with a dot, when it was last seen, and the harnesses it found', async () => {
    const r = await render(<RunnersList load={async () => runners} />);
    await flush();
    const rows = Array.from(r.container.querySelectorAll('.runner'));
    expect(rows.map((x) => x.getAttribute('data-runner'))).toEqual(['run_a', 'run_b', 'run_c']);
    expect(rows[0].querySelector('.live')).not.toBeNull();
    expect(rows[0].textContent).toContain('online');
    expect(rows[0].querySelector('.rn-h')!.textContent).toBe('claude 2.1.319');
    expect(rows[1].textContent).toContain('connector');
    expect(rows[1].querySelector('.rn-h')).toBeNull();
    expect(rows[2].querySelector('.gone')).not.toBeNull();
    expect(rows[2].textContent).toContain('last seen 3 min ago');
    expect(rows[2].querySelector('.rn-h')!.textContent).toBe('no harness found');
    r.unmount();
  });

  it('shows nothing on a service without the route, and the API’s words on an error', async () => {
    const none = await render(<RunnersList load={async () => null} />);
    await flush();
    expect(none.container.querySelector('.runners')).toBeNull();
    none.unmount();
    const bad = await render(
      <RunnersList
        load={async () => {
          throw new Error('the token is not valid');
        }}
      />
    );
    await flush();
    expect(bad.container.querySelector('.runners-err')!.textContent).toBe('the token is not valid');
    bad.unmount();
  });
});
