// Call pairing within a turn, shared by the replay and live sources, and the
// replay source's own grouping of a recorded file into turns and sessions.
// The rules come from CLIENT_API.md, "Turns".
import {
  AgentSummary,
  SavedAgent,
  CockpitEvent,
  ModelCallPair,
  SessionSummary,
  ToolCallPair,
  Turn,
  TurnDetail,
  TurnOrigin,
  TurnState,
  Usage,
} from '../types';

// A turn's origin as turn.started and GET /api/v0/turns send it.
export interface ApiOrigin {
  kind: string;
  session?: string;
  turn?: string;
  job?: string;
  job_kind?: string;
  agent?: string;
}

// A turn's origin as the screens read it; a kind this cockpit does not know is
// left out.
export function turnOrigin(o: unknown): TurnOrigin | undefined {
  const a = o as ApiOrigin | undefined;
  if (!a || typeof a !== 'object' || (a.kind !== 'asked' && a.kind !== 'result')) return undefined;
  return { kind: a.kind, session: a.session, turn: a.turn, job: a.job, jobKind: a.job_kind, agent: a.agent };
}

// Kinds that belong to the session, not to any turn.
const SESSION_KINDS = new Set([
  'session.registered',
  'session.opened',
  'session.closed',
  'events.dropped',
]);

export function extractCleanPrompt(rawText: string): string {
  if (!rawText) return '';
  const cleaned = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  return cleaned || rawText.trim();
}

export function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

export function addUsage(target: Usage, source?: Usage | null): void {
  if (!source) return;
  target.input_tokens += source.input_tokens || 0;
  target.output_tokens += source.output_tokens || 0;
  target.cache_read_tokens = (target.cache_read_tokens || 0) + (source.cache_read_tokens || 0);
  target.cache_write_tokens = (target.cache_write_tokens || 0) + (source.cache_write_tokens || 0);
}

// The cost of a set of events: the sum of cost_usd over their model.responded
// events. Complete only if every one has a cost_usd and cost_complete true.
// usd is null when no model.responded carries a cost. Completeness is tracked
// apart from the sum: an unpriced call leaves usd null but complete false, so
// a priced call after it is still a lower bound. No calls at all is complete.
export function turnCost(events: CockpitEvent[]): { usd: number | null; complete: boolean } {
  let usd: number | null = null;
  let complete = true;
  for (const e of events) {
    if (e.kind !== 'model.responded') continue;
    if (typeof e.cost_usd === 'number') usd = (usd ?? 0) + e.cost_usd;
    if (typeof e.cost_usd !== 'number' || e.cost_complete !== true) complete = false;
  }
  return { usd, complete };
}

// One call's cost added to a session row. usd undefined is an unpriced call:
// the total stays and becomes incomplete. Completeness is kept apart from the
// sum: a row whose total is null after an unpriced call has cost_complete
// false, and stays incomplete when a priced call follows. Only a row that says
// nothing about completeness (undefined) counts as complete so far.
export function addCost(session: SessionSummary, usd: number | undefined, complete: boolean): SessionSummary {
  const wasComplete = session.cost_complete !== false;
  return {
    ...session,
    cost_usd: usd !== undefined ? (session.cost_usd ?? 0) + usd : session.cost_usd,
    cost_complete: wasComplete && usd !== undefined && complete,
  };
}

// A streamed model.responded adds its cost to its session's shown total.
export function addStreamedCost(session: SessionSummary, event: CockpitEvent): SessionSummary {
  if (event.kind !== 'model.responded' || event.session !== session.id) return session;
  const usd = typeof event.cost_usd === 'number' ? event.cost_usd : undefined;
  return addCost(session, usd, event.cost_complete === true);
}

function bySeq(events: CockpitEvent[]): CockpitEvent[] {
  // Stable: events without seq keep their file order.
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.seq ?? a.i) - (b.e.seq ?? b.i) || a.i - b.i)
    .map((x) => x.e);
}

// Pair each model.requested with the model.responded of the same exchange.
// Only events with no exchange at all fall back to "the next unused reply".
export function pairModelCalls(events: CockpitEvent[]): ModelCallPair[] {
  const replies = events.filter((e) => e.kind === 'model.responded');
  const used = new Set<CockpitEvent>();
  const pairs: ModelCallPair[] = [];
  events.forEach((evt, idx) => {
    if (evt.kind !== 'model.requested') return;
    let responded: CockpitEvent | undefined;
    if (evt.exchange) {
      responded = replies.find((r) => r.exchange === evt.exchange && !used.has(r));
    } else {
      responded = events
        .slice(idx + 1)
        .find((r) => r.kind === 'model.responded' && !r.exchange && !used.has(r));
    }
    if (responded) used.add(responded);
    pairs.push({ requested: evt, responded });
  });
  return pairs;
}

