// What a running turn is doing, read from its own events alone (the gateway's
// traffic, never a vendor CLI stream). One pure function gives the status line
// and the cost so far; another gives the tool cards. The plan is
// agentbus-notes/plans/LIVE_STATUS.md.
//
// Only events that exist today are read. Two framework steps will add more:
// `model.progress` (thinking, writing, choosing a tool, while a call runs) and
// codex `steps` / `step_results` (the commands inside one exec script). Both
// slot into the places marked below; until then a model call reads "Waiting on
// the model" and a codex script is shown as code.
import { CockpitEvent, ToolCallPair, TurnDetail } from '../types';
import { callFailed, pairModelCalls, pairToolCalls, turnCost } from './turns';
import { formatCost } from '../utils/format';

export type LiveState =
  | 'starting' // the agent runs, no model call yet
  | 'model' // a model call is open
  | 'tools' // one or more tool calls are open
  | 'agent' // nothing is open: the agent works between steps
  | 'finishing' // the last reply is in, the agent has not exited
  | 'finished'
  | 'failed'
  | 'stopped';

export interface LiveStatus {
  state: LiveState;
  // True while something runs: the spinner turns and the time ticks.
  running: boolean;
  // The whole line at `now`, such as "Waiting on the model · call 2 · 4s".
  line: string;
  // When the open step began (ms, the events' clock). The elapsed time counts from it.
  sinceMs: number;
  // The open model call's number, 1-based, when one is open.
  call?: number;
  // When the turn began and ended (ms), and its whole time so far.
  startedMs: number;
  endedMs?: number;
  elapsedMs: number;
  // The sum of cost_usd over the turn's replies; null when none has one.
  costUsd: number | null;
  costComplete: boolean;
  // The last priced reply: its cost and its id, so a "+$0.04" can show once per call.
  lastDeltaUsd?: number;
  lastDeltaId?: string;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
};

