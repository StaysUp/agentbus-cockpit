import { CallContext, ContextPiece } from '../types';

// How the Context tab lays out one call's request. Pieces come in the
// request's own order, which for Claude Code puts the messages before the
// system prompt and the tools; the tab shows system, tools, then messages,
// each in its own order.

// Where a message sits in the request.
//  - replayed: one of the first `replayed` messages, put in front by the
//    gateway from an earlier turn's stored history (own replay).
//  - new: the message this turn was started with.
//  - turn: anything after it, such as Claude Code's system message and the
//    turn's own tool loop.
export type MessagePart = 'replayed' | 'new' | 'turn';

// What a Responses API input item is, read from its shape (codex).
//  - system: codex's base instructions.
//  - tools: the additional_tools item.
//  - context: another item codex puts in front of the prompt (permissions,
//    skills, AGENTS.md, the environment).
//  - note: the recovery note AgentBus writes after a turn that did not finish.
//  - prompt: the person's message.
//  - other: a message, a reasoning item, a tool call or its output.
export type ItemRole = 'system' | 'tools' | 'context' | 'note' | 'prompt' | 'other';

export interface MessageRow {
  // The piece's place in the call's pieces, so a full read can fill it in.
  pieceIndex: number;
  // 0-based among the messages.
  index: number;
  piece: ContextPiece;
  role: string;
  part: MessagePart;
  // A role-system message: Claude Code's environment, hook texts and tool
  // additions, not the person's words.
  claudeCode: boolean;
  // Set on a Responses input item, read from its shape; undefined on Claude's.
  item?: ItemRole;
}

export interface PieceRow {
  pieceIndex: number;
  piece: ContextPiece;
  // A Responses input item shown in the system or tools section, and its role.
  item?: MessageRow;
}

export interface ContextLayout {
  system: PieceRow[];
  tools: PieceRow[];
  // Every message or input item, with its place among them. On a Responses
  // request the rows with item 'system' or 'tools' are also in system and
  // tools; they keep their index so the replayed count still lines up.
  messages: MessageRow[];
  // 'responses' when the request has Responses API items (codex), else 'messages'.
  format: 'messages' | 'responses';
  // How many messages are replayed, after clamping to what is there.
  replayed: number;
}

export interface LayoutOptions {
  // `replayed` on the call's model.requested.
  replayed?: number;
  // `continuity` on the turn's turn.started.
  continuity?: 'replay' | 'resume';
}

const SYSTEM_KINDS = new Set(['system', 'instructions']);
const MESSAGE_KINDS = new Set(['message', 'input_item']);

// The prefix of the note AgentBus writes after a turn that did not finish.
export const NOTE_PREFIX = '[Note from AgentBus, not written by the model]';

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// codex's own labels on an item's content, from its passthrough metadata.
function kindsOf(json: unknown): string[] {
  const meta = rec(rec(json)?.internal_chat_message_metadata_passthrough);
  const k = meta?.content_item_kinds;
  return Array.isArray(k) ? k.filter((x): x is string => typeof x === 'string') : [];
}

// The text of a message item's content, for reading its first words.
function itemText(json: unknown): string {
  const c = rec(json)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((p) => (typeof rec(p)?.text === 'string' ? (rec(p)!.text as string) : '')).join('');
}

// Reads one input item by structure, never by its text, except the note.
// Without json (the outline) only the tools item can be told, by its label.
export function itemRole(piece: ContextPiece): ItemRole {
  const j = rec(piece.json);
  if (!j) return piece.label === 'additional_tools' ? 'tools' : 'other';
  const type = typeof j.type === 'string' ? j.type : '';
  if (type === 'additional_tools') return 'tools';
  const role = typeof j.role === 'string' ? j.role : '';
  if (type !== 'message' && type !== '') return 'other';
  const kinds = kindsOf(j);
  if (role === 'user' && kinds.includes('user.text')) return 'prompt';
  if (role === 'developer' && kinds.includes('model.base_instructions')) return 'system';
  if ((role === 'developer' || role === 'user') && kinds.length > 0) return 'context';
  if (role === 'developer' && kinds.length === 0 && itemText(j).startsWith(NOTE_PREFIX)) return 'note';
  return 'other';
}

