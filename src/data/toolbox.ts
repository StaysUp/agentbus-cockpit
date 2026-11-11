import { CockpitEvent, TurnDetail } from '../types';

// A turn's toolbox: the MCP tools it could call, from its own record.
//
// AgentBus tools come from the turn's tools.listed: control stores it when
// its tool server first answers tools/list for the turn's token, with the
// names served and the harness's own tools hidden for the turn
// (CLIENT_API.md, kind tools.listed). What one call sent is the Tools tab's;
// this is what the turn had.
//
// How each harness shows MCP tools in the record (2026-11-11):
// - claude names a tool mcp__<server>__<tool>. Claude Code 2.1.321 defers
//   them: the first calls offer ToolSearch only, a ToolSearch with
//   "select:mcp__agentbus__list_agents,..." loads them, and the calls after
//   it carry their schemas (model.requested tools_offered).
// - codex 0.164.0 offers none of them by name: its exec tool runs JavaScript
//   that calls tools.mcp__<server>__<tool>(...), so a use is that text in an
//   exec's tool_input.

export interface ToolboxTool {
  name: string;
  // The call (1-based, the turn's model calls without probes) that first
  // carried the tool's schema.
  loadedIn?: number;
  // The call whose reply asked ToolSearch to select the tool by name.
  searchedIn?: number;
  // How many times the turn called it.
  uses: number;
}

export interface ToolboxServer {
  server: string;
  tools: ToolboxTool[];
}

export interface HiddenTool {
  name: string;
  why: string;
}

export interface Toolbox {
  // The turn has a tools.listed. False: the AgentBus tools below, if any,
  // were read from the calls alone (a turn recorded before the event).
  listed: boolean;
  server: string;
  agentbus: ToolboxTool[];
  hidden: HiddenTool[];
  other: ToolboxServer[];
}

export const TOOL_SERVER = 'agentbus';

const MCP_NAME = /^mcp__(.+?)__(.+)$/;
// A codex exec's call of an MCP tool, in its JavaScript.
const MCP_IN_CODE = /\btools\.mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_]+)\s*\(/g;

function split(name: string): { server: string; tool: string } | undefined {
  const m = MCP_NAME.exec(name);
  return m ? { server: m[1], tool: m[2] } : undefined;
}

function inputText(input: CockpitEvent['tool_input']): string {
  if (input === undefined || input === null) return '';
  return typeof input === 'string' ? input : JSON.stringify(input);
}

// The names a ToolSearch selected: "select:a,b" names them; a keyword
// query names none.
function selected(input: CockpitEvent['tool_input']): string[] {
  let q: unknown = input;
  if (typeof input === 'string') {
    try {
      q = JSON.parse(input);
    } catch {
      q = { query: input };
    }
  }
  const query = q && typeof q === 'object' ? (q as Record<string, unknown>).query : undefined;
  if (typeof query !== 'string' || !query.startsWith('select:')) return [];
  return query
    .slice('select:'.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function turnToolbox(detail: TurnDetail): Toolbox | null {
  const listedEv = detail.events.find((e) => e.kind === 'tools.listed');
  const server = typeof listedEv?.server === 'string' && listedEv.server ? listedEv.server : TOOL_SERVER;
  const calls = detail.modelCalls.filter((p) => !p.requested.probe);
  const callOf = (x?: string) => {
    if (!x) return undefined;
    const i = calls.findIndex((p) => p.requested.exchange === x);
    return i < 0 ? undefined : i + 1;
  };

  // Every server's tools, in first-seen order.
  const servers = new Map<string, Map<string, ToolboxTool>>();
  const tool = (s: string, name: string): ToolboxTool => {
    let m = servers.get(s);
    if (!m) {
      m = new Map();
      servers.set(s, m);
    }
    let t = m.get(name);
    if (!t) {
      t = { name, uses: 0 };
      m.set(name, t);
    }
    return t;
  };
  if (listedEv && Array.isArray(listedEv.tools)) {
    for (const n of listedEv.tools) if (typeof n === 'string') tool(server, n);
  }

  calls.forEach((p, i) => {
    for (const n of p.requested.tools_offered ?? []) {
      const s = split(n);
      if (!s) continue;
      const t = tool(s.server, s.tool);
      if (t.loadedIn === undefined) t.loadedIn = i + 1;
    }
  });
  for (const e of detail.events) {
    if (e.kind !== 'tool.requested' || e.probe) continue;
    const name = typeof e.tool_name === 'string' ? e.tool_name : '';
    const s = split(name);
    if (s) {
      tool(s.server, s.tool).uses++;
      continue;
    }
    if (name === 'ToolSearch') {
      for (const n of selected(e.tool_input)) {
        const sel = split(n);
        if (!sel) continue;
        const t = tool(sel.server, sel.tool);
        if (t.searchedIn === undefined) t.searchedIn = callOf(e.exchange);
      }
      continue;
    }
    const text = inputText(e.tool_input);
    if (!text.includes('mcp__')) continue;
    for (const m of text.matchAll(MCP_IN_CODE)) tool(m[1], m[2]).uses++;
  }

  const hidden: HiddenTool[] = [];
  if (listedEv && Array.isArray(listedEv.tools_hidden)) {
    for (const h of listedEv.tools_hidden as unknown[]) {
      if (!h || typeof h !== 'object') continue;
      const { name, why } = h as Record<string, unknown>;
      if (typeof name === 'string') hidden.push({ name, why: typeof why === 'string' ? why : '' });
    }
  }
  const agentbus = [...(servers.get(server)?.values() ?? [])];
  const other = [...servers.entries()]
    .filter(([s]) => s !== server)
    .map(([s, m]) => ({ server: s, tools: [...m.values()] }));
  if (!listedEv && agentbus.length === 0 && other.length === 0) return null;
  return { listed: !!listedEv, server, agentbus, hidden, other };
}

// One tool's state, in words: "used ×2", "loaded in call 3", "available".
export function toolState(t: ToolboxTool): string {
  const parts: string[] = [];
  if (t.uses > 0) parts.push(`used ×${t.uses}`);
  if (t.loadedIn !== undefined) parts.push(`loaded in call ${t.loadedIn}`);
  else if (t.searchedIn !== undefined) parts.push(`selected by ToolSearch in call ${t.searchedIn}`);
  if (parts.length === 0) parts.push('available');
  return parts.join(' · ');
}

// The turn header's line: "11 AgentBus tools · 2 used · 4 hidden".
export function toolboxSummary(box: Toolbox): string {
  const n = box.agentbus.length;
  const used = box.agentbus.filter((t) => t.uses > 0).length;
  const parts = [`${n} AgentBus tool${n === 1 ? '' : 's'}`, `${used} used`];
  if (box.hidden.length) parts.push(`${box.hidden.length} hidden`);
  const others = box.other.length;
  if (others) parts.push(`${others} other server${others === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
