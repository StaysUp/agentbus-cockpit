// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RightPanel } from '../components/RightPanel';
import { toolboxSummary, toolState, turnToolbox } from '../data/toolbox';
import { turnDetail } from '../data/turns';
import { Turn } from '../types';
import { click, ev, render } from './helpers';

const SERVED = [
  'list_agents',
  'ask_agent',
  'continue_session',
  'list_turns',
  'get_turn',
  'turn_diff',
  'apply_turn',
  'review_turn',
  'stop_turn',
  'search_history',
  'rename_session',
];
const HIDDEN = ['Task', 'Agent', 'ListAgents', 'SendMessage'].map((name) => ({ name, why: 'replaced by AgentBus tools' }));

// A claude turn as the record holds it (Claude Code 2.1.321, 2026-11-11): the
// first call offers ToolSearch and a placeholder, its reply selects three
// AgentBus tools, and the calls after it carry their schemas.
function claudeTurn() {
  return [
    ev({ kind: 'turn.started', turn: 't1', text: 'review my last turn' }),
    ev({ kind: 'tools.listed', turn: 't1', server: 'agentbus', tools: SERVED, tools_hidden: HIDDEN }),
    ev({ kind: 'model.requested', turn: 't1', exchange: 'x1', model: 'haiku', tools_offered: ['Bash', 'Read', 'ToolSearch', 'DeferredToolPlaceholder'] }),
    ev({ kind: 'model.responded', turn: 't1', exchange: 'x1', status: 200, stop_reason: 'tool_use' }),
    ev({
      kind: 'tool.requested',
      turn: 't1',
      exchange: 'x1',
      tool_id: 'u1',
      tool_name: 'ToolSearch',
      tool_input: { query: 'select:mcp__agentbus__list_agents,mcp__agentbus__review_turn,mcp__agentbus__list_turns', max_results: 5 },
    }),
    ev({ kind: 'tool.completed', turn: 't1', exchange: 'x2', tool_id: 'u1' }),
    ev({
      kind: 'model.requested',
      turn: 't1',
      exchange: 'x2',
      model: 'haiku',
      tools_offered: ['Bash', 'ToolSearch', 'mcp__agentbus__list_agents', 'mcp__agentbus__list_turns', 'mcp__agentbus__review_turn'],
    }),
    ev({ kind: 'model.responded', turn: 't1', exchange: 'x2', status: 200, stop_reason: 'tool_use' }),
    ev({ kind: 'tool.requested', turn: 't1', exchange: 'x2', tool_id: 'u2', tool_name: 'mcp__agentbus__list_agents', tool_input: {} }),
    ev({ kind: 'tool.requested', turn: 't1', exchange: 'x2', tool_id: 'u3', tool_name: 'mcp__agentbus__list_turns', tool_input: { limit: 3 } }),
    ev({ kind: 'tool.completed', turn: 't1', exchange: 'x3', tool_id: 'u2' }),
    ev({ kind: 'tool.completed', turn: 't1', exchange: 'x3', tool_id: 'u3' }),
    ev({
      kind: 'model.requested',
      turn: 't1',
      exchange: 'x3',
      model: 'haiku',
      tools_offered: ['Bash', 'ToolSearch', 'mcp__agentbus__list_agents', 'mcp__agentbus__list_turns', 'mcp__agentbus__review_turn'],
    }),
    ev({ kind: 'model.responded', turn: 't1', exchange: 'x3', status: 200, stop_reason: 'tool_use' }),
    ev({ kind: 'tool.requested', turn: 't1', exchange: 'x3', tool_id: 'u4', tool_name: 'mcp__agentbus__list_agents', tool_input: {} }),
    ev({ kind: 'tool.completed', turn: 't1', exchange: 'x4', tool_id: 'u4' }),
    ev({ kind: 'model.requested', turn: 't1', exchange: 'x4', model: 'haiku', tools_offered: ['Bash'] }),
    ev({ kind: 'model.responded', turn: 't1', exchange: 'x4', status: 200, stop_reason: 'end_turn', text: 'Queued.' }),
  ];
}

// A codex turn as the record holds it (codex-cli 0.164.0, 2026-11-11): no MCP
// tool by name in any call; exec's JavaScript calls them.
function codexTurn() {
  return [
    ev({ kind: 'turn.started', turn: 't2', text: 'ask for a review' }),
    ev({ kind: 'tools.listed', turn: 't2', server: 'agentbus', tools: SERVED }),
    ev({ kind: 'model.requested', turn: 't2', exchange: 'y1', model: 'gpt', tools_offered: ['exec', 'wait', 'list_agents', 'spawn_agent'] }),
    ev({ kind: 'model.responded', turn: 't2', exchange: 'y1', status: 200 }),
    ev({
      kind: 'tool.requested',
      turn: 't2',
      exchange: 'y1',
      tool_id: 'c1',
      tool_name: 'exec',
      tool_input:
        'const results=await Promise.allSettled([tools.mcp__agentbus__list_agents({}),tools.mcp__agentbus__list_turns({limit:5})]);',
    }),
    ev({ kind: 'model.requested', turn: 't2', exchange: 'y2', model: 'gpt', tools_offered: ['exec', 'wait', 'list_agents', 'spawn_agent'] }),
    ev({ kind: 'model.responded', turn: 't2', exchange: 'y2', status: 200 }),
    ev({
      kind: 'tool.requested',
      turn: 't2',
      exchange: 'y2',
      tool_id: 'c2',
      tool_name: 'exec',
      tool_input: 'text(await tools.mcp__agentbus__review_turn({agent:"a_1",turn:"t_0"}));\ntext(await tools.mcp__other_srv__ping({}));',
    }),
    // codex's own list_agents is not the AgentBus one.
    ev({ kind: 'tool.requested', turn: 't2', exchange: 'y2', tool_id: 'c3', tool_name: 'list_agents', tool_input: {} }),
  ];
}