// True when the request is in the Responses layout (codex): it has input
// items or an instructions string. Decided by the pieces' kinds.
export function isResponses(ctx: CallContext): boolean {
  return ctx.pieces.some((p) => p.kind === 'input_item' || p.kind === 'instructions');
}

// The tools inside an additional_tools item, namespaces flattened. undefined
// when its text is not read yet.
export function leafTools(json: unknown): { name: string; json: unknown }[] | undefined {
  const tools = rec(json)?.tools;
  if (!Array.isArray(tools)) return undefined;
  const out: { name: string; json: unknown }[] = [];
  const walk = (list: unknown[], prefix: string) => {
    for (const t of list) {
      const o = rec(t);
      const name = typeof o?.name === 'string' ? o.name : typeof o?.type === 'string' ? o.type : 'tool';
      if (o && Array.isArray(o.tools)) walk(o.tools, prefix ? `${prefix}.${name}` : name);
      else out.push({ name: prefix ? `${prefix}.${name}` : name, json: t });
    }
  };
  walk(tools, '');
  return out;
}

// How many tools a tools section holds, when every piece says. undefined
// when an additional_tools item has no text yet.
export function toolCount(rows: PieceRow[]): number | undefined {
  let n = 0;
  for (const r of rows) {
    if (r.item) {
      const leaves = leafTools(r.piece.json);
      if (!leaves) return undefined;
      n += leaves.length;
    } else n += 1;
  }
  return n;
}

export function layoutContext(ctx: CallContext, opts: LayoutOptions = {}): ContextLayout {
  const responses = isResponses(ctx);
  const system: PieceRow[] = [];
  const tools: PieceRow[] = [];
  const msgPieces: PieceRow[] = [];
  ctx.pieces.forEach((piece, pieceIndex) => {
    if (SYSTEM_KINDS.has(piece.kind)) system.push({ pieceIndex, piece });
    else if (piece.kind === 'tool') tools.push({ pieceIndex, piece });
    else msgPieces.push({ pieceIndex, piece });
  });

  const want = typeof opts.replayed === 'number' && opts.replayed > 0 ? Math.floor(opts.replayed) : 0;
  const replayed = Math.min(want, msgPieces.length);
  // With the vendor's resume, the earlier turns are inside the messages and
  // nothing marks where they end, so no message is called the new one.
  const resume = opts.continuity === 'resume';
  const roles = responses ? msgPieces.map((r) => itemRole(r.piece)) : [];
  // Claude: the message at `replayed` is the new one. codex: the gateway may
  // keep a changed context item in front of the prompt, so the new message is
  // the first prompt item from `replayed` on.
  let newAt = resume ? -1 : replayed;
  if (responses && !resume) newAt = roles.findIndex((r, i) => i >= replayed && r === 'prompt');

  const messages: MessageRow[] = msgPieces.map(({ pieceIndex, piece }, index) => {
    const role = MESSAGE_KINDS.has(piece.kind) ? piece.label : piece.kind;
    let part: MessagePart = 'turn';
    if (index < replayed) part = 'replayed';
    else if (index === newAt && (responses || role === 'user')) part = 'new';
    const row: MessageRow = { pieceIndex, index, piece, role, part, claudeCode: !responses && role === 'system' };
    if (responses) {
      row.item = roles[index];
      if (row.item === 'system') system.push({ pieceIndex, piece, item: row });
      if (row.item === 'tools') tools.push({ pieceIndex, piece, item: row });
    }
    return row;
  });
  return { system, tools, messages, format: responses ? 'responses' : 'messages', replayed };
}

export interface Sum {
  count: number;
  size: number;
  // The service's estimate summed; null when no piece had one.
  approxTokens: number | null;
}

export function sum(pieces: ContextPiece[]): Sum {
  let size = 0;
  let tok: number | null = null;
  for (const p of pieces) {
    size += p.size;
    if (typeof p.approx_tokens === 'number') tok = (tok ?? 0) + p.approx_tokens;
  }
  return { count: pieces.length, size, approxTokens: tok };
}

