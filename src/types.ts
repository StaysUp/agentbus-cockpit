export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface CockpitEvent {
  id: string;
  seq?: number;
  kind: string;
  time: string;
  session: string;
  turn?: string;
  exchange?: string;
  vendor?: string;
  client?: string;
  text?: string;
  model?: string;
  tools_offered?: string[];
  stop_reason?: string;
  usage?: Usage;
  latency_ms?: number;
  status?: number;
  tool_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  tool_output?: string;
  tool_error?: boolean;
  outcome?: string;
  // The harness's own check, not a person's request; it belongs to no turn.
  probe?: boolean;
  // On model.responded: the call's price in USD, and whether it is exact.
  cost_usd?: number;
  cost_complete?: boolean;
  [key: string]: unknown;
}

export interface ModelCallPair {
  requested: CockpitEvent;
  responded?: CockpitEvent;
}

export interface ToolCallPair {
  requested: CockpitEvent;
  completed?: CockpitEvent;
}

// A turn's state as GET /api/v0/turns gives it (CLIENT_API.md). A turn
// started through POST /turns is running until its agent exits, then finished
// on exit code 0, else failed. Any other turn is finished once it has a
// turn.completed, else running.
export type TurnState = 'running' | 'finished' | 'failed';

// One row of the turn list: what GET /api/v0/turns says about a turn.
export interface Turn {
  id: string;
  // 1-based, oldest first, within the session.
  turnNumber: number;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  // From start to end; undefined while the turn runs.
  durationMs?: number;
  // The person's words with system reminders taken out. From the list this
  // is a preview of the first 500 characters; promptTruncated says it was cut.
  prompt: string;
  promptTruncated?: boolean;
  // From the list, for a turn whose events are not loaded: the reply to the
  // turn's last model call (its first 500 characters; replyTruncated says it
  // was cut), the model that call asked for, and how many model calls the
  // turn made. Undefined when the source does not give them. A loaded turn
  // reads all three from its detail instead.
  reply?: string;
  replyTruncated?: boolean;
  model?: string;
  modelCalls?: number;
  // From the turn's turn.started: the agent (harness) and folder of the run
  // that started it, and the saved agent that ran it (agentId). Turns of one
  // session may name different agents. Absent for a turn no run started,
  // and in older files.
  agent?: string;
  agentId?: string;
  folder?: string;
  state: TurnState;
  // True when the person stopped the turn (POST /api/v0/turns/<id>/stop).
  stopped?: boolean;
  outcome?: string;
  // Sums the turn's replies that carried usage; null when none did.
  usage: Usage | null;
  // Sum of cost_usd over the turn's model.responded events; null when none has one.
  costUsd: number | null;
  // False when a reply lacks a complete cost, or events of the session were dropped.
  costComplete: boolean;
  // The seq of the turn's turn.started, when the source has seq.
  startedSeq?: number;
  // The turn's own events, paired, once they are loaded
  // (GET /api/v0/turns/{id}/events). Only loaded turns have it.
  detail?: TurnDetail;
}

// One turn's events, and what the cockpit reads from them.
export interface TurnDetail {
  events: CockpitEvent[];
  modelCalls: ModelCallPair[];
  toolCalls: ToolCallPair[];
  // The whole prompt from the turn's turn.started, cleaned and raw.
  prompt?: string;
  rawPrompt?: string;
  // The text of the last call's reply.
  agentResponse?: string;
}

// The turns of one session, oldest first, and the cursor (store, seq) they
// were computed at. A source with no cursor leaves store and seq out.
export interface TurnList {
  store?: string;
  seq?: number;
  turns: Turn[];
}

export interface SessionSummary {
  id: string;
  // The agent (harness) of the session's latest turn, and of its first:
  // a session whose later turns ran on another agent keeps its first.
  agent: string;
  first_agent?: string;
  client: string;
  folder?: string;
  title: string;
  started: string;
  last: string;
  open: boolean;
  turns: number;
  usage: Usage;
  cost_usd?: number | null;
  cost_complete?: boolean;
  // True when the service can take a next message for this session
  // (POST /api/v0/turns with session).
  resumable?: boolean;
}

// GET /api/v0/sessions: the rows and the cursor (store, seq) they were computed at.
// A source with no cursor leaves store and seq out.
export interface SessionList {
  store?: string;
  seq?: number;
  sessions: SessionSummary[];
}

// The session on screen: its row and its turns.
export interface SessionDetail extends SessionSummary {
  turnsList: Turn[];
}

export interface AgentSummary {
  id: string;
  name: string;
  vendor: string;
  mark: string;
  sessionCount: number;
  openCount: number;
  usage: Usage;
}