// Pair each tool.requested in `calls` with its tool.completed, matched by tool_id
// across `sessionEvents` (a result can land in another turn after compaction).
// A call with a tool_id and no matching result is pending. Only a call with no
// tool_id falls back to the next unused result that also has no tool_id.
export function pairToolCalls(calls: CockpitEvent[], sessionEvents: CockpitEvent[]): ToolCallPair[] {
  const results = sessionEvents.filter((e) => e.kind === 'tool.completed');
  const used = new Set<CockpitEvent>();
  const pairs: ToolCallPair[] = [];
  for (const call of calls) {
    if (call.kind !== 'tool.requested') continue;
    let completed: CockpitEvent | undefined;
    if (call.tool_id) {
      completed = results.find((r) => r.tool_id === call.tool_id && !used.has(r));
    } else {
      const start = sessionEvents.indexOf(call);
      completed = sessionEvents
        .slice(start + 1)
        .find((r) => r.kind === 'tool.completed' && !r.tool_id && !used.has(r));
    }
    if (completed) used.add(completed);
    pairs.push({ requested: call, completed });
  }
  return pairs;
}

// One turn's events, oldest first, with its calls paired and its prompt and
// final answer read out. The same for the live and the replay source.
export function turnDetail(rawEvents: CockpitEvent[]): TurnDetail {
  const events = bySeq(rawEvents);
  const start = events.find((e) => e.kind === 'turn.started');
  const rawPrompt = typeof start?.text === 'string' ? start.text : undefined;
  const modelCalls = pairModelCalls(events);
  const toolCalls = pairToolCalls(events, events);
  // The answer is the last exchange's reply, whatever order replies arrived in.
  const lastReply = modelCalls.length > 0 ? modelCalls[modelCalls.length - 1].responded : undefined;
  const text = lastReply && typeof lastReply.text === 'string' && lastReply.text !== '' ? lastReply.text : undefined;
  return {
    events,
    modelCalls,
    toolCalls,
    rawPrompt,
    prompt: rawPrompt === undefined ? undefined : extractCleanPrompt(rawPrompt),
    agentResponse: text,
  };
}

// Add streamed events to a loaded turn. An event already held (same id) is
// left out: the stream can resend what the turn's events already had.
export function addTurnEvents(detail: TurnDetail, events: CockpitEvent[]): TurnDetail {
  const held = new Set(detail.events.map((e) => e.id));
  const fresh: CockpitEvent[] = [];
  for (const e of events) {
    if (held.has(e.id)) continue;
    held.add(e.id);
    fresh.push(e);
  }
  return fresh.length === 0 ? detail : turnDetail([...detail.events, ...fresh]);
}

// --- Replay only. A recorded file has no turn list, so the replay source
// groups its events into turns here, by the rules GET /api/v0/turns uses.

// GET /api/v0/turns cuts a turn's reply to its first 500 characters (code
// points, never a split one).
export const REPLY_PREVIEW_CHARS = 500;

export function replyPreview(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= REPLY_PREVIEW_CHARS) return { text, truncated: false };
  return { text: chars.slice(0, REPLY_PREVIEW_CHARS).join(''), truncated: true };
}

// A turn's state by the API's rule: a run's turn (it has session.opened) is
// running until its session.closed, then finished on exit code 0 with no
// error, else failed. Any other turn is finished once it has a turn.completed.
function replayState(turnEvents: CockpitEvent[]): { state: TurnState; ended?: CockpitEvent; stopped?: boolean } {
  const opened = turnEvents.some((e) => e.kind === 'session.opened');
  const closed = turnEvents.find((e) => e.kind === 'session.closed');
  if (opened && closed) {
    const ok = closed.exit_code === 0 && !closed.error;
    return { state: ok ? 'finished' : 'failed', ended: closed, stopped: closed.stopped === true || undefined };
  }
  const completions = turnEvents.filter((e) => e.kind === 'turn.completed');
  if (!opened && completions.length > 0) return { state: 'finished', ended: completions[completions.length - 1] };
  return { state: 'running' };
}