// One content block of a message, read for display.
export interface Block {
  type: string;
  // Claude Code's own material inside a message: a <system-reminder> text, or
  // a block that is not text (tool additions and the like) in a system message.
  claudeCode: boolean;
  // What to show: the text, or the block as indented JSON.
  text: string;
  // A short name: a tool's name for tool_use, else empty.
  name?: string;
  // Set on codex's own material (context items): who wrote it.
  harness?: string;
  // Shown in place of the character count, such as the size of encrypted bytes.
  note?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && str((b as { text?: unknown }).text) !== undefined ? (b as { text: string }).text : pretty(b)))
      .join('\n\n');
  }
  return pretty(content);
}

const REMINDER = /^\s*<system-reminder>/;

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return pretty(content);
  return content
    .map((b) => (typeof rec(b)?.text === 'string' ? (rec(b)!.text as string) : pretty(b)))
    .join('\n\n');
}

// A Responses API item (codex), or the list of them in a reply, as blocks.
function itemBlocks(json: unknown): Block[] {
  if (Array.isArray(json)) return json.flatMap(itemBlocks);
  const it = rec(json);
  if (!it) return [{ type: 'json', claudeCode: false, text: pretty(json) }];
  const type = str(it.type) ?? 'json';
  const name = str(it.name);
  if (type === 'message' || (type === 'json' && it.content !== undefined)) {
    const kinds = kindsOf(it);
    const ctx = (it.role === 'developer' || it.role === 'user') && kinds.length > 0 && !kinds.includes('user.text') && !kinds.includes('model.base_instructions');
    const note = it.role === 'developer' && kinds.length === 0 && itemText(it).startsWith(NOTE_PREFIX);
    const parts = Array.isArray(it.content) ? it.content : [it.content];
    return parts.map((raw): Block => {
      const t = typeof raw === 'string' ? raw : rec(raw) && typeof rec(raw)!.text === 'string' ? (rec(raw)!.text as string) : undefined;
      if (t === undefined) return { type: str(rec(raw)?.type) ?? 'json', claudeCode: ctx, harness: ctx ? 'Codex' : undefined, text: pretty(raw) };
      return { type: note ? 'AgentBus note' : 'text', claudeCode: ctx, harness: ctx ? 'Codex' : undefined, text: t };
    });
  }
  if (type === 'reasoning' || type === 'compaction') {
    const enc = it.encrypted_content;
    const summary = Array.isArray(it.summary) ? partsText(it.summary) : '';
    const bytesNote = typeof enc === 'string' ? `encrypted ${type === 'reasoning' ? 'reasoning' : 'compaction'} (${enc.length.toLocaleString()} bytes)` : `${type} (no encrypted content)`;
    return [{ type, claudeCode: false, text: summary ? `${bytesNote}\n\n${summary}` : bytesNote, note: typeof enc === 'string' ? `${enc.length.toLocaleString()} bytes` : undefined }];
  }
  if (type === 'function_call') {
    let args = it.arguments;
    if (typeof args === 'string') {
      try {
        args = pretty(JSON.parse(args));
      } catch {
        /* leave the raw text */
      }
    }
    return [{ type, claudeCode: false, name, text: typeof args === 'string' ? args : pretty(args) }];
  }
  if (type === 'custom_tool_call') return [{ type, claudeCode: false, name, text: typeof it.input === 'string' ? it.input : pretty(it.input) }];
  if (type === 'function_call_output' || type === 'custom_tool_call_output') return [{ type, claudeCode: false, text: partsText(it.output) }];
  return [{ type, claudeCode: false, name, text: pretty(it) }];
}

// The blocks of a message piece's json (Anthropic: {role, content}). A
// Responses item (it has a string `type`) or a list of them is read by
// itemBlocks. Any other shape comes back as one JSON block.
export function blocksOf(json: unknown, role: string): Block[] {
  if (typeof json === 'string') return [{ type: 'text', claudeCode: false, text: json }];
  if (Array.isArray(json) || (rec(json) && typeof rec(json)!.type === 'string')) return itemBlocks(json);
  const sys = role === 'system';
  if (!json || typeof json !== 'object') return [{ type: 'json', claudeCode: sys, text: pretty(json) }];
  const content = (json as { content?: unknown }).content;
  if (typeof content === 'string') {
    return [{ type: 'text', claudeCode: sys || REMINDER.test(content), text: content }];
  }
  if (!Array.isArray(content)) return [{ type: 'json', claudeCode: sys, text: pretty(json) }];
  return content.map((raw): Block => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const type = str(b.type) ?? 'json';
    if (type === 'text' && typeof b.text === 'string') {
      return { type, claudeCode: sys || REMINDER.test(b.text), text: b.text };
    }
    if (type === 'tool_use') return { type, claudeCode: false, name: str(b.name), text: pretty(b.input) };
    if (type === 'tool_result') return { type, claudeCode: false, text: toolResultText(b.content) };
    if (type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
      return { type, claudeCode: false, text: b.thinking };
    }
    return { type, claudeCode: sys, text: pretty(b) };
  });
}