// One way a harness reaches a model, from GET /api/v0/harnesses.
export interface AccessOption {
  kind: string; // subscription, openrouter or api
  label: string;
  disabled?: boolean;
  // Models to offer, first the one to start from.
  models: string[];
  // Any model name is accepted, as an OpenRouter model id.
  any_model?: boolean;
  key_env?: string;
  // Whether key_env is set where the service runs. Never its value.
  key_set?: boolean;
}

// One harness the service can run an agent on, from GET /api/v0/harnesses.
export interface Harness {
  name: string;
  label?: string;
  disabled?: boolean;
  found: boolean;
  version?: string;
  signed_in?: boolean;
  access?: AccessOption[];
}

// What a person sets on a saved agent (POST and PUT /api/v0/agents).
export interface AgentFields {
  name: string;
  harness: string;
  access: string;
  model?: string;
  key_env?: string;
}

// A saved agent, from GET /api/v0/agents. A turn names it by id.
export interface SavedAgent extends AgentFields {
  id: string;
  key_set?: boolean;
  created?: string;
  updated?: string;
}

// POST /api/v0/turns: a saved agent and a folder, with the first message.
// The service isolates the session in a git worktree when the folder is in
// a git repo.
export interface RunRequest {
  agent: string;
  folder: string;
  prompt: string;
  model?: string;
  read_only?: boolean;
}

// The reply to POST /api/v0/turns: the session, and the turn it started.
// Every event of that turn carries the turn id.
export interface Started {
  id: string;
  turn?: string;
}

// GET /api/v0/calls/<exchange>/context: what one model call sent, split into
// pieces in the request's order, and the reply kept for it. With full=false
// every json is left out: kinds, labels and sizes only. size is the piece's
// exact byte count; approx_tokens is the service's estimate (size / 2.66),
// not the vendor's count.
export interface ContextPiece {
  kind: string;
  label: string;
  hash: string;
  size: number;
  approx_tokens?: number;
  json?: unknown;
}

export interface CallContext {
  exchange: string;
  session?: string;
  vendor?: string;
  time?: string;
  size: number;
  stop_reason?: string;
  reply?: ContextPiece;
  // Every other top-level field of the request, in its order.
  request?: Record<string, unknown>;
  pieces: ContextPiece[];
}

export interface DataSource {
  getAgents(): Promise<AgentSummary[]>;
  getSessions(agentId?: string): Promise<SessionSummary[]>;
  // The sessions with the cursor they were taken at. A source without it is
  // read through getSessions, and its lists always replace the shown one.
  getSessionList?(): Promise<SessionList>;
  // Every turn of one session, oldest first, without their events.
  getTurns(sessionId: string): Promise<TurnList>;
  // One turn's events, paired. null when the turn has no events.
  getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null>;
  // A source that keeps saved agents has these: the harnesses they can run
  // on, and the agents to list, save, edit and remove. Each rejects with the
  // API's own words.
  getHarnesses?(): Promise<Harness[]>;
  listAgents?(): Promise<SavedAgent[]>;
  createAgent?(f: AgentFields): Promise<SavedAgent>;
  updateAgent?(id: string, f: AgentFields): Promise<SavedAgent>;
  removeAgent?(id: string): Promise<void>;
  // A source that can start and continue sessions has these two. Each
  // rejects with an Error whose message is the API's own words. Starting
  // resolves with the session id and, from the live API, the new turn's id.
  startRun?(req: RunRequest): Promise<Started>;
  // agent names a saved agent: the turn runs on it, in the session's folder.
  sendMessage?(sessionId: string, req: { prompt: string; read_only?: boolean; model?: string; agent?: string }): Promise<Started>;
  // A source that runs turns can stop one: 'stopping' when the service took
  // the stop (202, also when it was already stopping), 'not-running' when the
  // turn has already ended (409). Rejects with an Error in the API's own words.
  stopTurn?(turnId: string): Promise<'stopping' | 'not-running'>;
  // A source that keeps request bodies has this: one model call's request
  // and reply by its exchange. Rejects with an Error in the API's own words.
  getCallContext?(exchange: string, full: boolean): Promise<CallContext>;
  // Calls onEvent for each new event, and onSnapshot with the sessions of the
  // snapshot the stream starts from: once at the start, and again whenever it
  // starts over (the store changed). Show that list, so the list and the
  // stream share one cursor.
  subscribe?(
    onEvent: (event: CockpitEvent) => void,
    onSnapshot?: (sessions: SessionSummary[], cursor?: { store: string; seq: number }) => void
  ): () => void;
}

// One click on an event. The nonce changes on every click, so the same id
// selected twice is still two selections. id null clears the selection.
export interface EventSelection {
  id: string | null;
  nonce: number;
}

// What the right panel shows, and what carries the mark in the conversation:
// the whole session, one turn in it, or one model call in that turn.
export type Level = 'session' | 'turn' | 'call';
