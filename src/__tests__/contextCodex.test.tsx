// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ContextTab } from '../components/ContextTab';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { blocksOf, itemRole, layoutContext, NOTE_PREFIX } from '../data/context';
import { CallContext, ContextPiece, DataSource } from '../types';
import { click, ev, flush, jsonl, render, openCall } from './helpers';

// Shapes follow the framework's codex fixtures (adapter/openai/testdata).
function item(json: Record<string, unknown>): ContextPiece {
  const raw = JSON.stringify(json);
  const label = json.type === 'message' ? (json.role as string) : (json.type as string);
  return { kind: 'input_item', label, hash: `h-${raw.length}-${label}`, size: raw.length, approx_tokens: Math.round(raw.length / 2.66), json };
}
const meta = (...kinds: string[]) => ({ internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } });
const msg = (role: string, text: string, kinds: string[] = [], type = 'input_text') => ({
  type: 'message',
  id: `msg_${text.length}`,
  role,
  content: [{ type, text }],
  ...(kinds.length ? meta(...kinds) : {}),
});

const toolsItem = item({
  type: 'additional_tools',
  id: 'at_1',
  role: 'developer',
  tools: [
    { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'custom', name: 'exec', description: 'Runs code' }, { type: 'custom', name: 'wait' }] },
    { type: 'function', name: 'spawn_agent' },
  ],
});
const base = item(msg('developer', 'You are Codex, an agent based on GPT-6.', ['model.base_instructions']));
const perms = item(msg('developer', '<permissions>read only</permissions>', ['permissions.instructions']));
const agents = item(msg('user', '# AGENTS.md instructions\n<INSTRUCTIONS>be brief</INSTRUCTIONS>', ['agents_md.instructions', 'environments.environment_context']));
const prompt = (t: string) => item(msg('user', t, ['user.text']));
const reasoning = item({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'A'.repeat(1234) });
const call = item({ type: 'custom_tool_call', id: 'c1', status: 'completed', call_id: 'call_1', name: 'exec', input: 'echo hello123' });
const out = item({ type: 'custom_tool_call_output', id: 'o1', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: 'hello123\n' }] });
const answer = (t: string) => item(msg('assistant', t, [], 'output_text'));

const REPLY: ContextPiece = {
  kind: 'message',
  label: 'output',
  hash: 'rep',
  size: 90,
  json: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It prints hello123.' }] }],
};

function codexCtx(pieces: ContextPiece[]): CallContext {
  return {
    exchange: 'c',
    session: 'cx',
    vendor: 'openai',
    size: pieces.reduce((n, p) => n + p.size, 0),
    stop_reason: 'completed',
    request: { model: 'gpt-6.1-sol', stream: true, store: false, include: ['reasoning.encrypted_content'] },
    reply: REPLY,
    pieces,
  };
}

// Turn 1's whole history (9 items), then turn 2's prompt and its own loop.
const history = [toolsItem, base, perms, agents, prompt('run echo'), reasoning, call, out, answer('hello123')];
const replayedCall = codexCtx([...history, prompt('and what did it print?'), reasoning, call, out]);
const firstCall = codexCtx([toolsItem, base, perms, agents, prompt('run echo')]);

function loader(answers: Record<string, CallContext>) {
  const turns: string[] = [];
  const load = async (turn: string, x: string, full: boolean): Promise<CallContext> => {
    turns.push(turn);
    const a = answers[x];
    if (!a) throw new Error('404');
    if (full) return a;
    const strip = ({ json: _j, ...rest }: ContextPiece) => rest;
    return { ...a, pieces: a.pieces.map(strip), reply: a.reply && strip(a.reply) };
  };
  return { load, turns };
}

const titles = (root: Element, sel = ':scope > .ctx-fold') => Array.from(root.querySelectorAll(sel)).map((f) => f.querySelector('.ctx-title')!.textContent);