describe('turnToolbox', () => {
  it('claude: served, loaded by ToolSearch, used, hidden', () => {
    const box = turnToolbox(turnDetail(claudeTurn()))!;
    expect(box.listed).toBe(true);
    expect(box.agentbus.map((t) => t.name)).toEqual(SERVED);
    const by = (n: string) => box.agentbus.find((t) => t.name === n)!;
    expect(toolState(by('list_agents'))).toBe('used ×2 · loaded in call 2');
    expect(toolState(by('list_turns'))).toBe('used ×1 · loaded in call 2');
    expect(toolState(by('review_turn'))).toBe('loaded in call 2');
    expect(by('review_turn').searchedIn).toBe(1);
    expect(toolState(by('ask_agent'))).toBe('available');
    expect(box.hidden).toEqual(HIDDEN);
    expect(box.other).toEqual([]);
    expect(toolboxSummary(box)).toBe('11 AgentBus tools · 2 used · 4 hidden');
  });

  it('codex: uses read from exec code, its own list_agents left out, another server found', () => {
    const box = turnToolbox(turnDetail(codexTurn()))!;
    const by = (n: string) => box.agentbus.find((t) => t.name === n)!;
    expect(box.agentbus).toHaveLength(11);
    expect(toolState(by('list_agents'))).toBe('used ×1');
    expect(toolState(by('review_turn'))).toBe('used ×1');
    expect(toolState(by('apply_turn'))).toBe('available');
    expect(box.hidden).toEqual([]);
    expect(box.other).toEqual([{ server: 'other_srv', tools: [{ name: 'ping', uses: 1 }] }]);
    expect(toolboxSummary(box)).toBe('11 AgentBus tools · 3 used · 1 other server');
  });

  it('a turn with no tools.listed and no MCP tool has no toolbox', () => {
    const d = turnDetail([
      ev({ kind: 'turn.started', turn: 't3', text: 'hi' }),
      ev({ kind: 'model.requested', turn: 't3', exchange: 'z1', tools_offered: ['Bash', 'Task'] }),
      ev({ kind: 'tool.requested', turn: 't3', exchange: 'z1', tool_id: 'k', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    ]);
    expect(turnToolbox(d)).toBeNull();
  });

  it('a turn recorded before the event shows the tools its calls name', () => {
    const d = turnDetail([
      ev({ kind: 'turn.started', turn: 't4', text: 'hi' }),
      ev({ kind: 'model.requested', turn: 't4', exchange: 'w1', tools_offered: ['mcp__agentbus__agentbus_list_agents'] }),
      ev({ kind: 'tool.requested', turn: 't4', exchange: 'w1', tool_id: 'k', tool_name: 'mcp__agentbus__agentbus_list_agents', tool_input: {} }),
    ]);
    const box = turnToolbox(d)!;
    expect(box.listed).toBe(false);
    expect(box.agentbus).toEqual([{ name: 'agentbus_list_agents', loadedIn: 1, uses: 1 }]);
  });
});

function turnOf(events: ReturnType<typeof ev>[], id: string): Turn {
  return {
    id,
    turnNumber: 1,
    sessionId: 's1',
    startedAt: events[0].time,
    durationMs: 1000,
    prompt: 'p',
    state: 'finished',
    agent: 'claude',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    costUsd: 0,
    costComplete: true,
    detail: turnDetail(events),
  } as unknown as Turn;
}

describe('the MCP tab', () => {
  const tab = (c: HTMLElement, label: string) =>
    Array.from(c.querySelectorAll('#d-tabs .tab')).find((b) => b.textContent === label)!;

  it('groups the tools, and the header line opens it', async () => {
    const r = await render(<RightPanel turn={turnOf(claudeTurn(), 't1')} totalTurns={1} />);
    const line = r.container.querySelector('#d-head .turn-tools')!;
    expect(line.textContent).toBe('11 AgentBus tools · 2 used · 4 hidden');
    await click(line);
    expect(tab(r.container, 'MCP').className).toContain('on');
    const body = r.container.querySelector('#d-body')!;
    expect(body.querySelector('.tab-sum')!.textContent).toBe(
      '11 AgentBus tools · 2 used · 4 hidden · what the turn could call; the Tools tab shows each call',
    );
    const heads = Array.from(body.querySelectorAll('.sub-h')).map((h) => h.textContent);
    expect(heads).toEqual(['AgentBus tools', 'Hidden by AgentBus']);
    const rows = Array.from(body.querySelectorAll('.mcp-t tr')).map((tr) => tr.textContent);
    expect(rows).toContain('list_agentsused ×2 · loaded in call 2');
    expect(rows).toContain('ask_agentavailable');
    expect(rows).toContain('ListAgentsreplaced by AgentBus tools');
    r.unmount();
  });

  it('says the tools are off for a turn without them, and the header has no line', async () => {
    const events = [
      ev({ kind: 'turn.started', turn: 't5', text: 'hi' }),
      ev({ kind: 'model.requested', turn: 't5', exchange: 'v1', tools_offered: ['Bash'] }),
      ev({ kind: 'model.responded', turn: 't5', exchange: 'v1', status: 200, stop_reason: 'end_turn' }),
    ];
    const r = await render(<RightPanel turn={turnOf(events, 't5')} totalTurns={1} />);
    expect(r.container.querySelector('#d-head .turn-tools')).toBeNull();
    await click(tab(r.container, 'MCP'));
    expect(r.container.querySelector('#d-body')!.textContent).toContain(
      'AgentBus tools are off for this turn ([agent_api] tools).',
    );
    r.unmount();
  });
});