// What the walk back through earlier turns needs of one turn.
export interface TurnInfo {
  // `replay_from` on its turn.started, when it has one.
  replayFrom?: string;
  // True for a turn the vendor's resume continued: its messages sit inside
  // the vendor's own history and nothing marks where they end.
  resumed: boolean;
  // True for a turn that took over from an interrupted one (recovered_from).
  recovered: boolean;
  // How many messages were put in front of its model calls; 0 for a first
  // turn, undefined when the events do not say.
  replayed?: number;
}

const trimmed = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

// Reads a turn's events for the walk. replayed comes from its first
// model.requested that carries a number; a turn that continued from nothing
// replayed none.
export function turnInfo(events: { kind: string; [k: string]: unknown }[]): TurnInfo {
  const start = events.find((e) => e.kind === 'turn.started');
  const replayFrom = trimmed(start?.replay_from);
  const resumed = start?.continuity === 'resume';
  const recovered = trimmed(start?.recovered_from) !== undefined;
  let replayed: number | undefined;
  for (const e of events) {
    if (e.kind === 'model.requested' && typeof e.replayed === 'number' && e.replayed >= 0) {
      replayed = Math.floor(e.replayed);
      break;
    }
  }
  if (replayed === undefined && !replayFrom && !resumed && !recovered) replayed = 0;
  return { replayFrom, resumed, recovered, replayed };
}

// A run of the replayed messages and where it came from.
//  - turn: messages [from, to) were that turn's own.
//  - earlier: messages [from, to) could not be given to a turn.
export interface ReplayGroup {
  kind: 'turn' | 'earlier';
  turnId?: string;
  from: number;
  to: number;
  // Why an 'earlier' group is one, in plain words.
  why?: string;
}

// Splits the first `total` messages of a call by the turn each came from,
// oldest first. `source` is the turn named by the call's turn's replay_from.
// It walks back one turn at a time: the messages a turn saw replayed were
// its predecessor's history, and the rest were its own. The walk stops at a
// first turn, at a resumed or recovered turn, and wherever a turn's events
// are missing or disagree; what is left over is one 'earlier' group.
export async function splitReplayed(
  total: number,
  source: string | undefined,
  getInfo: (turnId: string) => Promise<TurnInfo | undefined>
): Promise<ReplayGroup[]> {
  if (total <= 0) return [];
  const groups: ReplayGroup[] = [];
  let end = total;
  let id = source;
  let why = 'The turn this history came from is not known.';
  const seen = new Set<string>();
  while (id !== undefined && end > 0) {
    if (seen.has(id)) {
      why = 'The turns point back at each other.';
      break;
    }
    seen.add(id);
    let info: TurnInfo | undefined;
    try {
      info = await getInfo(id);
    } catch {
      info = undefined;
    }
    if (!info) {
      why = 'The events of an earlier turn could not be read.';
      break;
    }
    if (info.resumed) {
      why = 'A turn here was continued by the vendor’s resume, so its messages cannot be told apart from the ones before it.';
      break;
    }
    if (info.replayed === undefined || info.replayed > end) {
      why = 'The events do not say how much history that turn had in front of it.';
      break;
    }
    groups.push({ kind: 'turn', turnId: id, from: info.replayed, to: end });
    end = info.replayed;
    if (end === 0) break;
    if (info.recovered) {
      why = 'A turn here took over from an interrupted one, so the chain stops there.';
      break;
    }
    if (!info.replayFrom) {
      why = 'No earlier turn is named.';
      break;
    }
    id = info.replayFrom;
  }
  if (end > 0) groups.push({ kind: 'earlier', from: 0, to: end, why });
  return groups.reverse();
}