// Group a session's events into turns, oldest first, each with its detail.
// Events marked `probe` (the harness's own check, such as Claude Code's startup
// quota check) carry no turn id and are never part of a turn.
// With `turn` on the events, a turn is every event carrying that id, whenever it
// arrived. Without it (files recorded before `turn` existed), a turn runs from one
// turn.started to the next, or to its turn.completed.
export function buildTurns(sessionId: string, rawEvents: CockpitEvent[]): Turn[] {
  const events = bySeq(rawEvents);
  const groups: { key: string; events: CockpitEvent[] }[] = [];

  if (events.some((e) => e.turn)) {
    const byKey = new Map<string, CockpitEvent[]>();
    for (const e of events) {
      if (!e.turn || e.probe) continue;
      let list = byKey.get(e.turn);
      if (!list) {
        list = [];
        byKey.set(e.turn, list);
        groups.push({ key: e.turn, events: list });
      }
      list.push(e);
    }
    // A turn starts at its turn.started; order turns by that, else by first event.
    const startSeq = (g: { events: CockpitEvent[] }) => {
      const s = g.events.find((e) => e.kind === 'turn.started') ?? g.events[0];
      return events.indexOf(s);
    };
    groups.sort((a, b) => startSeq(a) - startSeq(b));
  } else {
    let current: CockpitEvent[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const start = current.find((e) => e.kind === 'turn.started') ?? current[0];
      groups.push({ key: start.exchange || `t-${sessionId}-${groups.length + 1}`, events: current });
      current = [];
    };
    for (const e of events) {
      if (SESSION_KINDS.has(e.kind) || e.probe) continue;
      if (e.kind === 'turn.started' && current.length > 0) flush();
      current.push(e);
      if (e.kind === 'turn.completed') flush();
    }
    flush();
  }

  return groups.map((g, i) => {
    const turnEvents = g.events;
    const detail = turnDetail(turnEvents);
    const turnStart = turnEvents.find((e) => e.kind === 'turn.started') ?? turnEvents[0];
    const named = turnStart.kind === 'turn.started' ? turnStart : undefined;
    const { state, ended, stopped } = replayState(turnEvents);
    const completed = turnEvents.filter((e) => e.kind === 'turn.completed').pop();

    let usage: Usage | null = null;
    for (const e of turnEvents) {
      if (e.kind !== 'model.responded' || !e.usage) continue;
      usage ??= createEmptyUsage();
      addUsage(usage, e.usage);
    }
    const cost = turnCost(turnEvents);

    const startMs = new Date(turnStart.time).getTime();
    const endMs = ended ? new Date(ended.time).getTime() : NaN;
    const durationMs = isNaN(endMs - startMs) ? undefined : Math.max(0, endMs - startMs);
    const reply = replyPreview(detail.agentResponse ?? '');
    const lastCall = detail.modelCalls[detail.modelCalls.length - 1];

    return {
      id: g.key,
      turnNumber: i + 1,
      sessionId,
      startedAt: turnStart.time,
      endedAt: ended?.time,
      durationMs,
      prompt: detail.prompt ?? '',
      reply: reply.text || undefined,
      replyTruncated: reply.truncated,
      model: (lastCall?.requested.model as string) || undefined,
      modelCalls: detail.modelCalls.length,
      agent: (named?.agent as string) || undefined,
      agentId: (named?.agent_id as string) || undefined,
      folder: (named?.folder as string) || undefined,
      folderRef: (named?.folder_ref as string) || undefined,
      origin: turnOrigin(named?.origin),
      state,
      stopped,
      outcome: completed ? (completed.outcome as string) || 'finished' : undefined,
      usage,
      costUsd: cost.usd,
      costComplete: cost.complete,
      startedSeq: turnStart.seq,
      detail,
    };
  });
}