// "4s", "1m 5s". Whole seconds, rounded down, never negative.
export function formatElapsed(msValue: number): string {
  const s = Math.max(0, Math.floor(msValue / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// One tool call as a card shows it.
export interface ToolCard {
  pair: ToolCallPair;
  // The model call whose reply asked for it, 1-based; undefined when unknown.
  call?: number;
  // The plain action: Read, Edit, Write, Run, Search, or the tool's own name.
  label: string;
  // The file path (shortened to the turn's folder), the command, or the pattern.
  target: string;
  // Edit: the lines taken out and put in, from the tool input.
  diff?: { del: string[]; add: string[] };
  // Write: the new file's lines.
  write?: string[];
  // A script the cockpit does not read (codex exec), shown as code.
  script?: string;
  startedMs: number;
  endedMs?: number;
  result?: ToolResult;
}

export interface ToolResult {
  // 'ok', 'exit 1', 'error' or 'done' (ended, outcome not readable).
  text: string;
  failed: boolean;
  exitCode?: number;
  // On a failure: the last line of the output, which says why.
  why?: string;
}

// The tools one reply asked for. They run together and their results come
// back in one request, so the group has one time.
export interface ToolGroup {
  call?: number;
  tools: ToolCard[];
  startedMs: number;
  // Set once every tool of the group has its result.
  endedMs?: number;
}

const FILE_TOOLS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Write',
  NotebookEdit: 'Edit',
};
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const RUN_TOOLS = new Set(['Bash']);
// Codex sends every step as one JavaScript script. Until the framework splits
// it into `steps`, the script is shown as it is.
const SCRIPT_TOOLS = new Set(['exec']);

// A path inside the folder, shown from the folder. macOS reports /tmp as
// /private/tmp, so that form counts as inside too.
export function shortPath(path: string, folder?: string): string {
  if (!folder) return path;
  const f = folder.replace(/\/+$/, '');
  for (const base of [f, `/private${f}`]) {
    if (path.startsWith(base + '/')) return path.slice(base.length + 1);
  }
  return path;
}

// A command, without a leading "cd <the turn's folder> &&".
function shortCommand(cmd: string, folder?: string): string {
  const one = cmd.trim();
  const m = one.match(/^cd\s+("?)([^"\s&;]+)\1\s*&&\s*([\s\S]+)$/);
  if (m && folder && shortPath(m[2] + '/x', folder) === 'x') return m[3];
  return one;
}

function input(e: CockpitEvent): Record<string, unknown> {
  return e.tool_input && typeof e.tool_input === 'object' ? (e.tool_input as Record<string, unknown>) : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// The card's label and target from the tool's name and input.
export function describeTool(req: CockpitEvent, folder?: string): Pick<ToolCard, 'label' | 'target' | 'diff' | 'write' | 'script'> {
  const name = req.tool_name || 'tool';
  const inp = input(req);
  if (FILE_TOOLS[name]) {
    const path = str(inp.file_path) ?? str(inp.notebook_path) ?? '';
    const out: Pick<ToolCard, 'label' | 'target' | 'diff' | 'write' | 'script'> = { label: FILE_TOOLS[name], target: shortPath(path, folder) };
    if (name === 'Edit' && (str(inp.old_string) !== undefined || str(inp.new_string) !== undefined)) {
      out.diff = { del: lines(str(inp.old_string)), add: lines(str(inp.new_string)) };
    } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
      const del: string[] = [];
      const add: string[] = [];
      for (const ed of inp.edits as Record<string, unknown>[]) {
        del.push(...lines(str(ed?.old_string)));
        add.push(...lines(str(ed?.new_string)));
      }
      out.diff = { del, add };
    } else if (name === 'Write' && str(inp.content) !== undefined) {
      out.write = lines(str(inp.content));
    }
    return out;
  }
  if (RUN_TOOLS.has(name)) return { label: 'Run', target: shortCommand(str(inp.command) ?? '', folder) };
  if (SEARCH_TOOLS.has(name)) {
    const pattern = str(inp.pattern) ?? '';
    const where = str(inp.path);
    return { label: 'Search', target: where ? `${pattern} in ${shortPath(where, folder)}` : pattern };
  }
  if (SCRIPT_TOOLS.has(name) && typeof req.tool_input === 'string') {
    return { label: name, target: '', script: req.tool_input };
  }
  const first = Object.values(inp).find((v) => typeof v === 'string') as string | undefined;
  return { label: name, target: typeof req.tool_input === 'string' ? firstLine(req.tool_input) : first ? firstLine(first) : '' };
}

function lines(s?: string): string[] {
  if (s === undefined || s === '') return [];
  return s.replace(/\n$/, '').split('\n');
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

// The line that says why a command failed: the last one it printed. A
// command's own output comes first and its error last, as in
// "hi world" then "ls: no_such_file: No such file or directory".
function lastLine(s: string): string {
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  return lines.length ? lines[lines.length - 1].trim() : '';
}

// The exit codes a codex exec script reports. Its output is "Script
// completed", "Wall time N seconds", "Output:", then what the script printed:
// each `text(await tools.exec_command(...))` prints the step's result as one
// JSON object ({"chunk_id":…,"exit_code":0,…,"output":"…"}), and the objects
// follow each other with nothing between them. A script can also print its
// own JSON, such as {"exit_code":1}. Every JSON object found at the top level
// of the output with a numeric exit_code counts, in order. A step's own output
// is a string inside its object, so JSON in it is never read as another step.
export function codexExits(output: string): { code: number; output?: string }[] {
  const found: { code: number; output?: string }[] = [];
  let i = 0;
  while (i < output.length) {
    const start = output.indexOf('{', i);
    if (start < 0) break;
    const end = matchBrace(output, start);
    if (end < 0) {
      i = start + 1;
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(output.slice(start, end + 1));
    } catch {
      i = start + 1;
      continue;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      if (typeof o.exit_code === 'number' && Number.isInteger(o.exit_code)) {
        found.push({ code: o.exit_code, output: typeof o.output === 'string' ? o.output : undefined });
      }
    }
    i = end + 1;
  }
  return found;
}

// The index of the brace that closes the one at `start`, reading JSON
// strings so a brace inside one does not count; -1 when it is not closed.
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// What a script printed besides its JSON objects, for the "why" line.
function codexPlainOutput(output: string): string {
  const at = output.indexOf('Output:\n');
  return at >= 0 ? output.slice(at + 'Output:\n'.length) : output;
}

// A tool's outcome from its result.
// claude: tool_error true is a failure; a Bash failure's output starts
// "Exit code N". codex: there is no error flag; the exit codes are in the
// output's JSON. Anything else that ended is "done".
export function toolResult(req: CockpitEvent, done: CockpitEvent): ToolResult {
  const out = typeof done.tool_output === 'string' ? done.tool_output : '';
  if (done.tool_error === true) {
    const m = out.match(/^Exit code (\d+)\s*\n?([\s\S]*)$/);
    if (m) return { text: `exit ${m[1]}`, failed: true, exitCode: Number(m[1]), why: lastLine(m[2]) || undefined };
    return { text: 'error', failed: true, why: lastLine(out) || undefined };
  }
  if (done.tool_error === false) return { text: 'ok', failed: false };
  if (SCRIPT_TOOLS.has(req.tool_name ?? '')) {
    const exits = codexExits(out);
    const bad = exits.find((x) => x.code !== 0);
    if (bad) {
      const why = lastLine(bad.output ?? '') || lastLine(codexPlainOutput(out).replace(/\{[\s\S]*$/, ''));
      return { text: `exit ${bad.code}`, failed: true, exitCode: bad.code, why: why || undefined };
    }
    if (exits.length > 0) return { text: 'ok', failed: false, exitCode: 0 };
  }
  return { text: 'done', failed: false };
}

function visible(events: CockpitEvent[]): CockpitEvent[] {
  // A probe exchange is the harness's own check, never a step of the turn.
  return events.filter((e) => !e.probe);
}

// The tools a turn ran, grouped by the reply that asked for them, oldest first.
export function toolGroups(detail: TurnDetail, folder?: string): ToolGroup[] {
  const calls = detail.modelCalls.filter((p) => !p.requested.probe);
  const callOf = (x?: string) => {
    if (!x) return undefined;
    const i = calls.findIndex((p) => p.requested.exchange === x);
    return i < 0 ? undefined : i + 1;
  };
  const groups: ToolGroup[] = [];
  for (const pair of detail.toolCalls) {
    if (pair.requested.probe) continue;
    const req = pair.requested;
    const card: ToolCard = {
      pair,
      call: callOf(req.exchange),
      ...describeTool(req, folder),
      startedMs: ms(req.time),
      endedMs: pair.completed ? ms(pair.completed.time) : undefined,
      result: pair.completed ? toolResult(req, pair.completed) : undefined,
    };
    // Tools of one reply carry its exchange. Without one, a tool joins the
    // group before it only when they were asked for at the same moment.
    const last = groups[groups.length - 1];
    const same = last && (req.exchange ? last.tools[0].pair.requested.exchange === req.exchange : !last.tools[0].pair.requested.exchange && last.startedMs === card.startedMs);
    if (same) last.tools.push(card);
    else groups.push({ call: card.call, tools: [card], startedMs: card.startedMs });
  }
  for (const g of groups) {
    g.startedMs = Math.min(...g.tools.map((t) => t.startedMs));
    g.endedMs = g.tools.every((t) => t.endedMs !== undefined) ? Math.max(...g.tools.map((t) => t.endedMs!)) : undefined;
  }
  return groups;
}

// The line for one open tool.
function toolLine(card: ToolCard): string {
  const t = card.target;
  switch (card.label) {
    case 'Read':
      return t ? `Reading ${t}` : 'Reading';
    case 'Edit':
      return t ? `Editing ${t}` : 'Editing';
    case 'Write':
      return t ? `Writing ${t}` : 'Writing';
    case 'Run':
      return t ? `Running ${t}` : 'Running a command';
    case 'Search':
      return t ? `Searching ${t}` : 'Searching';
    default:
      return `Running ${card.label}`;
  }
}

// A turn's live status at `now` (ms, on the events' clock), from its events.
//
// The rules (CLIENT_API "Turns", made finer):
// - A run's turn (it has session.opened) ends at its session.closed: stopped
//   when it says so, finished on exit code 0 with no error, else failed. Any
//   other turn ends at its turn.completed.
// - A run's turn with turn.completed and no session.closed yet is finishing,
//   and so is one whose last reply asked for no tool (that reply is its answer).
// - Otherwise the open step is the status: an open model call (no reply yet)
//   or open tool calls (no result yet); the later one wins.
// - Nothing open and no call yet: the agent is starting. Nothing open after a
//   call: the agent works between steps.
export function liveStatus(rawEvents: CockpitEvent[], now: number, agent?: string): LiveStatus {
  const events = visible(rawEvents);
  const start = events.find((e) => e.kind === 'turn.started') ?? events[0];
  const startedMs = start ? ms(start.time) : now;
  const name = agent || (typeof start?.agent === 'string' ? start.agent : '');
  const cost = turnCost(events);
  const priced = events.filter((e) => e.kind === 'model.responded' && typeof e.cost_usd === 'number');
  const lastPriced = priced[priced.length - 1];
  const base = {
    startedMs,
    costUsd: cost.usd,
    costComplete: cost.complete,
    lastDeltaUsd: lastPriced?.cost_usd as number | undefined,
    lastDeltaId: lastPriced?.id,
  };

  const opened = events.some((e) => e.kind === 'session.opened');
  const closed = events.find((e) => e.kind === 'session.closed');
  const completed = events.filter((e) => e.kind === 'turn.completed').pop();
  const modelCalls = pairModelCalls(events);

  const ended = (state: LiveState, end: CockpitEvent, why?: string): LiveStatus => {
    const endedMs = ms(end.time);
    const elapsedMs = Math.max(0, endedMs - startedMs);
    const parts = [state === 'finished' ? 'Finished' : state === 'stopped' ? 'Stopped' : 'Failed'];
    if (why) parts.push(why);
    parts.push(formatElapsed(elapsedMs));
    const c = formatCost(cost.usd, cost.complete);
    if (c && state === 'finished') parts.push(c);
    return { ...base, state, running: false, line: parts.join(' · '), sinceMs: endedMs, endedMs, elapsedMs };
  };

  if (opened && closed) {
    if (closed.stopped === true) return ended('stopped', closed);
    if (closed.exit_code === 0 && !closed.error) return ended('finished', closed);
    return ended('failed', closed, failure(closed, modelCalls.map((p) => p.responded)));
  }
  if (!opened && completed) return ended('finished', completed);

  const elapsedMs = Math.max(0, now - startedMs);
  const open = (state: LiveState, what: string, sinceMs: number, call?: number): LiveStatus => ({
    ...base,
    state,
    running: true,
    line: `${what} · ${formatElapsed(now - sinceMs)}`,
    sinceMs,
    call,
    elapsedMs,
  });

  if (completed) return open('finishing', 'Finishing', ms(completed.time));
  // The last reply asked for no tool and did not fail: it is the turn's
  // answer, and the agent is ending (turn.completed comes with it, or soon).
  const lastCall = modelCalls[modelCalls.length - 1];
  const lastReply = lastCall?.responded;
  if (
    lastReply &&
    !callFailed(lastReply) &&
    !events.some((e) => e.kind === 'tool.requested' && (lastCall.requested.exchange ? e.exchange === lastCall.requested.exchange : ms(e.time) >= ms(lastReply.time)))
  ) {
    return open('finishing', 'Finishing', ms(lastReply.time));
  }

  // The open model call: the last request with no reply.
  let openCall: { at: number; n: number } | undefined;
  modelCalls.forEach((p, i) => {
    if (!p.responded) openCall = { at: ms(p.requested.time), n: i + 1 };
  });
  // The open tools: asked for, with no result yet.
  const tools = pairToolCalls(events, events).filter((p) => !p.completed);
  const toolsAt = tools.length ? Math.min(...tools.map((p) => ms(p.requested.time))) : -1;

  if (openCall && openCall.at >= toolsAt) {
    // With model.progress (framework step 1) this becomes "Thinking",
    // "Writing" or "Choosing Edit" from the call's latest progress event.
    return open('model', `Waiting on the model · call ${openCall.n}`, openCall.at, openCall.n);
  }
  if (tools.length === 1) {
    const card = { ...describeTool(tools[0].requested, folderOf(start)), startedMs: toolsAt } as ToolCard;
    return open('tools', toolLine(card), toolsAt);
  }
  if (tools.length > 1) return open('tools', `${tools.length} tools running`, toolsAt);

  if (modelCalls.length === 0) return open('starting', `Starting ${name || 'the agent'}`, startedMs);
  const lastAt = Math.max(...events.map((e) => ms(e.time)));
  return open('agent', 'Waiting on the agent', lastAt);
}

function folderOf(start?: CockpitEvent): string | undefined {
  return typeof start?.folder === 'string' && start.folder ? start.folder : undefined;
}

// Why a run's turn failed, in a few words: a failed model call, the agent's
// error, or its exit code.
function failure(closed: CockpitEvent, replies: (CockpitEvent | undefined)[]): string | undefined {
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (r && callFailed(r)) {
      return r.status !== undefined && r.status !== 200 ? `call ${i + 1} returned ${r.status}` : `call ${i + 1} failed`;
    }
  }
  if (typeof closed.exit_code === 'number') return `the agent exited ${closed.exit_code}`;
  if (typeof closed.error === 'string' && closed.error) return closed.error.split('\n')[0];
  return undefined;
}

// The events' clock as the cockpit sees it: the receive time minus the event
// time, the smallest seen (the freshest event; a resent old one is larger).
// On one machine it is a few ms; it matters when the service runs elsewhere.
let clockSkew: number | null = null;
export function noteEventTime(iso: string, receivedAt = Date.now()): void {
  const t = Date.parse(iso);
  if (isNaN(t)) return;
  const skew = receivedAt - t;
  if (clockSkew === null || skew < clockSkew) clockSkew = skew;
}
export function eventsNow(at = Date.now()): number {
  return at - (clockSkew ?? 0);
}
export function resetClock(): void {
  clockSkew = null;
}

// The latest turn of each session, with its events, as the stream brings
// them. The session cards read their status from it. A new turn's
// session.opened or turn.started starts its entry over; an event of an older
// turn is left out. `backfill` is true when an entry starts from an event
// other than those two: the turn began before the cockpit saw it, so its
// earlier events must be read once.
export interface LiveTurn {
  turn: string;
  events: CockpitEvent[];
}
export type LiveTurns = Record<string, LiveTurn>;

export function addLiveEvent(cur: LiveTurns, e: CockpitEvent): { next: LiveTurns; backfill: boolean } {
  if (!e.turn || e.probe) return { next: cur, backfill: false };
  const held = cur[e.session];
  if (held && held.turn === e.turn) {
    if (held.events.some((x) => x.id === e.id)) return { next: cur, backfill: false };
    return { next: { ...cur, [e.session]: { turn: e.turn, events: [...held.events, e] } }, backfill: false };
  }
  const starts = e.kind === 'session.opened' || e.kind === 'turn.started';
  if (held && !starts) return { next: cur, backfill: false };
  return { next: { ...cur, [e.session]: { turn: e.turn, events: [e] } }, backfill: !starts };
}

// Earlier events of the entry's turn, read from the API, joined to it.
export function mergeLive(cur: LiveTurns, session: string, turn: string, events: CockpitEvent[]): LiveTurns {
  const held = cur[session];
  if (held && held.turn !== turn) return cur;
  const seen = new Set((held?.events ?? []).map((e) => e.id));
  const add = events.filter((e) => !seen.has(e.id) && !e.probe);
  if (held && add.length === 0) return cur;
  const all = [...add, ...(held?.events ?? [])];
  all.sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : 0) || Date.parse(a.time) - Date.parse(b.time));
  return { ...cur, [session]: { turn, events: all } };
}