describe('Context tab, codex', () => {
  it('reads each item by its shape', () => {
    expect([toolsItem, base, perms, agents, prompt('x'), reasoning, answer('y')].map(itemRole)).toEqual([
      'tools', 'system', 'context', 'context', 'prompt', 'other', 'other',
    ]);
    expect(itemRole(item(msg('developer', `${NOTE_PREFIX} the turn stopped`)))).toBe('note');
    // A developer message codex did not label is not context, whatever it says.
    expect(itemRole(item(msg('developer', 'You are Codex')))).toBe('other');
  });

  it('a replayed call: system, tools, one group for the history, the new prompt open', async () => {
    const evs = [
      ev({ seq: 1, session: 'cx', kind: 'session.registered', agent: 'codex', folder: '/work/cx' }),
      ev({ seq: 2, session: 'cx', kind: 'turn.started', turn: 'T1', text: 'run echo' }),
      ev({ seq: 3, session: 'cx', kind: 'model.requested', turn: 'T1', exchange: 'c1', model: 'gpt-6.1-sol' }),
      ev({ seq: 4, session: 'cx', kind: 'model.responded', turn: 'T1', exchange: 'c1', status: 200, stop_reason: 'completed', text: 'a' }),
      ev({ seq: 5, session: 'cx', kind: 'turn.completed', turn: 'T1', outcome: 'finished' }),
      ev({ seq: 6, session: 'cx', kind: 'turn.started', turn: 'T2', text: 'and', continuity: 'replay', replay_from: 'T1' }),
      ev({ seq: 7, session: 'cx', kind: 'model.requested', turn: 'T2', exchange: 'c2', model: 'gpt-6.1-sol', replayed: 9 }),
      ev({ seq: 8, session: 'cx', kind: 'model.responded', turn: 'T2', exchange: 'c2', status: 200, stop_reason: 'completed', text: 'b' }),
      ev({ seq: 9, session: 'cx', kind: 'turn.completed', turn: 'T2', outcome: 'finished' }),
    ];
    const { load } = loader({ c2: replayedCall });
    const base2 = new ReplayDataSource(jsonl(evs));
    const source: DataSource = {
      getAgents: () => base2.getAgents(),
      getSessions: (a) => base2.getSessions(a),
      getTurns: (id) => base2.getTurns(id),
      getTurn: (s, t) => base2.getTurn(s, t),
      getCallContext: load,
    };
    const r = await render(<App dataSource={source} />);
    await flush();
    await flush();
    const qa = (s: string) => Array.from(r.container.querySelectorAll(s));
    await openCall(r.container, 1, 0);
    await click(qa('#d-tabs .tab').find((t) => t.textContent === 'Context'));
    for (let i = 0; i < 4; i++) await flush();
    const body = r.container.querySelector('#d-body .ctx')!;
    expect(titles(body)).toEqual([
      'System',
      'Tools',
      'Turn 1',
      '#9 usernew message',
      '#10 reasoning',
      '#11 custom_tool_call',
      '#12 custom_tool_call_output',
      'Other fields',
      'outputcompleted',
    ]);
    // Tools: counted by tool, not by item. Three leaves in the fixture.
    expect(body.querySelectorAll(':scope > .ctx-fold')[1].querySelector('.ctx-meta')!.textContent).toContain('3 tools');
    // The history is folded and holds items #2 to #8; #0 and #1 sit in the sections above.
    const hist = body.querySelector(':scope > .ctx-fold.replayed')!;
    expect(hist.querySelector('.ctx-meta')!.textContent).toContain('7 messages');
    expect(body.textContent).not.toContain('Script completed');
    await click(hist.querySelector('.ctx-row'));
    expect(titles(hist.querySelector('.ctx-inner')!, '.ctx-inner > .ctx-fold')).toEqual([
      '#2 developerCodex context',
      '#3 userCodex context',
      '#4 user',
      '#5 reasoning',
      '#6 custom_tool_call',
      '#7 custom_tool_call_output',
      '#8 assistant',
    ]);
    // The new prompt is open; its reasoning is a size, not decoded text.
    const fresh = body.querySelector(':scope > .ctx-fold.msg-new')!;
    expect(fresh.classList.contains('open')).toBe(true);
    expect(fresh.textContent).toContain('and what did it print?');
    const reas = body.querySelectorAll(':scope > .ctx-fold.msg-turn')[0];
    await click(reas.querySelector('.ctx-row'));
    expect(reas.textContent).toContain('encrypted reasoning (1,234 bytes)');
    expect(reas.textContent).not.toContain('AAAA');
    // The tool call and its output read as text.
    const callFold = body.querySelectorAll(':scope > .ctx-fold.msg-turn')[1];
    await click(callFold.querySelector('.ctx-row'));
    expect(callFold.textContent).toContain('echo hello123');
    const outFold = body.querySelectorAll(':scope > .ctx-fold.msg-turn')[2];
    await click(outFold.querySelector('.ctx-row'));
    expect(outFold.textContent).toContain('Script completed');
    // The reply is the list of output items.
    expect(body.querySelector(':scope > .ctx-fold.reply-piece')!.textContent).toContain('It prints hello123.');
    r.unmount();
  });

  it('a first turn: base instructions as System, tools folded, context folded, the prompt open', async () => {
    const { load } = loader({ c: firstCall });
    const r = await render(<ContextTab turn="T1" exchange="c" load={load} />);
    await flush();
    await flush();
    const body = r.container.querySelector('.ctx')!;
    expect(body.querySelector('.ctx-fold.replayed')).toBeNull();
    expect(titles(body)).toEqual(['System', 'Tools', '#2 developerCodex context', '#3 userCodex context', '#4 usernew message', 'Other fields', 'outputcompleted']);
    expect(body.textContent).not.toContain('be brief');
    expect(body.querySelector('.ctx-fold.msg-new')!.textContent).toContain('run echo');
    await click(body.querySelector('.ctx-fold .ctx-row'));
    await click(body.querySelector('.ctx-fold .ctx-inner .ctx-row'));
    expect(body.textContent).toContain('You are Codex, an agent based on GPT-6.');
    r.unmount();
  });

  it('a recovered turn: the history ends with the AgentBus note', async () => {
    const note = item(msg('developer', `${NOTE_PREFIX} The turn was interrupted.`));
    const c = codexCtx([toolsItem, base, agents, prompt('first'), reasoning, note, prompt('go on')]);
    const l = layoutContext(c, { replayed: 6, continuity: 'replay' });
    expect(l.format).toBe('responses');
    expect(l.messages.map((m) => [m.item, m.part])).toEqual([
      ['tools', 'replayed'],
      ['system', 'replayed'],
      ['context', 'replayed'],
      ['prompt', 'replayed'],
      ['other', 'replayed'],
      ['note', 'replayed'],
      ['prompt', 'new'],
    ]);
    const { load } = loader({ c });
    const r = await render(<ContextTab turn="T1" exchange="c" load={load} replayed={6} continuity="replay" replayFrom="T1" recovered />);
    await flush();
    await flush();
    const body = r.container.querySelector('.ctx')!;
    await click(body.querySelector('.ctx-fold.replayed .ctx-row'));
    expect(body.querySelector('.ctx-fold.replayed')!.textContent).toContain('AgentBus note');
    expect(body.querySelector('.ctx-fold.msg-new')!.textContent).toContain('go on');
    r.unmount();
  });

  it('reads reasoning, calls and outputs as blocks', () => {
    expect(blocksOf(reasoning.json, 'reasoning')).toEqual([
      expect.objectContaining({ type: 'reasoning', text: 'encrypted reasoning (1,234 bytes)', note: '1,234 bytes' }),
    ]);
    expect(blocksOf({ type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' }, 'function_call')[0]).toMatchObject({ name: 'shell', text: '{\n  "cmd": "ls"\n}' });
    expect(blocksOf(out.json, 'x')[0].text).toBe('Script completed\n\nhello123\n');
  });
});

describe('Context tab, Claude stays as it was', () => {
  it('a Claude call has no Responses format and no item roles', () => {
    const c: CallContext = {
      exchange: 'x',
      size: 10,
      pieces: [
        { kind: 'message', label: 'user', hash: 'a', size: 5, json: { role: 'user', content: 'hi' } },
        { kind: 'message', label: 'system', hash: 'b', size: 5, json: { role: 'system', content: [{ type: 'text', text: 's' }] } },
      ],
    };
    const l = layoutContext(c, { replayed: 0 });
    expect(l.format).toBe('messages');
    expect(l.messages.map((m) => [m.role, m.part, m.claudeCode, m.item])).toEqual([
      ['user', 'new', false, undefined],
      ['system', 'turn', true, undefined],
    ]);
    expect(blocksOf(c.pieces[0].json, 'user')[0]).toEqual({ type: 'text', claudeCode: false, text: 'hi' });
  });
});