// Session summary from its events alone, for the replay source.
// `dropReports` is every events.dropped in the source, whichever session it
// was filed under: a report filed under another session (such as `default`)
// can still name this one, or say all_sessions. Without it, only this
// session's own events are looked at.
export function summarizeSession(
  sessionId: string,
  rawEvents: CockpitEvent[],
  turns: Turn[],
  dropReports?: CockpitEvent[]
): SessionSummary {
  const events = bySeq(rawEvents);
  const first = events[0];
  const last = events[events.length - 1];

  const named = latestNamed(events);
  const client = (events.find((e) => typeof e.client === 'string' && e.client)?.client as string) || '';

  // The latest turn or run that names them gives the agent and folder, as GET
  // /api/v0/sessions reads them. Older files have none, so fall back to the
  // client string and to paths seen in tool inputs.
  let agent = (named?.agent as string) || '';
  if (!agent) agent = client.toLowerCase().includes('claude') ? 'claude' : 'unknown';
  // The first that names one gives first_agent, as the API reads it.
  const firstNaming = events.find((e) => NAMING_KINDS.has(e.kind) && typeof e.agent === 'string' && e.agent);
  const firstAgent = (firstNaming?.agent as string) || undefined;
  const firstAgentId = (firstNaming?.agent_id as string) || undefined;
  let folder = (named?.folder as string) || '';
  if (!folder) folder = guessFolder(events);

  // Open while a run's child is running: a session.opened whose hold has no
  // session.closed yet.
  const holds = new Set<string>();
  for (const e of events) {
    const hold = e.hold as string | undefined;
    if (!hold) continue;
    if (e.kind === 'session.opened') holds.add(hold);
    if (e.kind === 'session.closed') holds.delete(hold);
  }

  const usage = createEmptyUsage();
  for (const t of turns) addUsage(usage, t.usage);

  // Cost by the API's rule: the sum over every model.responded of the session
  // (a probe's call costs money too, though it belongs to no turn). Incomplete
  // if any call is, or if an events.dropped names this session or says all_sessions.
  const cost = turnCost(events);
  const dropped = (dropReports ?? events).some(
    (e) =>
      e.kind === 'events.dropped' &&
      (e.all_sessions === true || (Array.isArray(e.sessions) && (e.sessions as unknown[]).includes(sessionId)))
  );

  return {
    id: sessionId,
    agent,
    first_agent: firstAgent,
    ...(firstAgentId ? { first_agent_id: firstAgentId } : {}),
    client,
    folder: folder || undefined,
    ...(named?.folder_ref ? { folder_ref: named.folder_ref as string } : {}),
    title: turns[0]?.prompt || sessionId,
    started: first?.time ?? '',
    last: last?.time ?? '',
    open: holds.size > 0,
    turns: turns.length,
    usage,
    cost_usd: cost.usd,
    cost_complete: cost.complete && !dropped,
  };
}

// The events that can name a session's agent and folder: a run's turn.started,
// a run's session.opened, and session.registered in files from before
// 2026-11-05. The latest one that names an agent wins.
const NAMING_KINDS = new Set(['turn.started', 'session.opened', 'session.registered']);

function latestNamed(events: CockpitEvent[]): CockpitEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (NAMING_KINDS.has(e.kind) && typeof e.agent === 'string' && e.agent) return e;
  }
  return undefined;
}

function guessFolder(events: CockpitEvent[]): string {
  for (const e of events) {
    if (e.kind !== 'tool.requested' || !e.tool_input || typeof e.tool_input !== 'object') continue;
    const input = e.tool_input as Record<string, unknown>;
    if (typeof input.command === 'string') {
      const match = input.command.match(/cd\s+([^\s&]+)/);
      if (match) return match[1];
    } else if (typeof input.file_path === 'string') {
      const parts = input.file_path.split('/');
      parts.pop();
      return parts.join('/');
    }
  }
  return '';
}

// The agent a session is listed under: its first. A session whose later
// turns ran on another agent stays in one place.
// The agent a session is listed under: the saved agent it started on, else
// the harness of its first turn. A later turn on another agent never moves it.
export function sessionGroup(s: SessionSummary): string {
  return s.first_agent_id || s.first_agent || s.agent;
}

// The rows of the Agents column: every saved agent, in the order the service
// lists them, even one with no session, each with its sessions; then one row
// for each other group sessions fall in (a harness alone, or an agent since
// removed), named as before saved agents existed.
export function buildAgents(sessions: SessionSummary[], saved: SavedAgent[] = []): AgentSummary[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const a of saved) groups.set(a.id, []);
  for (const s of sessions) {
    const g = sessionGroup(s);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  const byId = new Map(saved.map((a) => [a.id, a]));
  return Array.from(groups.entries()).map(([id, list]) => {
    const usage = createEmptyUsage();
    for (const s of list) addUsage(usage, s.usage);
    const a = byId.get(id);
    const harness = a?.harness ?? (list.find((s) => s.first_agent)?.first_agent || id);
    const name = a ? a.name : agentName(id, list);
    return {
      id,
      name,
      vendor: harness === 'claude' ? 'anthropic' : harness === 'codex' ? 'openai' : 'unknown',
      mark: harness === 'claude' ? 'C' : harness === 'codex' ? 'X' : name.charAt(0).toUpperCase(),
      sessionCount: list.length,
      openCount: list.filter((s) => s.open).length,
      usage,
      ...(a ? { saved: a, line: savedLine(a) } : {}),
    };
  });
}

// A saved agent's access and model, in a few words.
function savedLine(a: SavedAgent): string {
  const access = a.access === 'subscription' ? 'subscription' : a.access === 'openrouter' ? 'OpenRouter' : a.access;
  return a.model ? `${access} · ${a.model}` : access;
}

// The agent "" holds sessions no run started. Name it after the
// harness that sent them (the client up to its version), or "unknown agent".
// A saved agent's id that is no longer saved names its harness.
function agentName(id: string, sessions: SessionSummary[]): string {
  if (id === 'claude') return 'Claude Code';
  if (id === 'codex') return 'codex';
  const first = sessions.find((s) => s.first_agent)?.first_agent;
  if (id !== '' && first && first !== id) return `${first === 'claude' ? 'Claude Code' : first} (removed agent)`;
  if (id !== '') return id;
  const client = sessions.find((s) => s.client)?.client ?? '';
  return client.split('/')[0] || 'unknown agent';
}

// One model call of a turn with the tool calls its reply asked for.
export interface CallGroup {
  pair: ModelCallPair;
  // 1-based, in the turn's order.
  number: number;
  tools: ToolCallPair[];
}

// A turn's model calls, each with the tool calls it asked for. A tool call
// belongs to the call whose exchange it carries (the reply's events carry the
// request's exchange). Only a tool call with no exchange at all goes to the
// last call before it. One whose exchange matches no call (its request was
// never seen), or with no exchange and no call before it, is in `unmatched`,
// never under another call.
export function callGroups(turn: TurnDetail): { groups: CallGroup[]; unmatched: ToolCallPair[] } {
  const groups: CallGroup[] = turn.modelCalls.map((pair, i) => ({ pair, number: i + 1, tools: [] }));
  const unmatched: ToolCallPair[] = [];
  for (const tc of turn.toolCalls) {
    const x = tc.requested.exchange;
    let g: CallGroup | undefined;
    if (x) {
      g = groups.find((c) => c.pair.requested.exchange === x);
    } else {
      const at = turn.events.indexOf(tc.requested);
      for (const c of groups) if (turn.events.indexOf(c.pair.requested) < at) g = c;
    }
    (g ? g.tools : unmatched).push(tc);
  }
  return { groups, unmatched };
}

// A model call failed when its reply carries an error or a status other than
// 200. An interrupted stream can report status 200 with an error, and keep a
// stop reason, so the error decides whatever the status says.
export function callFailed(reply?: CockpitEvent): boolean {
  return !!reply && (!!reply.error || (reply.status !== undefined && reply.status !== 200));
}

// What a loaded turn says about how it continued, and what went wrong in it.
// Every field is read defensively: an older service leaves them out, and
// `recovered_from` is a failed turn's id and `recovered_reason` its reason.
export interface TurnNotes {
  // From turn.started: how the session's earlier turns reached this one.
  continuity?: 'replay' | 'resume';
  // The earlier turn whose history was replayed, as a turn id.
  replayFrom?: string;
  // Set when the session continued after an interrupted turn.
  recovered?: { turn?: string; reason?: string };
  // The error text of each replay.failed event, in order.
  replayErrors: string[];
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function turnNotes(detail?: TurnDetail): TurnNotes {
  const notes: TurnNotes = { replayErrors: [] };
  if (!detail) return notes;
  const start = detail.events.find((e) => e.kind === 'turn.started');
  if (start) {
    if (start.continuity === 'replay' || start.continuity === 'resume') notes.continuity = start.continuity;
    notes.replayFrom = text(start.replay_from);
    // The framework sends recovered_from as the failed turn's id (a string)
    // and recovered_reason as a string. Any other shape is ignored.
    const rec = typeof start.recovered_from === 'string' ? start.recovered_from.trim() : '';
    if (rec !== '') notes.recovered = { turn: rec, reason: text(start.recovered_reason)?.trim() };
  }
  for (const e of detail.events) {
    if (e.kind !== 'replay.failed') continue;
    notes.replayErrors.push(text(e.error) ?? 'a model request of this turn could not be given the earlier turn’s history');
  }
  return notes;
}

// The quiet line for a turn header: how it continued. A turn number is shown
// when the named turn is in the session's list; an unknown id is left out.
export function continuityLabel(notes: TurnNotes, turns: { id: string; turnNumber: number }[]): string | null {
  const num = (id?: string) => turns.find((t) => t.id === id)?.turnNumber;
  if (notes.recovered) {
    const n = num(notes.recovered.turn);
    const what = n !== undefined ? `turn ${n}` : 'an earlier turn';
    return `continued after ${what} was interrupted${notes.recovered.reason ? ` (${notes.recovered.reason})` : ''}`;
  }
  if (notes.continuity === 'replay') {
    const n = num(notes.replayFrom);
    return n !== undefined ? `continued from turn ${n}` : 'continued from an earlier turn';
  }
  if (notes.continuity === 'resume') return 'resumed';
  return null;
}
